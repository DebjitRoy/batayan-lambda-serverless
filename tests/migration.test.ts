import { describe, expect, it, vi } from "vitest";
import { decodeExtended, itemBytes, itemHash, validateRecords, type Backup, type Collection, type Document, type RecordToImport } from "../scripts/migration/backup.js";
import { newManifest, runMigration } from "../scripts/migration/engine.js";
import { checkTable, validateTargetOptions, waitForUnits, type MigrationTarget } from "../scripts/migration/target.js";
import { post, user, comment } from "./fixtures/legacy.js";
const password = "$2b$12$" + "a".repeat(53);
const fixture = () => ({ users: [{ ...user, password }], posts: [structuredClone(post)], comments: [structuredClone(comment)] });
const backup = (): Backup => ({ ...validateRecords(fixture()), files: [] });
class MemoryTarget implements MigrationTarget {
  rows = new Map<Collection, Document[]>();
  puts = 0;
  inspect = vi.fn(async () => {});
  close = vi.fn();
  async *scan(collection: Collection) { yield* this.rows.get(collection) ?? []; }
  async get(record: RecordToImport) { return this.rows.get(record.collection)?.find(row => row._id === record.id); }
  async put(record: RecordToImport) {
    this.puts++;
    if (await this.get(record)) throw Object.assign(new Error(), { name: "ConditionalCheckFailedException" });
    this.rows.set(record.collection, [...this.rows.get(record.collection) ?? [], structuredClone(record.item)]);
  }
}
describe("backup transformation", () => {
  it("decodes IDs and both date formats without changing Unicode or null values", () => {
    expect(decodeExtended({ _id: { $oid: post._id }, createdAt: { $date: { $numberLong: "1594074782405" } }, content: ["বাংলা।\n  text", null] })).toEqual({ _id: post._id, createdAt: post.createdAt, content: ["বাংলা।\n  text", null] });
    expect(decodeExtended({ $date: "2020-07-06T17:33:02.405-05:00" })).toBe(post.createdAt);
  });
  it.each([{ $unknown: "value" }, { $oid: "bad" }, { $date: { $numberLong: "99999999999999999999" } }, { $date: { $numberLong: "1", extra: true } }, { $date: "not-a-date" }, { $date: "2026-02-30T00:00:00Z" }, { $date: "2020-01-01" }])("rejects malformed or unsupported Extended JSON", value => {
    expect(() => decodeExtended(value)).toThrow();
  });
  it("preserves null section fields, legacy role, hash, empty comment title and defaults", () => {
    const input = fixture();
    const raw = input.posts[0] as unknown as Document;
    delete raw.additionalInfo;
    const sections = raw.content as Document[];
    sections[0]!.header = null; sections[0]!.image = null;
    input.comments[0]!.title = "";
    const transformed = validateRecords(input);
    expect(transformed.issues).toEqual([]);
    expect(transformed.records.find(record => record.collection === "posts")?.item).toMatchObject({ status: "published", additionalInfo: "", content: [expect.objectContaining({ _id: post.content[0]!._id, header: null, image: null })] });
    expect(transformed.records.find(record => record.collection === "users")?.item).toMatchObject({ role: "user", password });
    expect(transformed.records.find(record => record.collection === "comments")?.item.title).toBe("");
  });
  it("normalizes email with a hash-only audit and removes version metadata", () => {
    const input = fixture(); input.users[0]!.email = " EXAMPLE@example.com ";
    (input.users[0] as unknown as Document).__v = 0;
    const result = validateRecords(input);
    expect(result.issues).toEqual([]);
    expect(result.records[0]!.item.email).toBe("example@example.com");
    expect(result.records[0]!.item.__v).toBeUndefined();
    expect(result.emailNormalizations[0]).toMatchObject({ userId: user._id, sourceIndex: 0 });
    expect(JSON.stringify(result.emailNormalizations)).not.toContain("@");
  });
  it("rejects duplicate entity/email/section IDs, orphans and unknown fields", () => {
    const input = fixture();
    input.users.push({ ...input.users[0]!, _id: "507f1f77bcf86cd799439099" });
    input.posts.push(structuredClone(input.posts[0]!));
    input.posts[0]!.content.push(structuredClone(input.posts[0]!.content[0]!));
    input.comments[0]!.post = "507f1f77bcf86cd799439088";
    const result = validateRecords(input);
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(["DUPLICATE_EMAIL", "DUPLICATE_SECTION_ID", "DUPLICATE_ID", "ORPHAN_COMMENT"]));
    const another = fixture(); (another.posts[0] as unknown as Document).unknown = "sensitive value";
    expect(JSON.stringify(validateRecords(another).issues)).not.toContain("sensitive value");
    expect(validateRecords(another).issues.some(issue => issue.code === "unrecognized_keys")).toBe(true);
  });
  it("accounts for UTF-8/nested overhead and rejects oversized posts or unsafe counters", () => {
    expect(itemBytes({ content: ["বাংলা", null] })).toBeGreaterThan(Buffer.byteLength("contentবাংলা"));
    const input = fixture(); input.posts[0]!.content[0]!.content = "বাংলা".repeat(40000);
    expect(validateRecords(input).issues.some(issue => issue.code === "ITEM_TOO_LARGE")).toBe(true);
    const invalid = fixture(); invalid.posts[0]!.visited = Number.MAX_SAFE_INTEGER + 1;
    expect(validateRecords(invalid).issues).not.toHaveLength(0);
  });
  it("hashes object keys canonically while preserving array order", () => {
    expect(itemHash({ b: 2, a: ["one", "two"] })).toBe(itemHash({ a: ["one", "two"], b: 2 }));
    expect(itemHash({ a: ["one", "two"] })).not.toBe(itemHash({ a: ["two", "one"] }));
  });
});
describe("import and verification safety", () => {
  it("validates without a database or side effects", async () => {
    const data = backup(), target = new MemoryTarget();
    const result = await runMigration(data, newManifest("validate", data), target);
    expect(result.status).toBe("validated"); expect(target.inspect).not.toHaveBeenCalled(); expect(target.puts).toBe(0);
  });
  it("refuses all writes if any source record was rejected", async () => {
    const data = backup(), target = new MemoryTarget(); data.issues.push({ collection: "posts", code: "INVALID_RECORD" });
    expect((await runMigration(data, newManifest("import", data), target)).status).toBe("failed");
    expect(target.inspect).not.toHaveBeenCalled(); expect(target.puts).toBe(0);
  });
  it("resumes an interrupted import and skips identical records on rerun", async () => {
    const data = backup(), target = new MemoryTarget(), signal = new AbortController();
    const interrupted = await runMigration(data, newManifest("import", data), target, { signal: signal.signal, onProgress: manifest => { if (manifest.imported === 1) signal.abort(); } });
    expect(interrupted.status).toBe("interrupted"); expect(interrupted.imported).toBe(1);
    const resumed = await runMigration(data, newManifest("import", data), target);
    expect(resumed).toMatchObject({ status: "complete", imported: 2, matched: 1, missing: 0 });
    const repeated = await runMigration(data, newManifest("import", data), target);
    expect(repeated).toMatchObject({ status: "complete", imported: 0, matched: 3 });
    expect(target.puts).toBe(3);
  });
  it("fails preflight without overwriting edited records or adding any data", async () => {
    const data = backup(), target = new MemoryTarget();
    target.rows.set("posts", [{ ...data.records.find(record => record.collection === "posts")!.item, visited: 123 }]);
    const result = await runMigration(data, newManifest("import", data), target);
    expect(result.status).toBe("failed"); expect(target.puts).toBe(0);
    expect(result.issues).toContainEqual({ collection: "posts", id: post._id, code: "TARGET_CONFLICT", path: "visited" });
    expect(target.rows.get("posts")![0]!.visited).toBe(123);
  });
  it("compares a conditional-put race consistently and refuses conflicting content", async () => {
    const data = backup(), target = new MemoryTarget();
    target.put = async record => {
      target.rows.set(record.collection, [{ ...record.item, unexpected: true }]);
      throw Object.assign(new Error(), { name: "ConditionalCheckFailedException" });
    };
    const result = await runMigration(data, newManifest("import", data), target);
    expect(result.status).toBe("failed"); expect(result.imported).toBe(0);
    expect(result.issues.some(issue => issue.code === "TARGET_CONFLICT")).toBe(true);
  });
  it("requires missing records and unexpected jobs to be resolved", async () => {
    const data = backup(), target = new MemoryTarget();
    target.rows.set("jobs", [{ _id: "507f1f77bcf86cd799439099" }]);
    const result = await runMigration(data, newManifest("verify", data), target);
    expect(result).toMatchObject({ status: "failed", missing: 3, extras: 1 });
    expect(result.issues.some(issue => issue.code === "MISSING_TARGET_RECORD")).toBe(true);
    expect(target.puts).toBe(0);
  });
  it("does not swallow exhausted SDK errors or include exception details in reports", async () => {
    const data = backup(), target = new MemoryTarget();
    target.put = async () => { throw Object.assign(new Error("secret details"), { name: "ProvisionedThroughputExceededException" }); };
    const result = await runMigration(data, newManifest("import", data), target);
    expect(result.status).toBe("failed"); expect(JSON.stringify(result)).not.toContain("secret details");
    expect(result.issues.some(issue => issue.code === "ProvisionedThroughputExceededException")).toBe(true);
  });
});
describe("target identity and capacity checks", () => {
  const local = { accountId: "local", region: "us-east-1", stage: "recovery-local", endpoint: "http://127.0.0.1:8000" };
  it("requires explicit AWS account and isolated loopback local targets", () => {
    expect(() => validateTargetOptions(local)).not.toThrow();
    expect(() => validateTargetOptions({ ...local, endpoint: "https://example.com" })).toThrow("LOOPBACK");
    expect(() => validateTargetOptions({ ...local, stage: "dev" })).toThrow("ISOLATED");
    expect(() => validateTargetOptions({ ...local, accountId: "123456789012" })).toThrow("LOCAL_ACCOUNT");
    expect(() => validateTargetOptions({ ...local, endpoint: undefined })).toThrow("EXPLICIT_AWS_ACCOUNT");
    expect(() => validateTargetOptions({ ...local, writeUnitsPerSecond: -1 })).toThrow("WRITE_RATE");
  });
  it("refuses wrong schema or table ARN identity before writes", () => {
    const descriptor = { TableStatus: "ACTIVE" as const, KeySchema: [{ AttributeName: "_id", KeyType: "HASH" as const }], AttributeDefinitions: [{ AttributeName: "_id", AttributeType: "S" as const }] };
    expect(() => checkTable(descriptor, "posts", local)).not.toThrow();
    expect(() => checkTable(descriptor, "comments", local)).toThrow("SCHEMA");
    expect(() => checkTable({ ...descriptor, TableArn: "arn:aws:dynamodb:us-east-1:999999999999:table/batayan-serverless-recovery-posts" }, "posts", { accountId: "123456789012", region: "us-east-1", stage: "recovery" })).toThrow("IDENTITY");
  });
  it("paces by capacity units and responds to cancellation", async () => {
    vi.useFakeTimers();
    try {
      let complete = false;
      const waited = waitForUnits(10, 5).then(() => { complete = true; });
      await vi.advanceTimersByTimeAsync(1999); expect(complete).toBe(false);
      await vi.advanceTimersByTimeAsync(1); await waited; expect(complete).toBe(true);
      const controller = new AbortController(); controller.abort();
      await expect(waitForUnits(1, 1, controller.signal)).rejects.toThrow("INTERRUPTED");
    } finally { vi.useRealTimers(); }
  });
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
export type Document = { [key: string]: Value };
export type Collection = "users" | "posts" | "comments" | "series" | "jobs";
export const collections: Collection[] = ["users", "posts", "comments", "series", "jobs"];
export const transformVersion = "1";
export const sources = [
  { collection: "users", file: "batayan_users.json", count: 4, sha256: "3bbefc4902f1a0d626655ebe1c87066eb8a0392cb31cd9dbd4e63771597d5960" },
  { collection: "posts", file: "batayan_posts060326.json", count: 145, sha256: "5304347463a67f96fdb33dae275e06e522546923c6f22f013ba64acfcb2da137" },
  { collection: "comments", file: "batayan_comments_060326.json", count: 1344, sha256: "4fd15213c60e98e7723160eb38286400ee24eed1cb603d419095009f51568b63" }
] as const;
export type Issue = { collection: string; index?: number; id?: string; code: string; path?: string };
export class MigrationError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "MigrationError"; }
}
const id = z.string().regex(/^[a-f\d]{24}$/i);
const text = (max?: number) => max ? z.string().max(max) : z.string();
const date = z.string().datetime();
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Import schemas deliberately have no trim/coercion and retain embedded IDs/nulls.
const section = z.strictObject({
  _id: id, header: text(150).nullable().default(""), content: text().default(""),
  image: text().nullable().default(""), imgDescription: text(100).nullable().default(""),
  video: text().nullable().default(""), videoDescription: text(100).nullable().default("")
});
const post = z.strictObject({
  _id: id, title: text(100).min(1), postType: z.enum(["travel", "books", "miscl", "guest"]),
  gist: text(1000).default(""), createdAt: date, visited: counter.default(0), liked: counter.default(0),
  status: z.enum(["draft", "published", "archived"]).default("published"),
  photoHero: text().default("no-photo.jpg"), gallery: z.array(text()).default([]),
  content: z.array(section).default([]), searchBy: z.array(text()).default([]), additionalInfo: text().default(""),
  series: z.strictObject({ seriesId: id, part: counter.min(1) }).nullable().optional()
});
const comment = z.strictObject({
  _id: id, post: id, username: text(100).min(1), title: text(100),
  description: text(500).min(1), createdAt: date, reply: text(500).default("")
});
const user = z.strictObject({
  _id: id, name: text(100).min(1), email: z.string().trim().toLowerCase().pipe(z.email()),
  role: z.enum(["admin", "author", "guest", "user"]),
  password: z.string().regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/), createdAt: date
});
const schemas = { posts: post, comments: comment, users: user };

export function decodeExtended(value: unknown): Value {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MigrationError("INVALID_NUMBER");
    return value;
  }
  if (Array.isArray(value)) return value.map(decodeExtended);
  if (!value || typeof value !== "object") throw new MigrationError("INVALID_VALUE");
  const object = value as Record<string, unknown>, keys = Object.keys(object);
  if (keys.some(key => key.startsWith("$"))) {
    if (keys.length !== 1) throw new MigrationError("INVALID_EXTENDED_JSON");
    if ("$oid" in object) {
      const parsed = id.safeParse(object.$oid);
      if (!parsed.success) throw new MigrationError("INVALID_OBJECT_ID");
      return parsed.data;
    }
    if ("$date" in object) {
      let input = object.$date;
      if (input && typeof input === "object" && !Array.isArray(input)) {
        const wrapped = input as Record<string, unknown>;
        if (Object.keys(wrapped).length !== 1 || typeof wrapped.$numberLong !== "string" || !/^-?\d+$/.test(wrapped.$numberLong)) throw new MigrationError("INVALID_DATE");
        input = Number(wrapped.$numberLong);
        if (!Number.isSafeInteger(input)) throw new MigrationError("INVALID_DATE");
      } else if (typeof input === "string") {
        if (!z.iso.datetime({ offset: true }).safeParse(input).success) throw new MigrationError("INVALID_DATE");
      } else throw new MigrationError("INVALID_DATE");
      const result = new Date(input as number | string);
      if (!Number.isFinite(result.getTime())) throw new MigrationError("INVALID_DATE");
      return result.toISOString();
    }
    throw new MigrationError("UNSUPPORTED_EXTENDED_JSON");
  }
  return Object.fromEntries(keys.map(key => [key, decodeExtended(object[key])]));
}

export function canonical(value: Value): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export const itemHash = (item: Document) => sha256(canonical(item));
// Conservative upper bound: a DynamoDB number uses at most 21 bytes. Include
// UTF-8 attribute names, nested map/list overhead, and per-element overhead.
export function itemBytes(value: Value): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (typeof value === "number") return 21;
  if (value === null || typeof value === "boolean") return 1;
  if (Array.isArray(value)) return 3 + value.reduce<number>((sum, child) => sum + 1 + itemBytes(child), 0);
  return 3 + Object.entries(value).reduce((sum, [key, child]) => sum + Buffer.byteLength(key) + 1 + itemBytes(child), 0);
}
export type RecordToImport = { collection: "users" | "posts" | "comments"; id: string; index: number; item: Document; hash: string; bytes: number };
export type Backup = {
  records: RecordToImport[]; issues: Issue[];
  files: Array<{ file: string; collection: string; count: number; bytes: number; sha256: string }>;
  emailNormalizations: Array<{ userId: string; sourceIndex: number; originalHash: string; normalizedHash: string }>;
};
export function validateRecords(input: { users: unknown[]; posts: unknown[]; comments: unknown[] }): Omit<Backup, "files"> {
  const records: RecordToImport[] = [], issues: Issue[] = [], emailNormalizations: Backup["emailNormalizations"] = [];
  for (const collection of ["users", "posts", "comments"] as const) {
    const ids = new Set<string>(), emails = new Set<string>();
    for (const [index, raw] of input[collection].entries()) {
      let recordId: string | undefined;
      try {
        const decoded = decodeExtended(raw);
        if (decoded === null || Array.isArray(decoded) || typeof decoded !== "object") throw new MigrationError("INVALID_RECORD");
        if (typeof decoded._id === "string" && id.safeParse(decoded._id).success) recordId = decoded._id;
        const { __v, ...fields } = decoded;
        if (__v !== undefined && !counter.safeParse(__v).success) throw new MigrationError("INVALID_VERSION_METADATA");
        const parsed = schemas[collection].safeParse(fields);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) issues.push({ collection, index, id: recordId, code: issue.code, path: issue.path.join(".") });
          continue;
        }
        const item = JSON.parse(JSON.stringify(parsed.data)) as Document;
        const key = String(item._id);
        if (ids.has(key)) throw new MigrationError("DUPLICATE_ID");
        ids.add(key);
        if (collection === "users") {
          const email = String(item.email);
          if (emails.has(email)) throw new MigrationError("DUPLICATE_EMAIL");
          emails.add(email);
          if (fields.email !== email) emailNormalizations.push({ userId: key, sourceIndex: index, originalHash: sha256(String(fields.email)), normalizedHash: sha256(email) });
        }
        if (collection === "posts") {
          const sections = item.content as Document[];
          if (new Set(sections.map(s => s._id)).size !== sections.length) throw new MigrationError("DUPLICATE_SECTION_ID");
          if (item.series) throw new MigrationError("MISSING_SERIES_BACKUP");
        }
        const bytes = itemBytes(item);
        if (bytes > 400 * 1024) throw new MigrationError("ITEM_TOO_LARGE");
        records.push({ collection, id: key, index, item, hash: itemHash(item), bytes });
      } catch (error) {
        issues.push({ collection, index, id: recordId, code: error instanceof MigrationError ? error.code : "INVALID_RECORD" });
      }
    }
  }
  const posts = new Set(records.filter(record => record.collection === "posts").map(record => record.id));
  for (const record of records.filter(record => record.collection === "comments")) {
    if (!posts.has(String(record.item.post))) issues.push({ collection: "comments", id: record.id, index: record.index, code: "ORPHAN_COMMENT" });
  }
  return { records, issues, emailNormalizations };
}
export function loadBackup(directory: string): Backup {
  const input: { users: unknown[]; posts: unknown[]; comments: unknown[] } = { users: [], posts: [], comments: [] };
  const files: Backup["files"] = [], issues: Issue[] = [];
  for (const source of sources) {
    let buffer: Buffer;
    try { buffer = readFileSync(join(directory, source.file)); }
    catch { issues.push({ collection: source.collection, code: "SOURCE_READ_FAILED" }); continue; }
    const digest = sha256(buffer);
    if (digest !== source.sha256) issues.push({ collection: source.collection, code: "SOURCE_CHECKSUM_MISMATCH" });
    let data: unknown;
    try { data = JSON.parse(buffer.toString("utf8").replace(/^\uFEFF/, "")); }
    catch { issues.push({ collection: source.collection, code: "SOURCE_JSON_INVALID" }); continue; }
    if (!Array.isArray(data)) { issues.push({ collection: source.collection, code: "SOURCE_NOT_ARRAY" }); continue; }
    files.push({ file: source.file, collection: source.collection, count: data.length, bytes: buffer.length, sha256: digest });
    if (data.length !== source.count) issues.push({ collection: source.collection, code: "SOURCE_COUNT_MISMATCH" });
    input[source.collection] = data;
  }
  const validated = validateRecords(input);
  return { ...validated, issues: [...issues, ...validated.issues], files };
}

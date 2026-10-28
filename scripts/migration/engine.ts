import { collections, itemHash, MigrationError, transformVersion, type Backup, type Collection, type Document, type Issue, type RecordToImport } from "./backup.js";
import { abortIfNeeded, tableKeys, type MigrationTarget, type TargetOptions } from "./target.js";

export type Mode = "validate" | "import" | "verify";
export type Manifest = {
  transformVersion: string; mode: Mode; startedAt: string; finishedAt?: string;
  status: "running" | "validated" | "complete" | "failed" | "interrupted";
  target?: TargetOptions; files: Backup["files"]; emailNormalizations: Backup["emailNormalizations"];
  mappings: string[]; expected: Record<Collection, number>;
  imported: number; matched: number; rejected: number; missing: number; extras: number;
  issues: Issue[]; records: Array<{ collection: Collection; id: string; hash: string; bytes: number; outcome: string }>;
};
export function newManifest(mode: Mode, backup: Backup, target?: TargetOptions): Manifest {
  return {
    transformVersion, mode, startedAt: new Date().toISOString(), status: "running", target,
    files: backup.files, emailNormalizations: backup.emailNormalizations,
    mappings: ["ObjectId wrappers to unchanged strings", "Extended JSON dates to UTC ISO milliseconds", "Remove top-level __v", "Missing historical status to published", "Missing additionalInfo/reply to empty strings", "Canonicalize user email using trim/lowercase", "Preserve password hashes, legacy roles, explicit nulls and array order"],
    expected: Object.fromEntries(collections.map(collection => [collection, backup.files.find(file => file.collection === collection)?.count ?? backup.records.filter(record => record.collection === collection).length])) as Record<Collection, number>,
    imported: 0, matched: 0, rejected: backup.issues.length, missing: 0, extras: 0, issues: [...backup.issues],
    records: backup.records.map(record => ({ collection: record.collection, id: record.id, hash: record.hash, bytes: record.bytes, outcome: "pending" }))
  };
}
function key(collection: Collection, item: Document): string { return JSON.stringify(tableKeys[collection].map(field => item[field])); }
export function differingPaths(expected: unknown, actual: unknown, prefix = ""): string[] {
  if (Object.is(expected, actual)) return [];
  if (expected && actual && typeof expected === "object" && typeof actual === "object" && Array.isArray(expected) === Array.isArray(actual)) {
    const a = expected as Record<string, unknown>, b = actual as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(field => differingPaths(a[field], b[field], prefix ? `${prefix}.${field}` : field));
  }
  return [prefix || "<record>"];
}
async function compareTarget(backup: Backup, target: MigrationTarget, allowMissing: boolean, signal?: AbortSignal): Promise<{ issues: Issue[]; missing: number; extras: number; matched: number; matching: Set<string> }> {
  const issues: Issue[] = []; let missing = 0, extras = 0, matched = 0;
  const matching = new Set<string>();
  for (const collection of collections) {
    const pending = new Map(backup.records.filter(record => record.collection === collection).map(record => [key(collection, record.item), record]));
    for await (const item of target.scan(collection, signal)) {
      abortIfNeeded(signal);
      const record = pending.get(key(collection, item));
      if (!record) { extras++; issues.push({ collection, id: typeof item._id === "string" && /^[a-f\d]{24}$/i.test(item._id) ? item._id : undefined, code: "UNEXPECTED_TARGET_RECORD" }); continue; }
      pending.delete(key(collection, item));
      if (itemHash(item) !== record.hash) {
        for (const path of differingPaths(record.item, item)) issues.push({ collection, id: record.id, code: "TARGET_CONFLICT", path });
      } else { matched++; matching.add(`${collection}:${record.id}`); }
    }
    missing += pending.size;
    if (!allowMissing) for (const record of pending.values()) issues.push({ collection, id: record.id, code: "MISSING_TARGET_RECORD" });
  }
  return { issues, missing, extras, matched, matching };
}
export type RunOptions = { signal?: AbortSignal; checkpoint?: (manifest: Manifest) => void; onProgress?: (manifest: Manifest) => void };
export async function runMigration(backup: Backup, manifest: Manifest, target?: MigrationTarget, options: RunOptions = {}): Promise<Manifest> {
  const checkpoint = () => options.checkpoint?.(manifest);
  try {
    checkpoint();
    if (backup.issues.length) throw new MigrationError("BACKUP_VALIDATION_FAILED");
    abortIfNeeded(options.signal);
    if (manifest.mode === "validate") { manifest.status = "validated"; return manifest; }
    if (!target) throw new MigrationError("TARGET_REQUIRED");
    await target.inspect();
    const comparison = await compareTarget(backup, target, manifest.mode === "import", options.signal);
    manifest.issues.push(...comparison.issues); manifest.extras = comparison.extras; manifest.missing = comparison.missing;
    if (comparison.issues.length) throw new MigrationError("TARGET_VERIFICATION_FAILED");
    if (manifest.mode === "verify") {
      manifest.matched = comparison.matched;
      for (const record of manifest.records) record.outcome = "verified";
    } else {
      for (const [index, record] of backup.records.entries()) {
        abortIfNeeded(options.signal);
        try {
          if (comparison.matching.has(`${record.collection}:${record.id}`)) {
            manifest.matched++; manifest.records[index]!.outcome = "matched";
          } else {
            await target.put(record, options.signal); manifest.imported++; manifest.records[index]!.outcome = "imported";
          }
        }
        catch (error) {
          if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
          const existing = await target.get(record);
          if (!existing || itemHash(existing) !== record.hash) {
            manifest.issues.push({ collection: record.collection, id: record.id, code: "TARGET_CONFLICT" });
            throw new MigrationError("TARGET_CONFLICT");
          }
          manifest.matched++; manifest.records[index]!.outcome = "matched";
        }
        manifest.missing = Math.max(0, comparison.missing - manifest.imported);
        if ((index + 1) % 25 === 0) checkpoint();
        options.onProgress?.(manifest);
      }
      // A final consistent-read comparison detects missed writes and unexpected
      // records, including series/jobs that should be empty in this recovery.
      const verified = await compareTarget(backup, target, false, options.signal);
      manifest.issues.push(...verified.issues); manifest.missing = verified.missing; manifest.extras = verified.extras;
      if (verified.issues.length) throw new MigrationError("FINAL_VERIFICATION_FAILED");
    }
    manifest.status = "complete";
  } catch (error) {
    const code = options.signal?.aborted ? "INTERRUPTED" : error instanceof MigrationError ? error.code : error instanceof Error ? error.name : "MIGRATION_FAILED";
    manifest.status = code === "INTERRUPTED" ? "interrupted" : "failed";
    manifest.issues.push({ collection: "migration", code });
  } finally {
    manifest.rejected = manifest.issues.length;
    manifest.finishedAt = new Date().toISOString();
    target?.close();
    checkpoint();
  }
  return manifest;
}

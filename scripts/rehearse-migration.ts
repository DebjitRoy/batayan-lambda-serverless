import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CreateTableCommand, DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { collections, itemHash, loadBackup, type Document } from "./migration/backup.js";
import { newManifest, runMigration, type Manifest, type Mode } from "./migration/engine.js";
import { privateReportWriter } from "./migration/report.js";
import { DynamoTarget, tableKeys, type TargetOptions } from "./migration/target.js";

export async function main(): Promise<number> {
  // The rehearsal cannot target AWS or the API's dev/prod tables.
  const stage = `rehearsal-${Date.now()}`, scratchStage = `conflict-${Date.now()}`;
  const options: TargetOptions = { accountId: "local", region: "us-east-1", stage, endpoint: "http://127.0.0.1:8000" };
  const scratch = { ...options, stage: scratchStage };
  const reportDirectory = `migration-reports/${stage}`;
  const backup = loadBackup("src/migration");
  async function run(mode: Mode, filename: string, targetOptions = options, signal?: AbortSignal, onProgress?: (manifest: Manifest) => void) {
    const manifest = newManifest(mode, backup, mode === "validate" ? undefined : targetOptions);
    return runMigration(backup, manifest, mode === "validate" ? undefined : new DynamoTarget(targetOptions), { signal, onProgress, checkpoint: privateReportWriter(`${reportDirectory}/${filename}.json`) });
  }
  async function createTables(targetOptions: TargetOptions) {
    const target = new DynamoTarget(targetOptions);
    try {
      for (const collection of collections) await target.raw.send(new CreateTableCommand({
        TableName: target.table(collection), BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: tableKeys[collection].map(AttributeName => ({ AttributeName, AttributeType: "S" })),
        KeySchema: tableKeys[collection].map((AttributeName, index) => ({ AttributeName, KeyType: index === 0 ? "HASH" : "RANGE" }))
      }));
    } finally { target.close(); }
  }
  try {
    const validated = await run("validate", "01-validation");
    assert.equal(validated.status, "validated"); assert.deepEqual(validated.expected, { users: 4, posts: 145, comments: 1344, series: 0, jobs: 0 });
    await createTables(options);
    const controller = new AbortController();
    const interrupted = await run("import", "02-interrupted", options, controller.signal, manifest => { if (manifest.imported === 37) controller.abort(); });
    assert.equal(interrupted.status, "interrupted"); assert.equal(interrupted.imported, 37);
    console.log("Interruption checkpoint passed: 37 records written.");
    const resumed = await run("import", "03-resumed");
    assert.equal(resumed.status, "complete"); assert.equal(resumed.imported, 1456); assert.equal(resumed.matched, 37);
    const repeated = await run("import", "04-rerun");
    assert.equal(repeated.status, "complete"); assert.equal(repeated.imported, 0); assert.equal(repeated.matched, 1493);
    assert.deepEqual(repeated.records.map(r => r.hash), resumed.records.map(r => r.hash));
    const verified = await run("verify", "05-verification");
    assert.equal(verified.status, "complete"); assert.equal(verified.matched, 1493); assert.equal(verified.missing, 0); assert.equal(verified.extras, 0);
    console.log("Resume, identical rerun, and all-record verification passed.");

    await createTables(scratch);
    const target = new DynamoTarget(scratch);
    try {
      const source = backup.records.find(record => record.collection === "posts")!;
      const changed = { ...source.item, visited: Number(source.item.visited) + 1 };
      await target.document.send(new PutCommand({ TableName: target.table("posts"), Item: changed }));
      const conflict = await run("import", "06-conflict-refused", scratch);
      assert.equal(conflict.status, "failed"); assert.equal(conflict.imported, 0);
      assert(conflict.issues.some(issue => issue.code === "TARGET_CONFLICT"));
      const stored = await target.document.send(new GetCommand({ TableName: target.table("posts"), Key: { _id: source.id }, ConsistentRead: true }));
      assert.equal(itemHash(stored.Item as Document), itemHash(changed));
      // These explicit changes affect only this freshly created local fixture.
      await target.document.send(new DeleteCommand({ TableName: target.table("posts"), Key: { _id: source.id } }));
      await target.document.send(new PutCommand({ TableName: target.table("jobs"), Item: { _id: randomBytes(12).toString("hex"), status: "pending" } }));
      const extra = await run("import", "07-extra-refused", scratch);
      assert.equal(extra.status, "failed"); assert.equal(extra.imported, 0); assert.equal(extra.extras, 1);
      console.log("Edited-record and unexpected-job refusal passed; no conflicting record overwritten.");
    } finally {
      for (const collection of collections) await target.raw.send(new DeleteTableCommand({ TableName: target.table(collection) }));
      target.close();
    }
    console.log(`Phase 2 rehearsal passed. Verified local stage: ${stage}`);
    console.log(`Private manifests: ${reportDirectory}`);
    return 0;
  } catch (error) {
    console.error(`Rehearsal failed (${error instanceof Error ? error.name : "error"}); inspect private manifests under ${reportDirectory}.`);
    return 1;
  }
}

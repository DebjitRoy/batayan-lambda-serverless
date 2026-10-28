import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { CreateTableCommand } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { collections, itemHash, loadBackup, type Document, type RecordToImport } from "./migration/backup.js";
import { newManifest, runMigration } from "./migration/engine.js";
import { privateReportWriter } from "./migration/report.js";
import { DynamoTarget, tableKeys } from "./migration/target.js";

type Body = Record<string, any>;
type Check = { name: string; status: "passed" | "failed" | "pending"; error?: string };
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0;
export async function main(): Promise<number> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const stage = `acceptance-${Date.now()}`, base = "http://localhost:4200";
  const target = new DynamoTarget({ accountId: "local", region: "us-east-1", stage, endpoint: "http://127.0.0.1:8000" });
  const backup = loadBackup("src/migration");
  const checks: Check[] = [], timings: Array<{ route: string; ms: number }> = [], visits = new Map<string, number>();
  const report = { startedAt: new Date().toISOString(), finishedAt: "", stage, base, status: "running", coreHttpStatus: "running", failure: "", loginFailure: "", checks, timings, metrics: {} as Body, migratedLogin: "pending-credentials", s3: "mocked-in-integration-suite; real-bucket-tests-separate", logsContainSecrets: false };
  const writeReport = privateReportWriter<typeof report>("migration-reports/phase3-local.json");
  let child: ChildProcess | undefined, log = "", token = "";
  const syntheticUsers: string[] = [], syntheticPosts = new Set<string>(), syntheticComments: Array<{ post: string; _id: string }> = [], syntheticSeries = new Set<string>(), jobs = new Set<string>();
  async function check(name: string, fn: () => Promise<void | "pending">) {
    try {
      const pending = await fn() === "pending";
      checks.push({ name, status: pending ? "pending" : "passed" }); console.log(`${pending ? "Pending" : "Passed"}: ${name}`);
    }
    catch (error) { checks.push({ name, status: "failed", error: error instanceof Error ? error.name : "Error" }); throw error; }
  }
  async function request(method: string, path: string, data?: unknown, expected = 200, authenticated = true): Promise<Body> {
    const started = performance.now();
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(authenticated && token ? { authorization: `Bearer ${token}` } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(20000) });
    const value = await response.json() as Body;
    timings.push({ route: `${method} ${path.split("?")[0]!.replace(/[a-f\d]{24}/g, "{id}")}`, ms: performance.now() - started });
    if (response.status !== expected) throw new Error(`HTTP_${response.status}_EXPECTED_${expected}`);
    return value;
  }
  const sourcePosts = backup.records.filter(record => record.collection === "posts");
  const id = () => randomBytes(12).toString("hex");
  async function cleanupSynthetic() {
    for (const key of syntheticComments) await target.document.send(new DeleteCommand({ TableName: target.table("comments"), Key: key }));
    for (const post of syntheticPosts) await target.document.send(new DeleteCommand({ TableName: target.table("posts"), Key: { _id: post } }));
    for (const seriesId of syntheticSeries) {
      // Only records in series created by this run are removed.
      const rows: Document[] = []; for await (const row of target.scan("series")) if (row.seriesId === seriesId) rows.push(row);
      for (const row of rows) await target.document.send(new DeleteCommand({ TableName: target.table("series"), Key: { seriesId, recordKey: row.recordKey } }));
    }
    for (const email of syntheticUsers) await target.document.send(new DeleteCommand({ TableName: target.table("users"), Key: { email } }));
    for (const job of jobs) await target.document.send(new DeleteCommand({ TableName: target.table("jobs"), Key: { _id: job } }));
    syntheticComments.length = 0; syntheticPosts.clear(); syntheticSeries.clear(); syntheticUsers.length = 0; jobs.clear();
  }
  try {
    assert.equal(backup.issues.length, 0);
    try { await fetch(target.options.endpoint!, { signal: AbortSignal.timeout(1500) }); }
    catch { throw new Error("DYNAMODB_LOCAL_UNAVAILABLE"); }
    try { await fetch(`${base}/api/posts`, { signal: AbortSignal.timeout(500) }); throw new Error("ACCEPTANCE_PORT_IN_USE"); }
    catch (error) { if (error instanceof Error && error.message === "ACCEPTANCE_PORT_IN_USE") throw error; }
    for (const collection of collections) await target.raw.send(new CreateTableCommand({ TableName: target.table(collection), BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: tableKeys[collection].map(AttributeName => ({ AttributeName, AttributeType: "S" })), KeySchema: tableKeys[collection].map((AttributeName, index) => ({ AttributeName, KeyType: index === 0 ? "HASH" : "RANGE" })) }));
    await check("restore and verify all 1,493 backup records before HTTP testing", async () => {
      const manifest = await runMigration(backup, newManifest("import", backup, target.options), new DynamoTarget(target.options), { checkpoint: privateReportWriter(`migration-reports/${stage}-restore.json`) });
      assert.equal(manifest.status, "complete"); assert.equal(manifest.imported, 1493);
    });
    await target.inspect();
    child = spawn(process.execPath, ["node_modules/serverless/run.js", "offline", `--stage=${stage}`, "--httpPort=4200", "--lambdaPort=4202"], {
      stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
      env: { ...process.env, AWS_ACCESS_KEY_ID: "local", AWS_SECRET_ACCESS_KEY: "local", AWS_SESSION_TOKEN: "", AWS_REGION: "us-east-1", DYNAMODB_ENDPOINT: target.options.endpoint!, LAMBDA_ENDPOINT: "http://localhost:4202", JWT_SECRET: randomBytes(32).toString("hex"), S3_BUCKET: "synthetic-test", S3_PUBLIC_BASE_URL: "https://example.invalid", OPENAI_API_KEY: "" }
    });
    child.stdout!.on("data", chunk => { log += String(chunk); }); child.stderr!.on("data", chunk => { log += String(chunk); });
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error("ACCEPTANCE_SERVER_EXITED");
      try { const response = await fetch(`${base}/api/posts?limit=1`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { ready = true; break; } } catch {}
      await sleep(500);
    }
    assert(ready, "Acceptance server did not start");
    await check("restored lists: all sort orders, exact totals, page boundaries, status and literal search", async () => {
      for (const field of ["createdAt", "title", "visited", "liked"]) for (const order of ["asc", "desc"]) {
        const expected = [...sourcePosts].sort((a, b) => {
          const x = a.item[field]!, y = b.item[field]!;
          const compared = typeof x === "string" && typeof y === "string" ? Buffer.compare(Buffer.from(x), Buffer.from(y)) : x < y ? -1 : x > y ? 1 : 0;
          return (order === "asc" ? compared : -compared) || a.id.localeCompare(b.id);
        });
        const list = await request("GET", `/api/posts?sortBy=${field}&sortOrder=${order}&page=2&limit=7&status=published`);
        assert.equal(list.total, 145); assert.equal(list.totalPages, 21);
        assert.deepEqual(list.items.map((post: Body) => post._id), expected.slice(7, 14).map(record => record.id));
      }
      assert.equal((await request("GET", "/api/posts?page=100&limit=10")).items.length, 0);
      assert.equal((await request("GET", "/api/posts?status=draft")).total, 0);
      assert.equal((await request("GET", "/api/posts?status=archived")).total, 0);
      const actualTag = sourcePosts.flatMap(record => record.item.searchBy as string[]).find(value => /[\u0980-\u09ff]/.test(value)) ?? "বাংলা";
      for (const search of [actualTag, actualTag.slice(0, 2), ".*", "A.B", "BOOKS"]) {
        const expected = sourcePosts.filter(record => (record.item.searchBy as string[]).some(tag => tag.toLowerCase().includes(search.toLowerCase()))).length;
        assert.equal((await request("GET", `/api/posts?search=${encodeURIComponent(search)}`)).total, expected);
      }
    });
    await check("legacy post/section IDs, nulls, Unicode and comment envelopes are preserved", async () => {
      for (const record of sourcePosts.slice(0, 3)) {
        const result = await request("GET", `/api/posts/${record.id}`); visits.set(record.id, (visits.get(record.id) ?? 0) + 1);
        assert.deepEqual(result.content, record.item.content); assert.equal(result.visited, Number(record.item.visited) + visits.get(record.id)!);
        assert.equal(result._version, undefined); assert.equal(result.isSeries, false);
      }
      const parent = String(backup.records.find(record => record.collection === "comments")!.item.post);
      const expected = backup.records.filter(record => record.collection === "comments" && record.item.post === parent).sort((a, b) => String(b.item.createdAt).localeCompare(String(a.item.createdAt)) || a.id.localeCompare(b.id));
      const list = await request("GET", `/api/posts/${parent}/comments`);
      assert.deepEqual(list.items, expected.map(record => record.item));
      assert.deepEqual(await request("GET", `/api/posts/${parent}/comments/${expected[0]!.id}`), expected[0]!.item);
    });
    try { await check("known migrated-user login, when private test credentials are available", async () => {
      const email = process.env.MIGRATION_TEST_EMAIL, password = process.env.MIGRATION_TEST_PASSWORD;
      const legacy = backup.records.find(record => record.collection === "users" && record.item.email === email?.trim().toLowerCase());
      if (!email || !password) { report.migratedLogin = "pending-credentials"; return "pending"; }
      if (!legacy) throw new Error("MIGRATION_TEST_EMAIL_NOT_IN_BACKUP");
      const result = await request("POST", "/api/auth/login", { email, password }, 200, false);
      assert.equal(result.user.id, legacy.id); assert.equal(result.user.role, legacy.item.role); assert.equal(result.user.password, undefined);
      await request("POST", "/api/auth/login", { email, password: `invalid-${randomBytes(32).toString("hex")}` }, 401, false);
      report.migratedLogin = "passed";
    }); } catch (error) {
      report.migratedLogin = "failed";
      report.loginFailure = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "MIGRATED_LOGIN_CHECK_FAILED";
      console.error(`Migrated-user login failed (${report.loginFailure}); continuing independent HTTP checks.`);
    }
    await check("synthetic authentication and all post/series/comment mutation routes", async () => {
      const email = `acceptance-${Date.now()}@example.com`, password = "synthetic-acceptance-password";
      syntheticUsers.push(email);
      const registered = await request("POST", "/api/auth/register", { name: "Acceptance", email, password }, 201, false); token = registered.token;
      assert.equal(registered.user.password, undefined); assert((await request("POST", "/api/auth/login", { email, password })).token);
      await request("POST", "/api/auth/register", { name: "Duplicate", email, password }, 409);
      await request("POST", "/api/posts", { title: "Unauthorized", postType: "books" }, 401, false);
      await request("POST", "/api/posts", { title: "Invalid", postType: "unknown" }, 400);
      await request("GET", "/api/posts/not-an-id", undefined, 400);
      await request("GET", `/api/posts/${id()}`, undefined, 404);
      const group = await request("POST", "/api/series", { title: "Acceptance walks" }, 201); syntheticSeries.add(group._id);
      const post = await request("POST", "/api/posts", { title: "Acceptance", postType: "travel", searchBy: ["keep-me"], series: { seriesId: group._id, part: 1 } }, 201); syntheticPosts.add(post._id);
      const second = await request("POST", "/api/posts", { title: "Part two", postType: "travel", series: { seriesId: group._id, part: 2 } }, 201); syntheticPosts.add(second._id);
      await request("POST", "/api/posts", { title: "Duplicate part", postType: "travel", series: { seriesId: group._id, part: 1 } }, 409);
      const updated = await request("PUT", `/api/posts/${post._id}`, { gist: "Changed" }); assert.deepEqual(updated.searchBy, ["keep-me"]);
      await request("PUT", `/api/posts/${post._id}/status`, { status: "archived" });
      assert.equal((await request("GET", "/api/posts?status=archived")).total, 1);
      assert.equal((await request("GET", "/api/posts?expanded=false")).total, 146);
      assert.equal((await request("GET", "/api/posts?expanded=true")).total, 147);
      assert.equal((await request("GET", `/api/series/${group._id}`)).totalParts, 2);
      await request("PUT", `/api/series/${group._id}`, { description: "Updated" });
      assert.equal((await request("GET", "/api/series?search=walk")).total, 1);
      await request("DELETE", `/api/series/${group._id}`, undefined, 409);
      const comment = await request("POST", `/api/posts/${post._id}/comments`, { username: "Reader", title: "Note", description: "Synthetic" }, 201);
      syntheticComments.push({ post: post._id, _id: comment._id });
      await request("PUT", `/api/posts/${post._id}/comments/${comment._id}`, { title: "Edited" });
      await request("PUT", `/api/posts/${post._id}/comments/${comment._id}/reply`, { reply: "Thanks" }, 401, false);
      await request("PUT", `/api/posts/${post._id}/comments/${comment._id}/reply`, { reply: "Thanks" });
      await request("GET", `/api/posts/${second._id}/comments/${comment._id}`, undefined, 404);
      await request("DELETE", `/api/posts/${post._id}/comments/${comment._id}`); syntheticComments.length = 0;
      for (const postId of syntheticPosts) await request("DELETE", `/api/posts/${postId}`); syntheticPosts.clear();
      await request("DELETE", `/api/series/${group._id}`); syntheticSeries.clear();
    });
    await check("real asynchronous local summary/grammar dispatch and failure polling", async () => {
      for (const [path, payload] of [["summary", { content: "Synthetic content" }], ["grammer-check", { sections: [{ id: "s1", text: "বাংলা" }] }]] as const) {
        const created = await request("POST", `/api/${path}`, payload, 202); jobs.add(created.jobId);
        let value: Body = {};
        for (let attempt = 0; attempt < 60; attempt++) { value = await request("GET", `/api/worker/${created.jobId}`); if (value.status === "failed") break; await sleep(100); }
        assert.equal(value.status, "failed"); assert.match(value.error, /OPENAI_API_KEY/); assert.equal(value.jobId, value.workId);
        await request("GET", `/api/grammer-check/${created.jobId}`);
        await request("GET", `/api/worker/${created.jobId}`, undefined, 401, false);
      }
    });
    await cleanupSynthetic();
    await check("concurrent restored-post reads increment counters without lost updates", async () => {
      const record = sourcePosts[0]!, before = visits.get(record.id) ?? 0;
      const results = await Promise.all(Array.from({ length: 12 }, () => request("GET", `/api/posts/${record.id}`)));
      visits.set(record.id, before + 12);
      assert.equal(new Set(results.map(value => value.visited)).size, 12);
      assert.equal(Math.max(...results.map(value => value.visited)), Number(record.item.visited) + before + 12);
    });
    await check("warm list latency at concurrency four and actual scan capacity are measured", async () => {
      const durations: number[] = [];
      for (let batch = 0; batch < 5; batch++) await Promise.all(Array.from({ length: 4 }, async () => { const start = performance.now(); const value = await request("GET", "/api/posts?limit=10"); assert.equal(value.total, 145); durations.push(performance.now() - start); }));
      let key: Record<string, unknown> | undefined, units = 0, pages = 0;
      do { const result = await target.document.send(new ScanCommand({ TableName: target.table("posts"), ConsistentRead: true, ExclusiveStartKey: key, ReturnConsumedCapacity: "TOTAL" })); key = result.LastEvaluatedKey; units += result.ConsumedCapacity?.CapacityUnits ?? 0; pages++; } while (key);
      const expectedRate = Number(process.env.MIGRATION_EXPECTED_LIST_REQUESTS_PER_MINUTE);
      const productionPostsRcu = 15;
      const expectedScanRcu = Number.isFinite(expectedRate) && expectedRate > 0 ? expectedRate * units / 60 : null;
      report.metrics = { requests: durations.length, concurrency: 4, p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), listP95TargetMs: 1000, listLatencyPass: percentile(durations, 0.95) <= 1000, strongScanReadUnits: units, scanPages: pages, productionPostsRcu, approximateSustainedListRequestsPerMinute: units ? productionPostsRcu * 60 / units : null, expectedListRequestsPerMinute: expectedScanRcu === null ? null : expectedRate, expectedScanRcu, scanCapacityBudgetPass: expectedScanRcu === null ? null : expectedScanRcu <= productionPostsRcu, scope: "local latency and catalog read-capacity estimate; other reads, real AWS burst latency and account cost not established" };
      assert.equal(report.metrics.listLatencyPass, true, "Local list p95 exceeded the agreed target");
      if (report.metrics.scanCapacityBudgetPass === false) throw new Error("EXPECTED_LIST_TRAFFIC_EXCEEDS_POSTS_READ_CAPACITY");
    });
    await check("backup content is unchanged except explicitly counted visit increments", async () => {
      let verified = 0;
      for (const collection of collections) {
        const expected = backup.records.filter(record => record.collection === collection);
        const actual: Document[] = []; for await (const row of target.scan(collection)) actual.push(row);
        assert.equal(actual.length, expected.length);
        for (const source of expected) {
          const row = actual.find(item => item._id === source.id)!; assert(row);
          if (collection === "posts" && visits.has(source.id)) {
            assert.equal(row.visited, Number(source.item.visited) + visits.get(source.id)!); assert.equal(row._version, visits.get(source.id)!);
            delete row._version; row.visited = source.item.visited!;
          }
          assert.equal(itemHash(row), source.hash); verified++;
        }
      }
      assert.equal(verified, 1493);
    });
    await check("server logs do not contain passwords, hashes or bearer tokens", async () => {
      const secrets = [token, process.env.MIGRATION_TEST_PASSWORD, "synthetic-acceptance-password", ...backup.records.filter(record => record.collection === "users").map(record => String(record.item.password))].filter((value): value is string => Boolean(value));
      report.logsContainSecrets = secrets.some(secret => log.includes(secret)); assert.equal(report.logsContainSecrets, false);
    });
    report.coreHttpStatus = "passed";
    report.status = report.migratedLogin === "failed" ? "failed" : "passed";
    if (report.migratedLogin === "failed") report.failure = report.loginFailure;
  } catch (error) {
    report.status = "failed";
    report.coreHttpStatus = "failed";
    report.failure = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : error instanceof Error ? error.name : "Error";
    console.error(`Local acceptance failed (${report.failure}); see the private report.`);
    if (report.failure === "DYNAMODB_LOCAL_UNAVAILABLE") console.error("Run npm run db:local:start in a separate terminal first.");
  } finally {
    try { await cleanupSynthetic(); } catch { checks.push({ name: "synthetic cleanup", status: "failed" }); report.status = "failed"; report.coreHttpStatus = "failed"; }
    if (child?.pid && child.exitCode === null) {
      try { if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); else process.kill(-child.pid, "SIGTERM"); } catch {}
    }
    target.close(); report.finishedAt = new Date().toISOString(); writeReport(report);
  }
  console.log(`Phase 3 local acceptance: ${report.status}. Private report: migration-reports/phase3-local.json`);
  console.log(`Migrated-user login: ${report.migratedLogin}. Isolated local stage: ${stage}`);
  return report.status === "passed" ? 0 : 1;
}

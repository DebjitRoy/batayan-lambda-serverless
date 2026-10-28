import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildSync } from "esbuild";
import { zipSync } from "fflate";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { privateReportWriter } from "./migration/report.js";
import { collections, type Collection } from "./migration/backup.js";
import { tableKeys } from "./migration/target.js";

export async function main(argv: string[]): Promise<number> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    if (!["--account-id", "--region", "--bucket"].includes(argv[index]!) || !argv[index + 1]) throw new Error("Use --account-id, --region, and --bucket.");
    flags.set(argv[index]!, argv[index + 1]!);
  }
  const account = flags.get("--account-id"), region = flags.get("--region"), bucket = flags.get("--bucket");
  if (!account || !/^\d{12}$/.test(account) || region !== "us-east-1" || !bucket || !/^[a-z0-9.-]+$/.test(bucket)) { console.error("Provide the explicit account, us-east-1 Region, and existing test bucket."); return 1; }
  const stage = `batayan-phase3-${Date.now()}`, prefix = `migration-tests/${stage}`;
  const report = { startedAt: new Date().toISOString(), finishedAt: "", status: "running", account, region, bucket, stage, prefix, testBudgetUsd: 0.25, syntheticDataOnly: true, checks: [] as string[], cleanup: "pending", failure: "" };
  const save = privateReportWriter<typeof report>("migration-reports/phase3-aws.json"); save(report);
  const s3 = new S3Client({ region, maxAttempts: 3 }), lambda = new LambdaClient({ region, maxAttempts: 3 }), sts = new STSClient({ region });
  const keys: string[] = [];
  let stackAttempted = false;
  const cli = (args: string[], timeout = 900000) => execFileSync("aws", [...args, "--region", region], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout });
  async function invoke(action: string, data: Record<string, unknown> = {}) {
    const result = await lambda.send(new InvokeCommand({ FunctionName: `${stage}-api`, Payload: Buffer.from(JSON.stringify({ action, ...data })) }));
    const value = JSON.parse(Buffer.from(result.Payload!).toString("utf8"));
    if (result.FunctionError) throw new Error(`SMOKE_LAMBDA_${value.errorType ?? "ERROR"}`);
    return value;
  }
  try {
    assert.equal((await sts.send(new GetCallerIdentityCommand({}))).Account, account);
    report.checks.push("AWS caller account verified");
    mkdirSync(".local/phase3-aws", { recursive: true });
    const bundle = resolve(".local/phase3-aws/index.js");
    buildSync({ entryPoints: ["scripts/aws-smoke-handler.ts"], outfile: bundle, bundle: true, platform: "node", target: "node22", format: "cjs", minify: true });
    const assetKey = `${prefix}/lambda.zip`; keys.push(assetKey);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: assetKey, Body: zipSync({ "index.js": readFileSync(bundle) }), ContentType: "application/zip" }));
    const resources: Record<string, unknown> = {};
    const refs: Record<string, unknown> = {};
    for (const collection of collections) {
      const logical = `${collection}Table`;
      resources[logical] = { Type: "AWS::DynamoDB::Table", Properties: { TableName: `${stage}-${collection}`, AttributeDefinitions: tableKeys[collection].map(AttributeName => ({ AttributeName, AttributeType: "S" })), KeySchema: tableKeys[collection].map((AttributeName, index) => ({ AttributeName, KeyType: index === 0 ? "HASH" : "RANGE" })), ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 } } };
      refs[`${collection.toUpperCase()}_TABLE`] = { Ref: logical };
    }
    const environment = { ...refs, JWT_SECRET: randomBytes(32).toString("hex"), S3_BUCKET: bucket, S3_PUBLIC_BASE_URL: `https://${bucket}.s3.amazonaws.com`, OPENAI_API_KEY: "", BACKGROUND_JOB_WORKER_FUNCTION_NAME: `${stage}-worker`, DYNAMODB_ENDPOINT: "" };
    resources.ExecutionRole = { Type: "AWS::IAM::Role", Properties: {
      AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] },
      Policies: [{ PolicyName: "isolated-smoke", PolicyDocument: { Version: "2012-10-17", Statement: [
        { Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:Query", "dynamodb:ConditionCheckItem"], Resource: collections.map(collection => ({ "Fn::GetAtt": [`${collection}Table`, "Arn"] })) },
        { Effect: "Allow", Action: ["s3:PutObject", "s3:PutObjectAcl"], Resource: `arn:aws:s3:::${bucket}/${prefix}/*` },
        { Effect: "Allow", Action: "lambda:InvokeFunction", Resource: `arn:aws:lambda:${region}:${account}:function:${stage}-worker` },
        { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: `arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${stage}-*:*` }
      ] } }]
    } };
    for (const [name, handler] of [["api", "index.handler"], ["worker", "index.worker"]]) {
      resources[`${name}LogGroup`] = { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: `/aws/lambda/${stage}-${name}`, RetentionInDays: 1 } };
      resources[`${name}Function`] = { Type: "AWS::Lambda::Function", DependsOn: `${name}LogGroup`, Properties: { FunctionName: `${stage}-${name}`, Runtime: "nodejs22.x", Handler: handler, Role: { "Fn::GetAtt": ["ExecutionRole", "Arn"] }, Timeout: 30, MemorySize: 256, Environment: { Variables: environment }, Code: { S3Bucket: bucket, S3Key: assetKey } } };
    }
    const template = resolve(`migration-reports/${stage}-template.json`);
    writeFileSync(template, JSON.stringify({ AWSTemplateFormatVersion: "2010-09-09", Resources: resources }), { mode: 0o600 });
    console.log(`Creating temporary AWS smoke stack ${stage}; synthetic data only, test budget $0.25.`);
    stackAttempted = true;
    cli(["cloudformation", "deploy", "--stack-name", stage, "--template-file", template, "--capabilities", "CAPABILITY_IAM", "--tags", "Purpose=BatayanPhase3SyntheticTest"]);
    report.checks.push("isolated Lambda role and provisioned DynamoDB tables deployed"); save(report);
    const email = `${stage}@example.com`;
    const registered = await invoke("register", { email }); assert.equal(registered.statusCode, 201);
    assert.equal((await invoke("login", { email })).statusCode, 200);
    const post = await invoke("create"); const visited = await invoke("visit", { postId: post._id }); assert.equal(visited.visited, 1);
    await invoke("delete", { postId: post._id });
    report.checks.push("actual Lambda auth, DynamoDB transaction CRUD, counter updates and IAM passed");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZmkAAAAASUVORK5CYII=", "base64");
    const directKey = `${prefix}/direct.png`; keys.push(directKey);
    const direct = await invoke("upload", { key: directKey, dataBase64: png.toString("base64") });
    assert.equal((await fetch(direct.imageUrl, { method: "HEAD" })).status, 200, "DIRECT_UPLOAD_NOT_PUBLIC");
    report.checks.push("actual direct S3 upload is publicly readable"); save(report);
    const signedKey = `${prefix}/presigned.png`; keys.push(signedKey);
    const signed = await invoke("presign", { key: signedKey });
    assert.equal((await fetch(signed.uploadUrl, { method: "PUT", headers: { "content-type": "image/png" }, body: png })).status, 200, "PRESIGNED_PUT_FAILED");
    assert.equal((await fetch(signed.imageUrl, { method: "HEAD" })).status, 200, "PRESIGNED_UPLOAD_NOT_PUBLIC");
    report.checks.push("actual presigned S3 upload is publicly readable"); save(report);
    const created = await invoke("enqueue");
    let job;
    for (let attempt = 0; attempt < 30; attempt++) { job = await invoke("poll", { jobId: created.jobId }); if (job?.status === "failed") break; await sleep(1000); }
    assert.equal(job?.status, "failed"); assert.match(job.error, /OPENAI_API_KEY/);
    report.checks.push("actual asynchronous Lambda invocation and job polling passed; paid AI disabled");
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.failure = error instanceof Error ? error.message.slice(0, 200) : "AWS_SMOKE_FAILED";
    console.error(`AWS smoke failed (${error instanceof Error ? error.name : "Error"}); inspect the private report.`);
  } finally {
    console.log("Cleaning up only this smoke test's AWS stack and exact S3 keys.");
    try {
      if (stackAttempted) {
        try { cli(["cloudformation", "describe-stacks", "--stack-name", stage], 30000); }
        catch (error) {
          const stderr = String((error as { stderr?: unknown }).stderr ?? "");
          if (/does not exist/i.test(stderr)) stackAttempted = false;
          else throw error;
        }
        if (stackAttempted) { cli(["cloudformation", "delete-stack", "--stack-name", stage]); cli(["cloudformation", "wait", "stack-delete-complete", "--stack-name", stage]); }
      }
      for (const Key of keys) {
        let version: string | undefined;
        try { version = (await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: Key }))).VersionId; }
        catch (error) { if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) continue; throw error; }
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: Key, VersionId: version }));
      }
      report.cleanup = "complete";
    } catch { report.cleanup = "failed-manual-cleanup-required"; report.status = "failed"; }
    report.finishedAt = new Date().toISOString(); save(report); s3.destroy(); lambda.destroy(); sts.destroy();
  }
  console.log(`AWS smoke: ${report.status}; cleanup=${report.cleanup}. Private report: migration-reports/phase3-aws.json`);
  return report.status === "passed" && report.cleanup === "complete" ? 0 : 1;
}

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createLocalTables } from "./local-tables.mjs";

if (existsSync(".env")) process.loadEnvFile(".env");
// Set these in this process only: packaging/deployment must keep using AWS.
process.env.DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT || "http://127.0.0.1:8000";
try {
  await createLocalTables();
} catch (error) {
  console.error("Cannot prepare DynamoDB Local. Start it on port 8000 before running npm run dev:local.");
  console.error(error.message);
  process.exit(1);
}

console.log("Local API: http://localhost:4100; worker: http://localhost:4102. Paid AI calls are disabled.");
const child = spawn(process.execPath, ["node_modules/serverless/run.js", "offline", "--stage=dev", "--httpPort=4100", "--lambdaPort=4102"], {
  stdio: "inherit",
  env: {
    ...process.env,
    LAMBDA_ENDPOINT: "http://localhost:4102",
    JWT_SECRET: process.env.JWT_SECRET || "local-development-only-change-this-secret",
    S3_BUCKET: process.env.S3_BUCKET || "synthetic-test",
    OPENAI_API_KEY: ""
  }
});
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });

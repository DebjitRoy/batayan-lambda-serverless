import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)], {
  env: { ...process.env, DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000" }, stdio: "inherit"
});
process.exit(result.status ?? 1);

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
mkdirSync("migration-reports", { recursive: true, mode: 0o700 });
const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/mongo-parity.test.ts", "--reporter=default", "--reporter=json", "--outputFile=migration-reports/phase3-parity.json"], {
  env: { ...process.env, RUN_MONGO_PARITY: "1", MONGOMS_DOWNLOAD_DIR: resolve(".local/mongodb") }, stdio: "inherit"
});
process.exit(result.status ?? 1);

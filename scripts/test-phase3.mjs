import { spawnSync } from "node:child_process";
const commands = [
  ["scripts/test-integration.mjs"],
  ["scripts/test-parity.mjs"],
  ["scripts/run-phase3.mjs", "local"],
  ["node_modules/typescript/bin/tsc", "--noEmit"]
];
for (const args of commands) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("Phase 3 local checks passed. Review external AWS/image reports and run test:release-gates before cutover.");

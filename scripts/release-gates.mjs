import { readFileSync } from "node:fs";
function report(name) { try { return JSON.parse(readFileSync(`migration-reports/${name}.json`, "utf8")); } catch { return undefined; } }
const local = report("phase3-local"), parity = report("phase3-parity"), images = report("phase3-images"), aws = report("phase3-aws");
const checks = [
  ["restored-data HTTP acceptance", (local?.coreHttpStatus ?? local?.status) === "passed"],
  ["local list latency target", local?.metrics?.listLatencyPass === true],
  ["catalog read capacity at the declared traffic", local?.metrics?.scanCapacityBudgetPass === true],
  ["MongoDB reference parity", parity?.success === true && parity?.numFailedTests === 0],
  ["existing images accessible", images?.accessible === 1123 && images?.uniqueKeys === 1123],
  ["AWS synthetic smoke and cleanup", aws?.status === "passed" && aws?.cleanup === "complete"],
  ["known migrated-user login", local?.migratedLogin === "passed"]
];
for (const [name, passed] of checks) console.log(`${passed ? "PASS" : "PENDING/FAIL"}: ${name}`);
if (local?.migratedLogin === "failed") {
  console.log(`Migrated-user login failure: ${local.loginFailure ?? "inspect phase3-local.json"}`);
  console.log("Check the application user's original password in the private MIGRATION_TEST_PASSWORD setting; the stored backup hash is unchanged.");
} else if (local?.migratedLogin !== "passed") {
  console.log("Migrated-user login has not passed; configure private MIGRATION_TEST_EMAIL/MIGRATION_TEST_PASSWORD and rerun test:acceptance.");
}
if (local?.coreHttpStatus === "failed" || !local) console.log(`Local acceptance failure: ${local?.failure ?? "missing/unreadable report"}. Run test:acceptance to refresh it.`);
console.log("Review measured scan capacity versus expected traffic and the account's actual billing before production cutover.");
process.exitCode = checks.every(([, passed]) => passed) ? 0 : 1;

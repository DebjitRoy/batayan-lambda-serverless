import { loadBackup, MigrationError } from "./migration/backup.js";
import { newManifest, runMigration, type Mode } from "./migration/engine.js";
import { privateReportWriter } from "./migration/report.js";
import { DynamoTarget, type TargetOptions } from "./migration/target.js";

const usage = `Usage: npm run migration:<validate|import|verify> -- --source src/migration --out migration-reports/<run>.json
Import/verify also require --account-id <local|12-digit-id> --region <region> --stage <stage>.
Use --endpoint http://127.0.0.1:8000 with --account-id local for isolated local rehearsal tables.
Optional: --write-units-per-second <positive-number>; AWS rate is capped at 80% of provisioned table capacity.
This CLI does not load .env, create tables, call APIs/workers, or update/delete existing records.`;

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help")) { console.log(usage); return 0; }
  try {
    const mode = argv[0] as Mode;
    if (!["validate", "import", "verify"].includes(mode)) throw new MigrationError("INVALID_MODE");
    const flags = new Map<string, string>();
    const allowed = new Set(["--source", "--out", "--account-id", "--region", "--stage", "--endpoint", "--write-units-per-second"]);
    for (let index = 1; index < argv.length; index += 2) {
      const flag = argv[index]!, value = argv[index + 1];
      if (!allowed.has(flag) || !value || value.startsWith("--") || flags.has(flag)) throw new MigrationError("INVALID_ARGUMENTS");
      flags.set(flag, value);
    }
    if (!flags.has("--source") || !flags.has("--out")) throw new MigrationError("SOURCE_AND_REPORT_REQUIRED");
    let targetOptions: TargetOptions | undefined;
    if (mode !== "validate") {
      if (!["--account-id", "--region", "--stage"].every(flag => flags.has(flag))) throw new MigrationError("EXPLICIT_TARGET_REQUIRED");
      targetOptions = { accountId: flags.get("--account-id")!, region: flags.get("--region")!, stage: flags.get("--stage")!, endpoint: flags.get("--endpoint"), writeUnitsPerSecond: flags.has("--write-units-per-second") ? Number(flags.get("--write-units-per-second")) : undefined };
    }
    const writeReport = privateReportWriter(flags.get("--out")!);
    const backup = loadBackup(flags.get("--source")!);
    const manifest = newManifest(mode, backup, targetOptions);
    const controller = new AbortController();
    const interrupt = () => { controller.abort(); };
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
    try {
      let target: DynamoTarget | undefined;
      try { if (targetOptions && !backup.issues.length) target = new DynamoTarget(targetOptions); }
      catch (error) {
        manifest.status = "failed"; manifest.finishedAt = new Date().toISOString(); manifest.rejected++;
        manifest.issues.push({ collection: "target", code: error instanceof MigrationError ? error.code : "TARGET_INITIALIZATION_FAILED" });
        writeReport(manifest); console.error("Target configuration rejected; see the private report."); return 1;
      }
      let lastProgress = 0;
      await runMigration(backup, manifest, target, {
        signal: controller.signal, checkpoint: writeReport,
        onProgress: current => {
          const processed = current.imported + current.matched;
          if (processed - lastProgress >= 100) { console.log(`Processed ${processed}/${backup.records.length}`); lastProgress = processed; }
        }
      });
      console.log(`${mode}: ${manifest.status}; imported=${manifest.imported}, matched=${manifest.matched}, issues=${manifest.rejected}, missing=${manifest.missing}, extras=${manifest.extras}`);
      console.log(`Private report: ${flags.get("--out")}`);
      return manifest.status === "interrupted" ? 130 : ["complete", "validated"].includes(manifest.status) ? 0 : 1;
    } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
  } catch (error) {
    console.error(error instanceof MigrationError ? error.code : "Migration could not run; check file permissions and arguments.");
    return 1;
  }
}

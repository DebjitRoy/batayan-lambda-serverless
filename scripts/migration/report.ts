import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { MigrationError } from "./backup.js";
import type { Manifest } from "./engine.js";

export function privateReportWriter<T extends object = Manifest>(output: string): (manifest: T) => void {
  const root = resolve("migration-reports"), destination = resolve(output), path = relative(root, destination);
  if (!path || path.startsWith("..") || isAbsolute(path) || !destination.endsWith(".json")) throw new MigrationError("REPORT_MUST_BE_JSON_UNDER_MIGRATION_REPORTS");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const identity = execFileSync("whoami", [], { encoding: "utf8" }).trim();
    execFileSync("icacls", [root, "/inheritance:r", "/grant:r", `${identity}:(OI)(CI)F`, "SYSTEM:(OI)(CI)F"], { stdio: "ignore" });
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  return manifest => {
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      renameSync(temporary, destination);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  };
}

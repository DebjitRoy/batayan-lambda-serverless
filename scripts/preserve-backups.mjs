import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
const expected = {
  "batayan_posts060326.json": "5304347463a67f96fdb33dae275e06e522546923c6f22f013ba64acfcb2da137",
  "batayan_comments_060326.json": "4fd15213c60e98e7723160eb38286400ee24eed1cb603d419095009f51568b63",
  "batayan_users.json": "3bbefc4902f1a0d626655ebe1c87066eb8a0392cb31cd9dbd4e63771597d5960"
};
const destination = resolve(process.argv[2] ?? ".recovery/originals");
mkdirSync(destination, { recursive: true, mode: 0o700 });
if (process.platform === "win32") {
  const identity = execFileSync("whoami", [], { encoding: "utf8" }).trim();
  execFileSync("icacls", [destination, "/inheritance:r", "/grant:r", `${identity}:(OI)(CI)F`, "SYSTEM:(OI)(CI)F"], { stdio: "ignore" });
}
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const files = [];
for (const [name, hash] of Object.entries(expected)) {
  const source = join("src/migration", name), target = join(destination, name);
  if (digest(source) !== hash) throw new Error(`Source checksum differs: ${name}`);
  if (!existsSync(target)) copyFileSync(source, target);
  if (digest(target) !== hash) throw new Error(`Recovery copy checksum differs: ${name}`);
  if (process.platform === "win32") {
    const identity = execFileSync("whoami", [], { encoding: "utf8" }).trim();
    execFileSync("icacls", [target, "/inheritance:r", "/grant:r", `${identity}:R`, "SYSTEM:F"], { stdio: "ignore" });
  }
  if (process.platform !== "win32") chmodSync(target, 0o400);
  files.push({ file: name, sha256: hash });
}
writeFileSync(join(destination, "manifest.json"), JSON.stringify({ verifiedAt: new Date().toISOString(), backupDate: "2026-06-03", files }, null, 2), { mode: 0o600 });
console.log(`Verified ${files.length} recovery copies at ${destination}. Keep an independent off-device copy too.`);

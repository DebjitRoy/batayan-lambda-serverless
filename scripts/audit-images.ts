import { existsSync } from "node:fs";
import { loadBackup, type Document } from "./migration/backup.js";
import { privateReportWriter } from "./migration/report.js";

export async function main(): Promise<number> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const base = process.env.S3_PUBLIC_BASE_URL;
  if (!base || new URL(base).protocol !== "https:") { console.error("Set the HTTPS S3_PUBLIC_BASE_URL before the read-only image audit."); return 1; }
  const backup = loadBackup("src/migration");
  if (backup.issues.length) { console.error("Backup preflight failed."); return 1; }
  const keys = new Set<string>(); let references = 0;
  for (const { item } of backup.records.filter(record => record.collection === "posts")) {
    for (const value of [item.photoHero, ...(item.gallery as string[]), ...(item.content as Document[]).map(section => section.image)]) {
      if (typeof value === "string" && value) { references++; keys.add(value); }
    }
  }
  const pending = [...keys], results: Array<{ key: string; status: number | null; outcome: string }> = [];
  const startedAt = new Date().toISOString();
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (;;) {
      const key = pending.pop(); if (!key) return;
      try {
        const encoded = key.split("/").map(encodeURIComponent).join("/");
        const response = await fetch(`${base.replace(/\/$/, "")}/${encoded}`, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(10000) });
        results.push({ key, status: response.status, outcome: response.ok ? "accessible" : response.status === 404 ? "missing" : "inaccessible-or-unknown" });
      } catch { results.push({ key, status: null, outcome: "request-failed" }); }
    }
  }));
  const report = { startedAt, finishedAt: new Date().toISOString(), readOnly: true, base, references, uniqueKeys: keys.size, accessible: results.filter(result => result.outcome === "accessible").length, results: results.sort((a, b) => a.key.localeCompare(b.key)) };
  privateReportWriter<typeof report>("migration-reports/phase3-images.json")(report);
  console.log(`Image audit: ${references} references, ${keys.size} unique keys, ${report.accessible} accessible, ${keys.size - report.accessible} unresolved.`);
  console.log("Private report: migration-reports/phase3-images.json");
  return report.accessible === keys.size ? 0 : 1;
}

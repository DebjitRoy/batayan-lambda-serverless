import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

mkdirSync(".local", { recursive: true });
const entry = process.argv[2] === "rehearse" ? "scripts/rehearse-migration.ts" : "scripts/migrate-mongodb-to-dynamodb.ts";
const outfile = resolve(`.local/${entry.includes("rehearse") ? "rehearse" : "migration"}-cli.cjs`);
buildSync({ entryPoints: [entry], outfile, bundle: true, packages: "external", platform: "node", target: "node22", format: "cjs" });
const { main } = createRequire(import.meta.url)(outfile);
process.exitCode = await main(process.argv.slice(2));

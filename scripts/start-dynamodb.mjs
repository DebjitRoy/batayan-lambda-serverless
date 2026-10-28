import { existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
const directory = resolve(".local/dynamodb");
if (!existsSync(join(directory, "DynamoDBLocal.jar"))) {
  console.error("Download DynamoDB Local into .local/dynamodb first; see README.md."); process.exit(1);
}
const bundledRoot = resolve(".local/jre");
const bundled = existsSync(bundledRoot) ? readdirSync(bundledRoot).map(name => join(bundledRoot, name, "bin", process.platform === "win32" ? "java.exe" : "java")).find(existsSync) : undefined;
console.log("Starting in-memory DynamoDB Local on port 8000. Keep this terminal open; stopping it clears local tables.");
const child = spawn(bundled ?? "java", [`-Djava.library.path=${join(directory, "DynamoDBLocal_lib")}`, "-jar", join(directory, "DynamoDBLocal.jar"), "-sharedDb", "-inMemory", "-port", "8000"], { stdio: "inherit" });
child.on("error", () => { console.error("Java could not start. Install Java 17+ or use the bundled .local/jre runtime."); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });

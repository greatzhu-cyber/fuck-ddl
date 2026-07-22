import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of [
  "manifest.json",
  "bridge-status.js",
  "domain-tracker.js",
  "service-worker.js",
  "popup.html",
  "popup.css",
  "popup.js",
]) {
  await cp(path.join(root, file), path.join(output, file));
}
await cp(path.join(root, "icons"), path.join(output, "icons"), {
  recursive: true,
});
const manifest = JSON.parse(await readFile(path.join(output, "manifest.json")));
if (
  manifest.manifest_version !== 3 ||
  manifest.permissions.includes("history")
) {
  throw new Error("Extension privacy contract failed");
}
console.log(`Built ${manifest.name} ${manifest.version}`);

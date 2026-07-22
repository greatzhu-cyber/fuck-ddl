import { readFileSync } from "node:fs";

const capabilityPath = new URL(
  "../apps/desktop/src-tauri/capabilities/default.json",
  import.meta.url,
);
const tauriConfigPath = new URL(
  "../apps/desktop/src-tauri/tauri.conf.json",
  import.meta.url,
);
const cargoPath = new URL(
  "../apps/desktop/src-tauri/Cargo.toml",
  import.meta.url,
);

const readJson = (path) =>
  JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
const capability = readJson(capabilityPath);
const tauriConfig = readJson(tauriConfigPath);
const cargo = readFileSync(cargoPath, "utf8");
const permissions = new Set(capability.permissions ?? []);

for (const permission of ["sql:default", "sql:allow-execute"]) {
  if (!permissions.has(permission)) {
    throw new Error("Desktop capability is missing " + permission);
  }
}

const preloads = tauriConfig.plugins?.sql?.preload ?? [];
if (!preloads.includes("sqlite:fuck-ddl.db")) {
  throw new Error("Desktop SQL preload must include sqlite:fuck-ddl.db");
}
if (!cargo.includes("tauri-plugin-sql")) {
  throw new Error("Desktop Cargo.toml must register tauri-plugin-sql");
}

console.log("Desktop SQLite capability contract passed");

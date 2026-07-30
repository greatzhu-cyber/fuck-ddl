import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const migrationsUrl = new URL("../supabase/migrations/", import.meta.url);
const migrationFiles = (await readdir(migrationsUrl))
  .filter((file) => file.endsWith(".sql"))
  .sort();
const sql = (
  await Promise.all(
    migrationFiles.map((file) =>
      readFile(new URL(file, migrationsUrl), "utf8"),
    ),
  )
).join("\n");

const userTables = [
  "profiles",
  "goals",
  "projects",
  "tasks",
  "cloud_state",
  "subtasks",
  "time_entries",
  "task_versions",
  "integration_accounts",
  "sync_cursors",
  "operation_receipts",
  "grade_records",
];

for (const table of userTables) {
  const tableDefinition = sql.match(
    new RegExp(`create table public\\.${table} \\(([\\s\\S]*?)\\n\\);`),
  );
  assert.ok(tableDefinition, `missing table: ${table}`);
  assert.match(
    tableDefinition[1],
    /user_id uuid not null|user_id uuid primary key/,
    `${table} must have a non-null user_id`,
  );
  assert.match(
    sql,
    new RegExp(`alter table public\\.${table} enable row level security;`),
    `${table} must enable RLS`,
  );
  assert.match(
    sql,
    new RegExp(
      `create policy ${table}_owner_all on public\\.${table} for all to authenticated[\\s\\S]*?using \\(\\(select auth\\.uid\\(\\)\\) = user_id\\)[\\s\\S]*?with check \\(\\(select auth\\.uid\\(\\)\\) = user_id\\);`,
    ),
    `${table} must enforce owner checks for reads and writes`,
  );
}

assert.match(
  sql,
  /alter table public\.github_allowlist enable row level security;/,
);
assert.match(
  sql,
  /revoke all on public\.github_allowlist from anon, authenticated;/,
);
assert.match(sql, /security definer\s+set search_path = ''/);
assert.doesNotMatch(
  sql,
  /service[_ -]?role/i,
  "migration must not embed service-role credentials",
);

console.log(
  `Schema contract passed for ${userTables.length} user-owned tables.`,
);

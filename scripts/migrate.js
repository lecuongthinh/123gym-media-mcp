import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to run migrations.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "migrations");
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined
});

const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock($1)", [320001]);
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const files = (await readdir(migrationDirectory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  for (const name of files) {
    const exists = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
    if (exists.rowCount) continue;
    const sql = await readFile(path.join(migrationDirectory, name), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      console.log(`Applied migration ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock($1)", [320001]).catch(() => {});
  client.release();
  await pool.end();
}

import { pool } from "./client";
import fs from "fs";
import path from "path";

async function initializeDatabase() {
  console.log("Starting database initialization...");
  let schemaPath = path.join(__dirname, "schema.sql");
  if (!fs.existsSync(schemaPath)) {
    schemaPath = path.join(__dirname, "../../src/db/schema.sql");
  }
  if (!fs.existsSync(schemaPath)) {
    schemaPath = path.join(__dirname, "../src/db/schema.sql");
  }
  const schemaSql = fs.readFileSync(schemaPath, "utf8");

  const client = await pool.connect();
  try {
    console.log("Resetting database schema (dropping public schema)...");
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    
    console.log("Applying schema.sql database script...");
    await client.query(schemaSql);
    console.log("Database initialized successfully!");
  } catch (error) {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  initializeDatabase();
}
export { initializeDatabase };

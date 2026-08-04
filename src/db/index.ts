import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const connectionString = process.env.DATABASE_URL || 'postgres://loguser:logpass@localhost:5432/logdb';
const dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({
  connectionString,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export async function initDb() {
  const client = await pool.connect();
  try {
    const schemaPath = path.join(dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await client.query(schemaSql);
    console.log('✅ Database schema and partitions initialized successfully.');
  } catch (error) {
    console.error('❌ Error initializing database schema:', error);
    throw error;
  } finally {
    client.release();
  }
}

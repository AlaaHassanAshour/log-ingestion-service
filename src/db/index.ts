import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const connectionString = process.env.DATABASE_URL || 'postgres://loguser:logpass@localhost:5432/logdb';
const dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({
  connectionString,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

function authEnabled() {
  return process.env.AUTH_ENABLED?.toLowerCase() === 'true';
}

function hashApiKey(apiKey: string) {
  return createHash('sha256').update(apiKey).digest('hex');
}

async function seedLoadgenApiKey(client: pg.PoolClient) {
  if (!authEnabled() || !process.env.LOADGEN_API_KEY) {
    return;
  }

  await client.query(
    `INSERT INTO api_keys (key_hash, can_ingest, can_query)
     VALUES ($1, true, true)
     ON CONFLICT (key_hash)
     DO UPDATE SET can_ingest = true, can_query = true`,
    [hashApiKey(process.env.LOADGEN_API_KEY)],
  );
}

export async function initDb() {
  const client = await pool.connect();
  try {
    const schemaPath = path.join(dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await client.query(schemaSql);
    await seedLoadgenApiKey(client);
    console.log('✅ Database schema and partitions initialized successfully.');
  } catch (error) {
    console.error('❌ Error initializing database schema:', error);
    throw error;
  } finally {
    client.release();
  }
}

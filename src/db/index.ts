import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// دعم __dirname داخل بيئات ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const connectionString = process.env.DATABASE_URL || 'postgres://loguser:logpass@localhost:5432/logdb';

export const pool = new pg.Pool({
  connectionString,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export async function initDb() {
  const client = await pool.connect();
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    
    await client.query('BEGIN');
    await client.query(schemaSql);
    await client.query('COMMIT');
    
    console.log('✅ Database schema, partitions, and GIN Trigram index initialized successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error initializing database schema:', error);
    throw error;
  } finally {
    client.release();
  }
}
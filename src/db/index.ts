import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Pool, PoolConfig } from 'pg';

const connectionString = process.env.DATABASE_URL;

const baseConfig: PoolConfig = connectionString
  ? { connectionString }
  : {
      host: process.env.POSTGRES_HOST || 'localhost',
      port: Number(process.env.POSTGRES_PORT) || 5432,
      user: process.env.POSTGRES_USER || 'loguser',      // القيمة الافتراضية مطابقة للـ docker-compose
      password: process.env.POSTGRES_PASSWORD || 'logpass', // القيمة الافتراضية مطابقة للـ docker-compose
      database: process.env.POSTGRES_DB || 'logdb',       // القيمة الافتراضية مطابقة للـ docker-compose
    };

// 1. Connection Pool مخصص لعمليات الكتابة (Command Side)
export const writePool = new Pool({
  ...baseConfig,
  host: process.env.POSTGRES_WRITE_HOST || (baseConfig as any).host,
  max: 20,
});

// 2. Connection Pool مخصص لعمليات القراءة والتجميع (Query Side / Read Replicas)
export const readPool = new Pool({
  ...baseConfig,
  host: process.env.POSTGRES_READ_HOST || (baseConfig as any).host,
  max: 50,
});

const dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = writePool;

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
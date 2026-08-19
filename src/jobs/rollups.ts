import { writePool } from '../db/index.js';

const DEFAULT_BATCH_SIZE = 5000;
const DEFAULT_INTERVAL_MS = 1000;

function rollupBatchSize() {
  const parsed = Number(process.env.ROLLUP_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_BATCH_SIZE;
}

function rollupIntervalMs() {
  const parsed = Number(process.env.ROLLUP_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

export async function processRollupBatch() {
  const client = await writePool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `WITH picked AS (
         SELECT timestamp, id, service, level
         FROM logs
         WHERE rollup_processed = false
         ORDER BY timestamp, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       ),
       minute_rollup AS (
         INSERT INTO log_rollups_minute (bucket_start, service, level, count)
         SELECT date_trunc('minute', timestamp), service, level, COUNT(*)::bigint
         FROM picked
         GROUP BY 1, 2, 3
         ON CONFLICT (bucket_start, service, level)
         DO UPDATE SET count = log_rollups_minute.count + EXCLUDED.count
         RETURNING 1
       ),
       hour_rollup AS (
         INSERT INTO log_rollups_hour (bucket_start, service, level, count)
         SELECT date_trunc('hour', timestamp), service, level, COUNT(*)::bigint
         FROM picked
         GROUP BY 1, 2, 3
         ON CONFLICT (bucket_start, service, level)
         DO UPDATE SET count = log_rollups_hour.count + EXCLUDED.count
         RETURNING 1
       ),
       updated AS (
         UPDATE logs l
         SET rollup_processed = true
         FROM picked p
         WHERE l.timestamp = p.timestamp
           AND l.id = p.id
         RETURNING 1
       )
       SELECT COUNT(*)::int AS processed
       FROM updated`,
      [rollupBatchSize()],
    );

    await client.query('COMMIT');
    return result.rows[0]?.processed ?? 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function startRollupJob() {
  let running = false;

  const run = async () => {
    if (running) {
      return;
    }

    running = true;
    try {
      await processRollupBatch();
    } catch (error) {
      console.error('Rollup job failed:', error);
    } finally {
      running = false;
    }
  };

  setInterval(run, rollupIntervalMs()).unref();
  void run();
}

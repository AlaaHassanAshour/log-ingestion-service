import { pool } from '../db/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function retentionDays() {
  const parsed = Number(process.env.RETENTION_DAYS ?? '30');
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 30;
}

export async function runRetentionOnce() {
  const days = retentionDays();
  await pool.query('SELECT drop_old_log_partitions($1);', [days]);
}

export function startRetentionJob() {
  const run = async () => {
    try {
      await runRetentionOnce();
      console.log(`Retention completed for partitions older than ${retentionDays()} days.`);
    } catch (error) {
      console.error('Retention job failed:', error);
    }
  };

  setInterval(run, DAY_MS).unref();
}

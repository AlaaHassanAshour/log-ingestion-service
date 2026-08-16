import { buildApp } from './app.js';
import { startRetentionJob } from './jobs/retention.js';
import { startRollupJob } from './jobs/rollups.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function start() {
  const app = await buildApp();
  try {
    await app.listen({ port: PORT, host: HOST });
    startRetentionJob();
    startRollupJob();
    console.log(`🚀 Log Ingestion Service running on http://${HOST}:${PORT}`);
  } catch (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
}

start();

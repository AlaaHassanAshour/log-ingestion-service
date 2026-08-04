import { buildApp } from './app.js';
import { initDb } from './db/index.js';
import { startRetentionCronJob } from './jobs/retention.js'; // 👈 استيراد المهمة

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function start() {
  try {
    // 1. تهيئة جداول وتوسيعات قاعدة البيانات أولاً
    await initDb();

    // 2. تشغيل مهمة الجدولة لـ Retention Policy في الخلفية
    startRetentionCronJob(); // 👈 تفعيل مهمة Retention هنا

    // 3. بناء وتشغيل تطبيق Fastify
    const app = await buildApp();
    await app.listen({ port: PORT, host: HOST });
    console.log(`🚀 Log Ingestion Service running on http://${HOST}:${PORT}`);
  } catch (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
}

start();
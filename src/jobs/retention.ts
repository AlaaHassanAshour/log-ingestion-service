import cron from 'node-cron';
import { pool } from '../db/index.js';

/**
 * تشغيل مهمة أوتوماتيكية لحذف التقسيمات أقدم من 30 يوماً
 */
export function startRetentionCronJob() {
  // تشغيل السكريبت كل يوم عند الساعة 00:05 منتصف الليل
  cron.schedule('5 0 * * *', async () => {
    console.log('🧹 Running scheduled Data Retention Policy check...');
    try {
      const retentionDays = process.env.RETENTION_DAYS ? parseInt(process.env.RETENTION_DAYS, 10) : 30;
      await pool.query('SELECT drop_old_log_partitions($1);', [retentionDays]);
      console.log(`✅ Retention job completed. Partitions older than ${retentionDays} days removed.`);
    } catch (err) {
      console.error('❌ Error executing partition retention job:', err);
    }
  });

  console.log('⏱️ Data Retention Cron Job initialized (runs daily at 00:05).');
}
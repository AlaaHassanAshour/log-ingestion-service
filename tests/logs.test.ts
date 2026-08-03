import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';

describe('Log Ingestion API Integration Tests', () => {
  let app: any;

  beforeAll(async () => {
    // إنشاء نسخة من تطبيق Fastify للاختبار
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    // إغلاق الاتصالات بعد انتهاء الاختبارات
    await app.close();
    await pool.end();
  });

  // 1. اختبار صحة السيرفر
  it('GET /health - should return status OK', async () => {
    const response = await request(app.server).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  // 2. اختبار إدخال سجل صحيح
  it('POST /api/logs - should ingest a valid log entry', async () => {
    const payload = {
      level: 'info',
      service: 'payment-service',
      message: 'Payment processed successfully',
      attributes: { amount: 150, currency: 'USD' },
    };

    const response = await request(app.server)
      .post('/api/logs')
      .send(payload);

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.ingested).toBe(1);
  });

  // 3. اختبار رفض البيانات الخاطئة
  it('POST /api/logs - should reject invalid log format', async () => {
    const invalidPayload = {
      level: 'invalid_level', // level غير معتمد
      service: '',
    };

    const response = await request(app.server)
      .post('/api/logs')
      .send(invalidPayload);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid log format');
  });

  // 4. اختبار استعلام السجلات
  it('GET /api/logs - should query ingested logs', async () => {
    const response = await request(app.server)
      .get('/api/logs?service=payment-service');

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data.length).toBeGreaterThan(0);
    expect(response.body.data[0].service).toBe('payment-service');
  });
});
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';

describe('required log API contract', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const service = `contract-test-${Date.now()}`;
  const baseTimestamp = '2026-07-20T14:32:01.123Z';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await pool.end();
  });

  it('GET /health returns ready status', async () => {
    const response = await request(app.server).get('/health');

    expect(response.status).toBe(200);
  });

  it('POST /logs accepts valid entries and rejects invalid entries by index', async () => {
    const response = await request(app.server)
      .post('/logs')
      .send({
        logs: [
          {
            timestamp: baseTimestamp,
            level: 'error',
            service,
            message: 'payment declined',
            attributes: { user_id: '42', region: 'eu-west', retries: 3, cached: false },
          },
          {
            timestamp: baseTimestamp,
            level: 'critical',
            service,
            message: 'bad level',
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(1);
    expect(response.body.rejected).toEqual([{ index: 1, reason: "invalid level: 'critical'" }]);
  });

  it('POST /logs returns 400 when every entry is rejected', async () => {
    const response = await request(app.server)
      .post('/logs')
      .send({
        logs: [
          {
            timestamp: baseTimestamp,
            level: 'info',
            service,
            message: '',
          },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body.accepted).toBe(0);
    expect(response.body.rejected[0].index).toBe(0);
  });

  it('POST /logs returns 400 for malformed JSON', async () => {
    const response = await request(app.server)
      .post('/logs')
      .set('Content-Type', 'application/json')
      .send('{"logs": [');

    expect(response.status).toBe(400);
    expect(typeof response.body.error).toBe('string');
  });

  it('GET /logs supports filters, attributes, and cursor pagination shape', async () => {
    const response = await request(app.server)
      .get('/logs')
      .query({
        service,
        level: 'error',
        since: '2026-07-20T14:00:00Z',
        until: '2026-07-20T15:00:00Z',
        'attr.user_id': '42',
        q: 'declined',
        limit: '1',
      });

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.logs)).toBe(true);
    expect(response.body.logs).toHaveLength(1);
    expect(response.body.logs[0]).toMatchObject({
      timestamp: baseTimestamp,
      level: 'error',
      service,
      message: 'payment declined',
      attributes: expect.objectContaining({ user_id: '42' }),
    });
    expect(response.body).toHaveProperty('next_cursor');
  });

  it('GET /logs rejects invalid query parameters', async () => {
    const response = await request(app.server).get('/logs?level=critical');

    expect(response.status).toBe(400);
    expect(typeof response.body.error).toBe('string');
  });

  it('GET /logs rejects malformed cursors', async () => {
    const response = await request(app.server).get('/logs?cursor=not-a-valid-cursor');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid cursor');
  });

  it('GET /logs/aggregate returns time bucketed counts', async () => {
    const response = await request(app.server)
      .get('/logs/aggregate')
      .query({
        service,
        since: '2026-07-20T14:00:00Z',
        until: '2026-07-20T15:00:00Z',
        bucket: '1m',
        group_by: 'service',
      });

    expect(response.status).toBe(200);
    expect(response.body.buckets).toEqual([
      {
        start: '2026-07-20T14:32:00.000Z',
        group: service,
        count: 1,
      },
    ]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';

describe('required log API contract', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const service = `contract-test-${Date.now()}`;
  const baseTimestamp = '2026-07-20T14:32:01.123Z';

  beforeAll(async () => {
    delete process.env.AUTH_ENABLED;
    delete process.env.LOADGEN_API_KEY;
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('GET /health returns ready status', async () => {
    const response = await request(app.server).get('/health');

    expect(response.status).toBe(200);
  });

  it('POST /logs accepts valid entries and rejects invalid entries by index', async () => {
    const response = await request(app.server)
      .post('/logs')
      .set('Authorization', 'Bearer ignored-when-auth-disabled')
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

describe('optional API key authentication', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const apiKey = `loadgen-key-${Date.now()}`;
  const service = `auth-test-${Date.now()}`;

  beforeAll(async () => {
    process.env.AUTH_ENABLED = 'true';
    process.env.LOADGEN_API_KEY = apiKey;
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    delete process.env.AUTH_ENABLED;
    delete process.env.LOADGEN_API_KEY;
    if (app) {
      await app.close();
    }
    await pool.end();
  });

  it('keeps GET /health unauthenticated when auth is enabled', async () => {
    const response = await request(app.server).get('/health');

    expect(response.status).toBe(200);
  });

  it('rejects missing credentials on data endpoints', async () => {
    const response = await request(app.server).get('/logs');

    expect(response.status).toBe(401);
    expect(typeof response.body.error).toBe('string');
  });

  it('rejects malformed bearer credentials', async () => {
    const response = await request(app.server)
      .get('/logs')
      .set('Authorization', apiKey);

    expect(response.status).toBe(401);
    expect(typeof response.body.error).toBe('string');
  });

  it('accepts the seeded bearer key for ingest and query', async () => {
    const ingest = await request(app.server)
      .post('/logs')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        logs: [
          {
            timestamp: '2026-07-20T16:00:00.000Z',
            level: 'info',
            service,
            message: 'authenticated ingest',
            attributes: { user_id: 'seeded' },
          },
        ],
      });

    expect(ingest.status).toBe(200);
    expect(ingest.body.accepted).toBe(1);

    const query = await request(app.server)
      .get('/logs')
      .set('Authorization', `Bearer ${apiKey}`)
      .query({ service, 'attr.user_id': 'seeded' });

    expect(query.status).toBe(200);
    expect(query.body.logs).toHaveLength(1);
  });

  it('accepts X-API-Key as an additional credential transport', async () => {
    const response = await request(app.server)
      .get('/logs')
      .set('X-API-Key', apiKey)
      .query({ service });

    expect(response.status).toBe(200);
  });
});

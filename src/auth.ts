import { createHash } from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from './db/index.js';

type Scope = 'ingest' | 'query';

function authEnabled() {
  return process.env.AUTH_ENABLED?.toLowerCase() === 'true';
}

function hashApiKey(apiKey: string) {
  return createHash('sha256').update(apiKey).digest('hex');
}

function requiredScope(request: FastifyRequest): Scope | null {
  const path = request.url.split('?')[0];
  if (path === '/health' || !path.startsWith('/logs')) {
    return null;
  }

  if (request.method === 'POST' && path === '/logs') {
    return 'ingest';
  }

  if (request.method === 'GET' && (path === '/logs' || path === '/logs/aggregate')) {
    return 'query';
  }

  return null;
}

function credentialFromRequest(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) {
      return { error: 'missing or malformed bearer credential' };
    }
    return { apiKey: match[1] };
  }

  const xApiKey = request.headers['x-api-key'];
  if (Array.isArray(xApiKey)) {
    return { error: 'x-api-key must be provided only once' };
  }

  if (typeof xApiKey === 'string' && xApiKey.trim() !== '') {
    return { apiKey: xApiKey };
  }

  return { error: 'missing credential' };
}

async function authorize(apiKey: string, scope: Scope) {
  const result = await pool.query(
    `SELECT can_ingest, can_query
     FROM api_keys
     WHERE key_hash = $1`,
    [hashApiKey(apiKey)],
  );

  const key = result.rows[0];
  if (!key) {
    return { status: 401, error: 'invalid credential' };
  }

  if (scope === 'ingest' && !key.can_ingest) {
    return { status: 403, error: 'insufficient scope' };
  }

  if (scope === 'query' && !key.can_query) {
    return { status: 403, error: 'insufficient scope' };
  }

  return null;
}

export async function registerAuth(app: FastifyInstance) {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = requiredScope(request);
    if (!scope || !authEnabled()) {
      return;
    }

    const credential = credentialFromRequest(request);
    if (credential.error || !credential.apiKey) {
      return reply.status(401).send({ error: credential.error });
    }

    const failure = await authorize(credential.apiKey, scope);
    if (failure) {
      return reply.status(failure.status).send({ error: failure.error });
    }
  });
}

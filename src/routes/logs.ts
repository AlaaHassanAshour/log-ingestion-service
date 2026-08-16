import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db/index.js';

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const MAX_FUTURE_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type AttributeValue = string | number | boolean;

type ValidLogInput = {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  attributes: Record<string, AttributeValue>;
};

type QueryFilters = {
  service?: string;
  level?: LogLevel;
  since?: string;
  until?: string;
  q?: string;
  attributes: Record<string, string>;
};

type Cursor = {
  timestamp: string;
  id: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown, field: string, options: { required: boolean; futureLimit?: boolean }) {
  if (value === undefined || value === null || value === '') {
    return options.required ? `${field} is required` : undefined;
  }

  if (typeof value !== 'string') {
    return `${field} must be an ISO 8601 timestamp`;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return `${field} must be a valid ISO 8601 timestamp`;
  }

  if (options.futureLimit && date.getTime() - Date.now() > MAX_FUTURE_MS) {
    return `${field} must not be more than five minutes in the future`;
  }

  return undefined;
}

function validateAttributes(value: unknown): { attributes?: Record<string, AttributeValue>; reason?: string } {
  if (value === undefined) {
    return { attributes: {} };
  }

  if (!isPlainObject(value)) {
    return { reason: 'attributes must be a flat object' };
  }

  const attributes: Record<string, AttributeValue> = {};
  for (const [key, attributeValue] of Object.entries(value)) {
    const valueType = typeof attributeValue;
    if (valueType !== 'string' && valueType !== 'number' && valueType !== 'boolean') {
      return { reason: `attributes.${key} must be a string, number, or boolean` };
    }
    attributes[key] = attributeValue as AttributeValue;
  }

  return { attributes };
}

function validateLogEntry(raw: unknown): { log?: ValidLogInput; reason?: string } {
  if (!isPlainObject(raw)) {
    return { reason: 'log entry must be an object' };
  }

  const timestampError = parseTimestamp(raw.timestamp, 'timestamp', { required: true, futureLimit: true });
  if (timestampError) {
    return { reason: timestampError };
  }

  if (typeof raw.level !== 'string' || !LEVELS.has(raw.level)) {
    return { reason: `invalid level: '${String(raw.level)}'` };
  }

  if (typeof raw.service !== 'string' || raw.service.trim() === '') {
    return { reason: 'service must be a non-empty string' };
  }

  if (typeof raw.message !== 'string' || raw.message.trim() === '') {
    return { reason: 'message must be a non-empty string' };
  }

  const attributeResult = validateAttributes(raw.attributes);
  if (attributeResult.reason) {
    return { reason: attributeResult.reason };
  }

  return {
    log: {
      timestamp: raw.timestamp as string,
      level: raw.level as LogLevel,
      service: raw.service,
      message: raw.message,
      attributes: attributeResult.attributes ?? {},
    },
  };
}

function singleValue(value: unknown, name: string): { value?: string; error?: string } {
  if (value === undefined) {
    return {};
  }
  if (Array.isArray(value)) {
    return { error: `${name} must be provided only once` };
  }
  return { value: String(value) };
}

function parseFilters(query: Record<string, unknown>, options: { requireRange: boolean }): { filters?: QueryFilters; error?: string } {
  const filters: QueryFilters = { attributes: {} };

  for (const name of ['service', 'level', 'since', 'until', 'q'] as const) {
    const parsed = singleValue(query[name], name);
    if (parsed.error) {
      return { error: parsed.error };
    }
    if (parsed.value !== undefined) {
      filters[name] = parsed.value as never;
    }
  }

  for (const [name, rawValue] of Object.entries(query)) {
    if (!name.startsWith('attr.')) {
      continue;
    }

    const key = name.slice('attr.'.length);
    if (key === '') {
      return { error: 'attribute filter key must not be empty' };
    }

    const parsed = singleValue(rawValue, name);
    if (parsed.error) {
      return { error: parsed.error };
    }
    filters.attributes[key] = parsed.value ?? '';
  }

  if (filters.level && !LEVELS.has(filters.level)) {
    return { error: `unsupported level: ${filters.level}` };
  }

  const sinceError = parseTimestamp(filters.since, 'since', { required: options.requireRange });
  if (sinceError) {
    return { error: sinceError };
  }

  const untilError = parseTimestamp(filters.until, 'until', { required: options.requireRange });
  if (untilError) {
    return { error: untilError };
  }

  if (filters.since && filters.until && new Date(filters.until).getTime() <= new Date(filters.since).getTime()) {
    return { error: 'until must be later than since' };
  }

  return { filters };
}

function parseLimit(rawLimit: unknown): { limit?: number; error?: string } {
  if (rawLimit === undefined) {
    return { limit: DEFAULT_LIMIT };
  }

  const parsed = singleValue(rawLimit, 'limit');
  if (parsed.error) {
    return { error: parsed.error };
  }

  if (!/^\d+$/.test(parsed.value ?? '')) {
    return { error: 'limit must be numeric' };
  }

  const limit = Number(parsed.value);
  if (limit < 1 || limit > MAX_LIMIT) {
    return { error: `limit must be between 1 and ${MAX_LIMIT}` };
  }

  return { limit };
}

function encodeCursor(row: { timestamp: Date | string; id: string }) {
  const timestamp = row.timestamp instanceof Date ? row.timestamp.toISOString() : new Date(row.timestamp).toISOString();
  return Buffer.from(JSON.stringify({ timestamp, id: row.id }), 'utf8').toString('base64url');
}

function decodeCursor(rawCursor: unknown): { cursor?: Cursor; error?: string } {
  if (rawCursor === undefined) {
    return {};
  }

  const parsed = singleValue(rawCursor, 'cursor');
  if (parsed.error) {
    return { error: parsed.error };
  }

  try {
    const decoded = JSON.parse(Buffer.from(parsed.value ?? '', 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof decoded.timestamp !== 'string' || typeof decoded.id !== 'string') {
      return { error: 'invalid cursor' };
    }
    if (parseTimestamp(decoded.timestamp, 'cursor.timestamp', { required: true })) {
      return { error: 'invalid cursor' };
    }
    return { cursor: { timestamp: decoded.timestamp, id: decoded.id } };
  } catch {
    return { error: 'invalid cursor' };
  }
}

function addFilterSql(filters: QueryFilters, values: unknown[], conditions: string[], timeColumn = 'timestamp') {
  if (filters.service) {
    values.push(filters.service);
    conditions.push(`service = $${values.length}`);
  }

  if (filters.level) {
    values.push(filters.level);
    conditions.push(`level = $${values.length}`);
  }

  if (filters.since) {
    values.push(filters.since);
    conditions.push(`${timeColumn} >= $${values.length}`);
  }

  if (filters.until) {
    values.push(filters.until);
    conditions.push(`${timeColumn} < $${values.length}`);
  }

  if (filters.q) {
    values.push(`%${filters.q}%`);
    conditions.push(`message ILIKE $${values.length}`);
  }

  for (const [key, value] of Object.entries(filters.attributes)) {
    values.push(key);
    const keyParam = values.length;
    values.push(value);
    conditions.push(`attributes ->> $${keyParam} = $${values.length}`);
  }
}

function canUseMinuteRollup(filters: QueryFilters) {
  return !filters.q && Object.keys(filters.attributes).length === 0;
}

function aggregateSourceTable(filters: QueryFilters, bucket: string) {
  if (!canUseMinuteRollup(filters)) {
    return 'logs';
  }

  if (bucket === '1h' || bucket === '1d') {
    return 'log_rollups_hour';
  }

  return 'log_rollups_minute';
}

function jsonLog(row: Record<string, unknown>) {
  const timestamp = row.timestamp instanceof Date ? row.timestamp.toISOString() : new Date(String(row.timestamp)).toISOString();
  return {
    id: String(row.id),
    timestamp,
    level: row.level,
    service: row.service,
    message: row.message,
    attributes: row.attributes ?? {},
  };
}
const logBatchBodySchema = {


  type: 'object',
  additionalProperties: false,
  properties: {
    logs: {
      type: 'array',
      description: 'Batch of structured log entries. A batch with one entry is valid.',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          timestamp: { type: 'string' },

          level: { type: 'string' },

          service: { type: 'string' },

          message: { type: 'string' },

          attributes: {

            type: 'object',

            additionalProperties: true,

          },

        },

      },

    },

  },

} as const;


const logQueryStringSchema = {
  type: 'object',

  additionalProperties: true,
  properties: {
    service: { type: 'string', description: 'Exact service-name match' },
    level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'], description: 'Exact log level match' },
    since: { type: 'string', description: 'Inclusive start timestamp, for example 2026-07-20T14:00:00Z' },
    until: { type: 'string', description: 'Exclusive end timestamp, for example 2026-07-20T15:00:00Z' },
    q: { type: 'string', description: 'Case-insensitive substring match on message' },
    limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
    cursor: { type: 'string', description: 'Opaque cursor returned by a previous response' },

    'attr.user_id': { type: 'string', description: 'Example attribute filter. You can also use attr.<key> manually.' },
  },
} as const;
const aggregateQueryStringSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['since', 'until', 'bucket'],
  properties: {
    service: { type: 'string', description: 'Exact service-name match' },
    level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'], description: 'Exact log level match' },
    since: { type: 'string', description: 'Inclusive aggregation start timestamp, for example 2026-07-20T14:00:00Z' },
    until: { type: 'string', description: 'Exclusive aggregation end timestamp, for example 2026-07-20T15:00:00Z' },
    bucket: { type: 'string', enum: ['1m', '5m', '1h', '1d'], description: 'Aggregation bucket size' },
    group_by: { type: 'string', enum: ['service', 'level'], description: 'Optional grouping dimension' },
    q: { type: 'string', description: 'Case-insensitive substring match on message' },
    'attr.user_id': { type: 'string', description: 'Example attribute filter. You can also use attr.<key> manually.' },
  },
} as const;
export async function logRoutes(app: FastifyInstance) {
  app.post('/logs',{

     schema: {
      tags: ['Logs'],
      summary: 'Ingest a batch of structured logs',
      description: 'Accepts a logs array, validates each entry independently, and stores valid entries.',
      body: logBatchBodySchema,
      response: {
        200: {
          type: 'object',
          properties: {
            accepted: { type: 'number' },
            rejected: {
              type: 'array',
              items: {
                type: 'object',
                properties: {

                  index: { type: 'number' },

                  reason: { type: 'string' },

                },
              },
            },
          },
        },
        400: {
          type: 'object',
          additionalProperties: true,
          properties: {
            error: { type: 'string' },
            accepted: { type: 'number' },
            rejected: {
              type: 'array',
              items: {
                type: 'object',

                properties: {

                  index: { type: 'number' },

                  reason: { type: 'string' },

                },

              },

            },

          },

        },

      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body;
    if (!isPlainObject(body) || !Array.isArray(body.logs)) {
      return reply.status(400).send({ accepted: 0, rejected: [{ index: -1, reason: 'request body must be an object with a logs array' }] });
    }

    const validLogs: ValidLogInput[] = [];
    const rejected: Array<{ index: number; reason: string }> = [];

    body.logs.forEach((rawLog, index) => {
      const result = validateLogEntry(rawLog);
      if (result.log) {
        validLogs.push(result.log);
      } else {
        rejected.push({ index, reason: result.reason ?? 'invalid log entry' });
      }
    });

    if (validLogs.length === 0) {
      return reply.status(400).send({ accepted: 0, rejected });
    }
//بناء استعلام الإدخال الجماعي المتعدد (Bulk Insert Dynamic SQL
    const values: unknown[] = [];
    const tuples = validLogs.map((log, index) => {
      const offset = index * 5;
      values.push(log.timestamp, log.level, log.service, log.message, JSON.stringify(log.attributes));
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}::jsonb, false)`;
    });

    await pool.query(
      `INSERT INTO logs (timestamp, level, service, message, attributes, rollup_processed)
       VALUES ${tuples.join(', ')}`,
      values,
    );

    return reply.status(200).send({ accepted: validLogs.length, rejected });
  });

  app.get('/logs', {

     schema: {
      tags: ['Logs'],
      summary: 'Query logs',
      description: 'Search logs with freely combinable filters and cursor pagination.',
      querystring: logQueryStringSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            logs: { type: 'array', items: { type: 'object', additionalProperties: true } },
            next_cursor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  },async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const filterResult = parseFilters(query, { requireRange: false });
    if (filterResult.error || !filterResult.filters) {
      return reply.status(400).send({ error: filterResult.error });
    }

    const limitResult = parseLimit(query.limit);
    if (limitResult.error || !limitResult.limit) {
      return reply.status(400).send({ error: limitResult.error });
    }

    const cursorResult = decodeCursor(query.cursor);
    if (cursorResult.error) {
      return reply.status(400).send({ error: cursorResult.error });
    }

    const values: unknown[] = [];
    const conditions: string[] = [];
    addFilterSql(filterResult.filters, values, conditions);

    if (cursorResult.cursor) {
      values.push(cursorResult.cursor.timestamp);
      const timestampParam = values.length;
      values.push(cursorResult.cursor.id);
      conditions.push(`(timestamp < $${timestampParam} OR (timestamp = $${timestampParam} AND id < $${values.length}))`);
    }

    values.push(limitResult.limit + 1);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT id, timestamp, level, service, message, attributes
       FROM logs
       ${whereClause}
       ORDER BY timestamp DESC, id DESC
       LIMIT $${values.length}`,
      values,
    );

    const hasMore = result.rows.length > limitResult.limit;
    const rows = hasMore ? result.rows.slice(0, limitResult.limit) : result.rows;
    const nextCursor = hasMore ? encodeCursor(rows[rows.length - 1]) : null;

    return reply.status(200).send({
      logs: rows.map(jsonLog),
      next_cursor: nextCursor,
    });
  });

  app.get('/logs/aggregate', {
     schema: {

      tags: ['Logs'],

      summary: 'Aggregate logs into time buckets',

      description: 'Returns time-bucketed log counts with optional filtering and grouping.',

      querystring: aggregateQueryStringSchema,

      response: {

        200: {
          type: 'object',
          properties: {
            buckets: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  start: { type: 'string' },

                  group: { anyOf: [{ type: 'string' }, { type: 'null' }] },

                  count: { type: 'number' },

                },
              },
            },
          },
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  },async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const filterResult = parseFilters(query, { requireRange: true });
    if (filterResult.error || !filterResult.filters) {
      return reply.status(400).send({ error: filterResult.error });
    }

    const bucketResult = singleValue(query.bucket, 'bucket');
    if (bucketResult.error) {
      return reply.status(400).send({ error: bucketResult.error });
    }

    const bucketMap: Record<string, string> = {
      '1m': '1 minute',
      '5m': '5 minutes',
      '1h': '1 hour',
      '1d': '1 day',
    };
    const bucketInterval = bucketMap[bucketResult.value ?? ''];
    if (!bucketInterval) {
      return reply.status(400).send({ error: 'bucket must be one of 1m, 5m, 1h, or 1d' });
    }

    const groupByResult = singleValue(query.group_by, 'group_by');
    if (groupByResult.error) {
      return reply.status(400).send({ error: groupByResult.error });
    }

    const groupBy = groupByResult.value;
    if (groupBy !== undefined && groupBy !== 'service' && groupBy !== 'level') {
      return reply.status(400).send({ error: 'group_by must be service or level' });
    }

    const sourceTable = aggregateSourceTable(filterResult.filters, bucketResult.value ?? '');
    const values: unknown[] = [];
    values.push(bucketInterval);
    const bucketParam = values.length;
    values.push(filterResult.filters.since);
    const originParam = values.length;

    const groupSelect = groupBy ? `${groupBy} AS grouped_value` : 'NULL::text AS grouped_value';
    const groupResultSelect = groupBy ? 'grouped_value AS "group"' : 'NULL AS "group"';
    const groupClause = groupBy ? ', grouped_value' : '';

    let result;
    if (sourceTable === 'logs') {
      const conditions: string[] = [];
      addFilterSql(filterResult.filters, values, conditions);
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      result = await pool.query(
        `WITH bucketed AS (
           SELECT date_bin($${bucketParam}::interval, timestamp, $${originParam}::timestamptz) AS bucket_start,
                  ${groupSelect},
                  1 AS count
           FROM logs
           ${whereClause}
         )
         SELECT bucket_start AS start, ${groupResultSelect}, COUNT(*)::int AS count
         FROM bucketed
         GROUP BY bucket_start${groupClause}
         ORDER BY bucket_start ASC${groupBy ? ', grouped_value ASC' : ''}`,
        values,
      );
    } else {
      const rollupConditions: string[] = [];
      addFilterSql(filterResult.filters, values, rollupConditions, 'bucket_start');
      const pendingConditions: string[] = ['rollup_processed = false'];
      addFilterSql(filterResult.filters, values, pendingConditions, 'timestamp');
      const rollupWhereClause = rollupConditions.length > 0 ? `WHERE ${rollupConditions.join(' AND ')}` : '';
      const pendingWhereClause = `WHERE ${pendingConditions.join(' AND ')}`;

      result = await pool.query(
        `WITH bucketed AS (
           SELECT date_bin($${bucketParam}::interval, bucket_start, $${originParam}::timestamptz) AS bucket_start,
                  ${groupSelect},
                  count
           FROM ${sourceTable}
           ${rollupWhereClause}
           UNION ALL
           SELECT date_bin($${bucketParam}::interval, timestamp, $${originParam}::timestamptz) AS bucket_start,
                  ${groupSelect},
                  1 AS count
           FROM logs
           ${pendingWhereClause}
         )
         SELECT bucket_start AS start, ${groupResultSelect}, SUM(count)::int AS count
         FROM bucketed
         GROUP BY bucket_start${groupClause}
         ORDER BY bucket_start ASC${groupBy ? ', grouped_value ASC' : ''}`,
        values,
      );
    }

    return reply.status(200).send({
      buckets: result.rows.map((row) => ({
        start: row.start instanceof Date ? row.start.toISOString() : new Date(row.start).toISOString(),
        group: row.group,
        count: row.count,
      })),
    });
  });
}

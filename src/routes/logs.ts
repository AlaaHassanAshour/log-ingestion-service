import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';
import { pool } from '../db/index.js';

// Schemas
export const logSchema = z.object({
  timestamp: z.string().datetime().optional().default(() => new Date().toISOString()),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  service: z.string().min(1),
  message: z.string(),
  attributes: z.record(z.string(), z.any()).optional().default({}),
});

export type LogInput = z.infer<typeof logSchema>;

const searchQuerySchema = z.object({
  service: z.string().optional(),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  start_time: z.string().datetime().optional(),
  end_time: z.string().datetime().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().min(1).max(1000).default(50),
  offset: z.coerce.number().min(0).default(0),
});

// ✅ تحويل المخططات مباشرة لـ JSON Schema متوافق مع Swagger
const rawLogJsonSchema = zodToJsonSchema(logSchema, { target: 'openApi3' });
const rawSearchQueryJsonSchema = zodToJsonSchema(searchQuerySchema, { target: 'openApi3' });

export async function logRoutes(app: FastifyInstance) {
  // --- POST /api/logs ---
  app.post('/api/logs', {
    config: {
      rateLimit: {
        max: 300,
        timeWindow: '1 minute',
      },
    },
    schema: {
      tags: ['Logs'],
      summary: 'Ingest single or batch log entries',
      description: 'Accepts either a single log object or an array of log objects.',
      // نضع anyOf لتمرير الكائن أو المصفوفة لـ Zod بدون رفص Fastify المسبق
      body: {
        anyOf: [
          rawLogJsonSchema,
          {
            type: 'array',
            items: rawLogJsonSchema,
          },
        ],
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            ingested: { type: 'number' },
          },
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            details: { type: 'array' },
          },
        },
      },
    },
    // إيقاف الـ Validation المباشر المسبق من Fastify للـ Body ليتكفل به Zod بأخطائه الدقيقة
    attachValidation: true,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body;
      const rawLogs = Array.isArray(body) ? body : [body];

      if (!body || rawLogs.length === 0) {
        return reply.status(400).send({ error: 'Invalid log format' });
      }

      const validatedLogs: LogInput[] = [];
      for (const raw of rawLogs) {
        const parsed = logSchema.safeParse(raw);
        if (!parsed.success) {
          return reply.status(400).send({ 
            error: 'Invalid log format', 
            details: parsed.error.issues 
          });
        }
        validatedLogs.push(parsed.data);
      }

      const values: any[] = [];
      const valueTuples: string[] = [];

      validatedLogs.forEach((log, index) => {
        const offset = index * 5;
        valueTuples.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`);
        values.push(
          log.timestamp,
          log.level,
          log.service,
          log.message,
          JSON.stringify(log.attributes)
        );
      });

      const query = `
        INSERT INTO logs (timestamp, level, service, message, attributes)
        VALUES ${valueTuples.join(', ')}
        RETURNING id;
      `;

      await pool.query(query, values);

      return reply.status(201).send({ 
        success: true, 
        ingested: validatedLogs.length 
      });
    } catch (err: any) {
      request.log.error(err);
      return reply.status(500).send({ error: 'Failed to ingest logs', details: err.message });
    }
  });

  // --- GET /api/logs ---
  app.get('/api/logs', {
    config: {
      rateLimit: {
        max: 60, // حد للبحث والاستعلام: 60 طلب في الدقيقة
        timeWindow: '1 minute',
      },
    },
    schema: {
      tags: ['Logs'],
      summary: 'Query and search logs with filters and pagination',
      querystring: rawSearchQueryJsonSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  timestamp: { type: 'string' },
                  level: { type: 'string' },
                  service: { type: 'string' },
                  message: { type: 'string' },
                  attributes: { type: 'object' },
                },
              },
            },
            pagination: {
              type: 'object',
              properties: {
                total: { type: 'number' },
                limit: { type: 'number' },
                offset: { type: 'number' },
                hasMore: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const parsed = searchQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid query parameters',
          details: parsed.error.issues,
        });
      }

      const { service, level, start_time, end_time, q, limit, offset } = parsed.data;

      const conditions: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (service) {
        conditions.push(`service = $${paramIndex++}`);
        values.push(service);
      }

      if (level) {
        conditions.push(`level = $${paramIndex++}`);
        values.push(level);
      }

      if (start_time) {
        conditions.push(`timestamp >= $${paramIndex++}`);
        values.push(start_time);
      }

      if (end_time) {
        conditions.push(`timestamp <= $${paramIndex++}`);
        values.push(end_time);
      }

      if (q) {
        conditions.push(`message ILIKE $${paramIndex++}`);
        values.push(`%${q}%`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countQuery = `SELECT COUNT(*) FROM logs ${whereClause};`;
      const dataQuery = `
        SELECT id, timestamp, level, service, message, attributes
        FROM logs
        ${whereClause}
        ORDER BY timestamp DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++};
      `;

      const countResult = await pool.query(countQuery, values);
      const totalCount = parseInt(countResult.rows[0].count, 10);

      const dataResult = await pool.query(dataQuery, [...values, limit, offset]);

      return reply.status(200).send({
        data: dataResult.rows,
        pagination: {
          total: totalCount,
          limit,
          offset,
          hasMore: offset + dataResult.rows.length < totalCount,
        },
      });
    } catch (err: any) {
      console.error('❌ Error fetching logs:', err);
      return reply.status(500).send({ error: 'Internal Server Error', message: err.message });
    }
  });
}
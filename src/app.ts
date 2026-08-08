import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { logRoutes } from './routes/logs.js';
import { initDb } from './db/index.js';

export async function buildApp() {
  await initDb();

  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
      ? error.statusCode
      : 500;
    const message = error instanceof Error ? error.message : 'Internal Server Error';

    if (statusCode === 400) {
      return reply.status(400).send({ error: message });
    }

    return reply.status(statusCode).send({ error: message });
  });

  // 1. تسجيل إعدادات Swagger Core
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Log Ingestion Service API',
        description: 'High-performance log ingestion and search system built with Fastify and PostgreSQL.',
        version: '1.0.0',
      },
      servers: [
        {
          url: 'http://localhost:8080',
          description: 'Development Server',
        },
      ],
      tags: [
        { name: 'System', description: 'Health check endpoints' },
        { name: 'Logs', description: 'Log ingestion and querying endpoints' },
      ],
    },
  });

  // 2. تسجيل واجهة المستخدم Swagger UI (ستكون متاحة على /swagger)
  await app.register(fastifySwaggerUi, {
    routePrefix: '/swagger',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
  });

  // Health only becomes reachable after initDb has succeeded.
  app.get('/health', {
    schema: {
      tags: ['System'],
      summary: 'Health check endpoint',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
          },
        },
      },
    },
  }, async () => {
    return { status: 'ok' };
  });

  // تسجيل مسارات اللوجز
  await app.register(logRoutes);

  return app;
}

import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { logRoutes } from './routes/logs.js';

export async function buildApp() {
  const app = Fastify({ logger: false });

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

  // 2. تسجيل واجهة المستخدم Swagger UI (ستكون متاحة على /documentation)
  await app.register(fastifySwaggerUi, {
    routePrefix: '/documentation',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
  });

  // Health check endpoint
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
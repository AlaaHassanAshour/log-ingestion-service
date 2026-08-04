import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fastifyRateLimit from '@fastify/rate-limit'; // 👈 استيراد الإضافة
import { logRoutes } from './routes/logs.js';

export async function buildApp() {
  const app = Fastify({ logger: false });

  // 1. تسجيل الـ Rate Limiter العام للتطبيق
  await app.register(fastifyRateLimit, {
    max: 100, // حد أقصى 100 طلب
    timeWindow: '1 minute', // لكل دقيقة لكل IP
    errorResponseBuilder: (request, context) => {
      return {
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Rate limit exceeded. You can send up to ${context.max} requests per ${context.after}.`,
        expiresIn: context.after,
      };
    },
  });

  // 2. تسجيل إعدادات Swagger
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Log Ingestion Service API',
        description: 'High-performance log ingestion and search system built with Fastify and PostgreSQL.',
        version: '1.0.0',
      },
      servers: [{ url: 'http://localhost:8080', description: 'Development Server' }],
      tags: [
        { name: 'System', description: 'Health check endpoints' },
        { name: 'Logs', description: 'Log ingestion and querying endpoints' },
      ],
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: '/documentation',
  });

  // Health check endpoint (يمكن استثنائه من الـ Rate Limit إن أردت)
  app.get('/health', {
    config: {
      rateLimit: false, // تعطيل القيود عن الـ Health check
    },
    schema: {
      tags: ['System'],
      summary: 'Health check endpoint',
      response: {
        200: {
          type: 'object',
          properties: { status: { type: 'string' } },
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
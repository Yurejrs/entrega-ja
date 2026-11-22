import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { ApiConfig } from './config.js';
import { createPools, type DbPools } from './db.js';
import { ApiError } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerPlatformRoutes } from './routes/platform.js';
import { registerTenantRoutes } from './routes/tenant.js';
import { registerDeliveryRoutes } from './routes/deliveries.js';
import { registerMobileRoutes } from './routes/mobile.js';
import { classifyFailure, incrementMetric, metricsSnapshot } from './observability.js';

export async function buildServer(config: ApiConfig, injectedPools?: DbPools) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 1_048_576 });
  const pools = injectedPools ?? createPools(config);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
  await app.register(swagger, { openapi: { info: { title: 'API Entregas', version: '1.0.0-beta.1' },
    servers: [{ url: '/v1' }], tags: ['auth','platform','tenant','deliveries','mobile','files'].map(name => ({ name })) } });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler((error, request, reply) => {
    const err = error as Error & { code?: string; validation?: unknown; statusCode?: number };
    const known = error instanceof ApiError;
    const pgCode = err.code ?? '';
    const status = known ? error.statusCode : pgCode === '23505' ? 409 : ['23503','23514','22P02'].includes(pgCode) ? 400 : pgCode === '42501' ? 403 : err.statusCode && err.statusCode < 500 ? err.statusCode : err.validation ? 400 : 500;
    const code = known ? error.code : pgCode === '23505' ? 'CONFLICT' : ['23503','23514','22P02'].includes(pgCode) ? 'INVALID_DATA' : pgCode === '42501' ? 'FORBIDDEN' : status < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR';
    if (status >= 500) request.log.error(error);
    reply.status(status).send({ code, message: known ? error.message : status >= 500 ? 'Erro interno' : err.message, requestId: request.id });
  });

  app.addHook('onResponse', async (request, reply) => {
    incrementMetric('http_requests_total');
    const failure = classifyFailure(request.url, reply.statusCode);
    if (failure) incrementMetric(failure);
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/metrics', async () => ({ metrics: metricsSnapshot() }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await Promise.all([pools.auth,pools.tenant,pools.platform].map(pool => pool.query('SELECT 1')));
      await access(config.fileStorageDir,constants.R_OK | constants.W_OK);
      return { status: 'ok' };
    }
    catch { reply.status(503); return { status: 'unavailable' }; }
  });

  registerAuthRoutes(app, pools, config);
  registerPlatformRoutes(app, pools);
  registerTenantRoutes(app, pools, config);
  registerDeliveryRoutes(app, pools, config);
  registerMobileRoutes(app, pools, config);
  app.addHook('onClose', async () => { if (!injectedPools) await pools.close(); });
  return { app, pools };
}

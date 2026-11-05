import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { loadConfig } from './config-loader.js';
import { checkConnection, createDb, initOracleClient } from './db.js';
import { ApiError, createReadEngine } from './read-engine.js';

const digest = (value) => createHash('sha256').update(value).digest();

export function buildApp({ engine, apiKey, defaultLimit = 20, maxLimit = 100, logger = true }) {
  const app = Fastify({ logger });
  const expectedKey = digest(apiKey);

  const sendError = (reply, status, code, message) =>
    reply.code(status).send({ error: { code, message } });

  app.setNotFoundHandler((req, reply) => sendError(reply, 404, 'not_found', 'Route not found'));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      if (err.cause) req.log.error({ code: err.cause.code, msg: err.cause.message }, 'database error');
      return sendError(reply, err.status, err.code, err.message);
    }
    if (err.validation) return sendError(reply, 400, 'invalid_request', err.message);
    req.log.error({ msg: err.message }, 'unhandled error');
    return sendError(reply, 500, 'internal_error', 'Internal server error');
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.register(async (api) => {
    api.addHook('onRequest', async (req, reply) => {
      const key = req.headers['x-api-key'];
      if (typeof key !== 'string' || !timingSafeEqual(digest(key), expectedKey)) {
        return sendError(reply, 401, 'unauthorized', 'A valid X-API-Key header is required');
      }
    });

    api.get(
      '/api/:model',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              page: { type: 'integer', minimum: 1, default: 1 },
              limit: { type: 'integer', minimum: 1, maximum: maxLimit, default: defaultLimit },
            },
          },
        },
      },
      (req) => engine.list(req.params.model, req.query),
    );

    api.get('/api/:model/:id', (req) => engine.get(req.params.model, req.params.id));
  });

  return app;
}

const intFromEnv = (name, fallback) => {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};

async function main() {
  const { database, models } = loadConfig();
  if (!process.env.API_KEY) throw new Error('API_KEY is not set');
  const defaultLimit = intFromEnv('DEFAULT_PAGE_SIZE', 20);
  const maxLimit = intFromEnv('MAX_PAGE_SIZE', 100);
  if (defaultLimit > maxLimit) throw new Error('DEFAULT_PAGE_SIZE must not exceed MAX_PAGE_SIZE');

  initOracleClient(process.env.ORACLE_CLIENT_LIB_DIR);
  const db = createDb(database);
  await checkConnection(db);

  const app = buildApp({
    engine: createReadEngine(db, models),
    apiKey: process.env.API_KEY,
    defaultLimit,
    maxLimit,
  });
  app.addHook('onClose', () => db.destroy());
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close());

  await app.listen({ port: intFromEnv('PORT', 3000), host: process.env.HOST ?? '127.0.0.1' });
  app.log.info(`Serving ${[...models.keys()].join(', ')}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`Startup failed: ${err.message}`);
    process.exit(1);
  });
}

/**
 * Youthnic lookup backend.
 *
 * The only service that touches the Forward Scan database, and it only ever
 * reads. Packing desks call it over HTTP; they hold no connection string.
 */

import express from 'express';
import dotenv from 'dotenv';

import { testConnection, closePool, auditReadOnlyPrivileges, describeSource } from './db.js';
import { lookupByTrackingId, listSellerAccounts } from './lookup.js';
import { verifySchema } from './schema.js';
import { TtlCache } from './cache.js';

dotenv.config();

// Render supplies PORT at runtime. Local deployments can keep using
// LOOKUP_API_PORT, with 3100 as the development default.
const PORT = Number.parseInt(process.env.PORT || process.env.LOOKUP_API_PORT || '3100', 10);
const CACHE_TTL_SECONDS = Number.parseInt(process.env.VMS_LOOKUP_CACHE_SECONDS || '60', 10);
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Bounded so a long shift of unique scans cannot grow the process without end.
const cache = new TtlCache(CACHE_TTL_SECONDS, 500);

// Seller accounts change rarely, so they are cached longer than lookups.
const accountsCache = new TtlCache(300, 4);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

app.use((req, res, next) => {
  const { origin } = req.headers;

  if (ALLOWED_ORIGINS.length === 0) {
    // Electron renderers send no Origin, so no CORS header is needed by
    // default. Browsers are only allowed in when origins are configured.
    if (!origin) return next();
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

/** Is the service able to answer lookups at all. */
app.get('/api/health', async (req, res) => {
  const source = describeSource();
  let database = 'disconnected';
  let detail;

  try {
    database = (await testConnection()) ? 'connected' : 'disconnected';
  } catch (err) {
    database = 'error';
    detail = err.message;
  }

  const schema = database === 'connected'
    ? await verifySchema()
    : { ok: false, checked: false, missing: [], reason: 'Database not connected.' };

  const ready = database === 'connected' && schema.ok;

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'degraded',
    database,
    driver: source.driver,
    source: source.target,
    schema: schema.ok ? 'verified' : 'mismatch',
    schemaReason: schema.reason,
    schemaMissing: schema.missing,
    detail,
    cacheSize: cache.size(),
    cacheTtlSeconds: CACHE_TTL_SECONDS,
  });
});

/**
 * Prove, without writing anything, that the connection cannot modify Forward
 * Scan. PostgreSQL privileges are read from the catalog rather than tested by
 * attempting an INSERT, which would risk a real write if the role were
 * misconfigured.
 */
app.get('/api/readonly-audit', async (req, res) => {
  try {
    res.json(await auditReadOnlyPrivileges());
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

/**
 * The seller accounts Forward Scan knows about, so the setup wizard can be
 * filled from the database instead of hand-typed codes.
 */
app.get('/api/seller-accounts', async (req, res) => {
  const all = req.query.all === '1' || req.query.all === 'true';
  const cacheKey = all ? 'all' : 'scan-enabled';

  const hit = accountsCache.get(cacheKey);
  if (hit) return res.json({ ...hit, cached: true });

  try {
    const accounts = await listSellerAccounts(!all);
    const payload = { status: 'ok', accounts };
    accountsCache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

app.get('/api/lookup', async (req, res) => {
  const { marketplace, trackingId, channelId = '', refresh } = req.query;

  if (!marketplace || !trackingId) {
    return res.status(400).json({
      status: 'error',
      message: 'marketplace and trackingId are both required.',
    });
  }

  const cacheKey = `${marketplace}|${channelId}|${trackingId}`.toLowerCase();

  if (!refresh) {
    const hit = cache.get(cacheKey);
    if (hit) return res.json({ ...hit, cached: true });
  }

  const started = process.hrtime.bigint();
  const result = await lookupByTrackingId(marketplace, trackingId, channelId);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  // Transient failures are not cached, so a retry can still succeed. A
  // not_found is cached only briefly by the same TTL, which is what makes the
  // 5-minute sync window retryable.
  if (result.status === 'found' || result.status === 'not_found') {
    cache.set(cacheKey, result);
  }

  res.json({ ...result, lookupMs: Math.round(elapsedMs) });
});

app.post('/api/cache/clear', (req, res) => {
  cache.clear();
  accountsCache.clear();
  res.json({ status: 'ok' });
});

app.use((req, res) => res.status(404).json({ status: 'error', message: 'Not found.' }));

const server = app.listen(PORT, async () => {
  const source = describeSource();
  console.log(`[server] listening on http://0.0.0.0:${PORT}`);
  console.log(`[server] source: ${source.driver} ${source.target || '(not configured)'}`);

  // Reported at startup so a schema problem is visible before the first scan.
  const schema = await verifySchema();
  if (schema.ok) {
    console.log('[server] Forward Scan schema verified (oms_orders, sku_photos, channels)');
  } else {
    console.error(`[server] schema not usable: ${schema.reason}`);
  }
});

async function shutdown() {
  console.log('\n[server] shutting down');
  server.close();
  await closePool();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

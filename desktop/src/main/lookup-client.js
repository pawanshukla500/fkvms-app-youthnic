/**
 * Lookup client — asks the backend to resolve a tracking barcode to SKUs.
 *
 * The desktop app has no database driver and no connection string; everything
 * goes through this HTTP call. Electron's net module is used so the request
 * reuses Chromium's connection pool and proxy settings instead of opening a
 * fresh socket stack per scan.
 */

const { net } = require('electron');
const config = require('./config');

const REQUEST_TIMEOUT_MS = 5000;

// Monotonic counter used to discard responses that a newer scan has already
// superseded. Without this, a slow lookup could overwrite the image of the
// parcel the operator is actually holding.
let latestRequestId = 0;

function buildUrl(baseUrl, trackingId, marketplace, options) {
  const params = new URLSearchParams({ marketplace, trackingId });
  // Scoping to the seller account (Forward Scan channels.id) is what keeps a
  // tracking ID that exists under two accounts from resolving to the wrong
  // parcel. Zero or absent means search every account.
  if (options.channelId) params.set('channelId', String(options.channelId));
  if (options.bypassCache) params.set('refresh', '1');
  return `${baseUrl.replace(/\/+$/, '')}/api/lookup?${params.toString()}`;
}

/**
 * Issue a GET and resolve with the parsed JSON body.
 * Never rejects; transport problems come back as an error-shaped result so a
 * database or network fault can never interrupt VMS recording.
 */
function getJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      try { request.abort(); } catch { /* already finished */ }
      finish({ status: 'error', message: 'Lookup timed out.' });
    }, timeoutMs);

    const request = net.request({ method: 'GET', url, redirect: 'follow' });
    request.setHeader('Accept', 'application/json');

    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          finish(JSON.parse(body));
        } catch {
          finish({ status: 'error', message: 'Lookup API returned an unreadable response.' });
        }
      });
      response.on('error', (err) => finish({ status: 'error', message: err.message }));
    });

    request.on('error', (err) => finish({
      status: 'error',
      message: 'Cannot reach the lookup service.',
      detail: err.message,
    }));

    request.end();
  });
}

/**
 * Resolve a tracking barcode.
 *
 * @param {string} trackingId
 * @param {string} marketplace
 * @param {{bypassCache?: boolean, channelId?: number}} [options]
 * @returns {Promise<object>} the backend result, or { status: 'stale' } when a
 *   newer scan has started since this call began.
 */
async function lookup(trackingId, marketplace, options = {}) {
  const requestId = ++latestRequestId;

  if (!trackingId) return { status: 'error', message: 'No tracking ID to look up.' };
  if (!marketplace) return { status: 'error', message: 'No marketplace selected.' };

  const { backendUrl } = config.getConfig();
  if (!backendUrl) {
    return { status: 'error', message: 'No lookup backend configured. Open Settings.' };
  }

  const result = await getJson(
    buildUrl(backendUrl, trackingId, marketplace, options),
    REQUEST_TIMEOUT_MS
  );

  if (requestId !== latestRequestId) return { status: 'stale' };
  return result;
}

/**
 * Probe the backend and the database behind it.
 */
function checkHealth(overrideUrl) {
  const baseUrl = overrideUrl || config.getConfig().backendUrl;
  if (!baseUrl) {
    return Promise.resolve({ status: 'error', message: 'No backend URL configured.' });
  }
  return getJson(`${baseUrl.replace(/\/+$/, '')}/api/health`, 3000);
}

/**
 * The seller accounts Forward Scan knows about.
 *
 * Used by the setup wizard so a desk is configured with real channel ids
 * instead of hand-typed numbers that could drift from the database.
 */
function fetchSellerAccounts(overrideUrl) {
  const baseUrl = overrideUrl || config.getConfig().backendUrl;
  if (!baseUrl) {
    return Promise.resolve({ status: 'error', message: 'No backend URL configured.' });
  }
  return getJson(`${baseUrl.replace(/\/+$/, '')}/api/seller-accounts`, 5000);
}

module.exports = { lookup, checkHealth, fetchSellerAccounts };

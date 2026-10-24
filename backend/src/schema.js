/**
 * Startup check that Forward Scan still looks the way the lookup expects.
 *
 * The schema is fixed and verified (see the header of `lookup.js`), so there is
 * nothing to configure. What this does is confirm the tables and columns are
 * actually present, so a schema drift upstream produces one clear message at
 * startup instead of a confusing per-scan failure on the packing floor.
 */

import { readOnlyQuery, getDriver } from './db.js';

/** Table -> the columns the lookup reads. */
const REQUIRED = {
  oms_orders: [
    'id', 'tracking_raw', 'tracking_norm', 'channel_id', 'channel_label',
    'company', 'item_count', 'total_qty', 'items_json', 'status_group', 'synced_at',
  ],
  sku_photos: ['sku', 'title', 'image_url', 'marketplace'],
  channels: ['id', 'name', 'marketplace', 'company', 'scan_enabled'],
};

let cached = null;

/**
 * @returns {Promise<{ok: boolean, checked: boolean, missing: string[], reason: string|null}>}
 */
export async function verifySchema({ force = false } = {}) {
  if (cached && !force) return cached;

  if (getDriver() === 'unset') {
    cached = {
      ok: false,
      checked: false,
      missing: [],
      reason: 'VMS_DATABASE_URL is not set.',
    };
    return cached;
  }

  let present;
  try {
    present = await readColumns();
  } catch (err) {
    // Unreachable database is reported by the health check separately; do not
    // cache it, so the service recovers as soon as the database comes back.
    return {
      ok: false,
      checked: false,
      missing: [],
      reason: `Could not read the schema: ${err.message}`,
    };
  }

  const missing = [];
  for (const [table, columns] of Object.entries(REQUIRED)) {
    const found = present.get(table);
    if (!found) {
      missing.push(`${table} (table missing)`);
      continue;
    }
    for (const column of columns) {
      if (!found.has(column)) missing.push(`${table}.${column}`);
    }
  }

  cached = {
    ok: missing.length === 0,
    checked: true,
    missing,
    reason: missing.length === 0
      ? null
      : `Forward Scan is missing expected columns: ${missing.join(', ')}`,
  };
  return cached;
}

async function readColumns() {
  const map = new Map();

  if (getDriver() === 'sqlite') {
    const tables = await readOnlyQuery(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('oms_orders', 'sku_photos', 'channels')",
    );
    for (const table of tables) {
      // PRAGMA is refused by the query guard, so columns come from the stored
      // DDL instead. Only the identifier before the first type keyword matters.
      const body = String(table.sql || '');
      const inner = body.slice(body.indexOf('(') + 1, body.lastIndexOf(')'));
      const columns = new Set();
      for (const part of splitTopLevel(inner)) {
        const match = part.trim().match(/^["'`[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?\s/);
        if (match) columns.add(match[1]);
      }
      map.set(table.name, columns);
    }
    return map;
  }

  const rows = await readOnlyQuery(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name IN ('oms_orders', 'sku_photos', 'channels')
  `);

  for (const row of rows) {
    if (!map.has(row.table_name)) map.set(row.table_name, new Set());
    map.get(row.table_name).add(row.column_name);
  }
  return map;
}

/** Split a CREATE TABLE body on commas that are not inside parentheses. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

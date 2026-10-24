/**
 * Tracking ID -> SKU, quantity and product image.
 *
 * The schema below is not inferred. It was read out of Forward Scan's own
 * SQLAlchemy models (`backend/app/models.py`) and confirmed against a live
 * database snapshot:
 *
 *   oms_orders   one row per shipment. `tracking_norm` is the normalised AWB
 *                and carries an index (ix_oms_orders_tracking_norm).
 *                `items_json` is a JSON array of
 *                  {sku, qty, sub_order_id, status, amount}
 *                and, on data written by current Forward Scan builds, also
 *                  {title, image_url}
 *                (see `parse_order_row` in Forward Scan's oms/mapping.py).
 *   sku_photos   sku (PK, normalised via normalize_sku_key), title, image_url,
 *                marketplace. Populated by Forward Scan's `sku_photos` job.
 *   channels     id, name, marketplace, company, scan_enabled. One row per
 *                seller account, e.g. "ETHNIC JUNCTION - Myntra Youthnic".
 *
 * `items_json` is parsed in this process rather than in SQL, because Forward
 * Scan declares the column as TEXT on both SQLite and PostgreSQL, so neither
 * backend can be relied on to expose JSON operators over it.
 */

import { readOnlyQuery } from './db.js';
import {
  normalizeTracking, normalizeSkuKey, normalizeImageUrl, decodeHtmlEntities,
} from './normalize.js';

/**
 * Columns read from oms_orders. Listed explicitly so an upstream schema change
 * fails loudly here instead of silently returning something unexpected.
 */
const ORDER_SQL = `
  SELECT o.id,
         o.tracking_raw,
         o.tracking_norm,
         o.channel_id,
         o.channel_label,
         o.company,
         o.warehouse,
         o.channel_order_id,
         o.invoice_id,
         o.item_count,
         o.total_qty,
         o.items_json,
         o.status_text,
         o.status_group,
         o.order_date,
         o.synced_at,
         c.name AS channel_name,
         c.marketplace AS channel_marketplace,
         c.company AS channel_company
  FROM oms_orders o
  LEFT JOIN channels c ON c.id = o.channel_id
  WHERE o.tracking_norm = $1
`;

/**
 * Which Forward Scan `channels.marketplace` values belong to each VMS.
 *
 * Taken from the live channels table. Used only to warn when a parcel is
 * scanned at the wrong desk; it never suppresses a result, because the operator
 * is holding the parcel and needs to see what is in it either way.
 */
const MARKETPLACE_PREFIXES = {
  flipkart: ['flipkart'],
  myntra: ['myntra'],
};

/**
 * Look up everything the packing panel needs for one scanned barcode.
 *
 * @param {string} marketplace 'flipkart' or 'myntra' (the desk's current VMS)
 * @param {string} trackingId  the barcode exactly as scanned
 * @param {number|string|null} channelId  Forward Scan channels.id for the
 *        active seller account, or null to search every account
 * @returns {Promise<object>}
 */
export async function lookupByTrackingId(marketplace, trackingId, channelId = null) {
  const trackingNorm = normalizeTracking(trackingId);

  if (!trackingNorm) {
    return {
      status: 'error',
      trackingId,
      message: 'The scanned value contained no usable characters.',
    };
  }

  const channel = parseChannelId(channelId);

  let rows;
  try {
    rows = channel === null
      ? await readOnlyQuery(ORDER_SQL, [trackingNorm])
      : await readOnlyQuery(`${ORDER_SQL} AND o.channel_id = $2`, [trackingNorm, channel]);
  } catch (err) {
    return {
      status: 'error',
      trackingId,
      trackingNorm,
      message: `Lookup failed: ${err.message}`,
    };
  }

  if (rows.length === 0) {
    // Either Forward Scan has not synced this order yet, or it belongs to a
    // different seller account than the one selected at this desk.
    return {
      status: 'not_found',
      trackingId,
      trackingNorm,
      marketplace,
      channelId: channel,
      message: channel === null
        ? 'No order in Forward Scan carries this tracking ID yet.'
        : 'No order for this tracking ID under the selected seller account.',
    };
  }

  const shipment = pickShipment(rows);
  const items = parseItems(shipment.items_json);
  const photos = await loadPhotos(items);

  const resolved = items.map((item) => {
    const key = normalizeSkuKey(item.sku);
    const photo = photos.bySku.get(key);
    // An image carried on the order line is preferred: it is the listing image
    // for that exact sub-order, whereas sku_photos is a per-SKU fallback.
    const ownImage = normalizeImageUrl(item.image_url);
    const photoImage = photo ? normalizeImageUrl(photo.image_url) : null;

    return {
      sku: item.sku,
      qty: item.qty,
      title: decodeHtmlEntities(item.title) || decodeHtmlEntities(photo ? photo.title : null),
      imageUrl: ownImage || photoImage,
      imageSource: ownImage ? 'order_item' : (photoImage ? 'sku_photos' : null),
      status: item.status || null,
      subOrderId: item.sub_order_id || null,
    };
  });

  const withImages = resolved.filter((item) => item.imageUrl).length;

  return {
    status: 'found',
    trackingId,
    trackingNorm,
    marketplace,
    marketplaceMismatch: isMismatch(marketplace, shipment.channel_marketplace),
    sellerAccount: {
      channelId: shipment.channel_id,
      name: shipment.channel_name || shipment.channel_label || null,
      company: shipment.channel_company || shipment.company || null,
      marketplace: shipment.channel_marketplace || null,
    },
    orderStatus: shipment.status_group || null,
    orderStatusText: shipment.status_text || null,
    channelOrderId: shipment.channel_order_id || null,
    invoiceId: shipment.invoice_id || null,
    syncedAt: shipment.synced_at || null,
    items: resolved,
    itemCount: resolved.length,
    totalQty: resolved.reduce((sum, item) => sum + (Number(item.qty) || 0), 0),
    imagesResolved: withImages,
    imagesMissing: resolved.length - withImages,
    // Set when sku_photos could not be consulted at all, which is a different
    // problem from a SKU simply having no photo row.
    photoTableUnavailable: photos.unavailable,
    multipleShipments: rows.length > 1,
    shipmentCount: rows.length,
  };
}

/**
 * List the seller accounts Forward Scan knows about.
 *
 * The setup wizard uses this so the desk is configured with real channel ids
 * rather than hand-typed codes that could drift from the database.
 *
 * @param {boolean} scanEnabledOnly restrict to channels flagged for scanning
 */
export async function listSellerAccounts(scanEnabledOnly = true) {
  // The predicate is a fixed literal rather than a bound value: PostgreSQL
  // wants `= true` and SQLite stores 0/1, and a bare truthiness test is the
  // one form both accept.
  const rows = await readOnlyQuery(`
    SELECT id, name, marketplace, company, oms_status, scan_enabled
    FROM channels
    ${scanEnabledOnly ? 'WHERE scan_enabled' : ''}
    ORDER BY company, marketplace, name
  `);

  return rows.map((row) => ({
    channelId: Number(row.id),
    name: row.name,
    marketplace: row.marketplace,
    company: row.company,
    omsStatus: row.oms_status,
    // SQLite stores booleans as 0/1, PostgreSQL as true/false.
    scanEnabled: row.scan_enabled === true || row.scan_enabled === 1,
  }));
}

function parseChannelId(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Choose which row to show when one tracking ID maps to several shipments.
 *
 * Prefers a live order over a cancelled one, then the most recently synced,
 * so a re-used AWB does not surface a stale cancelled parcel.
 */
function pickShipment(rows) {
  if (rows.length === 1) return rows[0];

  const rank = (row) => {
    const group = String(row.status_group || '').toUpperCase();
    if (group === 'CANCELLED') return 2;
    if (group === 'SHIPPED') return 1;
    return 0;
  };

  return [...rows].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return String(b.synced_at || '').localeCompare(String(a.synced_at || ''));
  })[0];
}

function parseItems(itemsJson) {
  if (!itemsJson) return [];
  let parsed;
  try {
    parsed = JSON.parse(itemsJson);
  } catch {
    // Malformed JSON is a Forward Scan data problem, not something to guess at.
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item) => item && typeof item === 'object' && item.sku)
    .map((item) => ({
      sku: String(item.sku).trim(),
      qty: Number(item.qty) || 0,
      title: item.title ? String(item.title).trim() : null,
      image_url: item.image_url || null,
      status: item.status || null,
      sub_order_id: item.sub_order_id || null,
    }));
}

/**
 * Fetch photo rows for the SKUs on this shipment.
 *
 * Keyed on the already-normalised `sku_photos.sku`, which is how Forward Scan
 * stores it (`_store_sku_photos` writes `normalize_sku_key(...)`).
 */
async function loadPhotos(items) {
  const keys = [...new Set(items.map((item) => normalizeSkuKey(item.sku)).filter(Boolean))];
  if (keys.length === 0) return { bySku: new Map(), unavailable: false };

  const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');

  try {
    const rows = await readOnlyQuery(
      `SELECT sku, title, image_url, marketplace FROM sku_photos WHERE sku IN (${placeholders})`,
      keys,
    );
    return {
      bySku: new Map(rows.map((row) => [row.sku, row])),
      unavailable: false,
    };
  } catch (err) {
    // Missing photos must never fail the whole lookup: the SKU and quantity are
    // what the operator needs most, and they are already in hand.
    console.error('[lookup] sku_photos unavailable:', err.message);
    return { bySku: new Map(), unavailable: true };
  }
}

function isMismatch(deskMarketplace, channelMarketplace) {
  const prefixes = MARKETPLACE_PREFIXES[String(deskMarketplace || '').toLowerCase()];
  if (!prefixes || !channelMarketplace) return false;
  const actual = String(channelMarketplace).toLowerCase();
  return !prefixes.some((prefix) => actual.startsWith(prefix));
}

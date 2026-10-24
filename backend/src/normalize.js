/**
 * Normalisation rules copied from Forward Scan's own
 * `backend/app/oms/mapping.py`.
 *
 * These must stay byte-for-byte equivalent to the Python versions. Forward Scan
 * stores `oms_orders.tracking_norm` and `sku_photos.sku` already normalised, so
 * if our normalisation diverges even slightly, scans stop matching and the desk
 * silently shows "not found" for parcels that are present.
 */

// Python: _SUFFIX_RE = re.compile(r"\s*\([^)]*\)\s*")
// Strips courier suffixes such as "( EK_E2E )" before the character filter, so
// the parentheses content cannot leak through as stray characters.
const SUFFIX_RE = /\s*\([^)]*\)\s*/g;

// Python: _TRACK_KEEP = re.compile(r"[^A-Z0-9\-_/]")
const TRACK_DROP_RE = /[^A-Z0-9\-_/]/g;

/**
 * Canonical tracking form used by Forward Scan for AWB lookups.
 *
 * Mirrors `normalize_tracking`: strip bracketed suffixes, uppercase, drop every
 * character outside [A-Z0-9-_/], then trim leading/trailing `-`, `_` and `/`.
 *
 * @param {string|null|undefined} raw
 * @returns {string}
 */
export function normalizeTracking(raw) {
  if (!raw) return '';
  let s = String(raw).replace(SUFFIX_RE, ' ').trim().toUpperCase();
  s = s.replace(TRACK_DROP_RE, '');
  return trimChars(s, '-_/');
}

/**
 * Canonical SKU key used by Forward Scan for `sku_photos.sku`.
 *
 * Mirrors `normalize_sku_key`: collapse whitespace runs to a single space,
 * trim, uppercase. Note it does NOT remove separators or size suffixes.
 *
 * @param {string|null|undefined} value
 * @returns {string}
 */
export function normalizeSkuKey(value) {
  if (!value) return '';
  return String(value).replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * Python's `str.strip(chars)` removes any of the given characters from both
 * ends; JavaScript's `trim` cannot express that.
 */
function trimChars(input, chars) {
  let start = 0;
  let end = input.length;
  while (start < end && chars.includes(input[start])) start += 1;
  while (end > start && chars.includes(input[end - 1])) end -= 1;
  return input.slice(start, end);
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
};

/**
 * Decode HTML entities in a product title.
 *
 * Marketplace listing titles reach Forward Scan still escaped, so a saree
 * described as "Beige &amp; Black" would otherwise be shown to the operator
 * with the entity visible. The decoded text is rendered with textContent, so
 * decoding here cannot introduce markup into the panel.
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function decodeHtmlEntities(value) {
  if (!value || typeof value !== 'string') return null;
  const decoded = value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
  const trimmed = decoded.replace(/\s+/g, ' ').trim();
  return trimmed || null;
}

/**
 * Promote protocol-relative and plain-HTTP image URLs to HTTPS.
 *
 * Mirrors `normalize_image_url`. Applied on read as well as on write, because
 * rows stored by older Forward Scan builds may predate the rule, and a
 * plain-HTTP image would be blocked by the renderer's content policy.
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function normalizeImageUrl(value) {
  if (!value || typeof value !== 'string') return null;
  const url = value.trim();
  if (!url) return null;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.toLowerCase().startsWith('http://')) return `https://${url.slice(7)}`;
  return url;
}

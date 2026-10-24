/**
 * SKU panel for the packing screen.
 *
 * Draws only what the operator needs while packing: the product image, the SKU
 * name, the quantity, and a minimal loading / not-found / error state. The VMS
 * itself lives in a separate browser view covering the left side of the window.
 *
 * The result shape comes from the backend's /api/lookup and is built directly
 * from Forward Scan's own data:
 *   { status, trackingId, marketplaceMismatch, sellerAccount: {name, ...},
 *     items: [{sku, qty, title, imageUrl, imageSource, status}], ... }
 */

let currentBarcode = null;
let retryInFlight = false;

document.addEventListener('DOMContentLoaded', async () => {
  window.youthnic.onPackingStarted(({ marketplace, sellerAccountLabel }) => {
    document.getElementById('marketplaceName').textContent =
      marketplace.charAt(0).toUpperCase() + marketplace.slice(1);
    document.getElementById('marketplaceBadge').dataset.marketplace = marketplace;
    document.getElementById('sellerAccountName').textContent = sellerAccountLabel || '';
  });

  // The main process is the single source of truth for the split, so the panel
  // cannot end up positioned where the VMS view has already been placed.
  window.youthnic.onLayoutBounds(applyLayout);

  window.youthnic.onVmsStatus(({ message, state }) => setStatus(message, state));

  window.youthnic.onLookupLoading(({ barcode }) => {
    currentBarcode = barcode;
    showLoading(barcode);
  });

  window.youthnic.onLookupResult(renderResult);

  document.getElementById('btnBack').addEventListener('click', () => {
    window.youthnic.backToSelection();
  });

  document.getElementById('btnCollapse').addEventListener('click', () => {
    window.youthnic.setPanelCollapsed(true);
  });

  document.getElementById('btnReveal').addEventListener('click', () => {
    window.youthnic.setPanelCollapsed(false);
  });

  document.querySelectorAll('[data-action="retry"]').forEach((button) => {
    button.addEventListener('click', retry);
  });

  showConfigWarnings();
});

/**
 * Apply the split the main process calculated.
 *
 * @param {{panelWidth: number, collapsed: boolean}} bounds
 */
function applyLayout({ panelWidth, collapsed }) {
  const panel = document.getElementById('skuPanel');
  const reveal = document.getElementById('btnReveal');

  document.documentElement.style.setProperty('--panel-width', `${panelWidth}px`);
  panel.hidden = Boolean(collapsed) || panelWidth <= 0;
  reveal.hidden = !panel.hidden;
}

async function showConfigWarnings() {
  const warnings = await window.youthnic.getConfigWarnings();
  if (!Array.isArray(warnings) || warnings.length === 0) return;

  const el = document.getElementById('configWarning');
  el.textContent = warnings.join(' ');
  el.hidden = false;
}

function setStatus(message, state) {
  const el = document.getElementById('statusItem');
  el.textContent = message;
  el.dataset.state = state || 'idle';
}

/**
 * Show exactly one of the panel's states.
 */
function showState(name) {
  document.querySelectorAll('.sku-state').forEach((el) => {
    el.hidden = el.dataset.state !== name;
  });
}

function showLoading(barcode) {
  document.getElementById('loadingBarcode').textContent = barcode;
  showState('loading');
}

function renderResult(result) {
  if (result.status === 'found') {
    renderItems(result);
  } else if (result.status === 'not_found') {
    document.getElementById('notFoundTracking').textContent = result.trackingId || '';
    document.getElementById('notFoundHint').textContent = result.message || '';
    showState('notfound');
  } else if (result.status === 'error') {
    document.getElementById('errorMsg').textContent = result.message || 'Lookup failed.';
    showState('error');
  }
  // 'stale' results are dropped by the main process and never arrive here.
}

function renderItems(result) {
  const list = document.getElementById('itemsList');

  // Clearing image sources before dropping the nodes lets Chromium release the
  // decoded bitmaps straight away instead of holding them for the GC. Over a
  // 200-scan shift this is the difference between flat and climbing memory.
  list.querySelectorAll('img').forEach((img) => { img.src = ''; });
  list.replaceChildren();

  document.getElementById('foundTracking').textContent = result.trackingId;

  renderMismatch(result);

  const items = Array.isArray(result.items) ? result.items : [];

  const multiSku = items.length > 1;
  const multiNotice = document.getElementById('multiSkuNotice');
  multiNotice.hidden = !multiSku;
  if (multiSku) {
    multiNotice.textContent = `${items.length} different SKUs · ${result.totalQty} pieces in this shipment`;
  }

  items.forEach((item) => list.appendChild(buildItemCard(item)));

  renderOrderMeta(result);
  showState('found');
}

/**
 * Warn when the scanned parcel is not from the account this desk is packing.
 *
 * `marketplaceMismatch` means the parcel's channel belongs to the other VMS,
 * which usually means the parcel reached the wrong desk.
 */
function renderMismatch(result) {
  const notice = document.getElementById('mismatchNotice');
  const account = result.sellerAccount || {};

  if (!result.marketplaceMismatch) {
    notice.hidden = true;
    notice.textContent = '';
    return;
  }

  notice.hidden = false;
  notice.textContent = account.name
    ? `Wrong desk: this parcel belongs to ${account.name}`
    : 'Wrong desk: this parcel belongs to another marketplace';
}

/**
 * Secondary detail, kept below the product so it never competes with the
 * image and SKU for the operator's attention.
 */
function renderOrderMeta(result) {
  const meta = document.getElementById('orderMeta');
  meta.replaceChildren();

  const account = result.sellerAccount || {};
  const rows = [];

  if (account.name) rows.push(['Account', account.name]);
  if (result.orderStatusText) rows.push(['Order', result.orderStatusText]);
  if (result.imagesMissing > 0) {
    rows.push([
      'Images',
      result.photoTableUnavailable
        ? 'Photo table unavailable'
        : `${result.imagesMissing} of ${result.itemCount} have no photo in Forward Scan`,
    ]);
  }

  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'meta-row';
    row.append(line('meta-label', label), line('meta-value', value));
    meta.appendChild(row);
  }
}

function buildItemCard(item) {
  const card = document.createElement('div');
  card.className = 'item-card';

  const figure = document.createElement('div');
  figure.className = 'item-image';

  if (item.imageUrl) {
    const img = document.createElement('img');
    // eager + high priority matter here: the operator is holding the parcel
    // and waiting, so this image must not queue behind anything.
    img.loading = 'eager';
    img.fetchPriority = 'high';
    img.decoding = 'async';
    img.alt = '';
    img.addEventListener('error', () => {
      figure.replaceChildren(fallback('Image failed to load'));
      reattachQuantity(figure, item);
    }, { once: true });
    img.src = item.imageUrl;
    figure.appendChild(img);
  } else {
    // Distinct from a load failure: Forward Scan simply has no photo for this
    // SKU, which the operator cannot fix at the desk.
    figure.appendChild(fallback('No photo in Forward Scan'));
  }

  // Quantity sits on the image rather than below the SKU text, because picking
  // the right count is as easy to get wrong as picking the right product.
  attachQuantity(figure, item);

  const details = document.createElement('div');
  details.className = 'item-details';

  // The SKU code is the thing printed on the garment bag, so it is always
  // shown. A title from Forward Scan is extra context when it exists.
  details.appendChild(line('item-name', item.sku || 'Unknown SKU'));
  if (item.title) details.appendChild(line('item-sku', item.title));

  card.append(figure, details);
  return card;
}

function attachQuantity(figure, item) {
  const quantity = Number(item.qty);
  if (!Number.isFinite(quantity) || quantity <= 0) return;
  const badge = document.createElement('span');
  badge.className = quantity > 1 ? 'qty-badge is-multiple' : 'qty-badge';
  badge.textContent = `×${quantity}`;
  figure.appendChild(badge);
}

function reattachQuantity(figure, item) {
  attachQuantity(figure, item);
}

function line(className, text) {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return el;
}

function fallback(text) {
  const el = document.createElement('div');
  el.className = 'img-fallback';
  el.textContent = text;
  return el;
}

async function retry() {
  if (!currentBarcode || retryInFlight) return;
  retryInFlight = true;
  showLoading(currentBarcode);

  try {
    const result = await window.youthnic.retryLookup(currentBarcode);
    if (result.status !== 'stale') renderResult(result);
  } finally {
    retryInFlight = false;
  }
}

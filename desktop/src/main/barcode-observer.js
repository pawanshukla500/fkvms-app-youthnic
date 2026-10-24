/**
 * Barcode Observer — watches the VMS's own AWB field and reports completed
 * scans to the main process so the SKU panel can look them up.
 *
 * Scope is deliberately narrow: the observer binds to the single element
 * #awbInput, which is the field the VMS itself drives via
 * getElementById("awbInput"). Nothing else on the page is read, so password
 * fields and unrelated keystrokes are never seen.
 *
 * The observer is passive. It attaches listeners, it does not call
 * preventDefault, it does not write to the field, it does not move focus, and
 * it does not dispatch synthetic input. The VMS receives the scan exactly as
 * the scanner typed it.
 *
 * Validation mirrors the VMS: /^[a-zA-Z0-9_-]+$/ and 4-30 characters, so our
 * panel never looks up a value the VMS itself would reject.
 */

const { getSelectors } = require('./vms-selectors');

/**
 * Build the observer script for a marketplace's verified DOM contract.
 *
 * The script is idempotent and re-entrant: a second injection tears down the
 * listeners and MutationObserver installed by the first, which is what keeps
 * SPA route changes and reloads from stacking duplicate handlers.
 */
function buildObserverScript(operator) {
  const config = JSON.stringify({
    selector: operator.awbInputSelector,
    pattern: operator.awbPattern,
    minLength: operator.awbMinLength,
    maxLength: operator.awbMaxLength,
  });

  return `
(function() {
  var cfg = ${config};

  // Tear down a previous injection so listeners never accumulate.
  if (window.__youthnicObserver && window.__youthnicObserver.teardown) {
    try { window.__youthnicObserver.teardown(); } catch (e) {}
  }

  var pattern = new RegExp(cfg.pattern);

  // Fired slightly ahead of the VMS's own ~1000 ms commit so the product image
  // is on screen by the time recording starts. A scanner delivers a whole
  // barcode in well under this window.
  var SETTLE_MS = 500;

  // A re-scan of the same AWB inside this window is the scanner firing twice,
  // not a new parcel. The VMS skips these as duplicates, so we do too.
  var DUPLICATE_WINDOW_MS = 1500;

  var lastReported = '';
  var lastReportedAt = 0;
  var settleTimer = null;
  var boundInput = null;
  var mutationObserver = null;

  function isScannableAwb(value) {
    if (!value) return false;
    if (value.length < cfg.minLength || value.length > cfg.maxLength) return false;
    return pattern.test(value);
  }

  function report(rawValue) {
    var value = (rawValue || '').trim();
    if (!isScannableAwb(value)) return;

    var now = Date.now();
    if (value === lastReported && (now - lastReportedAt) < DUPLICATE_WINDOW_MS) return;

    lastReported = value;
    lastReportedAt = now;

    if (window.__youthnicBridge && window.__youthnicBridge.reportBarcode) {
      window.__youthnicBridge.reportBarcode(value);
    }
  }

  function clearSettleTimer() {
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  }

  function onInput(event) {
    var value = event.target.value;
    clearSettleTimer();
    settleTimer = setTimeout(function() {
      settleTimer = null;
      report(value);
    }, SETTLE_MS);
  }

  // Scanners that append Enter or Tab give the strongest possible signal that
  // the barcode is complete, so the settle delay is skipped. The event is only
  // observed; it is not consumed, so the VMS still sees it.
  function onKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== 'Tab') return;
    clearSettleTimer();
    report(event.target.value);
  }

  function bind(input) {
    if (!input || input === boundInput) return;
    unbind();
    boundInput = input;
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKeyDown);
  }

  function unbind() {
    if (!boundInput) return;
    boundInput.removeEventListener('input', onInput);
    boundInput.removeEventListener('keydown', onKeyDown);
    boundInput = null;
  }

  function sync() {
    var input = document.querySelector(cfg.selector);
    if (input) {
      bind(input);
    } else if (boundInput && !boundInput.isConnected) {
      // React unmounted the scan screen, e.g. the feed was disconnected.
      unbind();
    }
  }

  sync();

  // The AWB field only exists once a feed is attached, and React replaces the
  // node across route changes, so its arrival has to be watched for.
  var root = document.body || document.documentElement;
  if (root) {
    mutationObserver = new MutationObserver(sync);
    mutationObserver.observe(root, { childList: true, subtree: true });
  }

  window.__youthnicObserver = {
    teardown: function() {
      clearSettleTimer();
      unbind();
      if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
      }
      window.__youthnicObserver = null;
    },
    isBound: function() { return !!boundInput; }
  };

  return boundInput ? 'bound' : 'waiting';
})();
`;
}

/**
 * Inject (or re-inject) the observer into the VMS page.
 * Safe to call on every dom-ready and navigation event.
 */
async function injectObserver(webContents, marketplace) {
  const selectors = getSelectors(marketplace);
  if (!selectors || !selectors.verified || !selectors.operator) {
    // Without a verified AWB field there is nothing safe to bind to, and
    // guessing would risk reading unrelated inputs.
    console.warn(`[barcode-observer] No verified scan field for ${marketplace}; observer not installed.`);
    return null;
  }

  if (!webContents || webContents.isDestroyed()) return null;

  try {
    const result = await webContents.executeJavaScript(
      buildObserverScript(selectors.operator),
      true
    );
    console.log(`[barcode-observer] ${marketplace}: ${result}`);
    return result;
  } catch (err) {
    console.error('[barcode-observer] Injection failed:', err.message);
    return null;
  }
}

module.exports = { injectObserver };

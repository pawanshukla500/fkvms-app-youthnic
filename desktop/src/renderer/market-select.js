/**
 * Marketplace selection screen.
 *
 * Only the chosen marketplace is ever loaded; neither VMS is preloaded, which
 * is what keeps a 4 GB desk to one browser engine at a time.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const config = await window.youthnic.getConfig();

  if (config.deskName) {
    document.getElementById('deskName').textContent = `${config.deskName} · ${config.deviceId}`;
  }

  await Promise.all([prepareCards(config), checkBackend()]);

  document.querySelectorAll('.market-card').forEach((card) => {
    card.addEventListener('click', () => launch(card));
  });

  document.getElementById('btnSetup').addEventListener('click', () => {
    window.youthnic.openSetup();
  });

  const updateButton = document.getElementById('btnUpdates');
  updateButton.addEventListener('click', handleUpdateButton);
  window.youthnic.onUpdateStatus(renderUpdateStatus);
});

/**
 * Fill in each card's readiness and seller accounts, so an unusable
 * marketplace is visible before it is clicked rather than failing after.
 */
async function prepareCards(config) {
  const slots = Array.from(document.querySelectorAll('.card-slot'));

  await Promise.all(slots.map(async (slot) => {
    const marketplace = slot.dataset.marketplace;
    const card = slot.querySelector('.market-card');
    const desc = card.querySelector('.card-desc');

    const [summary, accounts] = await Promise.all([
      window.youthnic.getMarketplaceSummary(marketplace),
      window.youthnic.getSellerAccounts(marketplace),
    ]);

    if (!summary.url) {
      card.dataset.ready = 'false';
      desc.textContent = 'Not configured';
      return;
    }

    card.dataset.ready = 'true';
    desc.textContent = describe(summary);

    populateAccounts(slot, accounts, config.activeSellerAccountId);
  }));
}

function describe(summary) {
  const parts = [];
  parts.push(summary.hasPassword ? 'Auto login' : 'Manual login');
  parts.push(summary.feedId ? `Feed ${summary.feedId}` : 'No Feed ID');
  return parts.join(' · ');
}

/**
 * A marketplace can have several seller accounts (Myntra has two here), and a
 * tracking ID may exist under more than one, so the account is chosen up front
 * and sent with every lookup.
 */
function populateAccounts(slot, accounts, activeId) {
  const picker = slot.querySelector('.account-picker');
  const select = picker.querySelector('select');

  if (accounts.length === 0) {
    picker.hidden = true;
    return;
  }

  select.replaceChildren();

  for (const account of accounts) {
    const option = document.createElement('option');
    option.value = account.id;
    // An account with no channel id cannot narrow the query, so say so rather
    // than letting it look like a working filter.
    option.textContent = account.channelId
      ? account.label
      : `${account.label} (searches all accounts)`;
    if (account.id === activeId) option.selected = true;
    select.appendChild(option);
  }

  // A single account needs no decision from the operator.
  picker.hidden = accounts.length === 1;
}

async function launch(card) {
  const marketplace = card.dataset.marketplace;

  if (card.dataset.ready !== 'true') {
    setStatus(`${label(marketplace)} has no VMS URL configured. Open Settings to add it.`, 'err');
    return;
  }

  const select = document.querySelector(`.card-slot[data-marketplace="${marketplace}"] select`);
  const sellerAccountId = select && select.options.length > 0 ? select.value : '';

  document.querySelectorAll('.market-card').forEach((other) => { other.disabled = true; });
  card.classList.add('loading');
  card.querySelector('.card-action span').textContent = 'Opening...';

  const result = await window.youthnic.selectMarketplace(marketplace, sellerAccountId);

  // The main process navigates away on success. On failure this view is still
  // on screen, so the buttons are made usable again.
  if (!result || !result.ok) {
    document.querySelectorAll('.market-card').forEach((other) => { other.disabled = false; });
    card.classList.remove('loading');
    card.querySelector('.card-action span').textContent = 'Select';
  }
}

function label(marketplace) {
  return marketplace.charAt(0).toUpperCase() + marketplace.slice(1);
}

function setStatus(message, kind) {
  document.getElementById('statusBar').className = `status-bar ${kind}`;
  document.getElementById('backendStatus').textContent = message;
}

async function checkBackend() {
  const result = await window.youthnic.checkBackendHealth();

  if (result.status === 'ok') {
    const via = result.driver ? ` (${result.driver})` : '';
    setStatus(`Lookup service and Forward Scan database connected${via}`, 'ok');
    return;
  }

  if (result.schema === 'mismatch' && result.database === 'connected') {
    setStatus(`Forward Scan schema does not match what the lookup expects: ${result.schemaReason || ''}`, 'err');
    return;
  }

  if (result.database && result.database !== 'connected') {
    setStatus('Lookup service reachable, but it cannot reach the Forward Scan database', 'err');
    return;
  }

  setStatus(`Lookup service unreachable: ${result.message || 'unknown error'}`, 'err');
}

let updateState = 'idle';

async function handleUpdateButton() {
  const button = document.getElementById('btnUpdates');
  button.disabled = true;

  try {
    if (updateState === 'available') {
      button.textContent = 'Downloading...';
      await window.youthnic.downloadUpdate();
      return;
    }
    if (updateState === 'downloaded') {
      button.textContent = 'Restarting...';
      await window.youthnic.installUpdate();
      return;
    }

    updateState = 'checking';
    button.dataset.state = 'checking';
    button.textContent = 'Checking...';
    const result = await window.youthnic.checkForUpdates();
    if (!result.ok && result.state !== 'unavailable') {
      renderUpdateStatus({ state: 'error', message: result.message });
    } else if (result.state === 'unavailable') {
      renderUpdateStatus(result);
    }
  } finally {
    if (updateState !== 'downloading' && updateState !== 'downloaded') {
      button.disabled = false;
    }
  }
}

function renderUpdateStatus(status) {
  const button = document.getElementById('btnUpdates');
  if (!button) return;

  updateState = status.state || 'idle';
  button.dataset.state = updateState;
  button.disabled = false;

  if (updateState === 'checking') button.textContent = 'Checking...';
  else if (updateState === 'available') button.textContent = `Download v${status.version}`;
  else if (updateState === 'downloading') {
    button.disabled = true;
    button.textContent = `Downloading ${status.percent || 0}%`;
  } else if (updateState === 'downloaded') button.textContent = `Restart for v${status.version}`;
  else if (updateState === 'current') button.textContent = 'Up to date';
  else if (updateState === 'unavailable') button.textContent = 'Updates on installed builds';
  else if (updateState === 'error') button.textContent = 'Update check failed';
  else button.textContent = 'Check for updates';

  if (updateState === 'current' || updateState === 'unavailable' || updateState === 'error') {
    setTimeout(() => {
      if (updateState === status.state) renderUpdateStatus({ state: 'idle' });
    }, 5000);
  }
}

/**
 * Setup wizard — administrator-controlled, run once per packing computer.
 *
 * Passwords are sent straight to the main process for OS-backed encryption and
 * are never read back, so an existing password shows only as "saved".
 */

const TOTAL_STEPS = 6;
const BACKEND_STEP = 5;
let currentStep = 1;

const field = (id) => document.getElementById(id);
const value = (id) => field(id).value.trim();

document.addEventListener('DOMContentLoaded', async () => {
  const config = await window.youthnic.getConfig();

  field('deviceId').value = config.deviceId || await window.youthnic.generateDeviceId();
  field('deskName').value = config.deskName || '';
  field('backendUrl').value = config.backendUrl || 'http://localhost:3100';

  await Promise.all([
    prefillMarketplace('flipkart', 'fk'),
    prefillMarketplace('myntra', 'my'),
  ]);

  renderAccounts(config.sellerAccounts || []);
  field('btnAddAccount').addEventListener('click', () => addAccountRow({
    id: '', label: '', marketplace: 'flipkart', channelId: 0,
  }));
  field('btnLoadAccounts').addEventListener('click', loadAccountsFromBackend);

  if (!await window.youthnic.isEncryptionAvailable()) {
    showNotice(
      'Windows credential encryption is unavailable on this machine, so passwords cannot be saved. '
      + 'Operators will need to log in to the VMS manually.',
      'warn'
    );
  }

  field('btnGenDevice').addEventListener('click', async () => {
    field('deviceId').value = await window.youthnic.generateDeviceId();
  });

  field('btnPrev').addEventListener('click', () => showStep(currentStep - 1));
  field('btnNext').addEventListener('click', () => {
    if (validateStep(currentStep)) showStep(currentStep + 1);
  });
  field('btnActivate').addEventListener('click', activate);
  field('btnTestBackend').addEventListener('click', testBackend);

  showStep(1);
});

async function prefillMarketplace(marketplace, prefix) {
  const summary = await window.youthnic.getMarketplaceSummary(marketplace);
  field(`${prefix}Url`).value = summary.url;
  field(`${prefix}Username`).value = summary.username;
  field(`${prefix}FeedId`).value = summary.feedId;

  if (summary.hasPassword) {
    const input = field(`${prefix}Password`);
    input.placeholder = 'Saved — leave blank to keep';
    input.dataset.hasSaved = 'true';
  }
}

function showStep(step) {
  currentStep = Math.min(TOTAL_STEPS, Math.max(1, step));

  document.querySelectorAll('.step-panel').forEach((panel) => {
    panel.hidden = Number(panel.dataset.step) !== currentStep;
  });

  document.querySelectorAll('.step').forEach((indicator) => {
    const n = Number(indicator.dataset.step);
    indicator.classList.toggle('active', n === currentStep);
    indicator.classList.toggle('completed', n < currentStep);
  });

  field('btnPrev').disabled = currentStep === 1;
  field('btnNext').hidden = currentStep === TOTAL_STEPS;
  field('btnActivate').hidden = currentStep !== TOTAL_STEPS;

  if (currentStep === TOTAL_STEPS) buildReview();
}

function validateStep(step) {
  clearNotice();

  if (step === 1) {
    if (!value('deviceId')) return fail('Generate a Device ID before continuing.');
    if (!value('deskName')) return fail('Enter a name for this packing desk.');
  }

  if (step === 2 || step === 3) {
    const prefix = step === 2 ? 'fk' : 'my';
    const url = value(`${prefix}Url`);
    if (url && !/^https?:\/\//i.test(url)) {
      return fail('The VMS URL must start with http:// or https://');
    }
    // A marketplace may be left entirely blank; it is then shown as not
    // configured on the selection screen instead of failing at launch.
  }

  if (step === 4) {
    const accounts = collectAccounts();
    const incomplete = accounts.find((account) => !account.label);
    if (incomplete) return fail('Every seller account needs a name.');

    const ids = accounts.map((account) => account.id);
    if (new Set(ids).size !== ids.length) {
      return fail('Two seller accounts have the same name. Make each one unique.');
    }

    // Two accounts sharing a channel id would make the marketplace picker
    // meaningless, since both would resolve the same Forward Scan rows.
    const channels = accounts.map((account) => account.channelId).filter(Boolean);
    if (new Set(channels).size !== channels.length) {
      return fail('Two seller accounts have the same Channel ID.');
    }
  }

  if (step === BACKEND_STEP) {
    const backend = value('backendUrl');
    if (!backend) return fail('A lookup backend URL is required.');
    if (!/^https?:\/\//i.test(backend)) {
      return fail('The backend URL must start with http:// or https://');
    }
  }

  return true;
}

function fail(message) {
  showNotice(message, 'error');
  return false;
}

function showNotice(message, kind) {
  const el = field('notice');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
}

function clearNotice() {
  field('notice').hidden = true;
}

async function testBackend() {
  const url = value('backendUrl');
  const resultEl = field('testResult');

  if (!url) {
    resultEl.textContent = 'Enter a backend URL first.';
    resultEl.dataset.kind = 'error';
    return;
  }

  resultEl.textContent = 'Testing...';
  resultEl.dataset.kind = 'pending';

  // Tested against the typed URL rather than the saved one, so an unverified
  // address is never written into this desk's configuration.
  const result = await window.youthnic.checkBackendHealth(url);

  if (result.status === 'ok') {
    resultEl.textContent = `Lookup service and Forward Scan database reachable (${result.driver}).`;
    resultEl.dataset.kind = 'ok';
  } else if (result.database === 'connected' && result.schema === 'mismatch') {
    resultEl.textContent = `Reachable, but the Forward Scan schema is not what the lookup expects: ${result.schemaReason || ''}`;
    resultEl.dataset.kind = 'warn';
  } else if (result.database) {
    resultEl.textContent = `Lookup service reachable, but it cannot read the Forward Scan database: ${result.detail || result.database}`;
    resultEl.dataset.kind = 'warn';
  } else {
    resultEl.textContent = result.message || 'Could not reach the lookup service.';
    resultEl.dataset.kind = 'error';
  }
}

/**
 * Replace the account rows with the real channels from Forward Scan.
 *
 * Only Flipkart and Myntra channels are relevant: those are the two VMS sites
 * this app wraps. Other channels (Amazon, Meesho, Ajio) are packed elsewhere.
 */
async function loadAccountsFromBackend() {
  const url = value('backendUrl');
  const resultEl = field('accountsResult');
  resultEl.hidden = false;

  if (!url) {
    resultEl.textContent = 'Set the backend URL in the next step first, then come back.';
    resultEl.dataset.kind = 'error';
    return;
  }

  resultEl.textContent = 'Loading...';
  resultEl.dataset.kind = 'pending';

  const response = await window.youthnic.fetchSellerAccounts(url);

  if (response.status !== 'ok' || !Array.isArray(response.accounts)) {
    resultEl.textContent = response.message || 'Could not read the seller accounts.';
    resultEl.dataset.kind = 'error';
    return;
  }

  const mapped = response.accounts
    .map((account) => ({
      marketplace: vmsFor(account.marketplace),
      label: account.name,
      channelId: account.channelId,
      id: slug(account.name),
    }))
    .filter((account) => account.marketplace);

  if (mapped.length === 0) {
    resultEl.textContent = 'The backend returned no Flipkart or Myntra channels.';
    resultEl.dataset.kind = 'warn';
    return;
  }

  renderAccounts(mapped);
  resultEl.textContent = `Loaded ${mapped.length} account(s) from Forward Scan. Remove any this desk does not pack.`;
  resultEl.dataset.kind = 'ok';
}

/** Which VMS a Forward Scan `channels.marketplace` value belongs to. */
function vmsFor(marketplace) {
  const name = String(marketplace || '').toLowerCase();
  if (name.startsWith('flipkart')) return 'flipkart';
  if (name.startsWith('myntra')) return 'myntra';
  return null;
}

/**
 * Seller account editor
 * ---------------------
 * Each row is a plain set of inputs; the list is read back from the DOM on
 * save so there is no second copy of the state to keep in step.
 */

function renderAccounts(accounts) {
  field('accountsList').replaceChildren();
  for (const account of accounts) addAccountRow(account);
}

function addAccountRow(account) {
  const row = document.createElement('div');
  row.className = 'account-row';

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.placeholder = 'Account name';
  labelInput.value = account.label || '';
  labelInput.dataset.role = 'label';

  const marketplaceSelect = document.createElement('select');
  marketplaceSelect.dataset.role = 'marketplace';
  for (const [v, text] of [['flipkart', 'Flipkart'], ['myntra', 'Myntra']]) {
    const option = document.createElement('option');
    option.value = v;
    option.textContent = text;
    if ((account.marketplace || 'flipkart') === v) option.selected = true;
    marketplaceSelect.appendChild(option);
  }

  const channelInput = document.createElement('input');
  channelInput.type = 'number';
  channelInput.min = '0';
  channelInput.step = '1';
  channelInput.placeholder = 'Channel ID';
  channelInput.value = account.channelId ? String(account.channelId) : '';
  channelInput.dataset.role = 'channelId';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn-remove';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => row.remove());

  // Preserved so renaming an account does not orphan the saved active
  // selection on this desk.
  row.dataset.existingId = account.id || '';

  row.append(labelInput, marketplaceSelect, channelInput, remove);
  field('accountsList').appendChild(row);
}

function collectAccounts() {
  return Array.from(document.querySelectorAll('.account-row')).map((row) => {
    const label = row.querySelector('[data-role="label"]').value.trim();
    const marketplace = row.querySelector('[data-role="marketplace"]').value;
    const channelId = Number.parseInt(row.querySelector('[data-role="channelId"]').value, 10) || 0;
    const id = row.dataset.existingId || slug(label);
    return { id, label, marketplace, channelId };
  }).filter((account) => account.label);
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function buildReview() {
  const accounts = collectAccounts();

  const rows = [
    ['Device ID', value('deviceId')],
    ['Desk name', value('deskName')],
    ['Backend URL', value('backendUrl')],
    ['Seller accounts', accounts.length
      ? accounts
        .map((a) => `${a.label} (${a.marketplace}, ${a.channelId ? `channel ${a.channelId}` : 'all accounts'})`)
        .join('; ')
      : ''],
    ['Flipkart URL', value('fkUrl')],
    ['Flipkart username', value('fkUsername')],
    ['Flipkart Feed ID', value('fkFeedId')],
    ['Flipkart password', passwordState('fkPassword')],
    ['Myntra URL', value('myUrl')],
    ['Myntra username', value('myUsername')],
    ['Myntra Feed ID', value('myFeedId')],
    ['Myntra password', passwordState('myPassword')],
  ];

  const review = field('review');
  review.replaceChildren();

  for (const [label, text] of rows) {
    const row = document.createElement('div');
    row.className = 'review-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'review-label';
    labelEl.textContent = label;

    const valueEl = document.createElement('span');
    valueEl.className = text ? 'review-value' : 'review-value muted';
    valueEl.textContent = text || 'not set';

    row.append(labelEl, valueEl);
    review.appendChild(row);
  }
}

function passwordState(id) {
  const input = field(id);
  if (input.value) return 'will be encrypted and saved';
  return input.dataset.hasSaved === 'true' ? 'already saved' : '';
}

async function activate() {
  if (!validateStep(1) || !validateStep(4) || !validateStep(BACKEND_STEP)) return;

  field('btnActivate').disabled = true;

  try {
    await window.youthnic.saveSellerAccounts(collectAccounts());
    await window.youthnic.completeSetup({
      deviceId: value('deviceId'),
      deskName: value('deskName'),
      backendUrl: value('backendUrl'),
      flipkartUrl: value('fkUrl'),
      flipkartUsername: value('fkUsername'),
      flipkartFeedId: value('fkFeedId'),
      myntraUrl: value('myUrl'),
      myntraUsername: value('myUsername'),
      myntraFeedId: value('myFeedId'),
    });

    await saveMarketplace('flipkart', 'fk');
    await saveMarketplace('myntra', 'my');

    // Hands control back to the main process, which shows the marketplace
    // screen now that setup is marked complete.
    await window.youthnic.backToSelection();
  } catch (err) {
    field('btnActivate').disabled = false;
    showNotice(`Could not save the configuration: ${err.message}`, 'error');
  }
}

async function saveMarketplace(marketplace, prefix) {
  const password = field(`${prefix}Password`).value;

  await window.youthnic.saveCredentials(marketplace, {
    url: value(`${prefix}Url`),
    username: value(`${prefix}Username`),
    feedId: value(`${prefix}FeedId`),
    // An empty field means "keep whatever is already stored".
    password: password || undefined,
  });
}

/**
 * Configuration management for Youthnic Packing Desk.
 *
 * Non-sensitive config (device ID, desk name, feed IDs, backend URL) is stored
 * in electron-store. Passwords are encrypted with Electron's safeStorage, which
 * is backed by Windows DPAPI, and only the ciphertext is persisted.
 *
 * safeStorage avoids a native dependency, so packing desks do not need
 * Visual Studio build tools to install the app.
 */

const Store = require('electron-store');
const { safeStorage, app } = require('electron');

const store = new Store({
  name: 'youthnic-config',
});

const SECRET_STORE_KEY = 'secrets';

/**
 * Default configuration.
 */
function getDefaultConfig() {
  return {
    deviceId: '',
    deskName: '',
    isFirstRun: true,
    activated: false,
    marketplaces: {
      flipkart: {
        url: 'https://fkvms.synlabs.io/',
        username: '',
        feedId: '',
        // password is stored separately, encrypted
      },
      myntra: {
        url: '',
        username: '',
        feedId: '',
      },
    },
    // Seller accounts this desk is allowed to pack for. A tracking ID can
    // repeat across accounts, so the active account is sent with every lookup
    // to keep the panel from showing another seller's parcel.
    sellerAccounts: getDefaultSellerAccounts(),
    activeSellerAccountId: '',
    backendUrl: 'http://localhost:3100',
    // Operators who need the VMS at full width (reviewing Pending or Error
    // Requests) can hide the SKU panel, and the choice persists per desk.
    panelCollapsed: false,
  };
}

/**
 * The accounts currently in use.
 *
 * `channelId` is Forward Scan's `channels.id`, read from the live database:
 * 17040 ETHNIC JUNCTION - Flipkart, 51680 ETHNIC JUNCTION - Myntra Youthnic,
 * 18116 VB EXPORT - Myntra PPMP. It is sent with every lookup so a tracking ID
 * that exists under more than one account resolves to this desk's seller.
 *
 * A channelId of 0 means "do not filter", which searches every account.
 * Step 4 of the setup wizard can refresh these from the backend.
 */
function getDefaultSellerAccounts() {
  // Labels match Forward Scan's own channels.name exactly, so what the operator
  // sees on the desk is what an administrator sees in Forward Scan. Plain
  // hyphens, not dashes, because this value round-trips through JSON on disk.
  return [
    { id: 'ethnic-junction-flipkart', label: 'ETHNIC JUNCTION - Flipkart', marketplace: 'flipkart', channelId: 17040 },
    { id: 'ethnic-junction-myntra-youthnic', label: 'ETHNIC JUNCTION - Myntra Youthnic', marketplace: 'myntra', channelId: 51680 },
    { id: 'vb-export-myntra-ppmp', label: 'VB EXPORT - Myntra PPMP', marketplace: 'myntra', channelId: 18116 },
  ];
}

/**
 * Bring seller accounts saved by an earlier build up to date.
 *
 * Builds before the schema was verified stored a free-text `code` and no
 * `channelId`. Such an account cannot scope a lookup, so a desk upgraded in
 * place would silently search every seller. Known accounts are matched by id
 * and given their real Forward Scan channel id.
 */
function migrateSellerAccounts(stored) {
  if (!Array.isArray(stored) || stored.length === 0) return getDefaultSellerAccounts();

  const defaults = new Map(getDefaultSellerAccounts().map((account) => [account.id, account]));

  return stored.map((account) => {
    const known = defaults.get(account.id);
    const channelId = Number.parseInt(account.channelId, 10) || (known ? known.channelId : 0);
    return {
      id: account.id,
      // Repair labels mangled by an older encoding round-trip.
      label: known ? known.label : String(account.label || '').replace(/\s*[—–]\s*/g, ' - '),
      marketplace: account.marketplace,
      channelId,
    };
  });
}

/**
 * Seller accounts configured for one marketplace.
 */
function getSellerAccounts(marketplace) {
  const { sellerAccounts } = getConfig();
  if (!marketplace) return sellerAccounts;
  return sellerAccounts.filter((account) => account.marketplace === marketplace);
}

/**
 * Resolve which account a lookup should be scoped to.
 * Falls back to the marketplace's only account when nothing is selected, and
 * returns null when the choice is genuinely ambiguous.
 */
function resolveActiveSellerAccount(marketplace, requestedId) {
  const accounts = getSellerAccounts(marketplace);
  if (accounts.length === 0) return null;

  const wanted = requestedId || getConfig().activeSellerAccountId;
  const match = accounts.find((account) => account.id === wanted);
  if (match) return match;

  return accounts.length === 1 ? accounts[0] : null;
}

function setActiveSellerAccount(accountId) {
  saveConfig({ activeSellerAccountId: accountId || '' });
}

function saveSellerAccounts(accounts) {
  const cleaned = (Array.isArray(accounts) ? accounts : [])
    .filter((account) => account && account.label && account.marketplace)
    .map((account) => ({
      id: String(account.id || account.label).trim(),
      label: String(account.label).trim(),
      marketplace: String(account.marketplace).trim(),
      // Stored as a number so a stray string cannot reach the query layer.
      channelId: Number.parseInt(account.channelId, 10) || 0,
    }));

  saveConfig({ sellerAccounts: cleaned });
  return cleaned;
}

/**
 * Get the full config object (never contains passwords).
 */
function getConfig() {
  const defaults = getDefaultConfig();
  const stored = store.get('config', {});
  return {
    ...defaults,
    ...stored,
    marketplaces: {
      flipkart: { ...defaults.marketplaces.flipkart, ...(stored.marketplaces || {}).flipkart },
      myntra: { ...defaults.marketplaces.myntra, ...(stored.marketplaces || {}).myntra },
    },
    sellerAccounts: migrateSellerAccounts(stored.sellerAccounts),
  };
}

/**
 * Configuration problems an administrator should fix, surfaced in the UI rather
 * than left to cause confusing behaviour at the desk.
 */
function getConfigWarnings() {
  const cfg = getConfig();
  const warnings = [];

  const flipkartUrl = (cfg.marketplaces.flipkart.url || '').trim().toLowerCase();
  const myntraUrl = (cfg.marketplaces.myntra.url || '').trim().toLowerCase();

  // Both marketplaces pointing at one site means one of them opens the wrong
  // VMS, which looks like a login failure rather than a configuration mistake.
  if (flipkartUrl && myntraUrl && flipkartUrl === myntraUrl) {
    warnings.push('Flipkart and Myntra are both set to the same VMS URL. Fix the Myntra URL in Settings.');
  }

  const unscoped = cfg.sellerAccounts.filter((account) => !account.channelId);
  if (unscoped.length > 0) {
    warnings.push(
      `${unscoped.length} seller account(s) have no Channel ID, so their lookups search every account. `
      + 'Open Settings, step 4, and load them from Forward Scan.',
    );
  }

  return warnings;
}

/**
 * Save non-credential config.
 */
function saveConfig(partial) {
  const current = getConfig();
  const merged = {
    ...current,
    ...partial,
    marketplaces: {
      flipkart: {
        ...current.marketplaces.flipkart,
        ...(partial.marketplaces || {}).flipkart,
      },
      myntra: {
        ...current.marketplaces.myntra,
        ...(partial.marketplaces || {}).myntra,
      },
    },
  };
  store.set('config', merged);
  return merged;
}

/**
 * Report whether OS-backed encryption is available.
 * On Windows this is DPAPI and is effectively always available.
 */
function isEncryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Save a marketplace password, encrypted with the OS keystore.
 */
function savePassword(marketplace, password) {
  if (!isEncryptionAvailable()) {
    throw new Error(
      'OS-backed encryption is unavailable on this machine, so the password cannot be stored safely.'
    );
  }
  const secrets = store.get(SECRET_STORE_KEY, {});
  const encrypted = safeStorage.encryptString(String(password));
  secrets[marketplace] = encrypted.toString('base64');
  store.set(SECRET_STORE_KEY, secrets);
}

/**
 * Read and decrypt a marketplace password. Returns null when unset.
 */
function getPassword(marketplace) {
  const secrets = store.get(SECRET_STORE_KEY, {});
  const encoded = secrets[marketplace];
  if (!encoded) return null;

  if (!isEncryptionAvailable()) return null;

  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch (err) {
    // Ciphertext is bound to the OS user account, so a copied config file
    // or a different Windows profile cannot decrypt it.
    console.error(`[config] Could not decrypt ${marketplace} password:`, err.message);
    return null;
  }
}

/**
 * Remove a stored marketplace password.
 */
function deletePassword(marketplace) {
  const secrets = store.get(SECRET_STORE_KEY, {});
  delete secrets[marketplace];
  store.set(SECRET_STORE_KEY, secrets);
}

/**
 * Get marketplace credentials (URL, username, password, feedId).
 */
function getMarketplaceCredentials(marketplace) {
  const config = getConfig();
  const mp = config.marketplaces[marketplace];
  if (!mp) return null;
  return {
    url: mp.url,
    username: mp.username,
    password: getPassword(marketplace) || '',
    feedId: mp.feedId,
  };
}

/**
 * Save all marketplace credentials (url, username, password, feedId).
 */
function saveMarketplaceCredentials(marketplace, creds) {
  saveConfig({
    marketplaces: {
      [marketplace]: {
        url: creds.url || '',
        username: creds.username || '',
        feedId: creds.feedId || '',
      },
    },
  });
  if (creds.password) {
    savePassword(marketplace, creds.password);
  }
}

/**
 * Generate a unique device ID.
 */
function generateDeviceId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `YPD-${timestamp}-${random}`.toUpperCase();
}

/**
 * Check if setup is complete.
 */
function isSetupComplete() {
  const config = getConfig();
  return Boolean(config.activated && config.deviceId && config.backendUrl);
}

/**
 * Path of the config file, for support/diagnostics.
 */
function getConfigPath() {
  return store.path;
}

module.exports = {
  getConfig,
  getConfigWarnings,
  saveConfig,
  getPassword,
  savePassword,
  deletePassword,
  getMarketplaceCredentials,
  saveMarketplaceCredentials,
  generateDeviceId,
  isSetupComplete,
  isEncryptionAvailable,
  getConfigPath,
  getSellerAccounts,
  saveSellerAccounts,
  resolveActiveSellerAccount,
  setActiveSellerAccount,
};

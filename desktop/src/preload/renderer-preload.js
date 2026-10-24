/**
 * Preload for the app's own screens (marketplace select, packing panel, setup).
 *
 * Exposes a fixed, minimal API. Marketplace passwords are never part of it:
 * the renderer can save one and ask whether one exists, but cannot read it.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Register a main-process listener and hand back an unsubscribe function. */
function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('youthnic', {
  // Configuration
  getConfig: () => ipcRenderer.invoke('get-config'),
  getConfigWarnings: () => ipcRenderer.invoke('get-config-warnings'),
  saveConfig: (partial) => ipcRenderer.invoke('save-config', partial),
  setPanelCollapsed: (collapsed) => ipcRenderer.invoke('set-panel-collapsed', collapsed),
  isSetupComplete: () => ipcRenderer.invoke('is-setup-complete'),
  generateDeviceId: () => ipcRenderer.invoke('generate-device-id'),
  isEncryptionAvailable: () => ipcRenderer.invoke('is-encryption-available'),
  completeSetup: (data) => ipcRenderer.invoke('complete-setup', data),
  saveCredentials: (marketplace, creds) => ipcRenderer.invoke('save-credentials', marketplace, creds),
  getMarketplaceSummary: (marketplace) => ipcRenderer.invoke('get-marketplace-summary', marketplace),

  // Seller accounts
  getSellerAccounts: (marketplace) => ipcRenderer.invoke('get-seller-accounts', marketplace),
  saveSellerAccounts: (accounts) => ipcRenderer.invoke('save-seller-accounts', accounts),

  // Navigation
  selectMarketplace: (marketplace, sellerAccountId) =>
    ipcRenderer.invoke('select-marketplace', marketplace, sellerAccountId),
  backToSelection: () => ipcRenderer.invoke('back-to-selection'),
  openSetup: () => ipcRenderer.invoke('open-setup'),

  // Lookup. An explicit URL lets the setup wizard test a backend before it is
  // saved, without pointing the live desk at an unverified address.
  checkBackendHealth: (overrideUrl) => ipcRenderer.invoke('check-backend-health', overrideUrl),
  fetchSellerAccounts: (overrideUrl) => ipcRenderer.invoke('fetch-seller-accounts', overrideUrl),
  retryLookup: (barcode) => ipcRenderer.invoke('retry-lookup', barcode),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),

  // Events
  onPackingStarted: (cb) => subscribe('packing-started', cb),
  onLayoutBounds: (cb) => subscribe('layout-bounds', cb),
  onVmsStatus: (cb) => subscribe('vms-status', cb),
  onLookupLoading: (cb) => subscribe('lookup-loading', cb),
  onLookupResult: (cb) => subscribe('lookup-result', cb),
  onUpdateStatus: (cb) => subscribe('update-status', cb),
});

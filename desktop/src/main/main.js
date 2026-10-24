/**
 * Youthnic Packing Desk — main process.
 *
 * Owns the window, the single VMS browser view, the barcode observer and the
 * lookup calls. The renderer only draws the SKU panel; it never gets database
 * or credential access, and the app never talks to PostgreSQL directly.
 */

const {
  app, BrowserWindow, WebContentsView, ipcMain, session, shell, dialog, screen,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

const config = require('./config');
const { autoLogin, connectFeed, detectState } = require('./vms-automation');
const { injectObserver } = require('./barcode-observer');
const lookupClient = require('./lookup-client');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD_DIR = path.join(__dirname, '..', 'preload');

/** Fraction of the window width given to the VMS. The SKU panel takes the rest. */
const VMS_WIDTH_RATIO = 0.78;
const SKU_PANEL_MIN_WIDTH = 260;

/**
 * Below this the VMS crowds its own Pending Requests and Error Requests cards
 * against the video preview, so the SKU panel gives width back rather than
 * squeezing the workflow the operator actually depends on.
 */
const VMS_MIN_WIDTH = 900;

/** How often the VMS surface is checked for session loss or feed disconnection. */
const STATE_POLL_INTERVAL_MS = 15000;

let mainWindow = null;
let vmsView = null;
let currentMarketplace = null;
let statePoller = null;
let lastKnownState = null;
let automationRunToken = 0;
let pendingUploadCount = 0;
let activeSellerAccount = null;
let panelCollapsed = false;
let updateDownloaded = false;

// --- Window ---

function createMainWindow() {
  // Sizing from the work area rather than a fixed 1366x768: on a smaller or
  // scaled display a fixed size puts the SKU panel partly off-screen, which is
  // exactly where the operator needs to read the SKU.
  const { workAreaSize } = screen.getPrimaryDisplay();
  const width = Math.min(1366, workAreaSize.width);
  const height = Math.min(820, workAreaSize.height);

  const win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(1024, workAreaSize.width),
    minHeight: Math.min(650, workAreaSize.height),
    center: true,
    title: 'Youthnic Packing Desk',
    backgroundColor: '#0f0f1e',
    show: false,
    webPreferences: {
      preload: path.join(PRELOAD_DIR, 'renderer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Repeated image loads during a long shift are the main source of
      // renderer growth, so the disk cache is left enabled and bounded by
      // Chromium rather than disabled outright.
      backgroundThrottling: false,
    },
  });

  win.on('close', (event) => {
    const warning = describeCloseRisk();
    if (!warning) return;

    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Stay in session', 'Close anyway'],
      defaultId: 0,
      cancelId: 0,
      title: 'Packing session is active',
      message: warning.message,
      detail: warning.detail,
    });

    if (choice === 0) event.preventDefault();
  });

  win.on('closed', () => {
    stopStatePolling();
    mainWindow = null;
    vmsView = null;
  });

  win.on('resize', updateVmsViewBounds);
  win.on('maximize', updateVmsViewBounds);
  win.on('unmaximize', updateVmsViewBounds);
  win.once('ready-to-show', () => win.show());

  return win;
}

/**
 * Describe why closing now is risky, or null when it is safe.
 * Based on the VMS's own state: an attached feed means the operator is mid
 * shift, and pendingCountVMS is the VMS's own count of unflushed uploads.
 */
function describeCloseRisk() {
  if (!vmsView || vmsView.webContents.isDestroyed()) return null;

  if (pendingUploadCount > 0) {
    return {
      message: `${pendingUploadCount} scan upload(s) have not finished.`,
      detail: 'Closing now may lose those recordings. Wait for the VMS upload queue to drain first.',
    };
  }

  if (lastKnownState === 'scanning') {
    return {
      message: 'The VMS feed is still connected.',
      detail: 'Disconnect the feed in the VMS before closing so no scan is interrupted.',
    };
  }

  return null;
}

/**
 * Width the SKU panel should occupy for the current window.
 *
 * Honours the panel's minimum so the SKU text stays readable, but gives width
 * back when that would push the VMS below the point where its own Pending and
 * Error Requests cards still fit beside the video.
 */
function computePanelWidth(windowWidth) {
  if (panelCollapsed) return 0;

  const preferred = Math.max(SKU_PANEL_MIN_WIDTH, Math.round(windowWidth * (1 - VMS_WIDTH_RATIO)));
  const affordable = Math.max(0, windowWidth - VMS_MIN_WIDTH);

  // On a window too narrow for both, the VMS wins: the operator can collapse
  // or expand the panel, but cannot re-lay-out the VMS.
  return Math.min(preferred, Math.max(affordable, 0)) || Math.min(preferred, windowWidth);
}

function updateVmsViewBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const { width, height } = mainWindow.getContentBounds();
  const panelWidth = computePanelWidth(width);
  const vmsWidth = Math.max(0, width - panelWidth);

  if (vmsView) {
    vmsView.setBounds({ x: 0, y: 0, width: vmsWidth, height });
  }

  // The renderer lays the panel out from these numbers instead of repeating the
  // ratio in CSS, so the panel and the VMS view can never disagree about where
  // the boundary is.
  sendToPanel('layout-bounds', { vmsWidth, panelWidth, collapsed: panelCollapsed });
}

function setPanelCollapsed(collapsed) {
  panelCollapsed = Boolean(collapsed);
  config.saveConfig({ panelCollapsed });
  updateVmsViewBounds();
  return { collapsed: panelCollapsed };
}

// --- Navigation between app screens ---

function destroyVmsView() {
  stopStatePolling();
  automationRunToken += 1;
  lastKnownState = null;
  pendingUploadCount = 0;
  currentMarketplace = null;
  activeSellerAccount = null;

  if (!vmsView) return;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.removeChildView(vmsView);
  }
  // Releasing the web contents is what actually frees the renderer process and
  // its video buffers; dropping the reference alone would not.
  if (!vmsView.webContents.isDestroyed()) {
    vmsView.webContents.close();
  }
  vmsView = null;
}

function showMarketSelection() {
  destroyVmsView();
  mainWindow.loadFile(path.join(RENDERER_DIR, 'market-select.html'));
}

function showSetupWizard() {
  destroyVmsView();
  mainWindow.loadFile(path.join(RENDERER_DIR, 'setup.html'));
}

function sendToPanel(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// --- Desktop updates ---

function setupAutoUpdater() {
  // electron-updater is intentionally inert during local development. A
  // packaged Windows build reads latest.yml from the configured GitHub repo.
  if (!app.isPackaged || process.platform !== 'win32') return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    sendToPanel('update-status', { state: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    sendToPanel('update-status', { state: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', (info) => {
    sendToPanel('update-status', { state: 'current', version: info.version });
  });
  autoUpdater.on('download-progress', (progress) => {
    sendToPanel('update-status', {
      state: 'downloading',
      percent: Math.round(progress.percent),
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    sendToPanel('update-status', { state: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (error) => {
    sendToPanel('update-status', { state: 'error', message: error.message });
  });

  // Do not interrupt startup with a download or an install. The button on the
  // marketplace screen triggers the same check on demand.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 10000);
}

function assertPanelSender(event) {
  return mainWindow
    && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents;
}

// --- Packing session ---

async function startPacking(marketplace, sellerAccountId) {
  const creds = config.getMarketplaceCredentials(marketplace);

  if (!creds || !creds.url) {
    dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      title: 'Marketplace not configured',
      message: `No VMS URL is configured for ${marketplace}.`,
      detail: 'Complete the setup wizard before packing on this marketplace.',
    });
    showSetupWizard();
    return { ok: false };
  }

  destroyVmsView();
  currentMarketplace = marketplace;
  panelCollapsed = Boolean(config.getConfig().panelCollapsed);
  activeSellerAccount = config.resolveActiveSellerAccount(marketplace, sellerAccountId);
  if (activeSellerAccount) config.setActiveSellerAccount(activeSellerAccount.id);
  const runToken = ++automationRunToken;

  // Load the panel first so status messages have somewhere to land.
  await mainWindow.loadFile(path.join(RENDERER_DIR, 'packing.html'));

  // One persistent partition per marketplace keeps logins, cookies and camera
  // permission grants separate and lets them survive a restart.
  const partition = `persist:vms-${marketplace}`;
  const vmsSession = session.fromPartition(partition);
  configureVmsSession(vmsSession);

  vmsView = new WebContentsView({
    webPreferences: {
      preload: path.join(PRELOAD_DIR, 'vms-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      session: vmsSession,
    },
  });

  mainWindow.contentView.addChildView(vmsView);
  updateVmsViewBounds();

  const vms = vmsView.webContents;

  attachVmsHandlers(vms, marketplace);

  sendToPanel('packing-started', {
    marketplace,
    vmsUrl: creds.url,
    sellerAccountLabel: activeSellerAccount ? activeSellerAccount.label : '',
    panelCollapsed,
    // An account with no channel id cannot scope the lookup, and the operator
    // should know that before trusting what the panel shows.
    sellerAccountScoped: Boolean(activeSellerAccount && activeSellerAccount.channelId),
  });
  updateVmsViewBounds();
  sendToPanel('vms-status', { message: 'Loading VMS...', state: 'busy' });

  try {
    await vms.loadURL(creds.url);
  } catch (err) {
    sendToPanel('vms-status', { message: `Could not load the VMS: ${err.message}`, state: 'error' });
    return { ok: false };
  }

  // A newer session may have started while the page was loading.
  if (runToken !== automationRunToken) return { ok: false };

  await runVmsAutomation(vms, marketplace, creds, runToken);
  startStatePolling(marketplace);

  return { ok: true };
}

function configureVmsSession(vmsSession) {
  // The VMS needs the webcam to record packing videos. Only media permissions
  // are granted; everything else is denied.
  const allowed = new Set(['media', 'camera', 'microphone', 'audioCapture', 'videoCapture']);

  vmsSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission));
  });

  vmsSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

function attachVmsHandlers(vms, marketplace) {
  // Re-inject on every surface change. The observer tears down its previous
  // instance on injection, so this cannot stack listeners.
  const reinject = () => { injectObserver(vms, marketplace); };

  vms.on('dom-ready', reinject);
  vms.on('did-navigate', reinject);
  vms.on('did-navigate-in-page', reinject);

  // An accidental F5 or Ctrl+R mid-recording would discard the in-progress
  // scan, so reload keystrokes are swallowed before the page sees them.
  vms.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isReloadKey = input.key === 'F5'
      || ((input.control || input.meta) && input.key.toLowerCase() === 'r');
    if (isReloadKey) {
      event.preventDefault();
      sendToPanel('vms-status', {
        message: 'Reload blocked to protect the active scan.',
        state: 'warn',
      });
    }
  });

  vms.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED, which fires routinely on client-side navigation.
    if (!isMainFrame || errorCode === -3) return;
    sendToPanel('vms-status', {
      message: `VMS failed to load (${errorDescription}). Check the network.`,
      state: 'error',
    });
  });

  vms.on('render-process-gone', (_e, details) => {
    sendToPanel('vms-status', {
      message: `The VMS view crashed (${details.reason}). Reconnect from the marketplace screen.`,
      state: 'error',
    });
  });

  // Keep the VMS from spawning extra windows, which would mean a second
  // browser engine and more memory than a 4 GB desk can spare.
  vms.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

async function runVmsAutomation(vms, marketplace, creds, runToken) {
  const onProgress = (message, state) => {
    if (runToken !== automationRunToken) return;
    sendToPanel('vms-status', { message, state: state || 'busy' });
  };

  const login = await autoLogin(vms, marketplace, creds, onProgress);
  if (runToken !== automationRunToken) return;

  if (!login.ok) {
    // Login is left to the operator rather than retried blindly, so the VMS's
    // own auth and lockout rules stay in control.
    return;
  }

  // Let the post-login view settle before looking for the Feed ID field.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (runToken !== automationRunToken) return;

  const feed = await connectFeed(vms, marketplace, creds.feedId, onProgress);
  if (runToken !== automationRunToken) return;

  if (feed.ok) {
    sendToPanel('vms-status', { message: 'VMS ready — scan a tracking barcode.', state: 'ok' });
  }
}

function startStatePolling(marketplace) {
  stopStatePolling();

  statePoller = setInterval(async () => {
    if (!vmsView || vmsView.webContents.isDestroyed()) return;

    const state = await detectState(vmsView.webContents, marketplace);
    pendingUploadCount = await readPendingUploadCount(vmsView.webContents);

    if (state === lastKnownState) return;
    const previous = lastKnownState;
    lastKnownState = state;

    if (state === 'login' && previous === 'scanning') {
      sendToPanel('vms-status', {
        message: 'VMS session expired. Log in again in the VMS to resume.',
        state: 'error',
      });
    } else if (state === 'feed' && previous === 'scanning') {
      sendToPanel('vms-status', {
        message: 'Feed disconnected. Reconnect the Feed ID in the VMS.',
        state: 'warn',
      });
    } else if (state === 'scanning') {
      sendToPanel('vms-status', { message: 'VMS ready — scan a tracking barcode.', state: 'ok' });
    }
  }, STATE_POLL_INTERVAL_MS);
}

function stopStatePolling() {
  if (statePoller) {
    clearInterval(statePoller);
    statePoller = null;
  }
}

/**
 * Read the VMS's own count of scans waiting to upload.
 * The VMS maintains this in localStorage as "pendingCountVMS".
 */
async function readPendingUploadCount(vms) {
  try {
    const raw = await vms.executeJavaScript('localStorage.getItem("pendingCountVMS")', true);
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

// --- Barcode to lookup ---

ipcMain.on('barcode-scanned', async (event, barcode) => {
  // Only trust reports from the VMS view we created.
  if (!vmsView || event.sender !== vmsView.webContents) return;
  if (typeof barcode !== 'string' || !barcode) return;

  const marketplace = currentMarketplace;
  sendToPanel('lookup-loading', { barcode, marketplace });

  const result = await lookupClient.lookup(barcode, marketplace, {
    channelId: activeSellerAccount ? activeSellerAccount.channelId : 0,
  });

  // A newer scan already superseded this one; dropping it keeps the panel from
  // flashing back to an older parcel's image.
  if (result.status === 'stale') return;
  if (marketplace !== currentMarketplace) return;

  sendToPanel('lookup-result', result);
});

// --- IPC: configuration and navigation ---

ipcMain.handle('get-config', () => config.getConfig());
ipcMain.handle('get-config-warnings', () => config.getConfigWarnings());
ipcMain.handle('set-panel-collapsed', (_e, collapsed) => setPanelCollapsed(collapsed));
ipcMain.handle('save-config', (_e, partial) => config.saveConfig(partial));
ipcMain.handle('is-setup-complete', () => config.isSetupComplete());
ipcMain.handle('generate-device-id', () => config.generateDeviceId());
ipcMain.handle('is-encryption-available', () => config.isEncryptionAvailable());

ipcMain.handle('save-credentials', (_e, marketplace, creds) => {
  config.saveMarketplaceCredentials(marketplace, creds);
  return { ok: true };
});

// Deliberately reports only whether a password exists; the password itself is
// never sent to a renderer.
ipcMain.handle('get-marketplace-summary', (_e, marketplace) => {
  const cfg = config.getConfig();
  const mp = cfg.marketplaces[marketplace] || {};
  return {
    url: mp.url || '',
    username: mp.username || '',
    feedId: mp.feedId || '',
    hasPassword: Boolean(config.getPassword(marketplace)),
  };
});

ipcMain.handle('complete-setup', (_e, setupData) => {
  config.saveConfig({
    deviceId: setupData.deviceId,
    deskName: setupData.deskName,
    backendUrl: setupData.backendUrl,
    activated: true,
    isFirstRun: false,
    marketplaces: {
      flipkart: {
        url: setupData.flipkartUrl,
        username: setupData.flipkartUsername,
        feedId: setupData.flipkartFeedId,
      },
      myntra: {
        url: setupData.myntraUrl,
        username: setupData.myntraUsername,
        feedId: setupData.myntraFeedId,
      },
    },
  });
  return { ok: true };
});

ipcMain.handle('get-seller-accounts', (_e, marketplace) => config.getSellerAccounts(marketplace));
ipcMain.handle('save-seller-accounts', (_e, accounts) => config.saveSellerAccounts(accounts));

ipcMain.handle('select-marketplace', (_e, marketplace, sellerAccountId) => startPacking(marketplace, sellerAccountId));
ipcMain.handle('back-to-selection', () => { showMarketSelection(); return { ok: true }; });
ipcMain.handle('open-setup', () => { showSetupWizard(); return { ok: true }; });
ipcMain.handle('check-backend-health', (_e, overrideUrl) => lookupClient.checkHealth(overrideUrl));
ipcMain.handle('fetch-seller-accounts', (_e, overrideUrl) => lookupClient.fetchSellerAccounts(overrideUrl));

ipcMain.handle('check-for-updates', async (event) => {
  if (!assertPanelSender(event)) return { ok: false, message: 'Invalid app window.' };
  if (!app.isPackaged || process.platform !== 'win32') {
    return { ok: false, state: 'unavailable', message: 'Updates are available in installed builds.' };
  }
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    return { ok: false, state: 'error', message: error.message };
  }
});

ipcMain.handle('download-update', async (event) => {
  if (!assertPanelSender(event) || !app.isPackaged || process.platform !== 'win32') {
    return { ok: false };
  }
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (error) {
    return { ok: false, state: 'error', message: error.message };
  }
});

ipcMain.handle('install-update', (event) => {
  if (!assertPanelSender(event) || !updateDownloaded) return { ok: false };
  setImmediate(() => autoUpdater.quitAndInstall());
  return { ok: true };
});

ipcMain.handle('retry-lookup', (_e, barcode) => lookupClient.lookup(barcode, currentMarketplace, {
  bypassCache: true,
  channelId: activeSellerAccount ? activeSellerAccount.channelId : 0,
}));

// --- Lifecycle ---

function initialize() {
  mainWindow = createMainWindow();
  if (config.isSetupComplete()) {
    showMarketSelection();
  } else {
    showSetupWizard();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    initialize();
    setupAutoUpdater();
  });

  app.on('window-all-closed', () => app.quit());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) initialize();
  });
}

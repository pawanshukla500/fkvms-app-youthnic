/**
 * Preload for the VMS browser view.
 *
 * Exposes exactly one function: a one-way channel the injected barcode
 * observer uses to report a completed AWB scan. There is no way to read
 * configuration, credentials or lookup results from the VMS page, and nothing
 * here can write back into the VMS.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Matches the VMS's own AWB rule, so a malformed value is dropped here rather
// than reaching the lookup service.
const AWB_PATTERN = /^[a-zA-Z0-9_-]{4,30}$/;

contextBridge.exposeInMainWorld('__youthnicBridge', {
  reportBarcode: (barcode) => {
    if (typeof barcode !== 'string') return;
    const value = barcode.trim();
    if (!AWB_PATTERN.test(value)) return;
    ipcRenderer.send('barcode-scanned', value);
  },
});

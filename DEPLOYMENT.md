# Youthnic Packing Desk — deployment guide

## What this is

A Windows application that wraps the Flipkart and Myntra VMS websites and shows
the product image, SKU name and quantity for every tracking barcode an operator
scans. The VMS is the real website, unmodified: its camera, recording, scanning
and upload all work as they normally do.

Two components:

| Component | Runs on | Purpose |
|---|---|---|
| Desktop app (Electron) | Each packing desk | Hosts the VMS, watches the scan field, draws the SKU panel |
| Lookup backend (Node/Express) | One server | Reads Forward Scan over a SELECT-only connection |

Packing desks have no database driver and no connection string. Every lookup is
an HTTP call to the backend.

```
  Packing desk (4 GB, Windows)
  ┌────────────────────────────────────┐
  │ Youthnic Packing Desk              │
  │ ┌──────────────────┐ ┌───────────┐ │
  │ │ VMS website 78%  │ │ SKU  22%  │ │
  │ │ camera/recording │ │ image+qty │ │
  │ └────────┬─────────┘ └─────┬─────┘ │
  │   observes #awbInput       │       │
  └────────────┬───────────────┴───────┘
               │ GET /api/lookup
               ▼
     ┌──────────────────────────┐
     │ Lookup backend           │
     │ BEGIN READ ONLY ... SELECT│
     │ 60 s result cache        │
     └────────────┬─────────────┘
                  ▼
     ┌──────────────────────────┐
     │ Forward Scan SQLite or   │
     │ PostgreSQL, read-only    │
     └──────────────────────────┘
```

---

## Current status

Verified on this build:

- The Flipkart VMS DOM contract, read out of the deployed app bundle. See
  `desktop/src/main/vms-selectors.js`.
- Desktop app starts, the six-step setup wizard renders and navigates, the three
  seller accounts are pre-seeded, and the preload bridge is exposed.
- Backend starts, and `/api/health`, `/api/lookup`, `/api/readonly-audit` and
  404 handling all respond correctly.
- The verified Forward Scan schema is `oms_orders`, `sku_photos` and
  `channels`; `oms_orders.items_json` is parsed by the API.
- The local SQLite snapshot resolved 25/25 sample tracking IDs with a 0.2 ms
  average lookup.
- Windows installer builds: `desktop/dist/Youthnic Packing Desk Setup 1.0.0.exe`.

Still open:

- Render cannot reach the SQLite file on a packing PC. Production needs a
  reachable PostgreSQL database or hosted Forward Scan copy.
- Myntra login and Feed ID automation remain unverified.
- Image coverage is currently low because Forward Scan's photo sync has not
  populated current SKU generations. SKU and quantity work without an image.
- Five-hour memory endurance and a clean-machine install still need testing.
- Myntra login and Feed ID automation (its VMS has not been inspected).

Lookups are disabled until the schema is mapped. The panel says so instead of
showing a guessed product. See "Mapping the schema" below.

---

## Prerequisites

**Packing desk**
- Windows 10/11 64-bit, 4 GB RAM
- Microsoft Edge WebView2 / Edge runtime present (standard on Windows 10/11)
- USB barcode scanner in keyboard-wedge mode (no driver needed)
- Webcam for the VMS recording
- Network access to the VMS site and the backend

**Backend server**
- Node.js 22.5+
- Network route to the Forward Scan SQLite file or PostgreSQL host
- A fixed address the desks can reach

---

## 1. Backend setup

```bash
cd backend
npm install
cp .env.example .env
```

Set `VMS_DATABASE_URL` to either the verified SQLite file:

```text
VMS_DATABASE_URL=C:/path/to/omsguru_forward_scan.db
```

or a SELECT-only PostgreSQL account:

```
VMS_DATABASE_URL=postgresql://vms_reader:<password>@<host>:5433/forward_scan
VMS_DATABASE_SSL=verify      # or no-verify / disable, per your network
```

Start it:

```bash
npm start
```

Check it:

```bash
curl http://localhost:3100/api/health
curl http://localhost:3100/api/readonly-audit
```

`/api/health` returns 503 until the database connects and the verified schema
is present. That is intentional: a desk should not look "ready" when it cannot
resolve a product.

### Create the read-only role

Enforcement belongs at the PostgreSQL level, not in application code. Run this
on the Forward Scan database as an administrator:

```sql
CREATE ROLE vms_reader WITH LOGIN PASSWORD '<secure-password>';

GRANT CONNECT ON DATABASE forward_scan TO vms_reader;
GRANT USAGE ON SCHEMA public TO vms_reader;

-- Prefer listing only the tables the lookup needs:
GRANT SELECT ON public.<shipments>, public.<order_items>, public.<sku_catalogue> TO vms_reader;

-- Make sure nothing else is granted, including on future tables.
REVOKE CREATE ON SCHEMA public FROM vms_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT TO vms_reader;
```

Then confirm it:

```bash
curl http://localhost:3100/api/readonly-audit
```

It must report `"status": "read_only"`. The audit reads
`information_schema.table_privileges` and `pg_roles`; it never attempts a write,
because a test INSERT against a misconfigured role would itself modify Forward
Scan.

The backend adds three more layers on top of the role: every statement runs
inside `BEGIN READ ONLY`, only `SELECT`/`WITH` statements are accepted, and all
values are bound as parameters.

**Never done by this system:** INSERT, UPDATE, DELETE, ALTER, DROP, TRUNCATE,
migrations, schema changes, or any change to Forward Scan's own sync jobs.

---

## 2. Verified Forward Scan schema

The backend is already mapped to the schema extracted from Forward Scan's
models and a live SQLite snapshot. `npm run verify` checks it without writing.

- `oms_orders`: one shipment per row, indexed `tracking_norm`, with
  `items_json`, `channel_id`, `channel_label`, `status_group`, and sync time.
- `sku_photos`: normalized SKU, title, image URL and marketplace.
- `channels`: seller account IDs and labels.

The lookup joins orders to channels, parses `items_json`, and prefers an image
stored on the order item before falling back to `sku_photos`. It never creates
or runs a second sync service.

---

## 3. Desktop app

Development:

```bash
cd desktop
npm install
npm start
```

Installer:

```bash
cd desktop
npm run dist
```

Output: `desktop/dist/Youthnic Packing Desk Setup 1.0.0.exe`.

### Build notes

Two Windows quirks hit electron-builder on a non-developer-mode machine:

1. Its code-signing bundle contains macOS symlinks that Windows refuses to
   extract without Developer Mode or admin rights. We do not code-sign, so
   `win.signAndEditExecutable` is `false` in `package.json`. The side effect is
   that the exe keeps Electron's embedded icon; shortcuts still use ours. To get
   a fully branded, signed exe, enable Developer Mode, set this back to `true`
   and supply a certificate.
2. electron-builder can fail to rename its freshly downloaded NSIS cache
   ("Access is denied", typically antivirus holding the folder). If that
   happens, place the extracted packages at
   `%LOCALAPPDATA%\electron-builder\Cache\nsis\nsis-3.0.4.1` and
   `...\Cache\nsis\nsis-resources-3.4.1` and rerun.

---

## 4. Per-desk setup wizard

The first launch opens a six-step wizard. Operators never see it again.

| Step | What to enter |
|---|---|
| 1 Device | Generated Device ID and a desk name |
| 2 Flipkart | VMS URL, username, password, Feed ID |
| 3 Myntra | VMS URL, username, password, Feed ID |
| 4 Accounts | Seller accounts and their Forward Scan Channel IDs |
| 5 Backend | Lookup API URL, with a live connection test |
| 6 Activate | Review and save |

Seller accounts are pre-seeded with the three in use:

- ETHNIC JUNCTION — Flipkart
- ETHNIC JUNCTION — Myntra Youthnic
- VB EXPORT — Myntra PPMP

The **Channel ID** is Forward Scan's `channels.id`. A tracking ID can exist
under more than one account, and this ID keeps a scan from resolving to another
seller's parcel. `0` searches the whole marketplace.

### Where settings are stored

- Passwords: encrypted with Electron `safeStorage`, which is Windows DPAPI.
  Only ciphertext is written to disk, and it is bound to that Windows user
  account, so copying the config file to another machine does not move the
  password.
- Everything else: `electron-store` JSON under the app's user data directory.
- VMS cookies and camera permission grants: one persistent session partition per
  marketplace (`persist:vms-flipkart`, `persist:vms-myntra`), so logins survive
  restarts and the two marketplaces never share state.

Settings can be changed later from the Settings button on the marketplace screen.
Changing them does not require rebuilding the installer.

---

## 5. Daily operator flow

1. Open the app.
2. Pick Flipkart or Myntra, and the seller account if more than one is configured.
3. The app loads the VMS, fills the login, waits, submits, waits for
   authentication, then fills the Feed ID and presses Connect.
4. Scan tracking barcodes in the VMS exactly as before.
5. The right-hand panel shows the product image, SKU name and quantity.

If automation cannot complete a step it says so and leaves the VMS to the
operator, rather than retrying blindly against the marketplace's auth rules.

---

## 6. How the scan is observed

The operator scans once, into the VMS. Our app never asks for a second scan.

The observer binds to exactly one element: `#awbInput`, the field the VMS itself
drives via `getElementById("awbInput")`. It attaches `input` and `keydown`
listeners and nothing else. It does not call `preventDefault`, does not write to
the field, does not move focus, and does not dispatch synthetic input, so the
VMS receives the barcode exactly as the scanner typed it. No other input on the
page is read, so passwords and unrelated keystrokes are never seen.

It mirrors the VMS's own rules so the panel never looks up something the VMS
would reject:

- `^[a-zA-Z0-9_-]+$`, 4 to 30 characters
- a repeat of the same AWB within 1.5 s is treated as the scanner double-firing
- the value is reported 500 ms after it settles, just ahead of the VMS's own
  ~1000 ms commit, or immediately on Enter/Tab for scanners that append one

Each lookup carries a sequence number. When a newer scan starts, the older
response is dropped, so a slow query cannot replace the image of the parcel the
operator is holding.

Re-injection on navigation tears down the previous listeners first, so SPA route
changes cannot stack duplicate handlers.

---

## 7. Long shifts

- One marketplace loads at a time; neither VMS is preloaded.
- Reload keys (F5, Ctrl+R) are swallowed in the VMS view so an accidental press
  cannot discard an in-progress recording.
- The VMS surface is polled every 15 s, and the panel reports an expired session
  or a dropped feed instead of silently going quiet.
- Closing is blocked with a warning while the VMS's own `pendingCountVMS` shows
  unflushed uploads, or while a feed is still attached.
- Installed builds have a manual update button on the marketplace screen.
  Updates are downloaded only after the operator asks, and installation occurs
  after the app quits, never in the middle of a recording.
- A database or backend failure shows in the panel only. VMS recording and
  uploading continue untouched.
- Session expiry is handled through the VMS's normal login screen. No keep-alive
  requests are sent, so the marketplace's server-side session policy is left alone.

---

## 8. Resource behaviour

- Single browser engine: the VMS is a `WebContentsView` in the same window as
  the panel, and the panel is plain HTML in the existing renderer.
- Leaving a session calls `webContents.close()`, which frees the renderer
  process and its video buffers rather than just dropping the reference.
- Only the first image per SKU is requested; additional images are never fetched.
- On a new scan, previous `img.src` values are cleared before the nodes are
  removed, so Chromium releases the decoded bitmaps immediately. This is what
  keeps memory flat across a few hundred scans.
- Images load with `fetchpriority="high"` because an operator is waiting on them.
- Backend caches results for 60 s in a 500-entry bounded cache; the connection
  pool is capped at 5.
- No local PostgreSQL, no nightly image sync and no background workers on the desk.

Measured so far: 376 MB across 4 processes with the app open and no VMS loaded.
Targets still to be measured on a real 4 GB desk: under 800 MB during packing,
sub-second lookups, and no growth over five hours.

**Not done, deliberately:** no aggressive GC, and no disabling of browser
features to force memory down. Either would risk the camera and upload path.

---

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| Panel: lookup service unreachable | Start the backend, check the configured backend URL, and confirm `/api/health` |
| Marketplace card: "Not configured" | No VMS URL saved for it; open Settings |
| Card says "Manual login" | No password stored; operator logs in by hand |
| Login did not complete | Check credentials; VMS error text is shown in the panel |
| Feed did not attach | Confirm the Feed ID is valid for this desk |
| Panel: not found / pending sync | Order is newer than the 5-minute sync, or older than 72-hour retention; press Retry |
| Panel: lookup unreachable | Backend URL or network; VMS keeps working regardless |
| Wrong seller's parcel appears | Channel ID is blank or wrong in step 4 |
| `/api/readonly-audit` is not `read_only` | The role can write; fix the grants before packing |
| Camera not available | Another app holds it; only media permissions are granted to the VMS |

---

## 10. Render deployment

The service is configured by `render.yaml` as a Node web service named
**Flipkart VMS Server** on the Starter plan. The service uses Render's
`PORT`, `/api/health`, and `npm ci --omit=dev`.

The requested Render project is `prj-db7k1pl9fdbs73ehkmc0`. The project
currently has no service, so create the service from the GitHub repository after
the first push, or create it from the Blueprint and record its service ID.

Do not put database credentials in `render.yaml`. The GitHub Actions workflow
expects `RENDER_API_KEY`, `RENDER_SERVICE_ID`, `VMS_DATABASE_URL`, and
`VMS_DATABASE_SSL` as GitHub Secrets. It writes the two database settings to
Render and triggers a deploy when backend files change.

The remote service cannot use a path such as
`C:/Users/.../omsguru_forward_scan.db`. Use a reachable PostgreSQL connection
or a hosted database copy before directing desk PCs to the Render URL.

---

## 11. GitHub Releases and updates

The desktop package points `electron-updater` at the
`pawanshukla500/fkvms-app-youthnic` GitHub repository. The release workflow
builds on Windows when a `v*` tag is pushed and uploads the NSIS installer,
blockmap and `latest.yml`. Those three files are required for update checks.

The app never auto-downloads or installs while packing. It checks on startup
of an installed build and exposes a button to download and restart when the
operator is ready.

# Youthnic Packing Desk

Lightweight Windows packing software for Flipkart and Myntra VMS. It hosts one
marketplace VMS at a time, observes the VMS's own tracking field, and shows the
matching SKU and quantity in a side panel.

## Included

- One VMS browser surface at a time, with camera and recording left untouched.
- Passive observation of the verified Flipkart `#awbInput` field.
- Read-only lookup API for the existing Forward Scan database.
- SQLite and PostgreSQL drivers selected from `VMS_DATABASE_URL`.
- Three configured Forward Scan channel IDs:
  - 17040, ETHNIC JUNCTION — Flipkart
  - 51680, ETHNIC JUNCTION — Myntra Youthnic
  - 18116, VB EXPORT — Myntra PPMP
- Work-area-aware 78/22 layout that gives the VMS room for Pending Requests and
  Error Requests; the SKU panel can also be collapsed.
- Windows DPAPI-protected marketplace passwords.
- GitHub Releases update check and download button in installed builds.

## Project structure

```text
backend/    Express read-only lookup API
desktop/    Electron Windows application
tools/      SQLite inspection and CDP smoke-test helpers
render.yaml Render Starter service definition
```

## Local development

```bash
# Backend
cd backend
npm ci
copy .env.example .env
# Set VMS_DATABASE_URL to a verified SQLite file or SELECT-only PostgreSQL URL.
npm run verify
npm start

# Desktop
cd desktop
npm ci
npm start
```

The backend listens on `http://localhost:3100` locally. Render supplies its
runtime `PORT` automatically.

## Build the Windows installer

```bash
cd desktop
npm ci
npm run dist
```

Output: `desktop/dist/Youthnic Packing Desk Setup 1.0.0.exe`.

## Deployment

`render.yaml` targets the existing Render project
`prj-db7k1pl9fdbs73ehkmc0` with a Starter web service. The Starter plan is the
requested $5–7/month floor and is more than sufficient for 8–9 desks because
the measured local lookup averaged 0.2 ms and the API uses a bounded cache.

Render cannot read the Forward Scan SQLite file on a packing PC. Production
must therefore provide a reachable PostgreSQL database or a hosted copy of the
verified Forward Scan data. Until that is available, deployment can start but
`/api/health` will remain degraded.

The Render workflow expects these GitHub Actions secrets:

- `RENDER_API_KEY`
- `RENDER_SERVICE_ID`
- `VMS_DATABASE_URL`
- `VMS_DATABASE_SSL`

Pushes to `main` deploy backend changes. A tag such as `v1.0.1` builds the
Windows installer and publishes the installer, blockmap and `latest.yml` to a
GitHub Release. Installed builds use that release metadata for the update
button.

See `DEPLOYMENT.md` for the verified schema, read-only rules, setup wizard,
Render prerequisites, and known limitations.

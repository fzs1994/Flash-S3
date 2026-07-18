# Flash S3 Browser

An Electron + Angular desktop client for Amazon S3, styled after S3 Browser, with a
fast multi-threaded transfer queue engine.

This is an MVP build: the core browsing/upload/download experience is fully wired
end-to-end. Additional S3 Browser Pro features (sync, scheduler, ACL/policy editor,
CloudFront, encryption) are intentionally deferred to follow-up passes so the
foundation is solid first — see "Roadmap" below.

## Features in this build

- Connection manager: save multiple AWS S3 credential profiles (access key/secret +
  region), encrypted at rest via Electron's OS-level `safeStorage` (DPAPI / Keychain /
  libsecret). "Test Connection" before saving.
- Bucket + object browser: bucket list sidebar, breadcrumb folder navigation,
  Explorer-style grid (name, size, last modified, storage class).
- File operations: new folder, rename, delete (multi-select), pre-signed URL
  generation (share links).
- Fast multi-threaded transfer queue:
  - Any number of uploads/downloads can be queued at once.
  - Configurable number of files transferring concurrently (1-16, default 4).
  - Each individual upload is itself multipart with parallel parts
    (`@aws-sdk/lib-storage`), so large files saturate bandwidth too.
  - Per-task pause / resume / cancel / retry, plus pause-all/resume-all.
  - Live progress %, transfer speed, and ETA per task, updated in real time via IPC.
  - Drag-and-drop upload directly onto the file grid, plus toolbar Upload
    Files/Folder buttons using native OS pickers.

### Known limitation

Pausing an in-flight transfer aborts the current HTTP request; resuming restarts
that file from byte 0 rather than a true byte-offset resume. True resumable-pause
(tracking S3 multipart `UploadId`s / HTTP Range requests per part) is a good
next enhancement — see Roadmap.

## Architecture

- **Electron main process** (`electron/`) owns all AWS SDK calls and the transfer
  queue. The Angular renderer never talks to AWS directly.
  - `electron/services/s3-manager.js` — bucket/object CRUD via `@aws-sdk/client-s3`.
  - `electron/services/transfer-queue.js` — the concurrent upload/download engine.
  - `electron/services/credential-store.js` — encrypted profile storage.
  - `electron/ipc/register.js` — wires it all to `ipcMain.handle(...)`.
  - `electron/preload.js` — the only bridge exposed to the renderer
    (`window.electronAPI`), via `contextBridge` with `contextIsolation: true`.
- **Angular renderer** (`src/`) is a standalone-component Angular 17 app that only
  ever calls `window.electronAPI.*`.
  - `core/services/*` — state + IPC-calling services (connections, browser
    navigation, transfers).
  - `features/*` — UI components (toolbar, bucket tree, object grid, transfer
    queue panel, connection manager, dialogs).

## Getting started

Requires Node.js 18+.

```bash
npm install
npm start          # runs `ng serve` + Electron together, with dev tools open
```

## Building an installer

```bash
npm run dist        # current platform
npm run dist:win     # Windows (nsis)
npm run dist:mac     # macOS (dmg)
npm run dist:linux   # Linux (AppImage)
```

Output lands in `release/`. Icons are expected at `build-resources/icon.ico` /
`.icns` / `.png` — add your own before building an installer (a default Electron
icon is used if they're missing, which electron-builder will warn about).

## Roadmap (Pro-tier features not yet implemented)

- Folder/bucket sync (local ⇄ S3, one-way and two-way) and scheduled sync jobs.
- Bucket policy / ACL / CORS / static website hosting editors.
- Lifecycle rule management, versioning UI, server-side encryption controls.
- CloudFront distribution management and invalidations.
- Search across buckets, bookmarks/favorites, multiple simultaneous bucket tabs.
- True resumable pause (byte-offset resume) for large transfers.
- S3-compatible custom endpoints (MinIO, Wasabi, Backblaze B2, DigitalOcean
  Spaces) — currently AWS S3 only, per initial scope.

## Security notes

- Secrets are encrypted at rest with `safeStorage`; if the OS has no available
  encryption backend, they fall back to base64 (not secure) — flagged in
  `credential-store.js` for follow-up (e.g., requiring OS keychain unlock).
- `contextIsolation: true` and `nodeIntegration: false` are enforced in
  `electron/main.js`; the renderer only ever sees the explicit API surface
  defined in `electron/preload.js`.

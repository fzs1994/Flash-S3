# Flash S3 Browser

An Electron + Angular desktop client for Amazon S3, styled after S3 Browser, with a
fast multi-threaded transfer queue engine, a dual-pane file-manager view, and
multi-account/multi-tab browsing.

The original S3 Browser is a well-established, mature product with a much
larger overall feature set (bucket policies, CloudFront, folder sync, versioning,
and more — see the honest comparison below). This build focuses on making the
day-to-day workflow — browsing, transferring, and moving files around — faster
and more pleasant, and on running on more than one operating system.

## Features in this build

**Connections & browsing**

- Connection manager: save multiple AWS S3 credential profiles (access key/secret +
  region), encrypted at rest via Electron's OS-level `safeStorage` (DPAPI / Keychain /
  libsecret). "Test Connection" before saving, and a confirmation prompt before
  deleting a saved connection.
- Multi-tab: open several connections at once, each in its own tab that remembers
  its own bucket/folder/selection independently of the others.
- Bucket + object browser: bucket list sidebar, breadcrumb folder navigation,
  Explorer-style grid (name, size, last modified, storage class).
- Bookmarks: save named shortcuts to a connection + bucket + folder ("Add current"
  bookmarks wherever you're standing), then jump straight back with one click. Add,
  edit, and delete bookmarks from a dropdown panel.
- Local search bar: instantly filter the current folder's files/folders by name
  without leaving the page or hitting the network.
- Export the current folder's full listing (every page, not just what's on
  screen) to a CSV file via a native save dialog.
- Dark mode toggle; resizable sidebar and transfer queue panel with sizes
  remembered across restarts.

**File operations**

- New folder, rename, delete (multi-select), and pre-signed URL (share link)
  generation, available from a right-click context menu on the file grid.
- Copy and move objects within a bucket, across buckets, or across entirely
  different saved AWS accounts — folders recurse automatically, and guardrails
  stop you from copying a folder into itself or onto its own current location.
- Toolbar buttons only appear when they're actually usable ("hide, don't
  disable") instead of sitting there greyed out.

**Dual-pane view**

- A classic Total-Commander-style dual-pane layout: two completely independent,
  side-by-side browsing panes, each free to point at any saved connection and
  any bucket — including two different buckets in the *same* AWS account at
  once.
- Drag-resizable divider between the panes, with the split remembered across
  restarts.
- Copy or move the current selection straight to whatever the other pane is
  showing, via the mini toolbar or a right-click context menu — including
  across different AWS accounts.

**Fast multi-threaded transfer queue**

- Any number of uploads, downloads, and now copy/move operations can be queued
  at once.
- Configurable number of files transferring concurrently (1–16, default 4),
  persisted across restarts.
- Each individual upload is itself multipart with parallel parts
  (`@aws-sdk/lib-storage`), so large files saturate bandwidth too; multipart
  chunk size is also configurable and persisted.
- Per-task pause / resume / cancel / retry, plus pause-all / resume-all.
- Live progress %, transfer speed, and ETA per task, updated in real time via IPC.
- Drag-and-drop upload directly onto the file grid, plus toolbar Upload
  Files/Folder buttons using native OS pickers.
- Cross-pane copy/move in the dual-pane view runs through this same queue, so
  it's visible, cancelable, and reports errors instead of happening silently.
- Whichever open tab or pane is looking at an affected folder auto-refreshes
  the moment its transfer completes.

### Known limitations

- Pausing an in-flight upload/download aborts the current HTTP request;
  resuming restarts that file from byte 0 rather than a true byte-offset
  resume.
- Pausing or cancelling a copy/move only takes effect *between* items, not
  mid-item, and a paused/retried copy job re-copies from the first item rather
  than resuming partway. Acceptable in practice since same-account S3-to-S3
  copies are typically near-instant per object.

## How this compares to S3 Browser

[S3 Browser](https://s3browser.com/) (by Netsdk Software) is a long-running,
feature-rich Windows client for Amazon S3 — this project is styled after it and
owes it the UI inspiration. It's a much more mature product overall (see its
[full feature list](https://s3browser.com/)), so this is an honest side-by-side
rather than a claim of outright superiority:

| Area | Flash S3 Browser (this build) | S3 Browser |
| --- | --- | --- |
| Platform | Windows, macOS, and Linux (Electron) | Windows only (incl. Windows Server) |
| Dual-pane / side-by-side browsing | Yes — two independent panes, drag-resizable, cross-pane copy/move | No — closest equivalent is the one-way/two-way Folder Sync Tool, not a live two-pane browser |
| Multi-account, multi-tab browsing | Yes — several connections open as tabs simultaneously | Multiple accounts supported, but one active account view at a time |
| Copy/move across accounts | Yes, including in the dual-pane view | Yes (a longstanding S3 Browser feature) |
| Transfer queue visibility for copy/move | Yes — copy/move shows up in the same queue as uploads/downloads with progress and errors | Copy/move runs as its own operation, separate from the upload/download queue |
| Bookmarks | Yes — add/edit/delete, "Add current" | No dedicated bookmarks; has a bucket/account list instead |
| CSV export of a folder listing | Yes, full paginated listing | Not a built-in export; primarily supports scripted/CLI listing |
| Local in-folder search/filter | Yes | Advanced search/filtering across criteria (name, size, date, metadata) |
| Cost | Free, single build, no Free/Pro split | Free tier + paid Pro tier gating some features |
| Folder/bucket sync tool | No (see Roadmap) | Yes — a signature, mature feature with exclusion rules, scheduling, metadata caching |
| Bucket policy / ACL / CORS / lifecycle editors | No (see Roadmap) | Yes |
| Versioning UI, storage class management | No (see Roadmap) | Yes |
| CloudFront management | No (see Roadmap) | Yes |
| Client-side encryption, transfer acceleration, bandwidth throttling | No (see Roadmap) | Yes |
| AWS SSO / IAM tooling, CLI automation | No (see Roadmap) | Yes |

In short: this build is currently strongest where day-to-day browsing and
moving files around is concerned — especially the dual-pane workflow and
cross-platform support — while S3 Browser remains far ahead on bucket
administration, sync, and account/security tooling. The Roadmap below tracks
closing that gap.

## Architecture

- **Electron main process** (`electron/`) owns all AWS SDK calls and the transfer
  queue. The Angular renderer never talks to AWS directly.
  - `electron/services/s3-manager.js` — bucket/object CRUD, cross-account
    copy/move, and CSV export via `@aws-sdk/client-s3`.
  - `electron/services/transfer-queue.js` — the concurrent upload/download/
    copy-move engine.
  - `electron/services/credential-store.js` — encrypted profile storage.
  - `electron/ipc/register.js` — wires it all to `ipcMain.handle(...)`.
  - `electron/preload.js` — the only bridge exposed to the renderer
    (`window.electronAPI`), via `contextBridge` with `contextIsolation: true`.
- **Angular renderer** (`src/`) is a standalone-component Angular 17 app that only
  ever calls `window.electronAPI.*`.
  - `core/services/*` — state + IPC-calling services: `s3-browser.service.ts`
    (single active-tab browsing), `pane.service.ts` (independent dual-pane
    browsing state), `transfer.service.ts` (transfer queue + auto-refresh),
    `bookmark.service.ts`, `connection.service.ts`.
  - `features/*` — UI components: toolbar, bucket tree, object grid, dual-pane
    view, context menu, bookmarks, transfer queue panel, connection manager,
    dialogs.

## Getting started

Requires Node.js 18+.

```bash
npm install
npm start          # runs `ng serve` + Electron together, with dev tools open
```

Note: changes under `electron/` (main process, IPC, preload) require a full
restart of `npm start` to take effect — only the Angular renderer live-reloads.

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

## Roadmap (features not yet implemented)

**Object management & metadata**

- Version history: view, download, or restore previous versions of an object if
  bucket versioning is on.
- Tags editor: view/add/remove S3 object tags.
- Storage class control: pick Standard/IA/Glacier/etc. on upload, or transition
  existing objects.

**Bucket administration**

- Bucket policy and CORS editor (raw JSON with validation).
- ACL viewer/editor per object or bucket.
- Static website hosting and lifecycle rule management.

**Sync & automation**

- One-way or two-way folder sync between a local directory and an S3 prefix
  (S3 Browser's signature "Directory Sync" feature) — still the single biggest
  missing feature relative to S3 Browser.
- Scheduled backups (e.g., "sync this folder nightly").

**Viewing & navigation**

- Inline preview for images/text/PDF without downloading.
- Sort/filter columns in the file list (by size, date, extension).
- Global search across all buckets in a connection, not just the current folder.
- Recently visited folders history, separate from bookmarks.

**Transfers & reliability**

- True resumable pause (currently restarts from byte 0 for uploads/downloads,
  and re-copies from the first item for copy/move — noted above as a known
  limitation).
- Bandwidth throttling for transfers.
- A persistent transfer log/report you can export.

**Security & accounts**

- AWS SSO support.
- A "why don't I have access" IAM diagnostics helper.
- A log of presigned URLs you've generated, with the ability to revoke by
  rotating.
- CloudFront distribution management and invalidations.
- S3-compatible custom endpoints (MinIO, Wasabi, Backblaze B2, DigitalOcean
  Spaces) — currently AWS S3 only, per initial scope.

## Security notes

- Secrets are encrypted at rest with `safeStorage`; if the OS has no available
  encryption backend, they fall back to base64 (not secure) — flagged in
  `credential-store.js` for follow-up (e.g., requiring OS keychain unlock).
- `contextIsolation: true` and `nodeIntegration: false` are enforced in
  `electron/main.js`; the renderer only ever sees the explicit API surface
  defined in `electron/preload.js`.

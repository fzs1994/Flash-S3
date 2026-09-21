# Flash S3 — v0.0.2

**Release date:** September 19, 2026

Incremental release focused on object detail/sharing, feedback for in-app
actions, and a handful of transfer-queue and macOS fixes. See the
[README](./README.md) for the full feature list and roadmap.

## Highlights

- **Object properties dialog** — view size, storage class, last modified,
  ETag, and other metadata for a selected object without leaving the grid.
- **Configurable presigned share URLs** — pick a URL type/expiry when
  generating a share link instead of a single fixed default.
- **Blank-space context menu** — right-click empty space in the file grid
  for folder-level actions (new folder, refresh, paste) instead of only on
  a selected item.
- **Toast notifications** — success/error toasts now surface for actions
  like copy, move, delete, and completed transfers, instead of failing
  silently.
- **Real-time transfer speed fix** — corrected the transfer queue's speed
  and ETA calculation so it tracks actual throughput instead of drifting.
- **Overlay color fix** — corrected drag-and-drop and dialog overlay
  coloring for readability in both light and dark mode.
- **macOS drag-and-drop fix** — resolved an issue where drag-and-drop
  uploads didn't register correctly on macOS.
- **New interactive docs site** — a hosted overview with live feature
  demos and screenshots, linked from the README.

## Known limitations

- Pausing an in-flight upload/download aborts the current request; resuming
  restarts that file from byte 0 rather than a true byte-offset resume.
- Pausing or cancelling a copy/move only takes effect *between* items, not
  mid-item, and a paused/retried copy job re-copies from the first item
  rather than resuming partway.
- Object versioning is not exposed — the listing shows current versions only.
- Static access keys only; IAM Identity Center, MFA, and assumed roles are
  on the roadmap.
- Search filters the current prefix, not the whole bucket.
- Glacier objects list but can't be restored from the app.
- Cross-region moves of very large objects fall back to download + re-upload.

## Upgrade notes

No breaking changes. Install over the previous version — saved connections,
bookmarks, and encrypted credentials carry over as-is.

## What's next

See the **Roadmap** section in the README for planned work, most notably
local folder ↔ prefix sync, an object versioning browser, SSO/assumed-role
support, and true resumable pause for transfers.

---

# Flash S3 — v0.0.1 (Initial Public Release)

**Release date:** July 27, 2026

This is the first public release of Flash S3, a free, cross-platform desktop
client for Amazon S3 built on Electron + Angular, styled after S3 Browser
but focused on fast day-to-day browsing and file transfers rather than full
bucket administration. See the [README](./README.md) for the full feature
list, architecture notes, and an honest comparison against S3 Browser.

## Highlights

- **Multi-account, multi-tab browsing** — save any number of AWS credential
  profiles (encrypted at rest via the OS keychain/DPAPI/libsecret), and open
  several connections at once, each in its own tab with independent
  bucket/folder/selection state.
- **Dual-pane view** — a Total-Commander-style side-by-side layout with two
  fully independent panes (including two buckets in the same account at
  once), a drag-resizable divider, and one-click copy/move between panes —
  even across different AWS accounts.
- **Fast, multi-threaded transfer queue** — any number of uploads, downloads,
  and copy/move jobs can be queued together, with a configurable number of
  concurrent transfers (1–16) and configurable multipart chunk size.
- **Real, live per-part upload progress** — large files upload via a
  hand-rolled multipart uploader (not the stock AWS SDK helper) so the
  transfer queue shows genuine part-by-part progress and speed, matching how
  S3 Browser displays it, with a toggle between whole-file and per-part
  progress views.
- **Transfer queue tabs** — All / Running / Queued / Error / Completed tabs
  with live counts, defaulting to Running; per-task pause/resume/cancel/retry
  plus pause-all/resume-all.
- **Favorite buckets** — star any bucket from the sidebar, filter the bucket
  list down to favorites only, and both the favorites list and the
  favorites-only toggle persist across restarts.
- **Full file operations** — new folder, rename, delete (multi-select),
  pre-signed URL generation, and copy/move within a bucket, across buckets,
  or across accounts, with folder recursion and self-copy guardrails.
- **Keyboard shortcuts** — `Delete` to delete the current selection, `F2` to
  rename, both respecting text-input focus and open dialogs so they never
  fire by accident.
- **Bookmarks** — save a named shortcut to a connection + bucket + folder and
  jump back to it in one click; add/edit/delete from a dropdown panel.
- **CSV export** — export a folder's complete listing (every page, not just
  what's visible) via a native save dialog.
- **Quality-of-life** — local in-folder search/filter, dark mode, a resizable
  sidebar and transfer panel with sizes remembered across restarts, and a
  custom app icon across window/taskbar/dock/installer.
- **Cross-platform** — packaged installers for Windows (NSIS), macOS (DMG),
  and Linux (AppImage).

## Known limitations

- Pausing an in-flight upload/download aborts the current request; resuming
  restarts that file from byte 0 rather than a true byte-offset resume.
- Pausing or cancelling a copy/move only takes effect *between* items, not
  mid-item, and a paused/retried copy job re-copies from the first item
  rather than resuming partway.
- Per-part upload progress between confirmations is a smoothed estimate
  anchored to real completions, not a byte-exact live counter — this is a
  deliberate tradeoff because the OS network stack doesn't expose true
  in-flight byte confirmation.
- No bucket policy/ACL/CORS/versioning/lifecycle editors, no folder sync
  tool, and no CloudFront management yet — tracked in the README's Roadmap.

## Upgrade notes

None — this is the first release.

## What's next

See the **Roadmap** section in the README for planned work, most notably
one-way/two-way folder sync, an inline file preview, bucket policy/ACL
editors, and true resumable pause for transfers.

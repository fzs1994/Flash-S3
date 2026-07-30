# Flash S3 — v1.0.0 (Initial Public Release)

**Release date:** July 27, 2026

This is the first public release of Flash S3, a free, cross-platform desktop
client for Amazon S3 built on Electron + Angular, styled after the S3
browser but focused on fast day-to-day browsing and file transfers rather
than full bucket administration. See the [README](./README.md) for the full
feature list, architecture notes, and an honest comparison against S3.

_(Package version is currently `0.0.1` in `package.json` — bump this to
`1.0.0` as part of tagging the release if you want the two to match.)_

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
  NetSDK's S3 Browser displays it, with a toggle between whole-file and
  per-part progress views.
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
  deliberate tradeoff (see Architecture notes in the README) because the OS
  network stack doesn't expose true in-flight byte confirmation.
- No bucket policy/ACL/CORS/versioning/lifecycle editors, no folder sync
  tool, and no CloudFront management yet — tracked in the README's Roadmap.

## Upgrade notes

None — this is the first release.

## What's next

See the **Roadmap** section in the README for planned work, most notably
one-way/two-way folder sync, an inline file preview, bucket policy/ACL
editors, and true resumable pause for transfers.

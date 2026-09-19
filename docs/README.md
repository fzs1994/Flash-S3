<div align="center">

<img src="assets/logo.png" width="84" alt="Flash S3" />

# Flash S3

**A desktop S3 client for people who are done with the AWS console.**
Multi-account tabs, dual-pane transfers, and a multipart queue that actually shows you what it's doing.

![version](https://img.shields.io/badge/version-1.0.0-2f6fb0)
![license](https://img.shields.io/badge/license-MIT-blue)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![stack](https://img.shields.io/badge/built%20with-Electron%20%2B%20Angular-58a6ff)

### → [**Interactive overview & screenshots**](https://fzs1994.github.io/flash-s3) ←

[Download](https://github.com/fzs1994/Flash-S3/releases) · [Issues](https://github.com/fzs1994/Flash-S3/issues) · [Release notes](RELEASE_NOTES.md)

</div>

---

## Why

The console makes you sign out to switch accounts, hides transfer progress, and can't copy between buckets. Flash S3 keeps every account in a tab, splits large objects into parallel parts you can watch and pause, and puts a second pane next to the first so a cross-account copy is one action.

## Features

- **Multi-account tabs** — dev, stage and prod open at once in one window.
- **Dual pane** — each pane picks its own connection and bucket; copy or move across in one action.
- **Parallel multipart transfers** — a 150 MB archive moves as 7 concurrent parts at 8.7 MB/s, with per-part progress, pause and resume.
- **Queue that persists** — All / Running / Queued / Error / Completed views with live counts; failed parts retry without restarting the file.
- **Bookmarks & filters** — star deep prefixes, filter buckets and object listings as you type.
- **Object actions** — download, copy to, move to, rename, delete, presigned share URL, properties.
- **Upload folders** — whole directory trees, structure intact.
- **Export CSV** — dump the current listing for an audit or a spreadsheet.
- **Any S3-compatible endpoint** — MinIO, Wasabi, R2.
- **Credentials in the OS keychain** — no plaintext config, no telemetry.

## Install

Download an installer from the [Releases page](https://github.com/fzs1994/Flash-S3/releases):

| Platform | File                       |
| -------- | -------------------------- |
| Windows  | `Flash-S3-Setup-1.0.0.exe` |
| macOS    | `Flash-S3-1.0.0.dmg`       |
| Linux    | `Flash-S3-1.0.0.AppImage`  |

## Build from source

Requires Node 18+.

```bash
git clone https://github.com/fzs1994/Flash-S3.git
cd Flash-S3
npm install
```

```bash
npm start        # Angular dev server + Electron window, live reload
npm run dist     # installers into release/
```

Add an account under **Connections → New**. Credentials go to the OS credential store, not the repo.

## Architecture

| Layer     | Stack            | Role                                                                           |
| --------- | ---------------- | ------------------------------------------------------------------------------ |
| Renderer  | Angular          | The whole UI; no direct filesystem or network access.                          |
| Main      | Electron / Node  | AWS SDK v3 clients, OS credential store, filesystem — reached over typed IPC.  |
| Workers   | Transfer engine  | Parts off the main thread, concurrency limit, retry-per-part, progress events. |
| Packaging | electron-builder | NSIS installer, signed DMG, AppImage from one tree.                            |

## Known limitations (v1.0.0)

- Object versioning is not exposed — the listing shows current versions only.
- Static access keys only; IAM Identity Center, MFA and assumed roles are on the roadmap.
- Search filters the current prefix, not the whole bucket.
- Glacier objects list but can't be restored from the app.
- Cross-region moves of very large objects fall back to download + re-upload.

## Security

Credentials live in Keychain / Credential Manager / libsecret. Nothing leaves your machine except signed HTTPS requests to AWS — no telemetry, no account. Presigned share links are generated locally and expire.

## Roadmap

- [ ] Local folder → prefix sync with a dry-run diff
- [ ] Object versioning browser
- [ ] SSO and assumed-role support
- [ ] Recursive bucket-wide search
- [ ] Storage-class transitions

## Contributing

Issues and pull requests welcome. Bug reports with the failing bucket layout and a rough object count are the most useful thing you can send — please open an issue before starting anything large.

## License

MIT. Flash S3 is an independent project and is not affiliated with or endorsed by Amazon Web Services.

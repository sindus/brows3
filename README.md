# Brows3

[![Release](https://img.shields.io/github/v/release/sindus/brows3)](https://github.com/sindus/brows3/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Build](https://github.com/sindus/brows3/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/sindus/brows3/actions/workflows/release.yml)

> Fork of [rgcsekaraa/brows3](https://github.com/rgcsekaraa/brows3) — adds grid view, async thumbnails, video support, and a local LRU cache.

**Brows3** is a high-performance, open-source Amazon S3 browser, S3 explorer, and S3 desktop client designed for developers who demand speed. Built with a **Rust** core and a **Tauri**-powered frontend, Brows3 solves the "slow listing" problem of traditional S3 browsers through its unique prefix-indexed caching architecture.

Navigating through buckets with millions of objects is now as fast as browsing your local file system.

---

## What's New in This Fork

| Feature | Description |
| :--- | :--- |
| **Grid / Icon View** | Toggle between list and grid with a single click. Grid shows thumbnails or file-type icons. |
| **Progressive Image Thumbnails** | Thumbnails load one by one as you browse — iCloud style. No waiting for the whole bucket. |
| **Video Thumbnails** | First-frame thumbnails extracted via bundled **ffmpeg** — no separate install needed for users. |
| **Content-Type Detection** | Images and videos without file extensions are detected via the S3 `Content-Type` header. |
| **Local LRU Thumbnail Cache** | Thumbnails are cached on disk. Default limit: **1 GB**. Evicts least-recently-used entries automatically. |
| **Cache Settings UI** | Configure cache size (100 MB – 10 GB) and clear the cache from the Settings page. |

---

## Why Brows3?

Traditional S3 tools often suffer from latency when navigating deep folder structures or listing large numbers of objects. Brows3 rethinks the browsing experience:

- **Instant Navigation**: After an initial index, folder traversal happens **instantly**. No more waiting for "Loading…" spinners when clicking through directories.
- **Deep Search**: Perform instant, localized searches across your entire bucket. Find any file in milliseconds, even in massive datasets.
- **Intelligent Background Indexing**: Brows3 populates its local cache in the background while you work, keeping your view synchronized without blocking interaction.
- **Hyper-Virtuoso Table**: Our custom-tuned virtualization engine handles lists of 100,000+ items with silky-smooth scrolling at 60fps.

## Feature Deep Dive

### File Management
- **Breadcrumb Navigation**: Path-based navigation for rapid traversal of complex hierarchies.
- **Bulk Operations**: Upload, download, and delete multiple files or recursive folders at once.
- **Mixed Content Support**: Seamlessly handle folders and files in a single drag-and-drop operation.
- **Copy-to-Clipboard**: Quick copy of S3 Paths, Keys, and Object URLs.
- **Presigned URL Sharing**: Generate temporary object links with configurable expiry directly from the bucket view.

### Rich Previews & Editing
- **Built-in Editor**: Powered by **Monaco (VS Code's Engine)**. Edit text, JSON, and code files directly in S3.
- **Direct Edit Action**: Quick "Edit" button in the file list and context menu for instant code/text modifications.
- **Media Previews**: Native support for **high-resolution images**, **videos**, and **PDFs**.

### Speed & Performance
- **Rust-Powered Backend**: Core logic is written in Rust for near-instant operations.
- **Smart In-Memory Caching**: Sub-millisecond navigation for recently visited folders with auto-invalidation and 30-minute TTL.
- **Lazy Loading**: Efficiently handles buckets with millions of objects.

### Enterprise & Restricted Access
- **Direct Bucket Access**: Instantly navigate to specific buckets even without `s3:ListBuckets` permission.
- **Profile-Gated Access**: Create isolated profiles for different AWS accounts or environments.
- **Persistent Secure Profiles**: Credentials survive restarts while secrets stay in the OS keychain instead of plain JSON.

### Other
- **In-App PDF Preview**: View PDFs directly within the application.
- **Automatic Region Discovery**: Profiles auto-detect the correct AWS region from system configurations.
- **Smart Tab Management**: Intelligent tab deduplication.
- **Deep Recursive Search**: 5x more depth with context-awareness and auto-region retry.
- **System Monitor**: Real-time visibility into API request success/failure rates and live logs.
- **Auto-Updates**: Seamless background updates.

## Technical Architecture

1. **Rust Core**: Handles S3 networking, credential management, local indexing, and thumbnail generation.
2. **Prefix-Indexed Tree**: In-memory structure for instant directory lookup.
3. **Paginated IPC Bridge**: High-speed, paginated data transfer between Rust and React.
4. **SSG React (The UI)**: Next.js frontend exported as a static site with the smallest possible memory footprint.

## Installation

Download the latest version from the [Releases](https://github.com/sindus/brows3/releases) page.

| Platform | Installer Type |
| :--- | :--- |
| **macOS** | `.dmg` (Apple Silicon / Intel) |
| **Windows** | `.msi`, `.exe` |
| **Linux** | `.deb`, `.AppImage` |

Windows releases bundle the WebView2 runtime so fresh machines don't need a separate download.

### Manual Build

#### Prerequisites (All Platforms)
- **Node.js** v20+ and **pnpm** (`npm install -g pnpm`)
- **Rust** (see platform instructions below)

#### Windows

```powershell
winget install Rustlang.Rustup
git clone https://github.com/sindus/brows3.git
cd brows3
pnpm install
pnpm tauri dev
```

#### macOS

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
xcode-select --install   # if needed
git clone https://github.com/sindus/brows3.git
cd brows3
pnpm install
pnpm tauri dev
```

#### Linux (Debian/Ubuntu)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
sudo apt update && sudo apt install -y \
  libgtk-3-dev libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
git clone https://github.com/sindus/brows3.git
cd brows3
pnpm install
pnpm tauri dev
```

#### Release Build (All Platforms)

```bash
pnpm tauri build
```

## Troubleshooting (macOS)

If you see **"Brows3.app is damaged and can't be opened"**:

Drag `Brows3.app` into `/Applications` first. If Gatekeeper still blocks it:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Brows3.app
```

See [macOS Troubleshooting Guide](docs/MACOS_TROUBLESHOOTING.md) and [Release Signing Guide](docs/RELEASE_SIGNING.md) for more details.

## Release Keys

For auto-updates, the GitHub Actions secrets must include `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and the matching public key must be in `src-tauri/tauri.conf.json`.

To generate a keypair:

```bash
pnpm tauri signer generate -w ~/.tauri/brows3.key
```

Then add the private key to `Repository Settings → Secrets and variables → Actions`.

## License

Distributed under the MIT License. See `LICENSE` for more information.

---

Forked from [rgcsekaraa/brows3](https://github.com/rgcsekaraa/brows3). Original work by [rgcsekaraa](https://www.linkedin.com/in/rgcsekaraa/).

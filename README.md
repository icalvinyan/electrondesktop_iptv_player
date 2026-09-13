# Xtream TV — Desktop

A TiviMate-style desktop IPTV player. Wraps the in-browser Xtream/M3U player in an Electron shell so streams that fail in a regular browser (CORS, mixed-content, `file://` restrictions) just work.

## What you get over the browser version

- **No CORS.** The shell strips `Origin`/`Referer` from outgoing requests, forces permissive `Access-Control-*` headers on every response, and exposes a Node-side `fetch` to the renderer for M3U/Xtream API downloads.
- **No mixed-content blocks.** HTTP IPTV servers play fine even though the app uses `file://` internally.
- **Realistic User-Agent.** Many IPTV servers reject the default Electron UA string. The app pretends to be desktop Chrome.
- **Native menus + keyboard shortcuts.** `⌘1`–`⌘4` switch views, `⌘O` opens a local M3U file, `⌘N` adds a server, `⌘R` reloads.
- **Window state persists** across launches.
- **Multi-view + PiP + Chromecast** all work, with better stability than a regular browser tab (no background throttling).

## First-time setup

You need [Node.js](https://nodejs.org/) 18 or newer.

```bash
cd xtream-desktop
npm install
npm start
```

The `npm install` step downloads Electron (~250 MB) once and caches it. After that, `npm start` launches the app in a few seconds.

## Build a distributable `.app` / `.exe` / `.AppImage`

```bash
npm run package:mac     # → dist/Xtream TV-0.1.0.dmg
npm run package:win     # → dist/Xtream TV Setup 0.1.0.exe
npm run package:linux   # → dist/Xtream TV-0.1.0.AppImage
```

The output appears in `dist/`. Move the `.app` / `.exe` / `.AppImage` wherever you'd put any other application.

> macOS: unsigned builds will need to be opened the first time via Finder → right-click → Open (or run `xattr -dr com.apple.quarantine "/Applications/Xtream TV.app"`).

## Project layout

```
xtream-desktop/
├── main.js            ← Electron main process (window, IPC, CORS, menus)
├── preload.js         ← Bridge exposing `window.xtream.{fetch, openM3UFile, onMenu}`
├── renderer/
│   └── index.html     ← The full player UI (HTML + CSS + JS in one file)
├── package.json
└── README.md
```

## Using the app

On first launch the connect screen opens. You have four ways to load channels:

1. **My Servers** — picks a previously-saved profile.
2. **Add Xtream** — host (e.g. `http://your-server.com:8080`), username, password.
3. **Import M3U** — paste any M3U/M3U8 URL, or use **File → Open M3U file…** to load a local playlist.
4. **Discover (iptv-org)** — one-click import of curated free public playlists (US, UK, news, sports, etc.).

Inside the app:

- **Live** — single-channel player with EPG, channel list, search, favorites, hover preview.
- **Multi** — 2/4/6/9-tile grid. Click a sidebar channel to drop it in. Per-tile audio focus. Toolbar has volume, mute, PiP-grid, and fullscreen-focused-tile buttons. Arrow keys ←/→ cycle tiles when one is fullscreen or when PiP is active.
- **Guide** — scrollable EPG grid.
- **Favorites** — starred channels.

## Keyboard reference

| Key | What it does |
|---|---|
| `Space` | Play / pause |
| `↑` / `↓` | Previous / next channel (Live view) |
| `←` / `→` | Cycle tiles when multi-view is fullscreen or PiP |
| `F` | Fullscreen |
| `M` | Mute |
| `S` | Star current channel |
| `/` | Focus search |
| `G` / `L` / `H` / `X` | Guide / Live / Favorites / Multi |
| `C` | Cast |
| `⌘1` – `⌘4` | Views (Live, Multi, Guide, Favorites) |
| `⌘O` | Open M3U file |
| `⌘N` | Add server |
| `Esc` | Exit fullscreen (returns to Multi tab if you were in a tile) |

## Troubleshooting

**A channel still doesn't play in the desktop app.** The red error panel at the bottom of the player will name the specific cause:

- **HEVC/H.265 or AC-3 channels** — HEVC video plays directly on Macs with hardware HEVC decoding. Anything Chromium can't decode (AC-3/E-AC-3 audio, HEVC on unsupported hardware) is automatically re-encoded through the bundled ffmpeg; for AC-3 only the audio is converted, so this is cheap. If you still get "uses HEVC/H.265 video or AC-3 audio…", check the main-process log for ffmpeg errors (run `npm install` if ffmpeg-static is missing). Otherwise the stream may be offline, or the account may be at its connection limit.
- **"manifest fetch failed"** — the IPTV server is unreachable from your network at the moment, or your account is at its concurrent-connection cap (close other devices/sessions and retry).
- **Long stalls / repeated buffering** — the IPTV server is rate-limiting or your account is being shared. Click **Stop** in the player overlay to release the connection.

**Chromecast button is greyed out.** Electron doesn't ship Chrome's Cast SDK in the same way regular Chrome does. The Cast button is best-effort here — for serious casting use the browser version on Chrome desktop instead, or run a separate Chromecast sender like [Cast All The Things](https://catt.readthedocs.io/).

## License / disclaimer

This project ships no streams of its own and includes no credentials. Use it with subscriptions you have paid for or with public playlists from sources like [iptv-org](https://github.com/iptv-org/iptv). You are responsible for what you connect it to.

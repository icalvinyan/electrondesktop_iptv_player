# Embedded libmpv addon — build & packaging guide

This addon embeds `libmpv` directly in the Electron main process via N-API,
decodes/renders VOD frames in-process (libmpv's *software* render API — see
the comment block at the top of `src/mpv_addon.cc` for why GL/Metal embedding
was not used), and streams RGBA frames to the renderer over IPC to be painted
onto `<canvas id="mpv2-canvas">`. This is what gives genuinely **in-window**
video — unlike the `xtream.mpv*` fallback in `main.js`, which launches the
external `mpv` binary in its own native window.

It is *not* prebuilt — native addons must be compiled against the exact
Electron/Node ABI and architecture you're shipping. Below is how to build it
for development, then how to make a release build that runs on end-user Macs
**without** Homebrew installed.

---

## 1. Development build (your machine has Homebrew + mpv)

```bash
brew install mpv pkg-config node-gyp
cd xtream-desktop/native/mpv-addon
npm install
# Build against your installed Electron's headers/ABI, not system Node:
npx electron-rebuild -f -w mpv-addon
#   — or, equivalently —
npm run build -- --target=$(node -p "require('electron/package.json').version") \
                 --dist-url=https://electronjs.org/headers
```

`binding.gyp` looks for `libmpv` under `/opt/homebrew` (Apple Silicon),
`/usr/local` (Intel), then a vendored copy at `native/mpv-addon/vendor/`
(see step 3). On success you'll have
`native/mpv-addon/build/Release/mpv_addon.node`.

Verify it loads:

```bash
cd xtream-desktop
node -e "console.log(require('./native/mpv-addon'))"
# → { available: true, error: null, MpvPlayer: [Function] }
```

Then `npm start` — VOD playback will prefer this addon automatically
(`playVodUrl` tries it first; see `Mpv2.tryStart` in `renderer/index.html`).

---

## 2. Why this can't just be "drop in libmpv.dylib"

Your bundling steps (Frameworks dir → `dylibbundler` → `install_name_tool` →
`codesign`) are exactly right for *distributing* a `.dylib` — but they assume
something is already linking against and calling into it. That "something" is
this addon: a compiled `.node` binary containing C++ that calls
`mpv_create`/`mpv_initialize`/`mpv_render_context_create`/etc. Bundling
`libmpv.dylib` alone, with no compiled code that uses its API, would do
nothing. The order is:

1. Compile `mpv_addon.node` (links against `libmpv.dylib` at build time).
2. Bundle `libmpv.dylib` + its transitive dependencies into the app, with
   their load paths rewritten to `@executable_path`-relative locations.
3. Re-point `mpv_addon.node`'s own load command for `libmpv` at the bundled
   copy (`install_name_tool -change`).
4. Code-sign every `.dylib` and the addon binary, then the whole app bundle.

## 3. Release build — redistributable, no Homebrew required

### 3a. Get a redistributable `libmpv.dylib`

Two options:

- **Easiest**: copy `libmpv.dylib` (and `libmpv.2.dylib` etc. — follow the
  symlink chain) out of your own Homebrew prefix
  (`/opt/homebrew/opt/mpv/lib/` or `brew --prefix mpv`/`lib`) into
  `native/mpv-addon/vendor/lib/`, and the matching headers
  (`brew --prefix mpv`/`include/mpv`) into `native/mpv-addon/vendor/include/mpv/`.
  This is a Homebrew build, so its dependency dylibs (FFmpeg, libass,
  libplacebo, etc.) also need to come along — `dylibbundler` (step 3b)
  handles discovering and copying all of them for you.
- **Most portable**: build `libmpv` from source with a minimal feature set
  (e.g. via `mpv-build` or a custom meson invocation) so it has fewer/no
  external dependencies to bundle and fewer codec-licensing questions to
  track. More setup work, smaller and simpler bundle.

Either way, point `binding.gyp`'s `vendor/include` and `vendor/lib` at what
you produced (the `.gyp` already includes those paths) and rebuild the addon
against the vendored copy so its link path matches what you'll bundle.

### 3b. Bundle the dylibs into the packaged app

`electron-builder` (already configured in `xtream-desktop/package.json`)
produces `dist/mac/Xtream TV.app`. After packaging (and *before* signing —
`dylibbundler` rewrites binaries, which invalidates signatures), run:

```bash
brew install dylibbundler

APP="dist/mac/Xtream TV.app"
ADDON="$APP/Contents/Resources/app.asar.unpacked/native/mpv-addon/build/Release/mpv_addon.node"
FRAMEWORKS="$APP/Contents/Frameworks"
mkdir -p "$FRAMEWORKS"

dylibbundler -of -b \
  -x "$ADDON" \
  -d "$FRAMEWORKS" \
  -p "@executable_path/../Frameworks/"
```

This walks `mpv_addon.node`'s dependency tree (libmpv → FFmpeg → libass →
…), copies every external `.dylib` into `Contents/Frameworks/`, and rewrites
each one's internal install names to `@executable_path/../Frameworks/<name>`
— including fixing `mpv_addon.node`'s own reference to `libmpv.dylib`. (Note
`@executable_path` here resolves relative to `Contents/MacOS/Xtream TV`, and
`native/mpv-addon` is also nested several directories deep inside
`app.asar.unpacked` — `binding.gyp` already adds an
`@loader_path/../../../Frameworks` rpath for exactly this reason. If
`dylibbundler` can't resolve the addon's own rpath-relative reference,
add the same rpath manually with
`install_name_tool -add_rpath @loader_path/../../../Frameworks "$ADDON"`.)

### 3c. Sign everything (innermost first)

```bash
IDENTITY="Developer ID Application: Your Name (TEAMID)"

codesign --force --options runtime --verify --verbose \
  --sign "$IDENTITY" "$FRAMEWORKS"/*.dylib

codesign --force --options runtime --verify --verbose \
  --sign "$IDENTITY" "$ADDON"

codesign --force --options runtime --verify --verbose --deep \
  --sign "$IDENTITY" "$APP"

# Confirm Gatekeeper is satisfied:
spctl --assess --type execute --verbose "$APP"
```

(`xtream-desktop/package.json` currently has `notarize: false` /
`identity: null` for local unsigned builds — flip those and supply your
Developer ID + notarization credentials for a distributable build. That's a
separate Apple-developer-account setup outside this addon's scope.)

### 3d. Smoke-test on a clean machine

Copy the signed `.app` to a Mac **without** Homebrew/mpv installed and
confirm:

```bash
node -e "console.log(require('/path/to/Xtream TV.app/Contents/Resources/app.asar.unpacked/native/mpv-addon'))"
```

reports `available: true`, and that playing a `.mkv` VOD title shows the
"Playing with the embedded native player" toast (rather than falling back to
the external-mpv or in-app pipelines).

---

## 4. Fallback behavior (what happens if you skip all of this)

`playVodUrl` in `renderer/index.html` tries, in order:

1. **Embedded libmpv** (`Mpv2` / `mpv2*` IPC) — requires this addon built
   and its dylibs resolvable (dev: Homebrew; release: bundled per above).
2. **External `mpv`** (`xtream.mpv*` / `startMpvPlayback` in `main.js`) —
   requires the end user to `brew install mpv` themselves; opens in its own
   native window.
3. **In-app browser/ffmpeg pipeline** (`playVodUrlInApp` /
   `startLocalTranscodeStream`) — always available, weakest `.mkv`/codec/
   subtitle support, which is the gap this whole effort exists to close.

Shipping without building/bundling this addon is fine functionally — the app
degrades gracefully — it just won't get the in-window-embedded experience
until steps 1–3 above are done for a release build.

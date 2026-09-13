// Thin loader for the compiled native addon. Keeping this indirection means
// main.js can `require('./native/mpv-addon')` without caring whether the
// binary lives at the standard node-gyp output path or a packaged-app path
// (electron-builder unpacks native modules out of the asar archive).
'use strict';
const path = require('path');
const fs = require('fs');

const candidates = [
  path.join(__dirname, 'build', 'Release', 'mpv_addon.node'),
  path.join(__dirname, 'build', 'Debug', 'mpv_addon.node'),
  path.join(__dirname, 'prebuilds', `${process.platform}-${process.arch}`, 'mpv_addon.node'),
  // Committed prebuilt, keyed by Node ABI (process.versions.modules) so a
  // binary built for another Electron major is skipped rather than crashing.
  path.join(__dirname, 'bin', `${process.platform}-${process.arch}-${process.versions.modules}`, 'mpv-addon.node'),
];

let addon = null;
let loadError = null;
for (const p of candidates) {
  if (fs.existsSync(p)) {
    try { addon = require(p); break; } catch (e) { loadError = e; }
  }
}

if (!addon) {
  module.exports = {
    available: false,
    error: loadError ? loadError.message : 'mpv_addon.node not built — run `npm run build` inside native/mpv-addon (see BUILD.md)',
    MpvPlayer: null,
  };
} else {
  module.exports = Object.assign({ available: true, error: null }, addon);
}

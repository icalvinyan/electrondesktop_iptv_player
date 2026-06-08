// Bridge between the renderer (browser context) and the Electron main process.
// Only carefully chosen APIs are exposed — the renderer cannot touch Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xtream', {
  isDesktop: true,
  platform: process.platform,
  fetch: (url, opts) => ipcRenderer.invoke('net:fetch', url, opts),
  openM3UFile: () => ipcRenderer.invoke('dialog:openM3U'),
  storageLoad: () => ipcRenderer.invoke('storage:load'),
  storageSave: (data) => ipcRenderer.invoke('storage:save', data),
  onMenu: (channel, cb) => {
    const handler = (_evt, ...args) => cb(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  // Cast (native Node.js implementation — no Chrome extension needed)
  castDiscover:    ()                          => ipcRenderer.invoke('cast:discover'),
  castConnect:     (host, port)               => ipcRenderer.invoke('cast:connect', host, port),
  castLoad:        (url, ct, title, icon, opts) => ipcRenderer.invoke('cast:load', url, ct, title, icon, opts),
  castStop:        ()                          => ipcRenderer.invoke('cast:stop'),
  castDisconnect:  ()                          => ipcRenderer.invoke('cast:disconnect'),
  castIsConnected: ()                          => ipcRenderer.invoke('cast:isConnected'),
  onCastStatus: (cb) => {
    const h = (_evt, data) => cb(data);
    ipcRenderer.on('cast:status', h);
    return () => ipcRenderer.removeListener('cast:status', h);
  },
  onCastLog: (cb) => {
    const h = (_evt, msg) => cb(msg);
    ipcRenderer.on('cast:log', h);
    return () => ipcRenderer.removeListener('cast:log', h);
  },
  // Net/Cloudflare-bypass log lines from the main process — forwarded so they
  // show up in the renderer DevTools console (and in exported console logs)
  // instead of only the launching terminal's stdout.
  onNetLog: (cb) => {
    const h = (_evt, msg) => cb(msg);
    ipcRenderer.on('net:log', h);
    return () => ipcRenderer.removeListener('net:log', h);
  },
  // Local transcode — HEVC→H.264 HLS for the in-app player
  localTranscode:     (url) => ipcRenderer.invoke('local:startTranscode', url),
  localTranscodeStop: ()    => ipcRenderer.invoke('local:stopTranscode'),
  // Native VOD player (mpv) — proper .mkv demuxing, every audio codec, and
  // styled subtitle rendering, launched as its own window and IPC-controlled.
  mpvAvailable: ()         => ipcRenderer.invoke('mpv:available'),
  mpvPlay:      (url, t)   => ipcRenderer.invoke('mpv:play', url, t),
  mpvCommand:   (cmdArr)   => ipcRenderer.invoke('mpv:command', cmdArr),
  mpvStop:      ()         => ipcRenderer.invoke('mpv:stop'),
  onMpvEvent: (cb) => {
    const h = (_evt, data) => cb(data);
    ipcRenderer.on('mpv:event', h);
    return () => ipcRenderer.removeListener('mpv:event', h);
  },
  // Embedded libmpv (native addon) — true in-window VOD playback. Renders
  // RGBA frames in-process and streams them here for a <canvas> to paint;
  // falls back to xtream.mpv* (external mpv window) or the in-app HLS/ffmpeg
  // pipeline when the addon hasn't been built on this machine.
  mpv2Available:       ()              => ipcRenderer.invoke('mpv2:available'),
  mpv2Open:            (url, t, w, h)  => ipcRenderer.invoke('mpv2:open', url, t, w, h),
  mpv2Command:         (cmdArr)        => ipcRenderer.invoke('mpv2:command', cmdArr),
  mpv2SetProperty:     (name, value)   => ipcRenderer.invoke('mpv2:setProperty', name, value),
  mpv2GetProperty:     (name)          => ipcRenderer.invoke('mpv2:getProperty', name),
  mpv2SetSurfaceSize:  (w, h)          => ipcRenderer.invoke('mpv2:setSurfaceSize', w, h),
  mpv2Close:           ()              => ipcRenderer.invoke('mpv2:close'),
  onMpv2Event: (cb) => {
    const h = (_evt, data) => cb(data);
    ipcRenderer.on('mpv2:event', h);
    return () => ipcRenderer.removeListener('mpv2:event', h);
  },
});

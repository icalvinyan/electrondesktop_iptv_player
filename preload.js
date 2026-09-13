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
  // Local transcode — HEVC/AC-3 → HLS for the in-app player.
  // opts.copyVideo: keep the video as-is and convert only the audio.
  localTranscode:     (url, opts) => ipcRenderer.invoke('local:startTranscode', url, opts),
  localTranscodeStop: ()    => ipcRenderer.invoke('local:stopTranscode'),
});

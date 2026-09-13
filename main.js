// =====================================================================
//  Xtream TV Desktop — Electron main process
//  Wraps the player UI in a desktop window and bypasses browser-only
//  problems (CORS, mixed-content, file:// fetch blocks).
// =====================================================================
'use strict';

const { app, BrowserWindow, Menu, shell, session, ipcMain, dialog, MessageChannelMain } = require('electron');
const path  = require('node:path');
const fs    = require('node:fs');
const http  = require('node:http');
const https = require('node:https');
const tls   = require('node:tls');
const dgram = require('node:dgram');
const net   = require('node:net');
const dns   = require('node:dns');
const os    = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { URL } = require('node:url');

// ---------- enable Chromecast (Media Router) ----------
// The Google Cast SDK requires the page to be served over http:// (not file://)
// AND needs the Chromium media router enabled.
app.commandLine.appendSwitch('enable-media-router');
app.commandLine.appendSwitch('load-media-router-component-extension', '1');

// ---------- pretend to be Chrome everywhere ----------
// Many IPTV CDNs 403 the Electron User-Agent. Setting userAgentFallback globally
// changes both navigator.userAgent and the default User-Agent header on every request.
const FAKE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
app.userAgentFallback = FAKE_UA;

// ---------- localhost renderer server ----------
// The Google Cast SDK will not initialize on a file:// origin. We spin up a tiny
// static server so the page loads as http://127.0.0.1:PORT — the Cast SDK then
// treats it as a proper web origin and can discover/connect to Cast devices.
let _rendererPort = 0;
function startRendererServer() {
  return new Promise((resolve, reject) => {
    const rendererDir = path.join(__dirname, 'renderer');
    const srv = http.createServer((req, res) => {
      // Only serve files under the renderer directory; default to index.html
      let relPath = req.url.split('?')[0]; // strip query string
      if (relPath === '/' || relPath === '') relPath = '/index.html';
      const filePath = path.join(rendererDir, relPath);
      // Security: stay inside renderer dir
      if (!filePath.startsWith(rendererDir)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        const ext = path.extname(filePath).toLowerCase();
        const mime = { '.html':'text/html', '.js':'application/javascript',
                       '.css':'text/css', '.png':'image/png', '.ico':'image/x-icon' };
        res.writeHead(200, { 'Content-Type': (mime[ext] || 'application/octet-stream') + '; charset=utf-8' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      _rendererPort = srv.address().port;
      resolve(_rendererPort);
    });
    srv.on('error', reject);
  });
}

// ---------- Cast stream proxy ----------
// The Chromecast can't reach 127.0.0.1, and some IPTV servers block non-browser
// User-Agents. This proxy runs on the LAN interface so the Chromecast fetches
// streams via our machine (same IP as the app), with proper headers.
//
// URL scheme: http://<lan-ip>:<port>/cast-proxy/<base64url(target-url)>
// M3U8 manifests are transparently rewritten so segment URLs also go through proxy.

let _castProxyPort      = 0;
let _castProxyLanIp     = '127.0.0.1';
let _proxyTranscode     = false;  // true when stream needs H.265→H.264 transcode
// Per-stream HLS sequence tracking: some IPTV servers reset EXT-X-MEDIA-SEQUENCE to 0
// on every manifest refresh. We synthesize monotonically-increasing values so the Cast
// device doesn't think the stream restarted and re-buffer from "the beginning".
const _m3u8SeqMap = new Map(); // baseUrl → last sequence number emitted
let _ffmpegBin          = null;   // resolved once at startup from ffmpeg-static

// Persistent transcode stream state.
// Pre-started before the Cast LOAD so ffmpeg has time to produce HLS segments
// before the Cast device opens /cast-hls/playlist.m3u8.
let _transcodeStream = null; // { proc, hlsDir, playlistPath, sourceUrl }

// Local (non-Cast) transcode stream state — separate from Cast so both can coexist.
let _localTranscodeStream = null; // { proc, hlsDir, playlistPath, sourceUrl }

function startLocalTranscodeStream(sourceUrl) {
  if (_localTranscodeStream) {
    try { _localTranscodeStream.proc.kill(); } catch(_) {}
    if (_localTranscodeStream.hlsDir) {
      try { fs.rmSync(_localTranscodeStream.hlsDir, { recursive: true, force: true }); } catch(_) {}
    }
    _localTranscodeStream = null;
  }
  const ffBin = findFfmpeg();
  if (!ffBin) return null;

  const hlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtream-local-hls-'));
  const playlistPath = path.join(hlsDir, 'playlist.m3u8');
  castProxyLog(`[LocalTranscode] starting ffmpeg HLS → ${hlsDir}`);

  // NOTE: this path is VOD-only (the renderer's "local transcode" fallback for
  // HEVC video / undecodable audio on on-demand playback). VOD sources are
  // debrid-resolved cached-torrent files — typically large remuxed .mkv with
  // multiple audio/subtitle/attachment streams and big Matroska headers — which
  // behave very differently from the small, steady Live TV channel feeds that
  // `startTranscodeStream` above is tuned for. A few VOD-specific adjustments:
  //   • Smaller `-analyzeduration`/`-probesize` so ffmpeg starts producing HLS
  //     segments (and the playlist) sooner — the renderer was timing out with
  //     "manifestLoadError" because the playlist file didn't exist yet by the
  //     time HLS.js tried to fetch it.
  //   • `?` on the stream maps so a missing/odd-indexed audio track (common in
  //     multi-audio-track rips) doesn't make ffmpeg exit immediately with no
  //     output at all.
  //   • `-sn -dn` to explicitly drop subtitle/data streams from the mux —
  //     mkv rips often carry these and they can confuse `-f hls` muxing.
  //   • `-max_muxing_queue_size` to absorb the bursty packet interleaving that
  //     large mkv remuxes can produce (a very common cause of ffmpeg aborting
  //     part-way through with "Too many packets buffered for output stream").
  //   • Dropped `-tune zerolatency` — that's a live-encoding knob; for VOD
  //     remuxing a finite file it does nothing useful and can hurt encode
  //     stability/efficiency.
  const proc = spawn(ffBin, [
    '-loglevel', 'error',
    '-user_agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    '-headers', 'Accept: */*\r\n',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-analyzeduration', '3000000',
    '-probesize', '5000000',
    '-fflags', '+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-i', sourceUrl,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn', '-dn',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-profile:v', 'main',
    '-level:v', '4.1',
    '-vf', "scale='if(gt(iw,1920),1920,-2)':'if(gt(ih,1080),-2,ih)',format=yuv420p",
    '-crf', '23',
    '-x264-params', 'repeat_headers=1:bframes=0',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-max_muxing_queue_size', '4096',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '10',
    '-hls_flags', 'delete_segments+append_list+independent_segments',
    '-hls_segment_filename', path.join(hlsDir, 'seg%05d.ts'),
    playlistPath,
  ]);

  const state = { proc, hlsDir, playlistPath, sourceUrl };
  _localTranscodeStream = state;

  proc.stderr.on('data', d => castProxyLog(`[LocalTranscode] ffmpeg: ${d.toString().trim()}`));
  proc.on('error', e => {
    castProxyLog(`[LocalTranscode] ffmpeg error: ${e.message}`);
    if (_localTranscodeStream === state) _localTranscodeStream = null;
  });
  proc.on('exit', (code, sig) => {
    castProxyLog(`[LocalTranscode] ffmpeg exited code=${code} signal=${sig}`);
    if (_localTranscodeStream === state) _localTranscodeStream = null;
    try { fs.rmSync(hlsDir, { recursive: true, force: true }); } catch(_) {}
  });

  return `http://127.0.0.1:${_castProxyPort}/local-hls/playlist.m3u8`;
}

function startTranscodeStream(sourceUrl) {
  if (_transcodeStream) {
    try { _transcodeStream.proc.kill(); } catch(_) {}
    if (_transcodeStream.hlsDir) {
      try { fs.rmSync(_transcodeStream.hlsDir, { recursive: true, force: true }); } catch(_) {}
    }
    _transcodeStream = null;
  }
  const ffBin = findFfmpeg();
  if (!ffBin) { castProxyLog('[Transcode] ffmpeg not found — cannot start stream'); return; }

  // Write transcoded HLS to a temp directory.
  // The Cast device gets a proper HLS stream (application/x-mpegurl) which the
  // Default Media Receiver fully supports, unlike raw MPEG-TS (video/mp2t).
  const hlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtream-hls-'));
  const playlistPath = path.join(hlsDir, 'playlist.m3u8');
  castProxyLog(`[Transcode] pre-starting ffmpeg HLS → ${hlsDir}`);

  const proc = spawn(ffBin, [
    '-loglevel', 'error',
    '-user_agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    '-headers', 'Accept: */*\r\n',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-fflags', '+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-i', sourceUrl,
    '-map', '0:v:0',           // first video track (skip data/subtitle streams)
    '-map', '0:a:0',           // first audio track
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'main',
    '-level:v', '4.1',         // 4.1 supports 1080p60 (4.0 would cap 4K incorrectly)
    '-vf', "scale='if(gt(iw,1920),1920,-2)':'if(gt(ih,1080),-2,ih)',format=yuv420p",
    // ↑ scale 4K→1080p if needed; force yuv420p so 10-bit HEVC doesn't produce 10-bit H.264
    '-crf', '23',
    '-x264-params', 'repeat_headers=1:bframes=0',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',            // broadcast standard; avoids A/V drift from 48→44.1 kHz resample
    '-ac', '2',               // downmix to stereo (Chromecast doesn't handle 5.1 from DMR)
    '-f', 'hls',
    '-hls_time', '2',                    // 2-second segments for low latency
    '-hls_list_size', '10',              // keep 10 segments rolling
    '-hls_flags', 'delete_segments+append_list+independent_segments',
    '-hls_segment_filename', path.join(hlsDir, 'seg%05d.ts'),
    playlistPath,
  ]);

  const state = { proc, hlsDir, playlistPath, sourceUrl };
  _transcodeStream = state;

  proc.stderr.on('data', d => castProxyLog(`[Transcode] ffmpeg: ${d.toString().trim()}`));
  proc.on('error', e => {
    castProxyLog(`[Transcode] ffmpeg error: ${e.message}`);
    if (_transcodeStream === state) _transcodeStream = null;
  });
  proc.on('exit', (code, sig) => {
    castProxyLog(`[Transcode] ffmpeg exited code=${code} signal=${sig}`);
    if (_transcodeStream === state) _transcodeStream = null;
    // Clean up temp dir
    try { fs.rmSync(hlsDir, { recursive: true, force: true }); } catch(_) {}
  });
}

// Resolve the bundled ffmpeg-static binary path.
// In a packaged Electron app the asar archive can't execute binaries directly,
// so electron-builder extracts ffmpeg-static to app.asar.unpacked via asarUnpack.
function findFfmpeg() {
  if (_ffmpegBin) return _ffmpegBin;
  try {
    // ffmpeg-static exports the path to its bundled binary
    let binPath = require('ffmpeg-static');
    // In packaged Electron (asar), the binary lives in app.asar.unpacked
    if (app.isPackaged && binPath.includes('app.asar')) {
      binPath = binPath.replace('app.asar', 'app.asar.unpacked');
    }
    _ffmpegBin = binPath;
    castProxyLog(`ffmpeg-static binary: ${_ffmpegBin}`);
  } catch (e) {
    castProxyLog(`ffmpeg-static not found: ${e.message} — run: npm install`);
    _ffmpegBin = null;
  }
  return _ffmpegBin;
}

function getLanIp() {
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

function makeCastProxyUrl(targetUrl) {
  const encoded = Buffer.from(targetUrl).toString('base64url');
  return `http://${_castProxyLanIp}:${_castProxyPort}/cast-proxy/${encoded}`;
}

// Returns the HLS playlist URL served by the cast proxy for the persistent ffmpeg transcode.
// Used when _proxyTranscode is true — ffmpeg writes HLS segments to a temp dir,
// and the Cast device fetches them via /cast-hls/playlist.m3u8 (+ relative seg*.ts URLs).
function makeCastHlsUrl() {
  return `http://${_castProxyLanIp}:${_castProxyPort}/cast-hls/playlist.m3u8`;
}

// Rewrite all proxiable URLs in an M3U8 manifest body.
// Handles segment lines, EXT-X-KEY URI, EXT-X-MAP URI, EXT-X-MEDIA URI.
// Also detects H.265/HEVC codec tags and sets _proxyTranscode accordingly.
// When _proxyTranscode is active, strips HEVC variants from multi-variant playlists
// so the device never switches to an incompatible stream mid-playback.
function rewriteM3U8(body, baseUrl) {
  const proxyBase = `http://${_castProxyLanIp}:${_castProxyPort}/cast-proxy/`;
  const wrap = (u) => {
    try {
      const abs = new URL(u.trim(), baseUrl).toString();
      return proxyBase + Buffer.from(abs).toString('base64url');
    } catch { return u; }
  };

  // Log manifest content for diagnostics
  castProxyLog(`M3U8 manifest content:\n${body.slice(0, 1200)}`);

  // Fix monotonically-increasing EXT-X-MEDIA-SEQUENCE.
  // Some IPTV servers reset the sequence counter to 0 on every manifest refresh.
  // The Cast device interprets this as "stream restarted" and re-buffers, causing
  // the user to see a ~60-second content loop. We detect regressions and synthesize
  // a continuation value so the sequence never goes backwards.
  {
    const seqMatch = body.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
    if (seqMatch) {
      const reportedSeq = parseInt(seqMatch[1], 10);
      const segCount = (body.match(/^#EXTINF:/mg) || []).length;
      const lastEmitted = _m3u8SeqMap.get(baseUrl);
      let useSeq = reportedSeq;
      if (lastEmitted !== undefined && reportedSeq <= lastEmitted) {
        // Only synthesize if this is a genuine large reset (e.g. server restarted and
        // wrapped the sequence back to 0 or a very small number). Small regressions
        // just mean the IPTV server is slow to advance its live playlist — in that case
        // we should let the real sequence through, otherwise the synthesized counter
        // races ahead of reality and the Chromecast thinks many segments are missing,
        // causing a permanent rebuffer loop.
        const RESET_THRESHOLD = Math.max(segCount * 3, 10);
        if (lastEmitted - reportedSeq > RESET_THRESHOLD) {
          useSeq = lastEmitted + 1;
          castProxyLog(`[SeqFix] sequence reset detected (reported=${reportedSeq} ≪ last=${lastEmitted}) → synthesized ${useSeq}`);
          body = body.replace(/^#EXT-X-MEDIA-SEQUENCE:\d+/m, `#EXT-X-MEDIA-SEQUENCE:${useSeq}`);
        } else {
          castProxyLog(`[SeqFix] slow server (reported=${reportedSeq} ≤ last=${lastEmitted}) — passing through real sequence`);
        }
      }
      _m3u8SeqMap.set(baseUrl, Math.max(useSeq + Math.max(segCount - 1, 0), lastEmitted || 0));
    }
  }

  // Detect codec from CODECS="..." — check for any H.265/HEVC variant
  // hvc1/hev1 = HEVC in ISOBMFF, dvh1/dvhe = Dolby Vision HEVC
  const codecMatch = body.match(/CODECS="([^"]+)"/i);
  if (codecMatch) {
    const codecs = codecMatch[1].toLowerCase();
    const needsTranscode = /hvc1|hev1|dvh1|dvhe/.test(codecs);
    if (_proxyTranscode !== needsTranscode) {
      _proxyTranscode = needsTranscode;
      castProxyLog(`codec detection: "${codecMatch[1]}" → transcode=${_proxyTranscode}${_proxyTranscode ? ' (H.265→H.264 via ffmpeg)' : ''}`);
      if (_proxyTranscode) {
        const bin = findFfmpeg();
        castProxyLog(`ffmpeg binary: ${bin || 'NOT FOUND — transcoding unavailable, stream will likely fail on Nest Hub'}`);
      }
    }
  }

  // When transcoding is active, strip HEVC/H.265 variants from multi-variant playlists.
  // Without this, the Cast device plays ~1s of an H.264 variant then auto-switches to
  // a higher-quality H.265 variant, triggering error 102 again even with transcoding on.
  let lines = body.split('\n');
  if (_proxyTranscode) {
    const filtered = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // EXT-X-STREAM-INF line with HEVC codecs → skip it and the following URL line
      if (line.startsWith('#EXT-X-STREAM-INF') && /CODECS="[^"]*(?:hvc1|hev1|dvh1|dvhe)/i.test(line)) {
        castProxyLog(`stripping HEVC variant: ${line.slice(0, 100)}`);
        i++; // skip the URL line that follows
        continue;
      }
      filtered.push(lines[i]);
    }
    if (filtered.length < lines.length) {
      castProxyLog(`stripped ${lines.length - filtered.length} HEVC variant lines from manifest`);
    }
    lines = filtered;
  }

  return lines.map(line => {
    const t = line.trim();
    if (!t) return line;
    // Rewrite URI="..." in tag attributes (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, etc.)
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(u)}"`);
    }
    // Segment / sub-manifest URL line
    return wrap(t);
  }).join('\n');
}

// Fetch targetUrl, following redirects, returning { statusCode, headers, body/pipe }.
function proxyFetch(targetUrl, onResponse) {
  const doRequest = (url, redirects) => {
    if (redirects > 5) return onResponse(new Error('Too many redirects'), null, null);
    let parsed;
    try { parsed = new URL(url); } catch (e) { return onResponse(e, null, null); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Connection': 'keep-alive',
      },
    };
    const req = lib.request(opts, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
        res.resume(); // consume and discard
        return doRequest(new URL(res.headers.location, url).toString(), redirects + 1);
      }
      onResponse(null, res, url);
    });
    req.on('error', (e) => onResponse(e, null, null));
    req.end();
  };
  doRequest(targetUrl, 0);
}

function castProxyLog(...args) {
  const msg = '[CastProxy] ' + args.join(' ');
  console.log(msg);
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('cast:log', msg); } catch {}
  }
}

function startCastProxyServer() {
  return new Promise((resolve, reject) => {
    _castProxyLanIp = getLanIp();

    const srv = http.createServer((req, res) => {
      // /cast-hls/ is handled by a separate listener added below — skip here
      if (req.url.startsWith('/cast-hls/')) return;

      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': '*' });
        res.end();
        return;
      }

      const match = req.url.match(/^\/cast-proxy\/([A-Za-z0-9_=-]+)/);
      if (!match) { res.writeHead(404); res.end(); return; }

      let targetUrl;
      try { targetUrl = Buffer.from(match[1], 'base64url').toString('utf8'); }
      catch { res.writeHead(400); res.end('bad encoding'); return; }

      castProxyLog(`→ ${targetUrl.slice(0, 100)}`);

      proxyFetch(targetUrl, (err, proxyRes, finalUrl) => {
        if (err) {
          castProxyLog(`fetch error: ${err.message} for ${targetUrl.slice(0, 80)}`);
          try { res.writeHead(502); res.end(err.message); } catch {}
          return;
        }

        const ct = (proxyRes.headers['content-type'] || '').toLowerCase();
        const effectiveUrl = finalUrl || targetUrl;
        const isM3U8 = ct.includes('mpegurl') || ct.includes('m3u') ||
                       effectiveUrl.includes('.m3u8') || targetUrl.includes('.m3u8') ||
                       ct.includes('octet-stream') && (effectiveUrl.includes('index') || effectiveUrl.includes('playlist'));

        castProxyLog(`← ${proxyRes.statusCode} ct="${ct}" m3u8=${isM3U8} url=${effectiveUrl.slice(0, 80)}`);

        if (isM3U8) {
          // If the IPTV server returned a non-200 on the manifest (e.g. 403 after a
          // device switch — the IPTV server keeps the old session token valid for a few
          // seconds after the previous Chromecast stops pulling segments).
          // Retry up to 4 times with 2.5s between attempts before giving up.
          if (proxyRes.statusCode !== 200) {
            proxyRes.resume(); // drain and discard error body
            const MAX_MANIFEST_RETRIES = 4;
            const MANIFEST_RETRY_DELAY = 2500;
            let attempt = 0;
            // Capture current generation so we can detect channel switches and abort.
            const myGeneration = _proxyGeneration;
            const tryManifest = () => {
              // If the user switched channels, a new proxy generation was issued.
              // Stop retrying immediately — continuing would waste the new channel's IPTV session slot.
              if (_proxyGeneration !== myGeneration) {
                castProxyLog(`manifest retry aborted — channel switched (gen ${myGeneration} → ${_proxyGeneration})`);
                try { res.destroy(); } catch {}
                return;
              }
              attempt++;
              castProxyLog(`manifest got non-200 — retry ${attempt}/${MAX_MANIFEST_RETRIES} in ${MANIFEST_RETRY_DELAY}ms`);
              setTimeout(() => {
                if (_proxyGeneration !== myGeneration) {
                  castProxyLog(`manifest retry ${attempt} aborted — channel switched`);
                  try { res.destroy(); } catch {}
                  return;
                }
                proxyFetch(targetUrl, (err2, proxyRes2, finalUrl2) => {
                  if (_proxyGeneration !== myGeneration) {
                    castProxyLog(`manifest retry ${attempt} response discarded — channel switched`);
                    if (proxyRes2) proxyRes2.resume();
                    try { res.destroy(); } catch {}
                    return;
                  }
                  if (err2) {
                    if (attempt < MAX_MANIFEST_RETRIES) { tryManifest(); return; }
                    castProxyLog(`manifest retry error: ${err2.message}`);
                    try { res.writeHead(502); res.end(err2.message); } catch {}
                    return;
                  }
                  const effectiveUrl2 = finalUrl2 || targetUrl;
                  castProxyLog(`manifest retry ${attempt} ← ${proxyRes2.statusCode} url=${effectiveUrl2.slice(0, 80)}`);
                  if (proxyRes2.statusCode !== 200 && attempt < MAX_MANIFEST_RETRIES) {
                    proxyRes2.resume();
                    tryManifest();
                    return;
                  }
                  let body2 = '';
                  proxyRes2.setEncoding('utf8');
                  proxyRes2.on('data', c => { body2 += c; });
                  proxyRes2.on('end', () => {
                    if (_proxyGeneration !== myGeneration || res.headersSent) return;
                    const rewritten2 = rewriteM3U8(body2, effectiveUrl2);
                    const buf2 = Buffer.from(rewritten2, 'utf8');
                    res.writeHead(proxyRes2.statusCode === 200 ? 200 : 502, {
                      'Content-Type': 'application/vnd.apple.mpegurl',
                      'Content-Length': buf2.length,
                      'Access-Control-Allow-Origin': '*',
                      'Cache-Control': 'no-cache',
                    });
                    res.end(buf2);
                  });
                  proxyRes2.on('error', e => { try { res.end(); } catch {} });
                });
              }, MANIFEST_RETRY_DELAY);
            };
            tryManifest();
            return;
          }

          let body = '';
          proxyRes.setEncoding('utf8');
          proxyRes.on('data', c => { body += c; });
          proxyRes.on('end', () => {
            const rewritten = rewriteM3U8(body, effectiveUrl);
            castProxyLog(`M3U8 rewritten ${body.length}→${rewritten.length} bytes, first line: ${rewritten.split('\n')[0]}`);
            const rewrittenBuf = Buffer.from(rewritten, 'utf8');
            res.writeHead(200, {
              'Content-Type': 'application/vnd.apple.mpegurl',
              'Content-Length': rewrittenBuf.length,
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-cache',
            });
            res.end(rewrittenBuf);
          });
          proxyRes.on('error', (e) => {
            castProxyLog(`M3U8 stream error: ${e.message}`);
            try { res.end(); } catch {}
          });
        } else {
          // Binary passthrough (segments, keys, etc.)
          const outHeaders = {
            'Content-Type': 'video/MP2T',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
          };

          if (_proxyTranscode) {
            // H.265 detected — transcode to H.264 via FFmpeg so Nest Hub can decode
            const ffBin = findFfmpeg();
            if (ffBin) {
              castProxyLog(`transcoding segment H.265→H.264 via ${ffBin}`);
              // Don't set Content-Length — transcoded size differs from input
              res.writeHead(200, outHeaders);
              const { spawn } = require('child_process');
              const ff = spawn(ffBin, [
                '-loglevel', 'error',
                // Input tolerance: many live IPTV segments lack SPS/PPS headers
                // (only the first segment carries them). Tell FFmpeg to skip
                // corrupt/missing header frames rather than aborting the transcode.
                '-fflags', '+genpts+discardcorrupt',
                '-err_detect', 'ignore_err',
                '-i', 'pipe:0',
                '-map', '0:v:0',  // first video track (skip subtitle/data streams)
                '-map', '0:a:0',  // first audio track
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-tune', 'zerolatency',
                '-crf', '23',
                // Scale 4K→1080p if needed; force yuv420p so 10-bit HEVC
                // doesn't produce 10-bit H.264 that Chromecast rejects.
                '-vf', "scale='if(gt(iw,1920),1920,-2)':'if(gt(ih,1080),-2,ih)',format=yuv420p",
                // Level 4.1 supports 1080p60; 4.0 incorrectly caps 4K sources.
                '-profile:v', 'main',
                '-level:v', '4.1',
                // Force IDR/SPS/PPS on every output keyframe so each output
                // segment is independently decodable (required by Nest Hub).
                '-flags', '+global_header',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-ar', '48000',  // broadcast standard; prevents A/V drift from 48→44.1 resample
                '-ac', '2',      // downmix to stereo (Chromecast DMR doesn't handle 5.1)
                '-f', 'mpegts',
                'pipe:1',
              ]);
              proxyRes.pipe(ff.stdin);
              ff.stdout.pipe(res);
              ff.stderr.on('data', d => castProxyLog(`ffmpeg stderr: ${d.toString().trim()}`));
              ff.on('error', e => { castProxyLog(`ffmpeg spawn error: ${e.message}`); try { res.end(); } catch {} });
              proxyRes.on('error', e => { castProxyLog(`segment stream error: ${e.message}`); try { ff.stdin.end(); } catch {} });
              res.on('close', () => { try { ff.kill(); } catch {} });
            } else {
              // ffmpeg not found — warn and pass through anyway (will likely error 102 on device)
              castProxyLog('⚠️  H.265 stream but ffmpeg-static not available — passing raw (device will likely fail with error 102)');
              castProxyLog('    Run: npm install  in xtream-desktop/ to install bundled ffmpeg');
              if (proxyRes.headers['content-length']) outHeaders['Content-Length'] = proxyRes.headers['content-length'];
              res.writeHead(proxyRes.statusCode, outHeaders);
              proxyRes.pipe(res);
              proxyRes.on('error', (e) => { castProxyLog(`segment stream error: ${e.message}`); try { res.end(); } catch {} });
            }
          } else {
            // Normal passthrough
            if (proxyRes.headers['content-length']) outHeaders['Content-Length'] = proxyRes.headers['content-length'];
            res.writeHead(proxyRes.statusCode, outHeaders);
            proxyRes.pipe(res);
            proxyRes.on('error', (e) => { castProxyLog(`segment stream error: ${e.message}`); try { res.end(); } catch {} });
          }
        }
      });
    });

    srv.listen(0, '0.0.0.0', () => {
      _castProxyPort = srv.address().port;
      castProxyLog(`listening on ${_castProxyLanIp}:${_castProxyPort}`);
      resolve(_castProxyPort);
    });
    srv.on('error', reject);

    // ── /cast-hls/ ────────────────────────────────────────────────────────
    // Serves the HLS playlist and TS segments written by the persistent ffmpeg
    // transcode process. ffmpeg is started BEFORE the Cast LOAD (via
    // startTranscodeStream()) so segments exist by the time the device connects.
    // The Cast device fetches playlist.m3u8 first; relative seg*.ts URLs in the
    // playlist resolve back to this same handler automatically.
    srv.on('request', function castHlsHandler(req, res) {
      const m = req.url.match(/^\/cast-hls\/(playlist\.m3u8|seg\d+\.ts)$/);
      if (!m) return;

      const state = _transcodeStream;
      if (!state || !state.hlsDir) {
        castProxyLog('[HLS] Cast device requested', m[1], 'but no transcode stream active — 404');
        res.writeHead(404); res.end(); return;
      }

      const filePath = path.join(state.hlsDir, m[1]);
      fs.readFile(filePath, (err, data) => {
        if (err) {
          castProxyLog(`[HLS] file not ready: ${m[1]} (${err.code})`);
          res.writeHead(404); res.end(); return;
        }
        const ct = m[1].endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
        castProxyLog(`[HLS] serving ${m[1]} (${data.length} bytes)`);
        res.writeHead(200, {
          'Content-Type': ct,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        });
        res.end(data);
      });
    });

    // ── /local-hls/ ───────────────────────────────────────────────────────
    // Serves HLS segments from the local (non-Cast) transcode stream so the
    // renderer's HLS.js player can play HEVC channels after automatic transcoding.
    srv.on('request', function localHlsHandler(req, res) {
      const m = req.url.match(/^\/local-hls\/(playlist\.m3u8|seg\d+\.ts)$/);
      if (!m) return;

      const state = _localTranscodeStream;
      if (!state || !state.hlsDir) {
        res.writeHead(404); res.end(); return;
      }

      const filePath = path.join(state.hlsDir, m[1]);
      // Poll briefly for the playlist to appear (ffmpeg may not have written it yet).
      // Guard every write with res.headersSent to prevent double-write if two
      // setTimeout callbacks race each other to the same response object.
      const tryRead = (attemptsLeft, delayMs) => {
        if (res.headersSent) return;
        fs.readFile(filePath, (err, data) => {
          if (res.headersSent) return;
          if (err) {
            if (attemptsLeft > 0 && err.code === 'ENOENT') {
              setTimeout(() => tryRead(attemptsLeft - 1, delayMs), delayMs);
            } else {
              res.writeHead(404); res.end();
            }
            return;
          }
          const ct = m[1].endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
          res.writeHead(200, {
            'Content-Type': ct,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
          });
          res.end(data);
        });
      };
      // VOD sources are large remote debrid-resolved files (often .mkv with
      // big headers) — ffmpeg can take noticeably longer than a Live TV channel
      // feed to probe the input and write its first playlist/segment. 3s wasn't
      // enough and the resulting 404s surfaced in the renderer as a fatal
      // "manifestLoadError" before ffmpeg ever got a chance to catch up.
      // Give the playlist up to ~24s and segments up to ~6s before giving up.
      tryRead(m[1].endsWith('.m3u8') ? 80 : 20, m[1].endsWith('.m3u8') ? 300 : 300);
    });
  });
}

// ---------- single instance ----------
const single = app.requestSingleInstanceLock();
if (!single) { app.quit(); process.exit(0); }
app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
});

// ---------- window-state persistence ----------
const stateFile = path.join(app.getPath('userData'), 'window-state.json');
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return null; }
}
function writeState(s) {
  try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch (e) {}
}

let mainWindow = null;

function createWindow() {
  const saved = readState() || {};
  const win = new BrowserWindow({
    width:  saved.width  || 1380,
    height: saved.height || 860,
    x: saved.x,
    y: saved.y,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0a0c10',
    title: 'Xtream TV',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The whole reason this app exists — disable browser-only blocks
      // so IPTV HTTP servers and M3U fetches just work.
      webSecurity: false,
      allowRunningInsecureContent: true,
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => {
    if (saved.maximized) win.maximize();
    if (saved.fullscreen) win.setFullScreen(true);
    win.show();
  });

  win.on('close', () => {
    const b = win.getBounds();
    writeState({
      ...b,
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
    });
  });

  // External links open in default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Always allow Picture-in-Picture and fullscreen
  win.webContents.on('select-bluetooth-device', (e, _devices, cb) => { e.preventDefault(); cb(''); });

  // Hand the renderer one end of a MessagePort dedicated to mpv2 video
  // frames. Frames travel over this port (not webContents.send) with
  // ArrayBuffers in the *transfer* list — see setupMpv2FramePort() for why.
  // Re-established on every load/reload since a fresh page has no port.
  win.webContents.on('did-finish-load', () => setupMpv2FramePort(win));

  win.loadURL(`http://127.0.0.1:${_rendererPort}/`);
  mainWindow = win;
}

// One end of a dedicated MessageChannel used solely to ship raw video frames
// from the mpv addon to the renderer's <canvas>.
//
// Why not webContents.send('mpv2:event', frame)? Electron's regular IPC
// (ipcMain/ipcRenderer/webContents.send) always *copies* the payload via its
// own structured-clone serialization when crossing the main<->renderer
// boundary — there is no way to mark a Buffer/ArrayBuffer as transferable on
// that path. At ~28fps * ~8MB/frame that's ~200MB/s of allocation + copy
// churn, which was ballooning V8's heap until macOS SIGKILLed the process
// (confirmed against mpv2-debug logs showing exactly that throughput).
//
// MessagePortMain (the Electron flavor of the standard Web MessagePort),
// once handed to the renderer, behaves like a normal Worker postMessage
// channel: passing an ArrayBuffer in the second "transfer list" argument
// *moves* ownership of its backing memory instead of cloning it — the same
// zero-copy mechanism browsers use to ship large buffers between threads.
// The addon now allocates each frame as a malloc'd ArrayBuffer (see
// mpv_addon.cc RenderFrame), so the whole pipeline — native render -> JS
// object -> renderer paint — involves exactly zero copies of the pixel data.
let _mpv2FramePort = null;
function setupMpv2FramePort(win) {
  try {
    if (_mpv2FramePort) { try { _mpv2FramePort.close(); } catch (_) {} _mpv2FramePort = null; }
    const { port1, port2 } = new MessageChannelMain();
    _mpv2FramePort = port1;
    _mpv2FramePort.start();
    win.webContents.postMessage('mpv2:frame-port', null, [port2]);
    mpv2Log('mpv2 frame MessagePort (re)established');
  } catch (e) {
    mpv2Log('setupMpv2FramePort failed:', e.message);
    _mpv2FramePort = null;
  }
}

// ---------- nuke CORS/origin headers on outgoing requests ----------
// We strip Origin/Referer so IPTV servers that block "unfamiliar" origins
// (very common for browser-loaded streams) just treat us like any client.
function configureNetwork() {
  const filter = { urls: ['*://*/*'] };
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, cb) => {
    const headers = { ...details.requestHeaders };
    delete headers['Origin'];
    delete headers['origin'];
    delete headers['Referer'];
    delete headers['referer'];
    // Force the fake Chrome UA on EVERY outgoing request so HLS segment loaders
    // can't slip the Electron UA through.
    headers['User-Agent'] = FAKE_UA;
    cb({ requestHeaders: headers });
  });
  // Force permissive CORS on every response so the renderer's fetch() works
  // regardless of what the upstream IPTV server sets.
  session.defaultSession.webRequest.onHeadersReceived(filter, (details, cb) => {
    const headers = { ...details.responseHeaders };
    headers['Access-Control-Allow-Origin']      = ['*'];
    headers['Access-Control-Allow-Headers']     = ['*'];
    headers['Access-Control-Allow-Methods']     = ['GET, POST, PUT, DELETE, OPTIONS'];
    headers['Access-Control-Allow-Credentials'] = ['true'];
    cb({ responseHeaders: headers });
  });
}

// ---------- Cloudflare "Attention Required" / JS-challenge bypass ----------
// Some stream-scraper addons (Torrentio, AIOStreams mirrors, etc.) sit behind
// Cloudflare's bot-protection, which returns a 403 + an interstitial page that
// runs a JS challenge before issuing a `cf_clearance` cookie. A plain HTTP
// request can't execute that JS — but Electron already ships a full Chromium,
// so we spin up a hidden BrowserWindow, let it load the page (Chromium solves
// the challenge automatically), and the resulting cf_clearance cookie lands in
// the *shared* session cookie jar — so the very next session.fetch() call from
// netFetch sails through. This is effectively a built-in FlareSolverr.
const _cfSolveInFlight = new Map(); // origin -> Promise, to dedupe concurrent solves
function looksLikeCloudflareChallenge(status, body) {
  if (status !== 403 && status !== 503) return false;
  const b = (body || '').slice(0, 4000);
  return /cloudflare/i.test(b) && (
    /attention required/i.test(b) ||
    /just a moment/i.test(b) ||
    /cf-browser-verification/i.test(b) ||
    /challenge-platform/i.test(b) ||
    /checking your browser/i.test(b)
  );
}
async function solveCloudflareChallenge(url, log) {
  const origin = new URL(url).origin;
  if (_cfSolveInFlight.has(origin)) return _cfSolveInFlight.get(origin);
  const p = (async () => {
    log && log('Cloudflare challenge detected for ' + origin + ' — solving with a hidden browser window…');
    const win = new BrowserWindow({
      show: false,
      webPreferences: { session: session.defaultSession, sandbox: true },
    });
    try {
      await win.loadURL(url, { userAgent: FAKE_UA });
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        let title = '';
        try { title = await win.webContents.executeJavaScript('document.title'); } catch (e) {}
        const challenged = /just a moment|attention required|checking your browser/i.test(title || '');
        if (!challenged) {
          // Give Chromium a brief moment to finish setting the clearance cookie
          // after the challenge page redirects/reloads.
          await new Promise(r => setTimeout(r, 1200));
          log && log('Cloudflare challenge cleared for ' + origin);
          return true;
        }
        await new Promise(r => setTimeout(r, 800));
      }
      log && log('Timed out waiting for Cloudflare challenge to clear for ' + origin);
      return false;
    } catch (e) {
      log && log('Error while solving Cloudflare challenge for ' + origin + ': ' + (e.message || e));
      return false;
    } finally {
      try { win.destroy(); } catch (e) {}
      _cfSolveInFlight.delete(origin);
    }
  })();
  _cfSolveInFlight.set(origin, p);
  return p;
}

// ---------- IPC: native fetch (used by renderer for big M3U downloads) ----------
// Uses Electron's session fetch (Chromium network stack) so cookies set by
// manifest/playlist responses are automatically sent on subsequent segment requests.
async function netFetch(url, opts = {}) {
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch (e) { throw new Error('Invalid URL: ' + url); }

  // Chromium's modern fetch()/Request implementation (undici-backed) throws
  // "Request cannot be constructed from a URL that includes credentials" for
  // any "scheme://user:pass@host" URL — and several IPTV providers hand out
  // exactly that shape (e.g. http://tvappapk@line.dino.ws/...). Strip the
  // userinfo out of the URL ourselves and translate it into a standard HTTP
  // Basic Authorization header instead, which is what the server actually
  // expects either way.
  let cleanUrl = url;
  const authHeaders = {};
  if (parsedUrl.username || parsedUrl.password) {
    const user = decodeURIComponent(parsedUrl.username || '');
    const pass = decodeURIComponent(parsedUrl.password || '');
    authHeaders['Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    parsedUrl.username = '';
    parsedUrl.password = '';
    cleanUrl = parsedUrl.toString();
  }

  const headers = {
    'User-Agent': FAKE_UA,
    'Accept': '*/*',
    ...authHeaders,
    ...(opts.headers || {}),
  };
  const doFetch = async () => {
    // Use Electron session fetch — shares Chromium cookie jar and goes through
    // onBeforeSendHeaders/onHeadersReceived hooks just like renderer XHR.
    const res = await session.defaultSession.fetch(cleanUrl, {
      method: opts.method || 'GET',
      headers,
      body: opts.body,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const body = opts.binary ? buf.toString('binary') : buf.toString('utf8');
    const headerObj = {};
    res.headers.forEach((v, k) => { headerObj[k] = v; });
    return { ok: res.ok, status: res.status, headers: headerObj, body };
  };

  let result = await doFetch();

  // If we hit a Cloudflare interstitial and the caller hasn't opted out, try to
  // solve it once with a hidden browser window, then retry the request.
  if (!opts.noCfBypass && looksLikeCloudflareChallenge(result.status, result.body)) {
    netLog(`Cloudflare interstitial detected for ${url} (status ${result.status}) — attempting bypass…`);
    const solved = await solveCloudflareChallenge(url, netLog);
    if (solved) {
      netLog(`Bypass reported success for ${new URL(url).origin} — retrying original request…`);
      result = await doFetch();
      netLog(`Retry after bypass: ${url} → status ${result.status}`);
      if (!result.ok) {
        netLog(`Bypass did not actually unblock the request — still got status ${result.status}. ` +
               `This usually means the site is using an interactive/managed challenge (CAPTCHA) ` +
               `that can't be solved automatically, or it's blocking by IP/rate-limit rather than a JS puzzle.`);
      }
    } else {
      netLog(`Bypass failed/timed out for ${new URL(url).origin} — the challenge likely requires ` +
             `human interaction (CAPTCHA) or the block isn't a solvable JS challenge.`);
    }
  }

  return result;
}

ipcMain.handle('net:fetch', (_evt, url, opts = {}) => netFetch(url, opts));

// ---------- IPC: persistent storage (origin-independent JSON file) ----------
const storageFile = path.join(app.getPath('userData'), 'xtream_storage.json');
ipcMain.handle('storage:load', () => {
  try { return JSON.parse(fs.readFileSync(storageFile, 'utf8')); } catch(e) { return null; }
});
ipcMain.handle('storage:save', (_evt, data) => {
  try { fs.writeFileSync(storageFile, JSON.stringify(data)); } catch(e) { console.error('storage:save failed', e); }
});

// ---------- IPC: file dialogs ----------
ipcMain.handle('dialog:openM3U', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Open M3U playlist',
    filters: [{ name: 'M3U playlists', extensions: ['m3u', 'm3u8'] }, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
  return { path: r.filePaths[0], body: fs.readFileSync(r.filePaths[0], 'utf8') };
});

// ============================================================
//  CAST V2 — native Node.js Chromecast implementation
//  No Chrome extension required.
// ============================================================

// ---- Minimal protobuf encoder/decoder for CastMessage ----
function _varint(n) {
  const b = [];
  n = n >>> 0;
  while (n > 0x7f) { b.push((n & 0x7f) | 0x80); n >>>= 7; }
  b.push(n & 0x7f);
  return Buffer.from(b);
}
function _tagString(field, str) {
  const d = Buffer.from(str, 'utf8');
  return Buffer.concat([Buffer.from([(field << 3) | 2]), _varint(d.length), d]);
}
function _tagVarint(field, val) {
  return Buffer.concat([Buffer.from([field << 3]), _varint(val)]);
}
function encodeCastMessage(sourceId, destinationId, namespace, payloadUtf8) {
  return Buffer.concat([
    _tagVarint(1, 0),
    _tagString(2, sourceId),
    _tagString(3, destinationId),
    _tagString(4, namespace),
    _tagVarint(5, 0),
    _tagString(6, payloadUtf8),  // field 6 = payload_utf8 per cast_channel.proto
  ]);
}
function decodeCastMessage(buf) {
  let i = 0;
  const msg = {};
  while (i < buf.length) {
    const tag = buf[i++];
    const field = tag >> 3, wire = tag & 7;
    if (wire === 0) {
      let v = 0, s = 0;
      for (;;) { const b = buf[i++]; v |= (b & 0x7f) << s; s += 7; if (!(b & 0x80)) break; }
      msg['_f' + field] = v;
    } else if (wire === 2) {
      let len = 0, s = 0;
      for (;;) { const b = buf[i++]; len |= (b & 0x7f) << s; s += 7; if (!(b & 0x80)) break; }
      const d = buf.slice(i, i + len); i += len;
      if (field === 2) msg.sourceId      = d.toString('utf8');
      else if (field === 3) msg.destinationId = d.toString('utf8');
      else if (field === 4) msg.namespace     = d.toString('utf8');
      // Chromecast firmware uses field 6 (payload_binary) for ALL payloads regardless of
      // payload_type — handle both field 6 and field 7 as UTF-8 string.
      else if (field === 6 || field === 7) msg.payloadUtf8 = d.toString('utf8');
    } else break; // unexpected wire type — stop
  }
  return msg;
}

// ---- mDNS discovery ----
// On macOS, mDNSResponder owns port 5353 so raw multicast sockets can't receive responses.
// We use the system dns-sd CLI (macOS/Linux with Avahi) which uses the native Bonjour API.
// On Windows we fall back to a raw mDNS socket approach.

function resolveDotLocal(hostname) {
  // Resolve a .local hostname to an IPv4 address via the system resolver (mDNSResponder on macOS).
  return new Promise((resolve, reject) => {
    const clean = hostname.replace(/\.$/, '');
    const resolver = new dns.Resolver();
    resolver.resolve4(clean, (err, addrs) => {
      if (err || !addrs || !addrs.length) {
        // Fallback: try getaddrinfo which also uses mDNSResponder
        dns.lookup(clean, { family: 4 }, (e2, addr) => {
          if (e2 || !addr) reject(err || e2 || new Error('Could not resolve ' + clean));
          else resolve(addr);
        });
      } else {
        resolve(addrs[0]);
      }
    });
  });
}

// macOS: use dns-sd -B to browse, dns-sd -L to look up each service
function castDiscoverDarwin(timeoutMs) {
  return new Promise((resolve) => {
    const found   = new Map(); // instanceName → {name, host, port}
    const pending = new Set();
    let browseDone = false;
    let browseProc = null;

    const finish = () => {
      if (browseProc) { try { browseProc.kill(); } catch(_){} browseProc = null; }
      // Wait briefly for any pending lookups, then resolve
      const wait = () => {
        if (pending.size === 0 || Date.now() > deadline) resolve([...found.values()]);
        else setTimeout(wait, 100);
      };
      wait();
    };
    const deadline = Date.now() + timeoutMs;
    const hardTimer = setTimeout(finish, timeoutMs);

    // dns-sd -B output example:
    //   9:00:01.123  Add  3  4 local.  _googlecast._tcp.  Living Room
    browseProc = spawn('dns-sd', ['-B', '_googlecast._tcp', 'local.']);
    let browseBuf = '';
    browseProc.stdout.on('data', (chunk) => {
      browseBuf += chunk.toString();
      const lines = browseBuf.split('\n');
      browseBuf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        const m = line.match(/\s+Add\s+\d+\s+\d+\s+\S+\s+_googlecast\._tcp\.\s+(.+)$/);
        if (!m) continue;
        const instanceName = m[1].trim();
        if (found.has(instanceName) || pending.has(instanceName)) continue;
        pending.add(instanceName);
        lookupServiceDarwin(instanceName).then(dev => {
          if (dev) found.set(instanceName, dev);
          pending.delete(instanceName);
        }).catch(() => pending.delete(instanceName));
      }
    });
    browseProc.on('error', () => finish());
    // Stop browsing after timeoutMs - 1s so lookups have time to finish
    setTimeout(() => { if (browseProc) { try { browseProc.kill(); } catch(_){} browseProc = null; } }, timeoutMs - 1000);
  });
}

function lookupServiceDarwin(instanceName) {
  // dns-sd -L output example:
  //   Living Room._googlecast._tcp.local. can be reached at LivingRoom.local.:8009 (interface 4)
  //   fn=Living Room  md=Chromecast  ...
  return new Promise((resolve) => {
    let out = '';
    const proc = spawn('dns-sd', ['-L', instanceName, '_googlecast._tcp', 'local.']);
    proc.stdout.on('data', d => { out += d.toString(); });
    const timer = setTimeout(() => {
      try { proc.kill(); } catch(_){}
      const hostMatch = out.match(/can be reached at ([^\s:]+(?:\.local)?\.?):(\d+)/i);
      const fnMatch   = out.match(/\bfn=([^\x01-\x1f\t]+?)(?:\s+\w+=|$)/);
      if (!hostMatch) return resolve(null);
      const rawHost = hostMatch[1];
      const port    = parseInt(hostMatch[2], 10);
      // dns-sd escapes spaces and special chars with backslashes — strip them.
      const unescape = s => s.replace(/\\(.)/g, '$1');
      const name    = unescape(fnMatch ? fnMatch[1].trim() : instanceName);
      // Resolve .local hostname → IP
      resolveDotLocal(rawHost).then(ip => resolve({ name, host: ip, port })).catch(() => {
        // If resolution fails, use hostname directly (might still work)
        const ip = rawHost.replace(/\.$/, '');
        resolve({ name, host: ip, port });
      });
    }, 2500);
  });
}

// Windows / Linux fallback: raw mDNS multicast socket
const MDNS_ADDR = '224.0.0.251', MDNS_PORT = 5353;
function buildMdnsQuery(name) {
  const labels = name.split('.').flatMap(p => { const b = Buffer.from(p); return [b.length, ...b]; });
  labels.push(0);
  return Buffer.concat([
    Buffer.from([0,0, 0,0, 0,1, 0,0, 0,0, 0,0]),
    Buffer.from(labels),
    Buffer.from([0,0x0c, 0,1]),
  ]);
}
function parseMdnsName(buf, offset) {
  const parts = []; let jumped = false, ptr = offset;
  for (;;) {
    if (ptr >= buf.length) break;
    const len = buf[ptr];
    if (len === 0) { if (!jumped) offset = ptr + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      const target = ((len & 0x3f) << 8) | buf[ptr + 1];
      if (!jumped) offset = ptr + 2;
      ptr = target; jumped = true; continue;
    }
    parts.push(buf.slice(ptr + 1, ptr + 1 + len).toString('utf8'));
    ptr += 1 + len; if (!jumped) offset = ptr;
  }
  return { name: parts.join('.'), end: offset };
}
function castDiscoverRaw(timeoutMs) {
  return new Promise((resolve) => {
    const devices = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let closed = false;
    const done = () => {
      if (closed) return; closed = true; clearTimeout(timer);
      try { sock.close(); } catch(_){} resolve([...devices.values()]);
    };
    const timer = setTimeout(done, timeoutMs);
    sock.on('message', (buf) => {
      try {
        const qdCount = buf.readUInt16BE(4), anCount = buf.readUInt16BE(6),
              nsCount = buf.readUInt16BE(8), arCount = buf.readUInt16BE(10);
        let off = 12;
        for (let i = 0; i < qdCount && off < buf.length; i++) {
          const r = parseMdnsName(buf, off); off = r.end + 4;
        }
        const srvMap = {}, aMap = {};
        const total = anCount + nsCount + arCount;
        for (let i = 0; i < total && off < buf.length; i++) {
          const nr = parseMdnsName(buf, off); off = nr.end;
          if (off + 10 > buf.length) break;
          const rrType = buf.readUInt16BE(off); off += 8;
          const rdLen  = buf.readUInt16BE(off); off += 2;
          const rdStart = off; off += rdLen;
          if (rrType === 33) {
            const port = buf.readUInt16BE(rdStart + 4);
            const hr = parseMdnsName(buf, rdStart + 6);
            if (!srvMap[nr.name]) srvMap[nr.name] = {};
            srvMap[nr.name].host = hr.name; srvMap[nr.name].port = port;
          } else if (rrType === 1 && rdLen === 4) {
            aMap[nr.name] = [buf[rdStart],buf[rdStart+1],buf[rdStart+2],buf[rdStart+3]].join('.');
          } else if (rrType === 16) {
            const txts = {}; let o = rdStart;
            while (o < rdStart + rdLen) {
              const l = buf[o++]; if (!l) break;
              const kv = buf.slice(o, o+l).toString('utf8'); o += l;
              const eq = kv.indexOf('='); if (eq > 0) txts[kv.slice(0,eq).toLowerCase()] = kv.slice(eq+1);
            }
            if (!srvMap[nr.name]) srvMap[nr.name] = {};
            srvMap[nr.name].txt = txts;
          }
        }
        for (const [srvName, srv] of Object.entries(srvMap)) {
          if (!srv.port) continue;
          const rawHost = srv.host || '';
          const ip = aMap[rawHost] || aMap[rawHost.replace(/\.$/, '')] || rawHost.replace(/\.$/, '');
          if (!ip) continue;
          const txt = srv.txt || {};
          const friendlyName = txt.fn || txt.md || srvName.replace(/\._googlecast\._tcp\.local\.?$/, '');
          devices.set(srvName, { name: friendlyName, host: ip, port: srv.port });
        }
      } catch(_) {}
    });
    sock.on('error', () => done());
    sock.bind(MDNS_PORT, '0.0.0.0', () => {
      try { sock.addMembership(MDNS_ADDR); } catch(_){}
      sock.setMulticastTTL(255);
      const q = buildMdnsQuery('_googlecast._tcp.local');
      sock.send(q, 0, q.length, MDNS_PORT, MDNS_ADDR);
    });
  });
}

function castDiscover(timeoutMs = 5000) {
  if (process.platform === 'darwin') return castDiscoverDarwin(timeoutMs);
  return castDiscoverRaw(timeoutMs);
}

// ---- Cast debug logger — forwards to renderer DevTools ----
function castLog(...args) {
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  console.log('[Cast]', msg);
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('cast:log', msg); } catch(_) {}
  }
}

// ---- Net/Cloudflare-bypass debug logger — forwards to renderer DevTools ----
// Main-process console.log only goes to the launching terminal, which most
// users never see. Forward these lines to the renderer's DevTools console too
// (prefixed "[netFetch]") so they show up in the same place as "[VOD]" logs
// and in any exported console log the user sends us.
function netLog(msg) {
  console.log('[netFetch]', msg);
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('net:log', String(msg)); } catch(_) {}
  }
}

// ---- Cast client ----
let _castSocket = null;
let _castReqId  = 1;
const _castCallbacks = new Map(); // requestId → {resolve, reject}
let _castSession = null; // { transportId, sessionId }
let _castMediaChannel = null;
let _castAppConnection = null;
let _pendingLaunch = false; // true while waiting for session after LAUNCH
let _closeCount   = 0;    // consecutive CLOSE responses; reset on each castConnect()
let _lastLoadUrl  = '';   // last URL sent in a LOAD — used for error diagnostics
let _lastLoadContentType = ''; // last content-type sent — used for error diagnostics
let _lastLoadParams = null;    // {url, contentType, title, iconUrl} — saved for error-102 transcode retry
let _transcodeRetryPending = false; // debounce: device sends ERROR 102 twice; only schedule one retry
let _castGen = 0; // incremented on each new connection; old sockets check this to ignore stale events

// Per-channel learning caches — persist across device switches for the lifetime of the app.
// Keyed by bare stream URL (no query string) for robustness against rotating tokens.
const _directFailCache  = new Set(); // URLs that always fail direct LOAD → skip to proxy immediately
const _transcodeCache   = new Set(); // URLs that need HEVC transcode → skip error-102 retry cycle

// Generation counter for proxy manifest retry loops.
// Incremented on every castLaunchAndLoad call so stale retry loops from the
// previous channel abort themselves immediately instead of racing the new channel's
// IPTV session slot with 403-inducing requests.
let _proxyGeneration = 0;
// Use a fresh random sender ID each session so a device that blocked 'sender-0'
// (e.g. after a previous crash-loop) will accept us as a new sender.
let _castSenderId = 'sender-0';

const NS_CON = 'urn:x-cast:com.google.cast.tp.connection';
const NS_HB  = 'urn:x-cast:com.google.cast.tp.heartbeat';
const NS_RCV = 'urn:x-cast:com.google.cast.receiver';
const NS_MED = 'urn:x-cast:com.google.cast.media';
const DST_RCV = 'receiver-0';
const APP_ID  = 'CC1AD845'; // Default Media Receiver

function castSend(dst, ns, payload) {
  if (!_castSocket) throw new Error('Not connected');
  const data = encodeCastMessage(_castSenderId, dst, ns, JSON.stringify(payload));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  const frame = Buffer.concat([header, data]);
  castLog('send', ns.split('.').pop(), JSON.stringify(payload).slice(0, 80), '—', frame.length, 'bytes');
  _castSocket.write(frame);
}

function castDisconnectInternal() {
  _castSession = null;
  _castMediaChannel = null;
  _castAppConnection = null;
  _closeCount = 0;
  if (_castSocket) { try { _castSocket.destroy(); } catch(_){} _castSocket = null; }
  if (_hbInterval) { clearInterval(_hbInterval); _hbInterval = null; }
  // Notify renderer
  if (mainWindow) mainWindow.webContents.send('cast:status', { connected: false });
}

let _hbInterval = null;
function castConnect(host, port) {
  return new Promise((resolve, reject) => {
    // If already connected to a device, send STOP before switching.
    // IMPORTANT: save refs first, clear global state, then destroy old socket
    // after a flush window — castDisconnectInternal() calls sock.destroy()
    // immediately which would discard the STOP writes before they're sent.
    if (_castSocket && !_castSocket.destroyed && _castSession) {
      const oldSock    = _castSocket;
      const oldSession = _castSession;
      castLog('switching device — sending STOP to current device before connecting to new one');
      try { castSendRaw(oldSock, oldSession.transportId, NS_MED, { type: 'STOP', requestId: _castReqId++ }); } catch(_) {}
      try { castSendRaw(oldSock, DST_RCV, NS_RCV, { type: 'STOP', requestId: _castReqId++, sessionId: oldSession.sessionId }); } catch(_) {}
      try { castSendRaw(oldSock, oldSession.transportId, NS_CON, { type: 'CLOSE' }); } catch(_) {}
      // Clear global state immediately so new connection can proceed, but
      // delay socket destruction so the STOP writes have time to flush.
      _castSession = null; _castMediaChannel = null; _castAppConnection = null;
      _closeCount = 0; _castSocket = null;
      if (_hbInterval) { clearInterval(_hbInterval); _hbInterval = null; }
      setTimeout(() => { try { oldSock.destroy(); } catch(_) {} }, 600);
      if (mainWindow) mainWindow.webContents.send('cast:status', { connected: false });
    } else {
      castDisconnectInternal();
    }
    // Bump generation so any lingering old-socket data handlers become no-ops.
    const myGen = ++_castGen;
    // Fresh sender ID avoids being blocked by devices that remember our previous ID
    _castSenderId = 'sender-' + Math.random().toString(36).slice(2, 10);
    castLog('using sender ID:', _castSenderId);
    // Use a plain connect timeout; clear it once TLS handshake succeeds
    const connectTimer = setTimeout(() => {
      sock.destroy();
      reject(new Error('Connect timeout'));
    }, 12000);

    const sock = tls.connect({ host, port: port || 8009, rejectUnauthorized: false }, () => {
      clearTimeout(connectTimer);
      sock.setTimeout(0); // no idle timeout — heartbeat keeps it alive
      _castSocket = sock;
      castLog('TLS connected to', host, port || 8009);
      // connType 0 = STRONG (exclusive — rejected if another sender already holds it)
      // connType 1 = WEAK  (non-exclusive — always accepted, coexists with other senders)
      // Send CONNECT then resolve after a brief pause so the Chromecast
      // can finish setting up the virtual channel before we send LAUNCH.
      castSend(DST_RCV, NS_CON, { type: 'CONNECT', origin: {} });
      // Heartbeat keeps the socket alive
      _hbInterval = setInterval(() => {
        try { castSend(DST_RCV, NS_HB, { type: 'PING' }); } catch(_) {}
      }, 5000);
      setTimeout(resolve, 300); // brief pause before caller sends LAUNCH
    });

    let _buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      // If a newer connection has been started, this socket is stale — ignore all data.
      if (_castGen !== myGen) return;
      castLog('data rx', chunk.length, 'bytes hex:', chunk.slice(0, 120).toString('hex'));
      _buf = Buffer.concat([_buf, chunk]);
      while (_buf.length >= 4) {
        const msgLen = _buf.readUInt32BE(0);
        if (_buf.length < 4 + msgLen) break;
        const msgBuf = _buf.slice(4, 4 + msgLen);
        _buf = _buf.slice(4 + msgLen);
        let msg;
        try { msg = decodeCastMessage(msgBuf); } catch(e) { castLog('decode error:', e.message); continue; }
        if (!msg.payloadUtf8) { castLog('no payloadUtf8 — ns:', msg.namespace, 'src:', msg.sourceId, 'dst:', msg.destinationId, 'rawHex:', msgBuf.slice(0,80).toString('hex')); continue; }
        let payload;
        try { payload = JSON.parse(msg.payloadUtf8); } catch(e) { castLog('JSON parse error:', e.message); continue; }

        castLog('msg', msg.namespace ? msg.namespace.split('.').pop() : '?', payload.type || '?');

        if (msg.namespace === NS_HB) {
          if (payload.type === 'PING') try { castSend(DST_RCV, NS_HB, { type: 'PONG' }); } catch(_){}
        }

        // The Chromecast sends CLOSE on the connection namespace when it terminates a virtual
        // connection. We allow a few re-tries but stop if we keep getting rejected.
        if (msg.namespace === NS_CON && payload.type === 'CLOSE') {
          const closedDst = msg.sourceId || DST_RCV;
          _closeCount = (_closeCount || 0) + 1;
          castLog('CLOSE from', closedDst, `(#${_closeCount}) pendingLaunch:`, _pendingLaunch);
          if (_closeCount > 3) {
            castLog('Too many CLOSE responses — giving up. Check: another app is casting, or reboot the Chromecast.');
            // Let _waitFor time out naturally with a descriptive error
          }
        }

        if (msg.namespace === NS_RCV) {
          if (payload.type === 'RECEIVER_STATUS') {
            const apps = payload.status && payload.status.applications;
            castLog('RECEIVER_STATUS apps:', apps ? apps.map(a => a.appId).join(',') : 'none');
            if (apps && apps.length > 0) {
              const app = apps[0];
              if (app.appId === APP_ID && app.transportId) {
                const isNew = !_castSession || _castSession.transportId !== app.transportId;
                _castSession = { transportId: app.transportId, sessionId: app.sessionId };
                if (isNew) {
                  castSend(app.transportId, NS_CON, { type: 'CONNECT', connType: 1, origin: {} });
                  castLog('app transport connected:', app.transportId);
                }
              }
            } else if (_castSession) {
              castLog('app stopped, clearing session');
              _castSession = null;
            }
          }
          if (payload.type === 'LAUNCH_ERROR') {
            castLog('LAUNCH_ERROR:', payload.reason);
            for (const [id, cb] of _castCallbacks) { cb.reject(new Error('Launch error: ' + (payload.reason || 'unknown'))); _castCallbacks.delete(id); }
          }
          if (payload.requestId != null) {
            const cb = _castCallbacks.get(payload.requestId);
            if (cb) { _castCallbacks.delete(payload.requestId); cb.resolve(payload); }
          }
        }

        if (msg.namespace === NS_MED) {
          if (payload.type === 'MEDIA_STATUS' && payload.status && payload.status[0]) {
            const s = payload.status[0];
            castLog('MEDIA_STATUS playerState=%s idleReason=%s extErr=%s detailedErr=%s',
              s.playerState, s.idleReason || '-', s.extendedStatus ? JSON.stringify(s.extendedStatus) : '-',
              s.detailedErrorCode || '-');
            // Error-102 transcode retry: wait for device IDLE (all downloads stopped)
            // before opening a new manifest connection — avoids 403 from the IPTV server.
            if (s.playerState === 'IDLE' && s.idleReason === 'ERROR' && _transcodeRetryPending && _lastLoadParams) {
              _transcodeRetryPending = false; // clear so duplicate IDLE events don't double-fire
              const p = _lastLoadParams;
              castLog('  Device IDLE after error — pre-starting transcoder, retrying in 1.5s...');
              // Start ffmpeg NOW so it has 1.5s to write initial HLS segments before the
              // Cast device opens /cast-hls/playlist.m3u8 — avoids empty-playlist 404.
              startTranscodeStream(p.url);
              setTimeout(async () => {
                try {
                  await castLaunchAndLoad(p.url, p.contentType, p.title, p.iconUrl, { keepTranscodeState: true });
                } catch (e) {
                  castLog('  transcode retry failed:', e.message);
                }
              }, 1500);
            }

            // Detailed codec/transcoding diagnostics when playback fails
            if (s.idleReason === 'ERROR') {
              const errCode = s.detailedErrorCode;
              // Cast SDK error codes: https://developers.google.com/cast/docs/reference/web_receiver/cast.framework.events.DetailedErrorCode
              const ERROR_LABELS = {
                100: 'MEDIA_UNKNOWN',
                101: 'MEDIA_ABORTED',
                102: 'MEDIA_DECODE',         // ← codec/profile not supported by device
                103: 'MEDIA_NETWORK',
                104: 'MEDIA_SRC_NOT_SUPPORTED',  // ← wrong content-type or unsupported container
                200: 'SOURCE_BUFFER_FAILURE',
                201: 'MEDIAKEYS_UNKNOWN',
                300: 'NETWORK',
                400: 'SEGMENT_NETWORK',
                401: 'HLS_NETWORK_MASTER_PLAYLIST',
                402: 'HLS_NETWORK_PLAYLIST',
                403: 'HLS_NETWORK_NO_KEY_RESPONSE',
                404: 'HLS_NETWORK_KEY_LOAD_TIMEOUT',
                405: 'HLS_NETWORK_INVALID_SEGMENT',
                406: 'HLS_SEGMENT_PARSING',
                500: 'CONTENT_UNSUPPORTED_BY_HARDWARE',  // ← 4K/HDR/HEVC hardware limit
              };
              const label = ERROR_LABELS[errCode] || ('UNKNOWN_' + errCode);
              castLog('⚠️  PLAYBACK ERROR DIAGNOSIS ⚠️');
              castLog('  Error code   :', errCode, '→', label);
              if (errCode === 102) {
                castLog('  Likely cause : Device cannot decode the video codec/profile.');
                castLog('  Suggestions  : Try H.264 Baseline/Main profile; avoid HEVC/H.265, VP9, AV1.');
                castLog('  Content-type :', _lastLoadContentType || '(unknown)');
                castLog('  Stream URL   :', (_lastLoadUrl || '').slice(0, 120));
              } else if (errCode === 104) {
                castLog('  Likely cause : Content-type mismatch or unsupported container.');
                castLog('  Content-type :', _lastLoadContentType || '(unknown)');
                castLog('  Try sending  : application/x-mpegurl for HLS, video/mp2t for MPEG-TS.');
              } else if (errCode === 500) {
                castLog('  Likely cause : Hardware limit — 4K/HDR/HEVC not supported on this device.');
              } else if (errCode >= 400 && errCode < 500) {
                castLog('  Likely cause : Network/segment fetch failure during playback.');
                castLog('  Consider using proxy mode; check IPTV server connection limits.');
              } else {
                castLog('  Extended status:', s.extendedStatus ? JSON.stringify(s.extendedStatus) : 'none');
              }
            }
          } else {
            castLog('media:', payload.type, payload.detailedErrorCode || payload.reason || JSON.stringify(payload).slice(0, 120));
            // Raw ERROR message — also run diagnosis
            if (payload.type === 'ERROR' && payload.detailedErrorCode != null) {
              const errCode = payload.detailedErrorCode;
              const ERROR_LABELS = { 100:'MEDIA_UNKNOWN',101:'MEDIA_ABORTED',102:'MEDIA_DECODE',103:'MEDIA_NETWORK',104:'MEDIA_SRC_NOT_SUPPORTED',200:'SOURCE_BUFFER_FAILURE',300:'NETWORK',400:'SEGMENT_NETWORK',500:'CONTENT_UNSUPPORTED_BY_HARDWARE' };
              const label = ERROR_LABELS[errCode] || ('UNKNOWN_' + errCode);
              castLog('⚠️  PLAYBACK ERROR DIAGNOSIS ⚠️');
              castLog('  Error code   :', errCode, '→', label);
              if (errCode === 102) {
                if (!_proxyTranscode && !_transcodeRetryPending && _lastLoadParams) {
                  // First error 102: manifest had no CODECS tag so we couldn't detect H.265 upfront.
                  // Enable transcoding now. We DON'T retry here — we wait for the device to send
                  // MEDIA_STATUS playerState=IDLE which confirms all segment downloads have stopped
                  // before we open a new manifest connection (avoids 403 on the IPTV server).
                  const ffBin = findFfmpeg();
                  if (ffBin) {
                    castLog('  → Error 102: enabling H.265→H.264 transcode — waiting for device IDLE before retry...');
                    _proxyTranscode = true;
                    _transcodeRetryPending = true;
                    // Remember this stream needs transcode so future casts skip the error-102 cycle.
                    const transcodeKey = _lastLoadParams.url.replace(/\?.*$/, '');
                    _transcodeCache.add(transcodeKey);
                    castLog(`[cache] added ${transcodeKey.slice(-20)} to transcode cache`);
                    // Retry fires from the MEDIA_STATUS IDLE handler below
                  } else {
                    castLog('  Cause  : Device cannot decode the video codec (likely H.265/HEVC).');
                    castLog('  ffmpeg-static not available — cannot transcode. Run: npm install');
                  }
                } else if (_proxyTranscode && !_transcodeRetryPending) {
                  castLog('  Error 102 even with transcoding active — stream may use an unsupported profile or container.');
                  castLog('  ffmpeg =', _ffmpegBin || 'NOT FOUND');
                }
              } else if (errCode === 500) {
                castLog('  Cause  : Hardware limit — 4K/HDR/HEVC not supported on this device.');
              } else if (errCode >= 400 && errCode < 500) {
                castLog('  Cause  : Network/segment fetch failure during playback.');
              }
            }
          }
          // Chromecast often sends MEDIA_STATUS with requestId=0 (broadcast) instead of
          // matching our requestId. Try exact match first, then fall back to any pending
          // media callback (we only ever have one LOAD in-flight at a time).
          if (payload.type === 'LOAD_FAILED' || payload.type === 'INVALID_REQUEST') {
            // Hard failure — reject the pending LOAD callback
            const cb = _castCallbacks.get(payload.requestId) || [..._castCallbacks.values()][0];
            const key = _castCallbacks.has(payload.requestId) ? payload.requestId : [..._castCallbacks.keys()][0];
            if (cb) { _castCallbacks.delete(key); cb.reject(new Error(payload.type + (payload.detailedErrorCode ? ' (' + payload.detailedErrorCode + ')' : ''))); }
          } else if (payload.type === 'MEDIA_STATUS' && _castCallbacks.size > 0) {
            const s = payload.status && payload.status[0];
            const state = s && s.playerState;
            // LOADING = intermediate broadcast — keep waiting, do not resolve yet.
            // Only resolve once the player transitions to an active state (PLAYING/BUFFERING/PAUSED)
            // or to IDLE without an error reason (live streams sometimes go IDLE→PLAYING quickly).
            const isActive = state === 'PLAYING' || state === 'BUFFERING' || state === 'PAUSED';
            // IDLE with no error reason AND no extendedStatus = genuinely ready.
            // IDLE with extendedStatus = intermediate state (Chromecast still loading); don't resolve yet.
            const isIdleOk = state === 'IDLE' && s && !s.idleReason && !s.extendedStatus;
            if (isActive || isIdleOk) {
              // Try exact requestId match first, fall back to any pending callback
              const cb = _castCallbacks.get(payload.requestId) ||
                         (payload.requestId === 0 ? [..._castCallbacks.values()][0] : null);
              const key = _castCallbacks.has(payload.requestId) ? payload.requestId :
                          (payload.requestId === 0 ? [..._castCallbacks.keys()][0] : null);
              if (cb && key != null) { _castCallbacks.delete(key); cb.resolve(payload); }
            }
            // state === 'LOADING' or state === 'IDLE' with idleReason — keep waiting
          }
          if (mainWindow) mainWindow.webContents.send('cast:mediaStatus', payload);
        }
      }
    });
    sock.on('error', (err) => {
      if (_castGen !== myGen) { castLog('stale socket error (ignored):', err.message); return; }
      castLog('socket error:', err.message);
      castDisconnectInternal();
      reject(err);
      for (const cb of _castCallbacks.values()) cb.reject(err);
      _castCallbacks.clear();
    });
    sock.on('close', () => {
      if (_castGen !== myGen) { castLog('stale socket closed (ignored)'); return; }
      castLog('socket closed');
      castDisconnectInternal();
      for (const cb of _castCallbacks.values()) cb.reject(new Error('Connection closed'));
      _castCallbacks.clear();
    });
  });
}

function _waitFor(condition, timeoutMs, errMsg) {
  return new Promise((resolve, reject) => {
    if (condition()) return resolve();
    const deadline = Date.now() + timeoutMs;
    const id = setInterval(() => {
      if (condition()) { clearInterval(id); resolve(); }
      else if (Date.now() > deadline) { clearInterval(id); reject(new Error(errMsg)); }
    }, 100);
  });
}

async function castLaunchAndLoad(url, contentType, title, iconUrl, opts = {}) {
  if (!_castSocket || _castSocket.destroyed) throw new Error('Not connected to any Cast device');
  if (!opts.keepTranscodeState) {
    // Fresh load — reset transcode state. Skipped on error-102 retry so _proxyTranscode stays true.
    _proxyTranscode = false;
    _transcodeRetryPending = false;
    // Kill any running transcoder from a previous session. If we don't do this, the ffmpeg
    // process keeps fetching segments from the IPTV server, causing the server to 403 the
    // new proxy manifest request (single-token / single-connection policy on most IPTV CDNs).
    if (_transcodeStream) {
      castProxyLog('[Transcode] killing stale transcoder on channel/device switch');
      try { _transcodeStream.proc.kill(); } catch(_) {}
      if (_transcodeStream.hlsDir) {
        try { fs.rmSync(_transcodeStream.hlsDir, { recursive: true, force: true }); } catch(_) {}
      }
      _transcodeStream = null;
    }
    // Reset per-stream HLS sequence tracking so channel/device switches start with a clean slate.
    // Kept inside !keepTranscodeState so retries don't lose their accumulated sequence offset.
    _m3u8SeqMap.clear();
  }
  // Bump proxy generation so any in-flight manifest retry loops for the previous
  // channel abort themselves rather than racing the new channel's IPTV session slot.
  _proxyGeneration++;
  _lastLoadParams = { url, contentType, title, iconUrl };

  // Launch the Default Media Receiver if not already running.
  if (!_castSession) {
    _pendingLaunch = true;
    castLog('sending LAUNCH');
    castSend(DST_RCV, NS_RCV, { type: 'LAUNCH', appId: APP_ID, requestId: _castReqId++ });
    try {
      await _waitFor(
        () => !!_castSession || _closeCount > 3,
        25000,
        'App launch timed out — Chromecast may need a reboot, or another app is blocking casting'
      );
      if (!_castSession && _closeCount > 3) {
        throw new Error('Chromecast refused connection after ' + _closeCount + ' attempts — try rebooting the device or closing Google Home');
      }
    } finally {
      _pendingLaunch = false;
    }
    castLog('session ready:', _castSession.transportId);
  } else {
    castLog('reusing existing session:', _castSession.transportId);
  }

  // Brief pause so the transport virtual-channel CONNECT is processed before LOAD
  await new Promise(r => setTimeout(r, 300));

  const ct = contentType || 'application/x-mpegurl';

  // Helper: send a LOAD and wait for success/failure
  const tryLoad = (loadUrl) => new Promise((resolve, reject) => {
    const mediaInfo = {
      contentId: loadUrl,
      contentType: ct,
      streamType: 'LIVE',
      metadata: { metadataType: 0, title: title || 'Live TV' },
    };
    if (iconUrl) mediaInfo.metadata.images = [{ url: iconUrl }];

    _lastLoadUrl = loadUrl;
    _lastLoadContentType = ct;
    const isHLS = /\.m3u8|mpegurl/i.test(loadUrl + ct);
    const isTS  = /\.ts($|\?)|mp2t/i.test(loadUrl + ct);
    const reqId = _castReqId++;
    castLog('sending LOAD →', loadUrl.slice(0, 100));
    castLog('  content-type :', ct);
    castLog('  format guess :', isHLS ? 'HLS (m3u8)' : isTS ? 'MPEG-TS' : 'unknown — device may reject');
    castLog('  via proxy    :', loadUrl.includes('127.0.0.1') ? 'YES' : 'NO (direct)');
    _castCallbacks.set(reqId, { resolve, reject });
    castSend(_castSession.transportId, NS_MED, {
      type: 'LOAD',
      requestId: reqId,
      sessionId: _castSession.sessionId,
      media: mediaInfo,
      activeTrackIds: [],
      autoplay: true,
      customData: {},
    });
    // Use a longer timeout when switching devices — the proxy may need up to ~30s
    // to recover the manifest after the IPTV server releases the old session token.
    const loadTimeout = opts.loadTimeoutMs || 20000;
    setTimeout(() => {
      if (_castCallbacks.has(reqId)) {
        _castCallbacks.delete(reqId);
        reject(new Error('Load timed out'));
      }
    }, loadTimeout);
  });

  // Derive a stable cache key from the URL — strip query string so rotating tokens
  // don't create separate entries for the same stream.
  const cacheKey = url.replace(/\?.*$/, '');

  // Strategy: use the per-channel learning caches to skip proven-wasteful steps.
  //   1. If this URL is in _transcodeCache, jump straight to ffmpeg transcode.
  //   2. If this URL is in _directFailCache, skip the direct LOAD and go via proxy.
  //   3. Otherwise try direct, learn from the result, fall back to proxy.
  const needsTranscodeFromCache = _transcodeCache.has(cacheKey);
  if (needsTranscodeFromCache && !_proxyTranscode) {
    castLog(`[cache] ${cacheKey.slice(-20)} known-HEVC → enabling transcode immediately`);
    _proxyTranscode = true;
    startTranscodeStream(url);
  }

  if ((_proxyTranscode || needsTranscodeFromCache) && _castProxyPort) {
    const hlsUrl = makeCastHlsUrl();
    castLog('transcode mode — HLS stream →', hlsUrl);
    const transcodeLoad = () => new Promise((resolve, reject) => {
      const mediaInfo = {
        contentId: hlsUrl,
        contentType: 'application/vnd.apple.mpegurl',
        streamType: 'LIVE',
        metadata: { metadataType: 0, title: title || 'Live TV' },
      };
      if (iconUrl) mediaInfo.metadata.images = [{ url: iconUrl }];
      _lastLoadUrl = hlsUrl;
      _lastLoadContentType = 'application/vnd.apple.mpegurl';
      const reqId = _castReqId++;
      castLog('sending LOAD (transcode HLS) →', hlsUrl);
      castLog('  content-type : application/vnd.apple.mpegurl');
      _castCallbacks.set(reqId, { resolve, reject });
      castSend(_castSession.transportId, NS_MED, {
        type: 'LOAD', requestId: reqId, sessionId: _castSession.sessionId,
        media: mediaInfo, activeTrackIds: [], autoplay: true, customData: {},
      });
      setTimeout(() => {
        if (_castCallbacks.has(reqId)) { _castCallbacks.delete(reqId); reject(new Error('Load timed out')); }
      }, 20000);
    });
    await transcodeLoad();
    castLog('transcode HLS load succeeded');
  } else if (_directFailCache.has(cacheKey) && _castProxyPort) {
    // This URL has previously failed direct LOAD — go straight to proxy.
    castLog(`[cache] ${cacheKey.slice(-20)} known-proxy-only → skipping direct LOAD`);
    const proxyUrl = makeCastProxyUrl(url);
    castLog('proxy URL:', proxyUrl.slice(0, 100));
    await tryLoad(proxyUrl);
    castLog('proxy load succeeded');
  } else {
    castLog('trying direct URL first →', url.slice(0, 80));
    try {
      await tryLoad(url);
      castLog('direct load succeeded');
    } catch (directErr) {
      castLog('direct load failed:', directErr.message, '— retrying via proxy');
      // Remember this URL always needs the proxy so we skip the direct attempt next time.
      _directFailCache.add(cacheKey);
      castLog(`[cache] added ${cacheKey.slice(-20)} to direct-fail cache`);
      if (!_castProxyPort) throw directErr;
      // Brief pause so the Chromecast settles after the LOAD_FAILED before we retry
      await new Promise(r => setTimeout(r, 1500));
      const proxyUrl = makeCastProxyUrl(url);
      castLog('proxy URL:', proxyUrl.slice(0, 100));
      await tryLoad(proxyUrl);
      castLog('proxy load succeeded');
    }
  }

  console.log('[Cast] LOAD success');
  if (mainWindow) mainWindow.webContents.send('cast:status', { connected: true, title, url });
}

function castStop() {
  if (!_castSocket || !_castSession) return;
  const sock = _castSocket;
  const session = _castSession;
  // Send stop commands BEFORE clearing state so the socket is still open when we write.
  try { castSendRaw(sock, session.transportId, NS_MED, { type: 'STOP', requestId: _castReqId++ }); } catch(_) {}
  try { castSendRaw(sock, DST_RCV, NS_RCV, { type: 'STOP', requestId: _castReqId++, sessionId: session.sessionId }); } catch(_) {}
  try { castSendRaw(sock, session.transportId, NS_CON, { type: 'CLOSE' }); } catch(_) {}
  // Clear state and destroy socket after giving the OS time to flush the writes.
  setTimeout(() => {
    castDisconnectInternal();
    try { sock.destroy(); } catch(_) {}
  }, 600);
}

// Like castSend but takes an explicit socket so it works after _castSocket is cleared
function castSendRaw(sock, dst, ns, payload) {
  if (!sock || sock.destroyed) return;
  const data = encodeCastMessage(_castSenderId, dst, ns, JSON.stringify(payload));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  sock.write(Buffer.concat([header, data]));
}

// IPC handlers
ipcMain.handle('cast:discover',    ()                           => castDiscover());
ipcMain.handle('cast:connect',     (_e, host, port)            => castConnect(host, port));
ipcMain.handle('cast:load',        (_e, url, ct, title, icon, opts) => castLaunchAndLoad(url, ct, title, icon, opts || {}));
ipcMain.handle('cast:stop',        ()                           => { castStop(); });
ipcMain.handle('cast:disconnect',  ()                           => { castDisconnectInternal(); });
ipcMain.handle('cast:isConnected', ()                           => !!_castSocket && !_castSocket.destroyed);

// Local transcode — lets the renderer play HEVC streams by routing through ffmpeg→H.264 HLS
ipcMain.handle('local:startTranscode', (_e, url) => startLocalTranscodeStream(url));
ipcMain.handle('local:stopTranscode',  () => {
  if (_localTranscodeStream) {
    try { _localTranscodeStream.proc.kill(); } catch(_) {}
    if (_localTranscodeStream.hlsDir) {
      try { fs.rmSync(_localTranscodeStream.hlsDir, { recursive: true, force: true }); } catch(_) {}
    }
    _localTranscodeStream = null;
  }
});

// ---------- VOD native player (mpv) ----------
// The browser <video>/HLS.js/ffmpeg-remux pipeline above works, but it can't
// give VOD playback what it really needs: native demuxing of .mkv containers,
// every audio codec torrent rips carry (DTS/TrueHD/AC-3/E-AC-3/Atmos), and
// styled subtitle rendering (ASS/SSA/PGS) — browsers fundamentally can't do
// any of that, full stop, transcoding workarounds notwithstanding.
//
// mpv (built on libmpv/FFmpeg's decoders, plus libass for subtitles) handles
// all of it natively, with proper audio-clock A/V sync and instant track
// switching — exactly the "Playback Engine" layer recommended for a desktop
// app. True pixel-level embedding of mpv's video surface *inside* the Electron
// BrowserWindow would require a native windowing addon (parenting an external
// process's window handle into a Chromium layer — there's no off-the-shelf,
// cross-platform way to do this from Node/Electron without writing native
// code per-OS). Instead we launch mpv as its own native window — still a
// fully "embedded"-feeling experience for the user (it opens instantly over
// the app, title-barred as part of Xtream TV, and closes back to the library
// on quit/EOF) — and drive it from our own VOD overlay via mpv's JSON IPC
// socket, so play/pause/seek/volume/track-selection all stay inside our UI.
let _mpvBin     = undefined; // undefined = not checked yet, false = not found, string = path
let _mpvProc    = null;
let _mpvSocket  = null;      // net.Socket — JSON IPC connection
let _mpvSockPath = null;
let _mpvReqId   = 1;
let _mpvPending = new Map(); // request_id -> { resolve, reject, timer }
let _mpvConnectAttempt = 0;

function findMpv() {
  if (_mpvBin !== undefined) return _mpvBin;
  const candidates = process.platform === 'darwin'
    ? ['/opt/homebrew/bin/mpv', '/usr/local/bin/mpv', '/Applications/mpv.app/Contents/MacOS/mpv']
    : process.platform === 'win32'
    ? ['C:\\Program Files\\mpv\\mpv.exe', 'C:\\ProgramData\\chocolatey\\bin\\mpv.exe']
    : ['/usr/bin/mpv', '/usr/local/bin/mpv', '/snap/bin/mpv'];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { _mpvBin = c; castProxyLog(`[mpv] found at ${c}`); return _mpvBin; } } catch(_) {}
  }
  try {
    const out = require('node:child_process')
      .execSync(process.platform === 'win32' ? 'where mpv' : 'command -v mpv', { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] })
      .trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) { _mpvBin = out; castProxyLog(`[mpv] found on PATH at ${out}`); return _mpvBin; }
  } catch (_) {}
  castProxyLog('[mpv] not found — install it (e.g. `brew install mpv`) for native VOD playback (proper .mkv/DTS/subtitle support)');
  _mpvBin = false;
  return false;
}

function notifyMpvEvent(payload) {
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('mpv:event', payload);
  }
}

function closeMpvSocket() {
  if (_mpvSocket) { try { _mpvSocket.destroy(); } catch(_) {} _mpvSocket = null; }
  for (const { reject, timer } of _mpvPending.values()) { clearTimeout(timer); try { reject(new Error('mpv connection closed')); } catch(_){} }
  _mpvPending.clear();
  _mpvSockPath = null;
}

function stopMpv() {
  closeMpvSocket();
  if (_mpvProc) {
    try { _mpvProc.kill(); } catch(_) {}
    _mpvProc = null;
  }
}

function connectMpvSocket(sockPath) {
  _mpvConnectAttempt = 0;
  const tryConnect = () => {
    _mpvConnectAttempt += 1;
    const sock = net.connect(sockPath);
    let buf = '';
    sock.on('connect', () => {
      _mpvSocket = sock;
      castProxyLog('[mpv] IPC socket connected');
      // Subscribe to the properties the renderer's overlay needs to mirror.
      ['pause', 'time-pos', 'duration', 'volume', 'mute', 'speed',
       'track-list', 'sub-text', 'eof-reached', 'playback-time', 'seeking']
        .forEach((prop, i) => {
          try { sock.write(JSON.stringify({ command: ['observe_property', i + 1, prop] }) + '\n'); } catch(_){}
        });
      notifyMpvEvent({ event: 'xtream-connected' });
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        if (msg && msg.request_id != null && _mpvPending.has(msg.request_id)) {
          const p = _mpvPending.get(msg.request_id);
          _mpvPending.delete(msg.request_id);
          clearTimeout(p.timer);
          if (msg.error && msg.error !== 'success') p.reject(new Error(msg.error));
          else p.resolve(msg.data !== undefined ? msg.data : msg);
        } else if (msg && msg.event) {
          notifyMpvEvent(msg);
        }
      }
    });
    sock.on('error', () => {
      // mpv may not have created the socket yet — retry briefly.
      if (_mpvConnectAttempt < 40 && _mpvProc) setTimeout(tryConnect, 150);
    });
    sock.on('close', () => {
      if (_mpvSocket === sock) _mpvSocket = null;
    });
  };
  tryConnect();
}

function sendMpvCommand(cmdArr) {
  return new Promise((resolve, reject) => {
    if (!_mpvSocket) { reject(new Error('mpv not connected')); return; }
    const id = _mpvReqId++;
    const timer = setTimeout(() => {
      if (_mpvPending.has(id)) { _mpvPending.delete(id); reject(new Error('mpv command timed out')); }
    }, 6000);
    _mpvPending.set(id, { resolve, reject, timer });
    try {
      _mpvSocket.write(JSON.stringify({ command: cmdArr, request_id: id }) + '\n');
    } catch (e) {
      _mpvPending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

// Launches mpv against a VOD URL, in its own native window with a JSON IPC
// socket for control. Returns { ok:true } or { ok:false, reason }.
function startMpvPlayback(url, title) {
  stopMpv();
  const bin = findMpv();
  if (!bin) return { ok: false, reason: 'not-found' };

  const sockPath = process.platform === 'win32'
    ? ('\\\\.\\pipe\\xtream-mpv-' + process.pid + '-' + Date.now())
    : path.join(os.tmpdir(), `xtream-mpv-${process.pid}-${Date.now()}.sock`);

  if (process.platform !== 'win32') { try { fs.unlinkSync(sockPath); } catch(_) {} }

  const args = [
    `--input-ipc-server=${sockPath}`,
    '--force-window=yes',
    '--idle=yes',
    '--keep-open=yes',
    '--autofit-larger=100%x100%',
    '--title=' + (title ? `${title} — Xtream TV` : 'Xtream TV — Now Playing'),
    '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    // Subtitle/OSD niceties — mpv demuxes embedded ASS/SRT/PGS tracks itself.
    '--sub-auto=fuzzy',
    '--osc=yes',
    url,
  ];
  castProxyLog(`[mpv] launching: ${bin} (socket=${sockPath})`);
  let proc;
  try {
    proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    castProxyLog(`[mpv] spawn failed: ${e.message}`);
    return { ok: false, reason: 'spawn-failed', message: e.message };
  }
  _mpvProc = proc;
  _mpvSockPath = sockPath;

  proc.stderr && proc.stderr.on('data', d => castProxyLog(`[mpv] ${d.toString().trim()}`));
  proc.on('error', e => {
    castProxyLog(`[mpv] process error: ${e.message}`);
    if (_mpvProc === proc) { _mpvProc = null; closeMpvSocket(); notifyMpvEvent({ event: 'xtream-error', message: e.message }); }
  });
  proc.on('exit', (code, sig) => {
    castProxyLog(`[mpv] exited code=${code} signal=${sig}`);
    if (_mpvProc === proc) {
      _mpvProc = null;
      closeMpvSocket();
      notifyMpvEvent({ event: 'xtream-closed', code, signal: sig });
    }
  });

  // Give mpv a brief head start to create the socket file before connecting.
  setTimeout(() => connectMpvSocket(sockPath), 250);
  return { ok: true };
}

ipcMain.handle('mpv:available', () => !!findMpv());
ipcMain.handle('mpv:play', (_e, url, title) => startMpvPlayback(url, title));
ipcMain.handle('mpv:command', (_e, cmdArr) => sendMpvCommand(cmdArr));
ipcMain.handle('mpv:stop', () => { stopMpv(); return true; });

app.on('before-quit', () => { try { stopMpv(); } catch(_) {} });

// ---------- VOD native player — embedded libmpv (in-window) ----------
// This is the "true embedding" path: native/mpv-addon wraps libmpv's client +
// software-render API in an N-API addon, decoding/rendering frames in-process
// and handing us RGBA buffers we forward straight to the renderer to paint
// onto a <canvas> — actually inside the app window, not a separate process's
// window like the external-`mpv` path above (which stays as the no-build-step
// fallback when this addon hasn't been compiled on the user's machine; see
// native/mpv-addon/BUILD.md for how to build/bundle it).
let _mpvAddon = null;
function loadMpvAddon() {
  if (_mpvAddon !== null) return _mpvAddon;
  try {
    _mpvAddon = require('./native/mpv-addon');
    if (_mpvAddon.available) castProxyLog('[mpv2] embedded libmpv addon loaded');
    else castProxyLog(`[mpv2] embedded libmpv addon not built: ${_mpvAddon.error}`);
  } catch (e) {
    castProxyLog(`[mpv2] failed to load addon: ${e.message}`);
    _mpvAddon = { available: false, error: e.message, MpvPlayer: null };
  }
  return _mpvAddon;
}

let _mpvPlayer = null; // native MpvPlayer instance for the active VOD session

// ---- mpv2 debug instrumentation ----
// Toggle with env var MPV2_DEBUG=1 (or set _mpv2Debug = true at runtime via
// the `mpv2:debug` IPC below). Frame payloads are extremely high-frequency,
// so they're summarized into a rolling fps/size counter and logged once a
// second rather than per-frame, while every other event (property-change,
// log-message, lifecycle, errors) is logged immediately with a timestamp —
// this is what lets us see, e.g., whether `pause`/`time-pos` events are
// actually arriving (autoplay/seek-bar symptoms) and whether frame delivery
// is steady or bursty (stutter/spinner symptoms).
let _mpv2Debug = process.env.MPV2_DEBUG === '1';
let _mpv2FrameStats = { count: 0, bytes: 0, windowStart: 0 };
let _mpv2LastLogAt = 0;
// Each frame is a multi-MB raw RGBA Buffer that has to be structured-cloned
// across the main↔renderer IPC boundary — that serialization runs on the
// main process's thread (the same thread Electron uses to pump the native
// event loop), so forwarding every frame the addon produces can saturate it
// and make the whole app — cursor, menus, window dragging — appear frozen
// system-wide, independent of anything the renderer does with the frame
// afterward. Cap forwarding to ~30fps (mpv already renders at ~28fps in
// steady state, so this is a no-op then) and silently drop any extra frames
// that arrive during bursts instead of queuing IPC sends.
const MPV2_MAX_FRAME_FORWARD_HZ = 30;
let _mpv2LastFrameForwardAt = 0;

function mpv2Log(...args) {
  if (!_mpv2Debug) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  castProxyLog(`[mpv2-debug ${ts}]`, ...args);
}

function notifyMpv2(payload) {
  if (_mpv2Debug && payload) {
    if (payload.type === 'frame' || payload.frame || payload.buffer || ArrayBuffer.isView(payload)) {
      // Frame-ish payload — summarize via a 1s rolling counter instead of
      // logging every single one (these can arrive 30-60x/sec).
      const now = Date.now();
      if (!_mpv2FrameStats.windowStart) _mpv2FrameStats.windowStart = now;
      _mpv2FrameStats.count += 1;
      try {
        const buf = payload.buffer || payload.data || payload;
        if (buf && typeof buf.length === 'number') _mpv2FrameStats.bytes += buf.length;
        else if (buf && typeof buf.byteLength === 'number') _mpv2FrameStats.bytes += buf.byteLength;
      } catch (_) {}
      const elapsed = now - _mpv2FrameStats.windowStart;
      if (elapsed >= 1000) {
        const fps = (_mpv2FrameStats.count / (elapsed / 1000)).toFixed(1);
        const kbps = (_mpv2FrameStats.bytes / 1024 / (elapsed / 1000)).toFixed(0);
        mpv2Log(`frames: ${_mpv2FrameStats.count} in ${elapsed}ms (~${fps} fps, ~${kbps} KB/s)`);
        _mpv2FrameStats = { count: 0, bytes: 0, windowStart: now };
      }
    } else if (payload.type === 'property-change' && payload.name === 'time-pos') {
      // time-pos fires ~10-15x/sec during normal playback — far too noisy to
      // log every occurrence now that the pipeline is confirmed healthy.
      // Throttle to roughly once per second so we can still see it's alive.
      const now = Date.now();
      if (now - _mpv2LastLogAt >= 1000) {
        _mpv2LastLogAt = now;
        mpv2Log('event ->', JSON.stringify(payload));
      }
    } else {
      // Non-frame, non-time-pos events (pause, duration, seeking, log-message,
      // end-file, etc.) — these are low-frequency and the most useful for
      // diagnosing playback-state symptoms, so log every one immediately.
      try { mpv2Log('event ->', JSON.stringify(payload)); }
      catch (_) { mpv2Log('event -> [unserializable]', payload && payload.type); }
    }
  }
  if (payload && payload.type === 'frame') {
    const now = Date.now();
    const minInterval = 1000 / MPV2_MAX_FRAME_FORWARD_HZ;
    if (_mpv2LastFrameForwardAt && now - _mpv2LastFrameForwardAt < minInterval) {
      return; // drop — too soon since the last forwarded frame
    }
    _mpv2LastFrameForwardAt = now;

    // Ship frames over the dedicated zero-copy MessagePort, transferring
    // (not cloning) the backing ArrayBuffer the addon just malloc'd. This is
    // the whole point of setupMpv2FramePort() — see its comment for the full
    // rationale (avoids the ~200MB/s structured-clone churn that was
    // OOM/SIGKILL-ing the app).
    if (_mpv2FramePort) {
      const buf = payload.buffer;
      try {
        _mpv2FramePort.postMessage(
          { type: 'frame', width: payload.width, height: payload.height, stride: payload.stride, buffer: buf },
          buf instanceof ArrayBuffer ? [buf] : []
        );
      } catch (e) {
        mpv2Log('frame port postMessage failed:', e.message);
      }
      return; // never falls through to webContents.send for frames
    }
    // No port yet (e.g. very first frame before did-finish-load fired) —
    // drop it rather than structured-clone-copying it through the slow path.
    return;
  }
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('mpv2:event', payload);
  }
}

function closeMpv2() {
  mpv2Log('closeMpv2()', _mpvPlayer ? '(destroying active player)' : '(no active player)');
  if (_mpvPlayer) {
    try { _mpvPlayer.destroy(); } catch (e) { mpv2Log('destroy() threw:', e.message); }
    _mpvPlayer = null;
  }
  _mpv2FrameStats = { count: 0, bytes: 0, windowStart: 0 };
}

function openMpv2(url, title, surfaceW, surfaceH) {
  const t0 = Date.now();
  mpv2Log(`openMpv2() url=${url} title=${title || ''} surface=${surfaceW || '?'}x${surfaceH || '?'}`);
  const addon = loadMpvAddon();
  if (!addon.available || !addon.MpvPlayer) {
    mpv2Log('openMpv2() addon unavailable:', addon.error);
    return { ok: false, reason: 'not-built', message: addon.error };
  }

  closeMpv2();
  try {
    _mpvPlayer = new addon.MpvPlayer((payload) => {
      // Frame buffers arrive as Node Buffers — forward as-is; structured
      // clone turns them into Uint8Array on the renderer side, which the
      // canvas surface wraps in a Uint8ClampedArray for putImageData with
      // zero extra copies.
      notifyMpv2(payload);
    });
    mpv2Log(`MpvPlayer constructed in ${Date.now() - t0}ms`);
    if (surfaceW && surfaceH) {
      _mpvPlayer.setSurfaceSize(surfaceW, surfaceH);
      mpv2Log(`setSurfaceSize(${surfaceW}, ${surfaceH})`);
    }
    // Properties the renderer's overlay needs to mirror playback state —
    // mirrors the set the external-mpv IPC path observes for parity.
    const props = ['pause', 'time-pos', 'duration', 'volume', 'mute', 'speed',
     'track-list', 'sub-text', 'eof-reached', 'seeking', 'core-idle'];
    props.forEach(p => {
      try {
        const rc = _mpvPlayer.observeProperty(p);
        // mpv_observe_property returns a negative mpv_error code on failure —
        // the addon used to discard this, which would let a silent
        // registration failure masquerade as "events just don't arrive".
        if (typeof rc === 'number' && rc < 0) mpv2Log(`observeProperty('${p}') returned error code ${rc}`);
      } catch (e) { mpv2Log(`observeProperty('${p}') failed:`, e.message); }
    });
    mpv2Log('observing properties:', props.join(', '));
    _mpvPlayer.loadFile(url);
    mpv2Log(`loadFile() issued — total open() time so far ${Date.now() - t0}ms`);
    castProxyLog(`[mpv2] embedded playback started: ${title || url}`);
    return { ok: true };
  } catch (e) {
    castProxyLog(`[mpv2] open failed: ${e.message}`);
    mpv2Log('openMpv2() threw:', e.message, e.stack || '');
    closeMpv2();
    return { ok: false, reason: 'error', message: e.message };
  }
}

ipcMain.handle('mpv2:available', () => !!loadMpvAddon().available);
ipcMain.handle('mpv2:open', (_e, url, title, w, h) => openMpv2(url, title, w, h));
// Lets the renderer flip verbose mpv2 logging on/off at runtime (instead of
// requiring the MPV2_DEBUG=1 env var + relaunch) — wired to a "Debug" toggle
// in the player overlay so the user can capture logs around a live repro.
ipcMain.handle('mpv2:debug', (_e, enabled) => {
  _mpv2Debug = !!enabled;
  castProxyLog(`[mpv2] debug logging ${_mpv2Debug ? 'ENABLED' : 'disabled'}`);
  return _mpv2Debug;
});
ipcMain.handle('mpv2:command', (_e, cmdArr) => {
  if (!_mpvPlayer) {
    mpv2Log('command() with no active player:', JSON.stringify(cmdArr));
    return Promise.reject(new Error('no active embedded player'));
  }
  const t0 = Date.now();
  mpv2Log('command ->', JSON.stringify(cmdArr));
  return _mpvPlayer.command(cmdArr).then((res) => {
    mpv2Log(`command <- ok in ${Date.now() - t0}ms:`, JSON.stringify(cmdArr), '=>', JSON.stringify(res));
    return res;
  }).catch((e) => {
    mpv2Log(`command <- FAILED in ${Date.now() - t0}ms:`, JSON.stringify(cmdArr), 'error:', e.message);
    throw e;
  });
});
ipcMain.handle('mpv2:setProperty', (_e, name, value) => {
  mpv2Log(`setProperty('${name}', ${JSON.stringify(value)})`, _mpvPlayer ? '' : '(NO ACTIVE PLAYER — dropped)');
  if (_mpvPlayer) {
    try {
      const rc = _mpvPlayer.setProperty(name, value);
      if (typeof rc === 'number' && rc < 0) mpv2Log(`setProperty('${name}', ${JSON.stringify(value)}) returned error code ${rc}`);
    } catch (e) { mpv2Log(`setProperty('${name}') threw:`, e.message); }
  }
  return true;
});
ipcMain.handle('mpv2:getProperty', (_e, name) => {
  const v = _mpvPlayer ? _mpvPlayer.getProperty(name) : null;
  mpv2Log(`getProperty('${name}') ->`, JSON.stringify(v));
  return v;
});
ipcMain.handle('mpv2:setSurfaceSize', (_e, w, h) => {
  mpv2Log(`setSurfaceSize(${w}, ${h})`, _mpvPlayer ? '' : '(NO ACTIVE PLAYER — dropped)');
  if (_mpvPlayer) _mpvPlayer.setSurfaceSize(w, h);
  return true;
});
ipcMain.handle('mpv2:close', () => { closeMpv2(); return true; });

app.on('before-quit', () => { try { closeMpv2(); } catch(_) {} });

// ---------- application menu ----------
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const tpl = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open M3U file…', accelerator: 'CmdOrCtrl+O', click: () => mainWindow && mainWindow.webContents.send('menu:open-m3u') },
        { label: 'Add server…',    accelerator: 'CmdOrCtrl+N', click: () => mainWindow && mainWindow.webContents.send('menu:add-server') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Live',      accelerator: 'CmdOrCtrl+1', click: () => mainWindow && mainWindow.webContents.send('menu:view', 'player') },
        { label: 'Multi',     accelerator: 'CmdOrCtrl+2', click: () => mainWindow && mainWindow.webContents.send('menu:view', 'multi')  },
        { label: 'Guide',     accelerator: 'CmdOrCtrl+3', click: () => mainWindow && mainWindow.webContents.send('menu:view', 'guide')  },
        { label: 'Favorites', accelerator: 'CmdOrCtrl+4', click: () => mainWindow && mainWindow.webContents.send('menu:view', 'favorites') },
        { type: 'separator' },
        { role: 'reload' }, { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Open project folder', click: () => shell.openPath(app.getAppPath()) },
        { label: 'iptv-org playlists',  click: () => shell.openExternal('https://github.com/iptv-org/iptv') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ---------- lifecycle ----------
app.whenReady().then(async () => {
  await startRendererServer();
  await startCastProxyServer();
  // Resolve ffmpeg-static path once at startup so it's ready before the first cast attempt
  findFfmpeg();
  configureNetwork();
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

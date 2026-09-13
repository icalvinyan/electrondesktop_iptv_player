# Port recent xtream-apk changes to xtream-desktop

- Date: 2026-09-13
- Project: xtream-desktop
- Status: done
- Original plan file: ~/.claude/plans/the-recent-changes-in-goofy-quokka.md


## Context
Three recent xtream-apk commits need desktop equivalents. Both apps share the same single-file web UI lineage (`renderer/index.html` ≈ apk `app/src/main/assets/www/index.html`), so items 1–2 port almost verbatim. Item 3 needs a desktop-specific engine: the apk hands HEVC/AC-3 to native ExoPlayer; desktop already has an ffmpeg-static → local HLS transcode (`main.js` `startLocalTranscodeStream`, served at `/local-hls/`), but it only fires on `fragParsingError`, only after 2 wasted `recoverMediaError()` retries, and hls.js 1.5.13 can't demux HEVC-in-TS at all — so users hit "stream parsing failed … unable to start ffmpeg".

Source commits (xtream-apk): `5cfff9e` (Copy URL), `50d4cbe` (456 check), `0310a05` (HEVC — web side only).

## 1. M3U URL copy button — `renderer/index.html`
- Add `serverM3uUrl(s)` just above `renderServerList()` (~line 2463), copied from apk: M3U profiles return `s.host`; Xtream profiles return `${host}/get.php?username=${encodeURIComponent(s.username)}&password=${encodeURIComponent(s.password)}&type=m3u_plus&output=${ts|m3u8}` (output from `s.container`; host trailing slashes stripped). Credentials must be encoded — passwords with `&`, `+`, `#` would otherwise break the query string.
- In the row template (~line 2500) add `<button data-act="copy" data-id="${s.id}" title="Copy M3U URL">Copy URL</button>` before Delete.
- In the server-list click handler (~line 2618, next to `act === 'edit'`/`'star'`) add `else if (btn.dataset.act === 'copy') copyText(serverM3uUrl(s), 'Copied M3U URL.');` — reuses existing `copyText()` (line 1673).
- Add the focus-visible CSS rule next to `.row-actions` (line 128).

## 2. Bulk import HTTP 456 check
**`main.js` `netFetch` (line 789):** add `opts.statusOnly` — pass an `AbortController` signal used **only** for a 10 s headers timeout (clear the timer once `session.fetch` resolves; on timeout throw a clear `Timed out after 10s` error). Once headers arrive, read `res.status` and call `await res.body?.cancel()` (wrapped in `.catch(() => {})`) instead of aborting — this closes the body stream without an `AbortError` rejection. Return `{ ok, status, headers, body: '' }`. Needed because the apk's desktop branch calls `xtream.fetch(url)`, which does `res.arrayBuffer()` — a `.m3u8` that redirects to an endless `.ts` would hang the main process forever.

**`renderer/index.html`:**
- Add `XtreamAPI.probeStream(stream)` after `streamUrl()` (line 1973): builds the `.m3u8` live URL (always m3u8, never ts); desktop path → `window.xtream.fetch(url, { statusOnly: true })`.then(r => r.status); browser path → the apk's AbortController fetch (copy as-is). No `withTimeout` helper exists on desktop — the timeout lives in `netFetch` / the AbortController.
- Replace the `else` branch in `runValidation()` (~line 2827) with the apk version: `'Checking streams…'` → `await checkStreams(api, i)` → 456 ⇒ `fail` `'✗ HTTP 456 — server refuses streams'`, else `ok` with `check.note` appended. Catch block: `'HTTP 456'` ⇒ `'✗ HTTP 456 — server refuses this account'`.
- Add `checkStreams(api, i)` after `runValidation()`, copied from apk (probe first/middle/last distinct channels; 456 → refused, 2xx/3xx → fine, other codes → note only). It also sets `channelCount`, replacing the old background fetch.

## 3. HEVC/H.265 "stream parsing failed"
Strategy: let Chromium decode HEVC itself where it can (Electron 42 supports HEVC via VideoToolbox on macOS through MSE), and use ffmpeg only for what it can't — copying video and transcoding just the audio when possible (cheap), full libx264 transcode otherwise.

**`renderer/index.html`:**
- Upgrade the hls.js `<script>` (line 7) 1.5.13 → 1.6.19 (same as apk; adds HEVC-in-TS demux).
- Port from apk: `CODEC_FAILURE_DETAILS` / `isCodecFailure()` (put above `class Player`, line 2136) and the `_hlsLogger(url)` hook that detects `"<codec> audio found, not supported in this browser"` (hls.js silently drops AC-3 and plays mute video). `_hlsLogger` returns a full logger object `{ trace, debug, log, info, warn, error }` — detection lives in `log` (where hls.js's TS demuxer emits that message; worker logs are forwarded there), the rest are no-ops. Pass that object as `debug:` in the main-player `hlsConfig` calls; add a `_loadToken` counter (incremented in `load()`/`stop()`) so stale callbacks are ignored.
- New `Player._transcodeFallback(info)` replacing the inline block at lines 2282–2295: runs once per load (`_triedLocalTranscode`), destroys hls, calls `window.xtream.localTranscode(url, { copyVideo })` where `copyVideo = info.details === 'unsupportedAudioCodec'` (video already proven decodable), then `_loadTranscoded()`. Returns false when `localTranscode` is unavailable.
- Call it (before the retry switch, so codec errors skip `recoverMediaError`) from: the main `load()` HLS error handler, `_forceHls()` error handler, the `<video>` `error` listener for `MEDIA_ERR_DECODE`/`SRC_NOT_SUPPORTED`, and the audio-drop logger (deferred via `setTimeout(0)` like apk).
- Merge the duplicate `stop()` methods (lines 2213 and 2322) into one that also bumps `_loadToken` and stops the local transcode.
- Fix messages: `_classify` fragParsingError / bufferAppendError text and `_loadTranscoded`'s error → accurate "channel uses HEVC/AC-3 and the ffmpeg transcode failed/unavailable (see logs)" instead of the misleading "unable to start ffmpeg … Cast" text.
- In `boot()` log `[codecs] MSE hevc=… ac-3=… hls.js=…` like apk, for diagnosis.

**`main.js` / `preload.js`:**
- `localTranscode: (url, opts) => ipcRenderer.invoke('local:startTranscode', url, opts)`; handler at line 1636 passes `opts`.
- `startLocalTranscodeStream(sourceUrl, { copyVideo })`: when `copyVideo`, use `-c:v copy` and drop `-vf`/x264 args. Mapping is always explicit for both streams: `-map 0:v:0? -map 0:a:0?`. Any `-map` turns off ffmpeg's default stream selection, so video must be mapped next to audio; the `?` suffixes let channels missing a stream (e.g. no audio) still start. Audio stays `aac` stereo 48 kHz.

Out of scope: multi-view tiles and the hover preview keep their current hls.js handling (they just get the 1.6 upgrade); no "remember channels needing transcode" setting.

## Docs
- Update README Troubleshooting HEVC bullet (HEVC now plays natively on supported Macs; AC-3/unsupported cases auto-transcode via bundled ffmpeg).
- Save this plan to `~/.claude/plans/2026-09-13-port-apk-copy-url-456-hevc.md` and `docs/plans/` in the repo.

## Verification
1. `npm install && npm start` (node_modules is currently absent, so ffmpeg-static must be installed first).
2. Copy URL: My Servers → Copy URL on an Xtream and an M3U profile; paste and confirm the get.php URL, then paste into Bulk Import to confirm it round-trips.
3. 456: Bulk Import a list containing a server known to return 456 on streams → row shows `✗ HTTP 456 — server refuses streams` and isn't auto-checked; valid servers show `✓ Valid` plus channel count. Check DevTools that no probe request stays open.
4. HEVC: play a known HEVC channel → DevTools console shows `[codecs] MSE hevc=true`; channel plays directly (no transcode). Play an AC-3 channel → log shows dropped audio → transcode with `-c:v copy` in main-process log, audio audible. Temporarily force `copyVideo=false`/unsupported path to confirm full transcode still works. Switch channels / stop → confirm the ffmpeg process exits (`pgrep ffmpeg`).
5. Regression: normal H.264 channels, a 403/404 channel (errors still classified), multi-view.

## Implementation notes (deviations found during testing)
- **`statusOnly` uses `controller.abort()` after headers, not `res.body.cancel()`.** Tested against an endless-`.ts` fixture: in Electron's `session.fetch`, `cancel()` leaves the request open and still reading (the fixture was still streaming to it after 19 s+). Calling abort after headers closed it after 376 bytes, and the main process logged no unhandled rejection.
- **Pre-existing bug: `/local-hls/` always returned 404.** The cast proxy's main request handler only skipped `/cast-hls/`, so it answered every local-transcode request before `localHlsHandler` ran. The desktop's ffmpeg fallback had never been able to play anything. Fixed by skipping `/local-hls/` too.
- **ffmpeg stop escalates to SIGKILL after 2 s** (`killFfmpeg`/`stopLocalTranscodeStream` in `main.js`). Once ffmpeg is transcoding, one SIGTERM only asks for a graceful stop, which hangs while the input is stalled (reproduced by SIGSTOPping the source). Also added a `will-quit` cleanup, and the renderer now stops ffmpeg when switching channels and when transcoded playback fails.
- The Cast transcode path (`startTranscodeStream`) has the same single-SIGTERM pattern and wasn't changed.

## Verification results (2026-09-13, Electron 42, this Mac: MSE hevc=true, ac-3=false)
- Bulk import against a fake panel: refuse→`✗ HTTP 456 — server refuses streams`, locked→`✗ HTTP 456 — server refuses this account`, dead→`✓ Valid … · stream check: HTTP 404`, endless redirect→`✓ Valid`, good→`✓ Valid`. 5 rows in 0.5 s.
- H.264/AAC and HEVC/AAC played directly through hls.js 1.6.19, with no ffmpeg.
- HEVC/AC-3: hls.js logged the dropped AC-3 track → audio-only transcode (`-c:v copy`) → 18 s continuous playback, 0 dropped frames, audio decoding.
- ffmpeg was killed on channel switch (including with a frozen source) and on app quit.
- `serverM3uUrl` encodes `p&a+ss#1` correctly and round-trips.

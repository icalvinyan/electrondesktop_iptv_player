# Clearer error for unreachable segment servers

- Date: 2026-09-13
- Project: xtream-desktop
- Status: done
- Original plan file: ~/.claude/plans/i-m-runnig-into-a-glistening-emerson.md


## Context

User hit: `segment fetch failed (no response)` on
`http://storetvx.xyz:8080/live/brhm1211/br2210dd00/115862.m3u8` (US: SportsNet East HD).

**Root cause (verified with curl/nc from this Mac): provider-side outage, not an app bug.**

- The manifest loads fine (200), but it's a stub playlist whose only "segment" lives on a
  *different* host:
  ```
  #EXTINF:15.0,
  http://kaynaklive.xyz:8080/aampB53UXAtT/JW4E6EZv8D4k/359582
  #EXT-X-ENDLIST
  ```
- `kaynaklive.xyz` (31.59.185.46, same answer from 1.1.1.1 and 8.8.8.8) **refuses TCP on
  8080, 80, 443, 25461** — immediate connection refused. hls.js gets status 0 →
  `fragLoadError` with no HTTP code → the vague "no response" message.
- Other channels on this account (e.g. 18343, 66560) route to the same `kaynaklive.xyz:8080`,
  so it's the provider's whole stream backend, not this one channel.
- The `.ts` output of the same channel on `storetvx.xyz` returns 200 but **0 bytes** in 15s
  (the panel proxies to the same dead backend), so switching container to TS won't help.
- Account is fine: `status: Active`, not expired. Note `max_connections: 1` (and
  `active_cons` showed 1 while the app was open) — worth mentioning, but not the cause here:
  a connection cap produces an HTTP 403/empty response, not a TCP refusal on another host.

Nothing in the app can make an unreachable server reachable. What the app *can* fix is the
message: it currently says the segments are "blocked", offers useless CORS-proxy buttons
(CORS is already disabled via `webSecurity:false`, and those proxies would send the user's
credentials to a third party), and gives no hint that the provider is down.

## Change

Scope: `renderer/index.html`, plus a one-line option in `main.js` `netFetch`.

0. **Per-call probe timeout** — `netFetch` (`main.js:816–846`) already bounds `statusOnly`
   requests with an AbortController at `STATUS_ONLY_TIMEOUT_MS` (10s), so a silently-dropping
   host can't hang the probe for Chromium's 30–60s socket timeout. 10s is still too slow to leave
   the user watching a spinner, so accept `opts.timeoutMs` (default stays 10s) and have the probe
   pass `4000`. A probe timeout counts as "unreachable" (`ERR_CONNECTION_TIMED_OUT`-equivalent).

1. **Probe the segment on a no-response fragment failure** — one helper,
   `Player._diagnoseAndFail(info)`, called from `Player.load()`'s `Hls.Events.ERROR` handler
   (`renderer/index.html:2383`) and `_forceHls()` (`renderer/index.html:2256`) instead of
   `_fail(this._classify(info))`:
   - Only probes when `details` is `fragLoadError`, there's no `httpCode`, and
     `window.xtream.fetch` exists (browser build skips straight to `_fail`).
   - `window.xtream.fetch(info.url, { statusOnly: true, timeoutMs: 4000 })`; on rejection,
     pull the code with `/net::ERR_[A-Z_]+/` from the message (IPC prefixes "Error invoking
     remote method…"); a "Timed out" rejection maps to `ERR_CONNECTION_TIMED_OUT`. Store as
     `info.netError`. A probe that *succeeds* leaves `netError` unset (transient failure →
     existing message).
   - Guard with the existing `_loadToken` pattern so a channel switch mid-probe discards the
     result; wrap the whole thing so any probe exception still ends in `_fail(...)`.
   - Also capture variant context from the hls.js event while it's in hand:
     `data.frag.level` → `this.hls.levels[level]` → `bitrate` / `height` when present
     (this provider's stub is a single media playlist, so it'll often be absent — then omit).

2. **URL-safe host comparison** — add a tiny `safeHost(u)` helper
   (`try { return new URL(u, location.href).host } catch { return '' }`) and use it everywhere
   `_classify()` needs a host, so a malformed/relative URL from hls.js can't throw inside the
   error handler.

3. **New branch in `_classify()`** (`renderer/index.html:2479` block), checked before the
   generic `no response` line, when there's no `httpCode` and either `info.netError` is set or
   `safeHost(info.url)` is non-empty and differs from `safeHost(this.currentSrc)`. Sets
   `info.unreachable = true` and returns roughly:
   > stream server unreachable — the playlist from storetvx.xyz:8080 loaded, but the video
   > server it points to (kaynaklive.xyz:8080) refused the connection
   > (net::ERR_CONNECTION_REFUSED). This is a provider-side outage or an IP block, not your
   > account or this app. Try again later, try from another network/VPN, or contact your
   > provider.

   Verb per code: REFUSED → "refused the connection", TIMED_OUT → "didn't respond",
   NAME_NOT_RESOLVED → "couldn't be found (DNS)", RESET/ADDRESS_UNREACHABLE/other → "couldn't be
   reached"; no code → same sentence without the parenthetical.

4. **Explicit flag instead of copy-matching for CORS buttons** — change `_fail(msg)` to
   `_fail(msg, meta = {})` and `onError(msg, meta)`; the `State.player.onError` wiring
   (`renderer/index.html:~5757`) passes `meta` to `showStreamError(msg, meta)`. In
   `showStreamError()` (`renderer/index.html:3764`), `looksLikeCors` becomes
   `!meta.hideCorsProxies && (<existing text checks>)`. `_diagnoseAndFail` sets
   `hideCorsProxies: true` when `info.unreachable`. Other call sites pass nothing → unchanged
   behaviour.

5. **Richer copied diagnostics** — `meta` also carries `segmentUrl` and the variant string
   (e.g. `level 0, 1280x720, 3.2 Mbps`). `showStreamError()` stashes `meta` on
   `State.lastStreamErrorMeta` (cleared in `hideStreamError()`); the `#stream-error-copy-msg`
   handler (`renderer/index.html:5770`) appends `Segment URL:` (only when it differs from the
   stream URL), `Variant:` and `Network error:` lines when present.

Not doing: auto-fallback to `.ts` or to the ffmpeg path — verified both hit the same dead
backend, so it would add code without fixing this case.

## Verification

1. `npm start`, play 115862 on the same server. Expect, within ~4s of hls.js giving up, the
   "stream server unreachable … kaynaklive.xyz:8080 … refused the connection
   (net::ERR_CONNECTION_REFUSED)" message, with Retry / Open Settings but **no** CORS-proxy
   buttons. Console shows the probe ran once.
2. Copy error details → blob contains `Segment URL: http://kaynaklive.xyz:8080/...` and
   `Network error: net::ERR_CONNECTION_REFUSED` (and `Variant:` only if hls.js exposed one).
3. Timeout path: in DevTools, point a test at a blackhole address (e.g. `http://10.255.255.1/x`)
   via `window.xtream.fetch(url, {statusOnly:true, timeoutMs:4000})` → rejects in ~4s.
4. Regression: a working channel plays unaffected; a 403 segment failure still shows the old
   403 text *with* its buttons; switching channels quickly during a failure leaves no stale
   overlay (`_loadToken` guard).
5. Re-check the backend before closing out: if `nc -z kaynaklive.xyz 8080` now succeeds, the
   channel should simply play — confirming the diagnosis.

After approval: save a copy as `docs/plans/2026-09-13-clearer-unreachable-segment-error.md`
and `~/.claude/plans/2026-09-13-clearer-unreachable-segment-error.md` per global instructions.

## Follow-up (same day): fail fast + catch it at bulk import

Symptom reported after the first change: the channel "continues buffering". Measured with
hls.js 1.6.19 in Electron: each fatal round takes ~38s (6 fragment retries, 1→8s backoff) and
`Player.load()` restarts it twice → ~2 min of spinner before the overlay.

- **Early probe** — `Player._earlyProbe()` runs `_diagnoseAndFail(..., { early: true })` on the
  first non-fatal no-response `fragLoadError`; if the error is in `UNREACHABLE_NET_ERRORS`
  (refused / DNS / address unreachable / timeout) hls.js is destroyed and the overlay shows.
  Measured: 0.8–1.9s instead of ~2 min.
- **Retry fix** — `load()` ignored a same-URL call, so the overlay's Retry did nothing after a
  failure. `_fail()` now sets `_failed`, and `load()` reloads when it's set.
- **Bulk import** — `checkStreams()` follows each 2xx playlist to its first segment via
  `probeFirstSegment()` (one master→variant hop, 64KB cap) and fails the row with
  "✗ Stream server unreachable — playlists load but <host> won't connect" when every playlist
  that loaded points at an unreachable server.
- **main.js** — `netFetch` `maxBytes` option backed by `netFetchCapped()` (`net.request`),
  because `session.fetch` leaves `Response.url` empty (breaks relative segment paths after a
  redirect) and hangs with `redirect: 'manual'`.
- `unreachableMessage()` says "no internet connection" for `ERR_INTERNET_DISCONNECTED` /
  `ERR_NETWORK_CHANGED` rather than blaming the provider.

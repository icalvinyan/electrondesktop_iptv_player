// mpv_addon.cc
//
// N-API wrapper that embeds libmpv directly in-process for true in-window VOD
// playback (no external mpv window, no browser-side demuxing/transcoding).
//
// Why the *software* render API (MPV_RENDER_API_TYPE_SW) rather than OpenGL/
// Metal:
//   Sharing a GPU context between libmpv and Chromium's compositor is the
//   normal way to embed mpv with zero-copy performance, but it requires
//   per-platform interop code (NSOpenGLContext/IOSurface on macOS, ANGLE/EGL
//   on Windows/Linux) plus changes to how Electron creates its GPU context —
//   effectively a separate native project per OS. The software API instead
//   asks libmpv to decode + scale + render each frame into a plain RGBA
//   buffer we own, which we hand to the renderer over IPC to paint onto a
//   <canvas>. It costs a CPU copy and blit per frame (fine at 1080p on any
//   machine from the last decade) in exchange for being trivially portable
//   and dramatically simpler/more robust to maintain. If GPU-path embedding
//   is wanted later, this file is the place to add an alternate render path.
//
// Threading model:
//   libmpv calls our "wakeup" and "render update" callbacks from its own
//   internal threads. We can't touch a JS value off the JS thread, so both
//   callbacks just signal a Napi::ThreadSafeFunction, which marshals the
//   actual work (draining the mpv event queue / rendering + delivering a
//   frame buffer) back onto the Node event loop.

#include <napi.h>
#include <mpv/client.h>
#include <mpv/render.h>

#include <atomic>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <vector>

namespace {

// Converts an mpv_node (the generic value type mpv uses for property values
// and command replies) into a JS value. Used for property-change events and
// command results so the renderer gets normal JS objects/arrays/numbers.
Napi::Value MpvNodeToJs(Napi::Env env, mpv_node* node) {
  if (!node) return env.Null();
  switch (node->format) {
    case MPV_FORMAT_NONE:
      return env.Null();
    case MPV_FORMAT_STRING:
      return Napi::String::New(env, node->u.string ? node->u.string : "");
    case MPV_FORMAT_FLAG:
      return Napi::Boolean::New(env, node->u.flag != 0);
    case MPV_FORMAT_INT64:
      return Napi::Number::New(env, static_cast<double>(node->u.int64));
    case MPV_FORMAT_DOUBLE:
      return Napi::Number::New(env, node->u.double_);
    case MPV_FORMAT_NODE_ARRAY: {
      auto arr = Napi::Array::New(env, node->u.list->num);
      for (int i = 0; i < node->u.list->num; i++) {
        arr.Set(static_cast<uint32_t>(i), MpvNodeToJs(env, &node->u.list->values[i]));
      }
      return arr;
    }
    case MPV_FORMAT_NODE_MAP: {
      auto obj = Napi::Object::New(env);
      for (int i = 0; i < node->u.list->num; i++) {
        obj.Set(node->u.list->keys[i], MpvNodeToJs(env, &node->u.list->values[i]));
      }
      return obj;
    }
    case MPV_FORMAT_BYTE_ARRAY:
      return Napi::Buffer<char>::Copy(env,
          static_cast<char*>(node->u.ba->data), node->u.ba->size);
    default:
      return env.Undefined();
  }
}

// Converts a JS value into a freshly-allocated mpv_node tree (for sending
// command arguments / property values into mpv). Caller owns the returned
// node and must free it with FreeMpvNode.
void JsToMpvNode(Napi::Env env, Napi::Value val, mpv_node* out,
                 std::vector<std::unique_ptr<std::string>>& stringPool) {
  if (val.IsString()) {
    auto s = std::make_unique<std::string>(val.As<Napi::String>().Utf8Value());
    out->format = MPV_FORMAT_STRING;
    out->u.string = const_cast<char*>(s->c_str());
    stringPool.push_back(std::move(s));
  } else if (val.IsBoolean()) {
    out->format = MPV_FORMAT_FLAG;
    out->u.flag = val.As<Napi::Boolean>().Value() ? 1 : 0;
  } else if (val.IsNumber()) {
    double d = val.As<Napi::Number>().DoubleValue();
    if (d == static_cast<int64_t>(d)) {
      out->format = MPV_FORMAT_INT64;
      out->u.int64 = static_cast<int64_t>(d);
    } else {
      out->format = MPV_FORMAT_DOUBLE;
      out->u.double_ = d;
    }
  } else if (val.IsArray()) {
    auto jsArr = val.As<Napi::Array>();
    uint32_t n = jsArr.Length();
    auto* list = new mpv_node_list();
    list->num = static_cast<int>(n);
    list->values = new mpv_node[n];
    list->keys = nullptr;
    for (uint32_t i = 0; i < n; i++) {
      JsToMpvNode(env, jsArr.Get(i), &list->values[i], stringPool);
    }
    out->format = MPV_FORMAT_NODE_ARRAY;
    out->u.list = list;
  } else {
    // Fall back to string via JSON-ish coercion for anything else (objects
    // aren't expected as mpv command args in practice).
    auto s = std::make_unique<std::string>(val.ToString().Utf8Value());
    out->format = MPV_FORMAT_STRING;
    out->u.string = const_cast<char*>(s->c_str());
    stringPool.push_back(std::move(s));
  }
}

void FreeMpvNodeTree(mpv_node* node) {
  if (!node) return;
  if ((node->format == MPV_FORMAT_NODE_ARRAY || node->format == MPV_FORMAT_NODE_MAP) && node->u.list) {
    for (int i = 0; i < node->u.list->num; i++) FreeMpvNodeTree(&node->u.list->values[i]);
    delete[] node->u.list->values;
    delete node->u.list;
  }
}

}  // namespace

// ---------------------------------------------------------------------------
// MpvPlayer — one instance per playback session (we tear down and recreate
// per VOD title rather than reusing, which keeps state simple and matches
// how the renderer already manages player lifecycle for Live TV/VOD).
// ---------------------------------------------------------------------------
class MpvPlayer : public Napi::ObjectWrap<MpvPlayer> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "MpvPlayer", {
      InstanceMethod("loadFile", &MpvPlayer::LoadFile),
      InstanceMethod("command", &MpvPlayer::Command),
      InstanceMethod("setProperty", &MpvPlayer::SetProperty),
      InstanceMethod("getProperty", &MpvPlayer::GetProperty),
      InstanceMethod("observeProperty", &MpvPlayer::ObserveProperty),
      InstanceMethod("setSurfaceSize", &MpvPlayer::SetSurfaceSize),
      InstanceMethod("destroy", &MpvPlayer::Destroy),
    });
    exports.Set("MpvPlayer", func);
    return exports;
  }

  MpvPlayer(const Napi::CallbackInfo& info) : Napi::ObjectWrap<MpvPlayer>(info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsFunction()) {
      Napi::TypeError::New(env, "MpvPlayer(onEvent) requires an event callback").ThrowAsJavaScriptException();
      return;
    }

    // onEvent(payload) — payload is one of:
    //   { type:'event', event:'...', ...props }
    //   { type:'property-change', name, value }
    //   { type:'frame', width, height, stride, buffer:<Buffer RGBA> }
    //   { type:'log', level, prefix, text }
    eventTsfn_ = Napi::ThreadSafeFunction::New(
        env, info[0].As<Napi::Function>(), "MpvPlayerEvents", 0, 1,
        [this](Napi::Env) { /* finalizer — nothing to clean up here */ });

    mpv_ = mpv_create();
    if (!mpv_) {
      Napi::Error::New(env, "mpv_create failed").ThrowAsJavaScriptException();
      return;
    }

    // We render frames ourselves — tell mpv not to open its own window.
    mpv_set_option_string(mpv_, "vo", "libmpv");
    mpv_set_option_string(mpv_, "vid", "auto");
    mpv_set_option_string(mpv_, "aid", "auto");
    mpv_set_option_string(mpv_, "sid", "auto");
    mpv_set_option_string(mpv_, "sub-auto", "fuzzy");
    mpv_set_option_string(mpv_, "keep-open", "yes");
    mpv_set_option_string(mpv_, "hwdec", "auto-safe");
    // Torrent/debrid sources are remote HTTP(S) — these mirror the tuning
    // already used for the ffmpeg pipeline (see startLocalTranscodeStream in
    // main.js) so first-frame latency on big remote .mkv files stays low.
    mpv_set_option_string(mpv_, "user-agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
    mpv_set_option_string(mpv_, "demuxer-lavf-o", "reconnect=1,reconnect_streamed=1,reconnect_delay_max=5");
    mpv_set_option_string(mpv_, "cache", "yes");
    mpv_set_option_string(mpv_, "demuxer-max-bytes", "150MiB");
    mpv_set_option_string(mpv_, "demuxer-max-back-bytes", "50MiB");

    mpv_request_log_messages(mpv_, "warn");

    int rc = mpv_initialize(mpv_);
    if (rc < 0) {
      Napi::Error::New(env, std::string("mpv_initialize failed: ") + mpv_error_string(rc))
          .ThrowAsJavaScriptException();
      mpv_terminate_destroy(mpv_);
      mpv_ = nullptr;
      return;
    }

    // Software render context — see file header for why SW over GL/Metal.
    mpv_render_param initParams[] = {
      { MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(MPV_RENDER_API_TYPE_SW) },
      { MPV_RENDER_PARAM_INVALID, nullptr },
    };
    rc = mpv_render_context_create(&renderCtx_, mpv_, initParams);
    if (rc < 0) {
      Napi::Error::New(env, std::string("mpv_render_context_create failed: ") + mpv_error_string(rc))
          .ThrowAsJavaScriptException();
      return;
    }

    mpv_set_wakeup_callback(mpv_, &MpvPlayer::OnWakeupThunk, this);
    mpv_render_context_set_update_callback(renderCtx_, &MpvPlayer::OnRenderUpdateThunk, this);

    alive_ = true;

    // PRIME THE PUMP: mpv_initialize()/mpv_render_context_create() above can
    // already enqueue events (log messages, core lifecycle events, etc.)
    // *before* mpv_set_wakeup_callback() is registered just a few lines up.
    // libmpv only guarantees the wakeup callback fires for events that arrive
    // AFTER registration — anything queued during the registration race can
    // sit in the queue with nobody ever told to drain it. Because DrainEvents
    // always fully drains (loops until MPV_EVENT_NONE), missing just the
    // *first* wakeup is enough to also miss the "queue went from empty to
    // non-empty" edge that would have triggered the next one — i.e. a single
    // missed kickoff can silently stall the entire property-change/event
    // pipeline for the rest of the session while frame delivery (a fully
    // separate OnRenderUpdate/renderPending_ path) keeps working fine. This
    // exactly matches the symptom captured in mpv2-debug logs: healthy frame
    // throughput with ZERO property-change/event forwarding, ever. Force one
    // explicit drain here so any pre-registration events get flushed and the
    // edge-triggered wakeup machinery starts from a known-clean state.
    OnWakeup();
  }

  ~MpvPlayer() override { TeardownInternal(); }

 private:
  // ---- lifecycle -----------------------------------------------------------

  void TeardownInternal() {
    bool wasAlive = alive_.exchange(false);
    if (!wasAlive) return;
    if (renderCtx_) {
      mpv_render_context_set_update_callback(renderCtx_, nullptr, nullptr);
      mpv_render_context_free(renderCtx_);
      renderCtx_ = nullptr;
    }
    if (mpv_) {
      mpv_set_wakeup_callback(mpv_, nullptr, nullptr);
      mpv_terminate_destroy(mpv_);
      mpv_ = nullptr;
    }
    eventTsfn_.Release();
  }

  Napi::Value Destroy(const Napi::CallbackInfo& info) {
    TeardownInternal();
    return info.Env().Undefined();
  }

  // ---- playback control -----------------------------------------------------

  Napi::Value LoadFile(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!alive_ || info.Length() < 1 || !info[0].IsString()) return env.Undefined();
    std::string url = info[0].As<Napi::String>().Utf8Value();
    const char* cmd[] = { "loadfile", url.c_str(), "replace", nullptr };
    mpv_command_async(mpv_, 0, cmd);
    return env.Undefined();
  }

  // command(["seek", "30", "relative"]) -> Promise<result>
  Napi::Value Command(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);
    if (!alive_ || info.Length() < 1 || !info[0].IsArray()) {
      deferred.Reject(Napi::String::New(env, "mpv not alive or bad args"));
      return deferred.Promise();
    }
    auto jsArr = info[0].As<Napi::Array>();
    uint32_t n = jsArr.Length();

    // mpv_command_node wants an mpv_node of format NODE_ARRAY of strings/etc.
    std::vector<std::unique_ptr<std::string>> pool;
    auto* list = new mpv_node_list();
    list->num = static_cast<int>(n);
    list->values = new mpv_node[n];
    list->keys = nullptr;
    for (uint32_t i = 0; i < n; i++) JsToMpvNode(env, jsArr.Get(i), &list->values[i], pool);
    mpv_node args{};
    args.format = MPV_FORMAT_NODE_ARRAY;
    args.u.list = list;

    uint64_t id = nextCmdId_.fetch_add(1);
    Napi::Promise promise = deferred.Promise();  // copy out before moving into the map
    {
      std::lock_guard<std::mutex> lk(pendingMutex_);
      pending_.emplace(id, std::move(deferred));
    }

    mpv_node result{};
    int rc = mpv_command_node(mpv_, &args, &result);
    // mpv_command_node is synchronous; resolve immediately rather than waiting
    // for an async reply event (simpler, and command() calls here are small —
    // seek/pause/track-switch — so blocking the addon's call briefly is fine).
    {
      std::lock_guard<std::mutex> lk(pendingMutex_);
      auto it = pending_.find(id);
      if (it != pending_.end()) {
        if (rc < 0) {
          it->second.Reject(Napi::String::New(env, mpv_error_string(rc)));
        } else {
          it->second.Resolve(MpvNodeToJs(env, &result));
        }
        pending_.erase(it);
      }
    }
    mpv_free_node_contents(&result);
    delete[] list->values;
    delete list;
    return promise;
  }

  Napi::Value SetProperty(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!alive_ || info.Length() < 2 || !info[0].IsString()) return env.Undefined();
    std::string name = info[0].As<Napi::String>().Utf8Value();
    Napi::Value v = info[1];
    int rc = 0;
    if (v.IsBoolean()) {
      int flag = v.As<Napi::Boolean>().Value() ? 1 : 0;
      rc = mpv_set_property(mpv_, name.c_str(), MPV_FORMAT_FLAG, &flag);
    } else {
      // Route everything else (numbers AND strings) through
      // mpv_set_property_string, which hands mpv the value as text and lets
      // mpv's own option/property parser coerce it to whatever underlying
      // type that property actually uses (INT64, DOUBLE, track-id-or-"no",
      // etc). This sidesteps guessing the wire format from the JS value's
      // shape — a previous "whole numbers → INT64, fractional → DOUBLE"
      // heuristic correctly fixed `aid`/`sid` (INT64 properties) but broke
      // `volume`/`speed` whenever the UI happened to send a whole-number
      // value (e.g. volume=80, speed=1): mpv declares those as DOUBLE, so
      // the INT64-formatted set returned MPV_ERROR_PROPERTY_FORMAT and
      // silently no-opped — exactly the "volume slider does nothing" symptom.
      // mpv_set_property_string has handled both cases correctly since it
      // defers to the property's real declared type instead of ours.
      std::string s;
      if (v.IsNumber()) {
        double d = v.As<Napi::Number>().DoubleValue();
        if (d == static_cast<int64_t>(d)) {
          s = std::to_string(static_cast<int64_t>(d));
        } else {
          // Enough precision to round-trip mpv's double properties (speed,
          // volume fractions, time-pos seeks, etc.) without truncation.
          char buf[64];
          snprintf(buf, sizeof(buf), "%.6f", d);
          s = buf;
        }
      } else {
        s = v.ToString().Utf8Value();
      }
      rc = mpv_set_property_string(mpv_, name.c_str(), s.c_str());
    }
    if (rc < 0) {
      // Surface failures (wrong property name, rejected value, etc.) instead
      // of letting them vanish — the JS side logs negative return codes.
      return Napi::Number::New(env, rc);
    }
    return env.Undefined();
  }

  Napi::Value GetProperty(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!alive_ || info.Length() < 1 || !info[0].IsString()) return env.Null();
    std::string name = info[0].As<Napi::String>().Utf8Value();
    mpv_node node{};
    if (mpv_get_property(mpv_, name.c_str(), MPV_FORMAT_NODE, &node) < 0) return env.Null();
    Napi::Value result = MpvNodeToJs(env, &node);
    mpv_free_node_contents(&node);
    return result;
  }

  Napi::Value ObserveProperty(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!alive_ || info.Length() < 1 || !info[0].IsString()) return env.Undefined();
    std::string name = info[0].As<Napi::String>().Utf8Value();
    // Return the mpv error code to JS so a silent registration failure is
    // visible (previously discarded — see mpv2-debug investigation: we were
    // seeing zero property-change events reach the renderer and needed to
    // rule out "the observe call itself failed").
    int rc = mpv_observe_property(mpv_, observeId_++, name.c_str(), MPV_FORMAT_NODE);
    return Napi::Number::New(env, rc);
  }

  // Tells the SW renderer what resolution to render at — call this with the
  // <canvas> backing-store size (devicePixelRatio-aware) so we don't waste
  // CPU upscaling/downscaling versus what's actually displayed.
  Napi::Value SetSurfaceSize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) return env.Undefined();
    int w = info[0].As<Napi::Number>().Int32Value();
    int h = info[1].As<Napi::Number>().Int32Value();
    if (w < 2) w = 2;
    if (h < 2) h = 2;
    std::lock_guard<std::mutex> lk(frameBufMutex_);
    surfaceW_ = w;
    surfaceH_ = h;
    return env.Undefined();
  }

  // ---- libmpv callbacks (fire on libmpv's internal threads) ----------------

  static void OnWakeupThunk(void* ctx) { static_cast<MpvPlayer*>(ctx)->OnWakeup(); }
  static void OnRenderUpdateThunk(void* ctx) { static_cast<MpvPlayer*>(ctx)->OnRenderUpdate(); }

  void OnWakeup() {
    if (!alive_) return;
    // Coalesce: many wakeups can fire before the JS thread drains the queue.
    if (wakeupPending_.exchange(true)) return;
    napi_status st = eventTsfn_.NonBlockingCall(this, [](Napi::Env env, Napi::Function jsCb, MpvPlayer* self) {
      self->wakeupPending_.store(false);
      self->DrainEvents(env, jsCb);
    });
    if (st != napi_ok) {
      // CRITICAL: wakeupPending_ is only ever reset to false *inside* the
      // lambda above. If NonBlockingCall itself fails (queue full / tsfn
      // closing / env shutting down), that lambda never runs and the flag
      // is stuck at `true` forever — every subsequent OnWakeup() call then
      // short-circuits at the exchange() above and DrainEvents() is never
      // invoked again. This exactly matches the symptom we captured: frames
      // kept flowing (separate renderPending_/OnRenderUpdate path, unaffected)
      // but property-change events (pause/time-pos/duration/...) silently
      // stopped arriving after the initial burst. Reset here so the next
      // wakeup can retry, and surface a counter so we can see it happen.
      failedWakeupCalls_.fetch_add(1);
      wakeupPending_.store(false);
    }
  }

  void OnRenderUpdate() {
    if (!alive_) return;
    uint64_t flags = renderCtx_ ? mpv_render_context_update(renderCtx_) : 0;
    if (!(flags & MPV_RENDER_UPDATE_FRAME)) return;
    if (renderPending_.exchange(true)) return;
    eventTsfn_.NonBlockingCall(this, [](Napi::Env env, Napi::Function jsCb, MpvPlayer* self) {
      self->renderPending_.store(false);
      self->RenderFrame(env, jsCb);
    });
  }

  // ---- work done back on the JS thread --------------------------------------

  void DrainEvents(Napi::Env env, Napi::Function jsCb) {
    if (!alive_ || !mpv_) return;
    Napi::HandleScope scope(env);
    uint64_t pass = drainPasses_.fetch_add(1) + 1;
    int drainedThisPass = 0;
    while (true) {
      mpv_event* ev = mpv_wait_event(mpv_, 0);
      if (!ev || ev->event_id == MPV_EVENT_NONE) break;
      drainedThisPass++;

      // Wrap each event's JS dispatch in try/catch: a single bad value
      // (e.g. an exception thrown while converting a NODE — track-list is a
      // nested array-of-maps and the likeliest culprit) must not abort the
      // whole drain loop and strand the remaining queued mpv events
      // un-dequeued. Previously an uncaught throw here would propagate out
      // of DrainEvents -> the NonBlockingCall lambda, silently killing that
      // drain pass (and possibly the JS callback machinery) — which would
      // perfectly explain "frames keep flowing but property-changes stop
      // arriving after the initial burst".
      try {
        if (ev->event_id == MPV_EVENT_LOG_MESSAGE) {
          auto* msg = static_cast<mpv_event_log_message*>(ev->data);
          Napi::Object payload = Napi::Object::New(env);
          payload.Set("type", "log");
          payload.Set("level", msg->level ? msg->level : "");
          payload.Set("prefix", msg->prefix ? msg->prefix : "");
          payload.Set("text", msg->text ? msg->text : "");
          jsCb.Call({ payload });
          continue;
        }

        if (ev->event_id == MPV_EVENT_PROPERTY_CHANGE) {
          auto* prop = static_cast<mpv_event_property*>(ev->data);
          propertyChangeEvents_.fetch_add(1);
          Napi::Object payload = Napi::Object::New(env);
          payload.Set("type", "property-change");
          payload.Set("name", prop->name ? prop->name : "");
          if (prop->format == MPV_FORMAT_NODE && prop->data) {
            payload.Set("value", MpvNodeToJs(env, static_cast<mpv_node*>(prop->data)));
          } else {
            payload.Set("value", env.Null());
          }
          jsCb.Call({ payload });
          continue;
        }

        otherMpvEvents_.fetch_add(1);
        Napi::Object payload = Napi::Object::New(env);
        payload.Set("type", "event");
        payload.Set("event", mpv_event_name(ev->event_id));
        if (ev->event_id == MPV_EVENT_END_FILE && ev->data) {
          auto* ef = static_cast<mpv_event_end_file*>(ev->data);
          payload.Set("reason", static_cast<double>(ef->reason));
          payload.Set("error", ef->error);
        }
        jsCb.Call({ payload });
      } catch (const std::exception& e) {
        drainExceptions_.fetch_add(1);
        try {
          Napi::Object payload = Napi::Object::New(env);
          payload.Set("type", "event-stats");
          payload.Set("drainException", e.what());
          payload.Set("eventId", static_cast<double>(ev->event_id));
          payload.Set("eventName", mpv_event_name(ev->event_id));
          jsCb.Call({ payload });
        } catch (...) { /* give up reporting — do not let this kill the loop */ }
      } catch (...) {
        drainExceptions_.fetch_add(1);
      }

      if (ev->event_id == MPV_EVENT_SHUTDOWN) break;
    }

    // Periodic heartbeat (every 50th drain pass that actually had events, and
    // always on the very first pass) so the renderer can confirm DrainEvents
    // is still being invoked and see the running event-type breakdown — this
    // is the direct evidence needed to confirm/rule out a stalled pipeline.
    if (drainedThisPass > 0 && (pass == 1 || pass % 50 == 0)) {
      try {
        Napi::Object payload = Napi::Object::New(env);
        payload.Set("type", "event-stats");
        payload.Set("drainPasses", static_cast<double>(drainPasses_.load()));
        payload.Set("propertyChangeEvents", static_cast<double>(propertyChangeEvents_.load()));
        payload.Set("otherMpvEvents", static_cast<double>(otherMpvEvents_.load()));
        payload.Set("drainExceptions", static_cast<double>(drainExceptions_.load()));
        payload.Set("failedWakeupCalls", static_cast<double>(failedWakeupCalls_.load()));
        jsCb.Call({ payload });
      } catch (...) {}
    }
  }

  // ---------------------------------------------------------------------
  // Zero-copy frame delivery
  //
  // The previous version rendered into a reused std::vector<uint8_t>
  // (frameBuf_) and then Napi::Buffer<uint8_t>::Copy()'d it into a Node
  // Buffer — copy #1. That Buffer then crossed the main->renderer process
  // boundary via webContents.send(), which structured-clones (= copies)
  // the whole payload again — copy #2. At ~28fps * ~8MB/frame that's
  // ~200MB/s of churn, enough to balloon V8's heap until macOS SIGKILLs
  // the process (see mpv2-debug log analysis).
  //
  // Fix: allocate each frame's backing store as a *V8-owned* Napi::ArrayBuffer
  // (Napi::ArrayBuffer::New(env, byteLength) — NOT the externally-backed
  // overload, and NOT a pooled Node Buffer). This matters for a subtle but
  // critical reason discovered the hard way: ArrayBuffers wrapping
  // externally-malloc'd memory are *not detachable*, and MessagePort
  // transfer requires a detachable buffer — every attempt to transfer one
  // threw "could not be cloned"/DataCloneError synchronously inside the
  // native callback, which Node logs as "Uncaught Node-API callback
  // exception" (flooding the log) and which compounded into the crash. A
  // V8-managed ArrayBuffer *is* detachable, so transfer actually works —
  // and we still get true zero-copy delivery because mpv renders directly
  // into that buffer's backing memory (ab.Data()); there is no separate
  // native allocation to copy from.
  // ---------------------------------------------------------------------
  void RenderFrame(Napi::Env env, Napi::Function jsCb) {
    if (!alive_ || !renderCtx_) return;
    Napi::HandleScope scope(env);

    int w, h;
    {
      std::lock_guard<std::mutex> lk(frameBufMutex_);
      w = surfaceW_;
      h = surfaceH_;
    }

    int stride = w * 4;
    size_t byteLen = static_cast<size_t>(stride) * h;

    Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(env, byteLen);
    void* pixels = ab.Data();

    int swSize[2] = { w, h };
    mpv_render_param renderParams[] = {
      { MPV_RENDER_PARAM_SW_SIZE, swSize },
      { MPV_RENDER_PARAM_SW_FORMAT, const_cast<char*>("rgba") },
      { MPV_RENDER_PARAM_SW_STRIDE, &stride },
      { MPV_RENDER_PARAM_SW_POINTER, pixels },
      { MPV_RENDER_PARAM_INVALID, nullptr },
    };
    int rc = mpv_render_context_render(renderCtx_, renderParams);
    if (rc < 0) return;
    mpv_render_context_report_swap(renderCtx_);

    Napi::Object payload = Napi::Object::New(env);
    payload.Set("type", "frame");
    payload.Set("width", w);
    payload.Set("height", h);
    payload.Set("stride", stride);
    payload.Set("buffer", ab);
    jsCb.Call({ payload });
  }

  // ---- members --------------------------------------------------------------

  mpv_handle* mpv_ = nullptr;
  mpv_render_context* renderCtx_ = nullptr;
  Napi::ThreadSafeFunction eventTsfn_;
  std::atomic<bool> alive_{false};
  std::atomic<bool> wakeupPending_{false};
  std::atomic<bool> renderPending_{false};
  // mpv2-debug instrumentation counters (surfaced to JS via periodic
  // 'event-stats' payloads from DrainEvents) — see OnWakeup()/DrainEvents().
  std::atomic<uint64_t> failedWakeupCalls_{0};
  std::atomic<uint64_t> drainPasses_{0};
  std::atomic<uint64_t> propertyChangeEvents_{0};
  std::atomic<uint64_t> otherMpvEvents_{0};
  std::atomic<uint64_t> drainExceptions_{0};
  std::atomic<uint64_t> nextCmdId_{1};
  uint64_t observeId_ = 1;

  std::mutex frameBufMutex_;
  int surfaceW_ = 1280;
  int surfaceH_ = 720;

  std::mutex pendingMutex_;
  std::map<uint64_t, Napi::Promise::Deferred> pending_;
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return MpvPlayer::Init(env, exports);
}

NODE_API_MODULE(mpv_addon, InitAll)

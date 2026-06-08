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
    {
      std::lock_guard<std::mutex> lk(frameBufMutex_);
      frameBuf_.clear();
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
    {
      std::lock_guard<std::mutex> lk(pendingMutex_);
      pending_.emplace(id, std::move(deferred));
    }
    Napi::Promise promise = pending_[id].Promise();  // copy out before async reply may erase

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
    if (v.IsBoolean()) {
      int flag = v.As<Napi::Boolean>().Value() ? 1 : 0;
      mpv_set_property(mpv_, name.c_str(), MPV_FORMAT_FLAG, &flag);
    } else if (v.IsNumber()) {
      double d = v.As<Napi::Number>().DoubleValue();
      mpv_set_property(mpv_, name.c_str(), MPV_FORMAT_DOUBLE, &d);
    } else {
      std::string s = v.ToString().Utf8Value();
      const char* cs = s.c_str();
      mpv_set_property(mpv_, name.c_str(), MPV_FORMAT_STRING, &cs);
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
    mpv_observe_property(mpv_, observeId_++, name.c_str(), MPV_FORMAT_NODE);
    return env.Undefined();
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
    eventTsfn_.NonBlockingCall(this, [](Napi::Env env, Napi::Function jsCb, MpvPlayer* self) {
      self->wakeupPending_.store(false);
      self->DrainEvents(env, jsCb);
    });
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
    while (true) {
      mpv_event* ev = mpv_wait_event(mpv_, 0);
      if (!ev || ev->event_id == MPV_EVENT_NONE) break;

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

      Napi::Object payload = Napi::Object::New(env);
      payload.Set("type", "event");
      payload.Set("event", mpv_event_name(ev->event_id));
      if (ev->event_id == MPV_EVENT_END_FILE && ev->data) {
        auto* ef = static_cast<mpv_event_end_file*>(ev->data);
        payload.Set("reason", static_cast<double>(ef->reason));
        payload.Set("error", ef->error);
      }
      jsCb.Call({ payload });

      if (ev->event_id == MPV_EVENT_SHUTDOWN) break;
    }
  }

  void RenderFrame(Napi::Env env, Napi::Function jsCb) {
    if (!alive_ || !renderCtx_) return;
    Napi::HandleScope scope(env);

    int w, h;
    {
      std::lock_guard<std::mutex> lk(frameBufMutex_);
      w = surfaceW_;
      h = surfaceH_;
      size_t needed = static_cast<size_t>(w) * h * 4;
      if (frameBuf_.size() != needed) frameBuf_.assign(needed, 0);
    }

    int stride = w * 4;
    void* pixels = frameBuf_.data();
    mpv_render_param renderParams[] = {
      { MPV_RENDER_PARAM_SW_SIZE, &(int[]){ w, h } },
      { MPV_RENDER_PARAM_SW_FORMAT, const_cast<char*>("rgba") },
      { MPV_RENDER_PARAM_SW_STRIDE, &stride },
      { MPV_RENDER_PARAM_SW_POINTER, pixels },
      { MPV_RENDER_PARAM_INVALID, nullptr },
    };
    int rc = mpv_render_context_render(renderCtx_, renderParams);
    if (rc < 0) return;
    mpv_render_context_report_swap(renderCtx_);

    // Copy into a Buffer the JS side owns — keeps frameBuf_ stable for reuse
    // on the next frame without racing the renderer's consumption of it.
    Napi::Buffer<uint8_t> outBuf = Napi::Buffer<uint8_t>::Copy(
        env, static_cast<uint8_t*>(pixels), static_cast<size_t>(stride) * h);

    Napi::Object payload = Napi::Object::New(env);
    payload.Set("type", "frame");
    payload.Set("width", w);
    payload.Set("height", h);
    payload.Set("stride", stride);
    payload.Set("buffer", outBuf);
    jsCb.Call({ payload });
  }

  // ---- members --------------------------------------------------------------

  mpv_handle* mpv_ = nullptr;
  mpv_render_context* renderCtx_ = nullptr;
  Napi::ThreadSafeFunction eventTsfn_;
  std::atomic<bool> alive_{false};
  std::atomic<bool> wakeupPending_{false};
  std::atomic<bool> renderPending_{false};
  std::atomic<uint64_t> nextCmdId_{1};
  uint64_t observeId_ = 1;

  std::mutex frameBufMutex_;
  std::vector<uint8_t> frameBuf_;
  int surfaceW_ = 1280;
  int surfaceH_ = 720;

  std::mutex pendingMutex_;
  std::map<uint64_t, Napi::Promise::Deferred> pending_;
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return MpvPlayer::Init(env, exports);
}

NODE_API_MODULE(mpv_addon, InitAll)

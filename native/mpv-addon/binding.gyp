{
  "targets": [
    {
      "target_name": "mpv_addon",
      "sources": [ "src/mpv_addon.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<(module_root_dir)/include"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            # Look for libmpv first via Homebrew (Apple Silicon, then Intel),
            # falling back to a vendored copy under native/mpv-addon/vendor/
            # (used when statically-linking a redistributable build for
            # packaging — see BUILD.md in this directory).
            "OTHER_LDFLAGS": [
              "-L/opt/homebrew/lib",
              "-L/usr/local/lib",
              "-L<(module_root_dir)/vendor/lib",
              "-lmpv",
              "-Wl,-rpath,@loader_path/../../../Frameworks",
              "-Wl,-rpath,/opt/homebrew/lib",
              "-Wl,-rpath,/usr/local/lib"
            ]
          },
          "include_dirs": [
            "/opt/homebrew/include",
            "/usr/local/include",
            "<(module_root_dir)/vendor/include"
          ]
        }],
        ["OS=='linux'", {
          "cflags": [ "<!@(pkg-config --cflags mpv)" ],
          "libraries": [ "<!@(pkg-config --libs mpv)" ]
        }],
        ["OS=='win'", {
          "include_dirs": [ "<(module_root_dir)/vendor/include" ],
          "libraries": [ "<(module_root_dir)/vendor/lib/mpv.lib" ],
          "copies": [{
            "destination": "<(PRODUCT_DIR)",
            "files": [ "<(module_root_dir)/vendor/lib/mpv-2.dll" ]
          }]
        }]
      ]
    }
  ]
}

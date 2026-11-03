// macOS Secure Keyboard Entry. While it is on, tools that watch the keyboard with an event tap
// (EVKey, OpenKey, GoTiengViet) don't see key presses, so they can't rewrite them. It applies to the
// whole login session, so the caller must turn it off whenever its window loses focus.
#include <Carbon/Carbon.h>
#include <node_api.h>

static napi_value Enable(napi_env env, napi_callback_info) {
  EnableSecureEventInput();
  return nullptr;
}

static napi_value Disable(napi_env env, napi_callback_info) {
  DisableSecureEventInput();
  return nullptr;
}

static napi_value ModuleInit(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"enable", nullptr, Enable, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"disable", nullptr, Disable, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, ModuleInit)

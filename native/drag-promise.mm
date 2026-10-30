// macOS file promises for dragging SFTP items out of Nixi (Finder, Desktop, any folder).
//
// Electron's webContents.startDrag only drags files that already exist, so remote files had to be
// downloaded to a temp folder *before* the drag started, and anything not finished by the time the
// mouse was let go could not follow the drop. With NSFilePromiseProvider the drag starts at once;
// Finder tells us the destination when the user drops, and the download goes straight there.
//
// JS API (loaded by src/main/ssh/drag-promise.ts):
//   init(cb)                       cb({ type: 'write', token, index, path, requestId })
//                                  cb({ type: 'end', token, dropped })
//   startDrag(nsViewHandle, token, [{ name, isDir }]) → boolean (false: mouse already released)
//   complete(requestId, error?)    report the end of one 'write'
//
// The drop location only reaches the source inside a real mouse drag session (an
// NSFilePromiseReceiver reading the promises from a pasteboard never triggers the write), so the
// end-to-end drop can only be checked by hand.
//
// Build: node scripts/build-native.mjs (universal x86_64 + arm64, N-API so no Electron headers).
#import <AppKit/AppKit.h>
#include <node_api.h>
#include <string>

static napi_threadsafe_function tsfn = nullptr;
static NSMutableDictionary<NSString *, void (^)(NSError *)> *pending;

struct Event {
  bool end;
  std::string token;
  int index;
  std::string path;
  std::string requestId;
  bool dropped;
};

static void emit(Event *e) {
  if (!tsfn || napi_call_threadsafe_function(tsfn, e, napi_tsfn_blocking) != napi_ok) delete e;
}

@interface NixiPromiseSource : NSObject <NSFilePromiseProviderDelegate, NSDraggingSource>
@property(nonatomic, strong) NSOperationQueue *queue;
@property(nonatomic, strong) NSMutableDictionary<NSValue *, NSString *> *tokens;
@end

@implementation NixiPromiseSource
- (instancetype)init {
  if ((self = [super init])) {
    _queue = [NSOperationQueue new];
    _queue.qualityOfService = NSQualityOfServiceUserInitiated;
    _tokens = [NSMutableDictionary new];
  }
  return self;
}

- (NSString *)filePromiseProvider:(NSFilePromiseProvider *)provider fileNameForType:(NSString *)fileType {
  return provider.userInfo[@"name"];
}

// Called after the drop, once per item, with the full destination path (folder + name).
- (void)filePromiseProvider:(NSFilePromiseProvider *)provider
          writePromiseToURL:(NSURL *)url
          completionHandler:(void (^)(NSError *))completionHandler {
  NSString *rid = [[NSUUID UUID] UUIDString];
  @synchronized(pending) {
    pending[rid] = [completionHandler copy];
  }
  emit(new Event{false, [provider.userInfo[@"token"] UTF8String], [provider.userInfo[@"index"] intValue],
                 url.path.UTF8String, rid.UTF8String, false});
}

// Off the main thread: the writes wait for JS, which runs on the main thread.
- (NSOperationQueue *)operationQueueForFilePromiseProvider:(NSFilePromiseProvider *)provider {
  return self.queue;
}

- (NSDragOperation)draggingSession:(NSDraggingSession *)session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
  return context == NSDraggingContextOutsideApplication ? NSDragOperationCopy : NSDragOperationNone;
}

- (void)draggingSession:(NSDraggingSession *)session endedAtPoint:(NSPoint)point operation:(NSDragOperation)operation {
  NSValue *key = [NSValue valueWithNonretainedObject:session];
  NSString *token = self.tokens[key];
  [self.tokens removeObjectForKey:key];
  if (token) emit(new Event{true, token.UTF8String, 0, "", "", operation != NSDragOperationNone});
}
@end

static NixiPromiseSource *source;

static NSFilePromiseProvider *makeProvider(NSString *name, BOOL isDir, NSString *token, uint32_t index) {
  NSFilePromiseProvider *p = [[NSFilePromiseProvider alloc] initWithFileType:(isDir ? @"public.folder" : @"public.data")
                                                                    delegate:source];
  p.userInfo = @{@"name" : name, @"token" : token, @"index" : @(index)};
  return p;
}

// ---------------------------------------------------------------- N-API glue

static std::string str(napi_env env, napi_value v) {
  size_t len = 0;
  napi_get_value_string_utf8(env, v, nullptr, 0, &len);
  std::string s(len, '\0');
  napi_get_value_string_utf8(env, v, s.data(), len + 1, &len);
  return s;
}

static napi_value mkstr(napi_env env, const std::string &s) {
  napi_value v;
  napi_create_string_utf8(env, s.c_str(), s.size(), &v);
  return v;
}

static void callJs(napi_env env, napi_value cb, void *, void *data) {
  Event *e = static_cast<Event *>(data);
  if (env && cb) {
    napi_value obj, b, n, undef;
    napi_create_object(env, &obj);
    napi_set_named_property(env, obj, "type", mkstr(env, e->end ? "end" : "write"));
    napi_set_named_property(env, obj, "token", mkstr(env, e->token));
    if (e->end) {
      napi_get_boolean(env, e->dropped, &b);
      napi_set_named_property(env, obj, "dropped", b);
    } else {
      napi_create_int32(env, e->index, &n);
      napi_set_named_property(env, obj, "index", n);
      napi_set_named_property(env, obj, "path", mkstr(env, e->path));
      napi_set_named_property(env, obj, "requestId", mkstr(env, e->requestId));
    }
    napi_get_undefined(env, &undef);
    napi_call_function(env, undef, cb, 1, &obj, nullptr);
  }
  delete e;
}

static napi_value Init(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value cb, name;
  napi_get_cb_info(env, info, &argc, &cb, nullptr, nullptr);
  if (tsfn) napi_release_threadsafe_function(tsfn, napi_tsfn_release);
  napi_create_string_utf8(env, "nixi-drag", NAPI_AUTO_LENGTH, &name);
  napi_create_threadsafe_function(env, cb, nullptr, name, 0, 1, nullptr, nullptr, nullptr, callJs, &tsfn);
  napi_unref_threadsafe_function(env, tsfn); // do not keep the process alive
  return nullptr;
}

static napi_value StartDrag(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3], result;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  napi_get_boolean(env, false, &result);
  void *handle = nullptr;
  size_t handleLen = 0;
  if (napi_get_buffer_info(env, args[0], &handle, &handleLen) != napi_ok || handleLen < sizeof(void *)) return result;
  NSView *view = (__bridge NSView *)(*(void **)handle);
  NSString *token = [NSString stringWithUTF8String:str(env, args[1]).c_str()];

  uint32_t count = 0;
  napi_get_array_length(env, args[2], &count);
  if (!view.window || !count) return result;
  // Only while the left button is still held: if it was let go before this call arrived, AppKit's
  // drag loop would wait for a mouse-up that already happened and block the main thread until
  // the next click.
  if (!(NSEvent.pressedMouseButtons & 1)) return result;

  // Same trick as Electron's startDrag: a synthetic drag event at the current mouse position.
  NSPoint at = [view.window mouseLocationOutsideOfEventStream];
  NSEvent *event = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged
                                      location:at
                                 modifierFlags:0
                                     timestamp:NSApp.currentEvent.timestamp
                                  windowNumber:view.window.windowNumber
                                       context:nil
                                   eventNumber:0
                                    clickCount:1
                                      pressure:1.0];
  NSPoint inView = [view convertPoint:at fromView:nil];

  NSMutableArray<NSDraggingItem *> *items = [NSMutableArray new];
  for (uint32_t i = 0; i < count; i++) {
    napi_value item, v;
    bool isDir = false;
    napi_get_element(env, args[2], i, &item);
    napi_get_named_property(env, item, "name", &v);
    NSString *name = [NSString stringWithUTF8String:str(env, v).c_str()];
    napi_get_named_property(env, item, "isDir", &v);
    napi_get_value_bool(env, v, &isDir);

    NSDraggingItem *d = [[NSDraggingItem alloc] initWithPasteboardWriter:makeProvider(name, isDir, token, i)];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    NSImage *icon = [[NSWorkspace sharedWorkspace]
        iconForFileType:isDir ? NSFileTypeForHFSTypeCode(kGenericFolderIcon) : (name.pathExtension.length ? name.pathExtension : @"public.data")];
#pragma clang diagnostic pop
    icon.size = NSMakeSize(32, 32);
    // A small stack: each item a few points apart under the cursor.
    [d setDraggingFrame:NSMakeRect(inView.x - 16 + 4 * i, inView.y - 16 - 4 * i, 32, 32) contents:icon];
    [items addObject:d];
  }
  NSDraggingSession *session = [view beginDraggingSessionWithItems:items event:event source:source];
  if (!session) return result;
  session.animatesToStartingPositionsOnCancelOrFail = YES;
  source.tokens[[NSValue valueWithNonretainedObject:session]] = token;
  napi_get_boolean(env, true, &result);
  return result;
}

static napi_value Complete(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  NSString *rid = [NSString stringWithUTF8String:str(env, args[0]).c_str()];
  NSError *error = nil;
  napi_valuetype t = napi_undefined;
  if (argc > 1) napi_typeof(env, args[1], &t);
  if (t == napi_string) {
    NSString *msg = [NSString stringWithUTF8String:str(env, args[1]).c_str()];
    error = [NSError errorWithDomain:@"Nixi" code:1 userInfo:@{NSLocalizedDescriptionKey : msg}];
  }
  void (^done)(NSError *) = nil;
  @synchronized(pending) {
    done = pending[rid];
    [pending removeObjectForKey:rid];
  }
  if (done) done(error);
  return nullptr;
}

static napi_value ModuleInit(napi_env env, napi_value exports) {
  pending = [NSMutableDictionary new];
  source = [NixiPromiseSource new];
  napi_property_descriptor props[] = {
      {"init", nullptr, Init, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"startDrag", nullptr, StartDrag, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"complete", nullptr, Complete, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 3, props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, ModuleInit)

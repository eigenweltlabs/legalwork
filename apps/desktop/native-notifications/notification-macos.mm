#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#import <Intents/Intents.h>
#import <Security/SecTask.h>
#include <napi.h>
#include <atomic>
#include <memory>

struct BridgeState {
  Napi::ThreadSafeFunction callback;
  std::atomic<bool> active{true};
  void emit(NSString *kind, NSString *identifier, NSString *error = @"") {
    if (!active.load()) return;
    std::string type(kind.UTF8String), id(identifier.UTF8String), detail(error.UTF8String);
    callback.NonBlockingCall([type, id, detail](Napi::Env env, Napi::Function js) {
      auto event = Napi::Object::New(env);
      event.Set("type", type); event.Set("id", id); event.Set("error", detail);
      js.Call({event});
    });
  }
};

@interface LegalWorkNotificationDelegate : NSObject <UNUserNotificationCenterDelegate> {
@public
  std::shared_ptr<BridgeState> state;
}
@property(nonatomic, strong) id<UNUserNotificationCenterDelegate> previous;
@end

@implementation LegalWorkNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
  if ([notification.request.content.userInfo[@"legalworkAssistant"] boolValue]) {
    completion(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound);
  } else if ([self.previous respondsToSelector:_cmd]) {
    [self.previous userNotificationCenter:center willPresentNotification:notification withCompletionHandler:completion];
  } else { completion(UNNotificationPresentationOptionNone); }
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:(void (^)(void))completion {
  if ([response.notification.request.content.userInfo[@"legalworkAssistant"] boolValue]) {
    if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) {
      state->emit(@"click", response.notification.request.identifier);
    }
    completion();
  } else if ([self.previous respondsToSelector:_cmd]) {
    [self.previous userNotificationCenter:center didReceiveNotificationResponse:response withCompletionHandler:completion];
  } else { completion(); }
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center openSettingsForNotification:(UNNotification *)notification {
  if ([self.previous respondsToSelector:_cmd]) [self.previous userNotificationCenter:center openSettingsForNotification:notification];
}
@end

static LegalWorkNotificationDelegate *delegate;
static std::shared_ptr<BridgeState> bridge;

static bool hasCommunicationEntitlement() {
  SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
  if (!task) return false;
  CFTypeRef value = SecTaskCopyValueForEntitlement(task, CFSTR("com.apple.developer.usernotifications.communication"), nullptr);
  bool enabled = value && CFEqual(value, kCFBooleanTrue);
  if (value) CFRelease(value);
  CFRelease(task);
  return enabled;
}

static NSString *field(Napi::Object object, const char *key) {
  auto value = object.Get(key);
  if (!value.IsString()) return @"";
  auto text = value.As<Napi::String>().Utf8Value();
  return [[NSString alloc] initWithBytes:text.data() length:text.size() encoding:NSUTF8StringEncoding];
}

static void installDelegate() {
  auto center = UNUserNotificationCenter.currentNotificationCenter;
  if (center.delegate != delegate) {
    delegate.previous = center.delegate;
    center.delegate = delegate;
  }
}

static Napi::Value initialize(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  if (bridge || info.Length() != 1 || !info[0].IsFunction()) return env.Undefined();
  bridge = std::make_shared<BridgeState>();
  bridge->callback = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "Assistant notifications", 0, 1);
  bridge->callback.Unref(env);
  delegate = [[LegalWorkNotificationDelegate alloc] init];
  delegate->state = bridge;
  installDelegate();
  env.AddCleanupHook([]() {
    bridge->active.store(false);
    bridge->callback.Abort();
    auto center = UNUserNotificationCenter.currentNotificationCenter;
    if (center.delegate == delegate) center.delegate = delegate.previous;
  });
  return env.Undefined();
}

static Napi::Value send(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  if (!bridge || info.Length() != 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "Notification bridge is not initialized").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto input = info[0].As<Napi::Object>();
  NSString *identifier = field(input, "id"), *name = field(input, "title"), *body = field(input, "body");
  NSString *conversation = field(input, "conversationId");
  NSData *avatar = [[NSData alloc] initWithBase64EncodedString:field(input, "avatarBase64") options:0];
  auto state = bridge;
  if (!identifier.length || !name.length || !avatar.length) {
    Napi::TypeError::New(env, "Invalid assistant notification").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  // An accepted request without this entitlement still displays the app icon.
  // Report the missing capability instead of treating delivery as avatar support.
  if (!hasCommunicationEntitlement()) {
    state->emit(@"failed", identifier, @"The app is not signed with the Communication Notifications capability. A matching Apple provisioning profile is required.");
    return env.Undefined();
  }
  installDelegate();
  auto center = UNUserNotificationCenter.currentNotificationCenter;
  [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound) completionHandler:^(BOOL granted, NSError *error) {
    if (!granted || error) { state->emit(@"failed", identifier, error.localizedDescription ?: @"Notifications are disabled"); return; }
    INPersonHandle *handle = [[INPersonHandle alloc] initWithValue:@"legalwork-main-assistant" type:INPersonHandleTypeUnknown];
    INImage *image = [INImage imageWithImageData:avatar];
    INPerson *sender = [[INPerson alloc] initWithPersonHandle:handle nameComponents:nil displayName:name image:image contactIdentifier:nil customIdentifier:@"legalwork-main-assistant"];
    INSendMessageIntent *intent = [[INSendMessageIntent alloc] initWithRecipients:nil outgoingMessageType:INOutgoingMessageTypeOutgoingMessageText content:body speakableGroupName:nil conversationIdentifier:conversation serviceName:nil sender:sender attachments:nil];
    [intent setImage:image forParameterNamed:@"sender"];
    INInteraction *interaction = [[INInteraction alloc] initWithIntent:intent response:nil];
    interaction.direction = INInteractionDirectionIncoming;
    [interaction donateInteractionWithCompletion:^(NSError *donationError) {
      if (donationError) { state->emit(@"failed", identifier, donationError.localizedDescription); return; }
      UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
      content.title = name; content.body = body; content.sound = UNNotificationSound.defaultSound;
      content.threadIdentifier = conversation;
      content.userInfo = @{@"legalworkAssistant": @YES};
      NSError *updateError;
      UNNotificationContent *message = [content contentByUpdatingWithProvider:intent error:&updateError];
      if (!message || updateError) { state->emit(@"failed", identifier, updateError.localizedDescription ?: @"Could not prepare sender avatar"); return; }
      UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier content:message trigger:nil];
      [center addNotificationRequest:request withCompletionHandler:^(NSError *deliveryError) {
        state->emit(deliveryError ? @"failed" : @"show", identifier, deliveryError.localizedDescription ?: @"");
      }];
    }];
  }];
  return env.Undefined();
}

static Napi::Object init(Napi::Env env, Napi::Object exports) {
  exports.Set("initialize", Napi::Function::New(env, initialize));
  exports.Set("send", Napi::Function::New(env, send));
  return exports;
}
NODE_API_MODULE(LegalWorkNotifications, init)

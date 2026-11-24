# Android FCM Push

> The published YA Android app uses a small hosted push broker to turn
> revocable, per-server device push subscriptions into FCM notifications while
> self-hosted YA servers and relays remain under their operators' control.

Topic: android-fcm-push

Status: Per-host enrollment, generic native presentation and authenticated
session taps are implemented for Android and iOS. The updated broker is deployed;
physical Android tests prove two-host isolation, foreground/background events,
session taps and headless presentation. iOS sandbox provisioning, two-host
enrollment and real background APNs presentation pass; live tap routing remains
under validation in [the delivery plan](../docs/tactical/141-native-push-delivery.md).

Related:

- [Notifications system overview](notifications.md)
- [Push broker v1 tactical plan](../docs/tactical/068-push-broker-v1.md)
- [Android FCM live smoke](../docs/tactical/069-android-fcm-live-smoke.md)
- [Android wrapper and notification integration](../docs/tactical/071-android-wrapper-notification-integration.md)
- [First-class Android shell](../docs/tactical/080-first-class-android-shell.md)
- [Mobile companion app](../docs/project/mobile-companion-app.md)
- [Mobile server pairing](mobile-server-pairing.md)
- [Security clients and authentication audit](security-client-audit.md)
- [Relay design](../docs/project/relay-design.md)
- [Relay client mux](relay-client-mux.md)
- [Web Push notifications](../docs/push-notifications.md)
- [Hard development rules](hard-development-rules.md)

## Product Boundary

YA servers and relays remain self-hostable. The normal published Android app
belongs to the YA Firebase project and uses a YA-hosted push broker because the
Firebase service-account credentials for that app cannot be distributed to
arbitrary server installations.

The push broker is not an account system or application-traffic relay. It
should know only what it needs to register Android installations, authorize and
rate-limit notification requests, and dispatch them through FCM.

The published service endpoint is `https://push.yepanywhere.com`. The
public name and protocol should use provider-neutral push terminology even
though FCM is the first delivery implementation.

Existing browser Web Push/VAPID remains supported independently. Native FCM is
an additional Android delivery target, not a replacement for self-hosted Web
Push.

## Service Boundary

The hosted push broker should be a separate runtime service from the relay. The
two services may share physical hosting, but they should not share a process,
event loop, database, or delivery credentials.

The official push broker is Linux-hosted infrastructure. Windows is not a
supported deployment target, so the push-broker package test command exits
before loading broker dependencies on native Windows. Linux CI remains the
authoritative broker verification environment; macOS development runs may
continue exercising the same package tests.

This preserves the relay's latency-sensitive opaque forwarding path, allows
broker persistence and outbound provider calls to proceed independently, and
keeps Firebase credentials outside the relay's otherwise narrow trust boundary.
Broker deployments and restarts should not disconnect live relay circuits, and
the public push endpoint should be movable without changing the relay endpoint.

## Trust Model

After an SRP-authorized device pairing, the YA Android app and the user's YA
server are fully trusted with each other's device-specific push material. The
operator is responsible for protecting secrets stored by their server, just as
they are for existing auth state and VAPID keys. Push is an optional child of
the durable paired-device relationship; it is not device authentication.

The hosted broker has narrower trust:

- it alone holds the official Firebase service-account credentials;
- it may store Android installation identifiers, current FCM delivery
  registrations, subscription associations, optional server/relay labels,
  privacy preferences, and delivery/rate-limit metadata;
- it does not receive SRP passwords or relay session keys; and
- it must not become a transcript or general YA message service.

An FCM registration does not need to be hidden from the Android app or its
authenticated YA server. Keeping the broker's current registration mapping is
primarily a delivery-lifecycle convenience, not a trust boundary between the
phone and server.

## Login And Push Enrollment

The default server-pairing path is the existing username/password SRP flow over
the upstream public relay. The same normalized username is the relay target and
SRP identity, matching the web relay login. A custom relay or direct connection
is an explicit advanced choice. The shared Rust core owns that native login
and its Keystore-backed resume credential. Push enrollment happens only after
the server records the authenticated paired device:

1. The user logs the native YA Android client into a YA server with SRP and
   establishes the paired-device relationship.
2. The user enables native notifications for that server.
3. The Android app creates a device push subscription through the configured
   broker.
4. The Android app gives the resulting subscription credentials to the trusted
   YA server over the authenticated, encrypted connection.
5. The YA server stores those credentials under the paired device and uses
   them for future notification requests.

A discovery-only QR may make the SRP device login easier by carrying route
hints and the SRP username; it does not replace the password. Any future
passwordless grant requires step-up authorization and its own security and
compatibility review. Neither QR form is a separate push authorization model.

## Device Push Subscription

A device push subscription is conceptually similar to the Web Push
subscription YA already stores. It is a one-way capability allowing one YA
server to request notifications for one Android installation.

Its conceptual fields are:

- broker endpoint;
- opaque subscription id; and
- high-entropy send secret.

These names describe the authority boundary, not a committed wire schema. The
opaque id identifies broker state; the send secret authorizes delivery. The
broker should store a verifier or hash rather than plaintext when its chosen
authentication scheme permits that.

One subscription per paired YA-server/Android-installation relationship permits
independent attribution, rate limiting, muting, and revocation. It is not a
chat room, a relay circuit, or an address that another server can discover by
username.

The broker maps the stable subscription to the Android installation's current
FCM delivery registration. The YA server may also know that registration, but
it should not need to use it as its durable destination.

The credential-free broker milestone separates two capabilities:

- an installation-management secret creates and revokes server-specific
  subscriptions and replaces the installation's current provider target; and
- each subscription has its own send secret, which can request notifications
  for that installation but cannot read or replace its provider target.

Both secrets are generated by the broker, returned once, and stored only as
verifiers by the broker. Unknown, revoked, and incorrectly authenticated
capabilities have the same externally visible failure.

Routes that await request-body parsing authenticate again immediately before
mutating installation state or submitting to the provider. The preliminary
authentication rejects invalid capabilities before that work and, for sends,
supplies stable rate-limit keys; it cannot authorize work after a concurrent
revocation.

## Credential-Free Broker V1 Contract

The standalone TypeScript service under `packages/push-broker/` exposes:

- `POST /v1/installations` to register one opaque FCM delivery target and
  receive an installation id and management secret;
- authenticated replacement and deletion beneath
  `/v1/installations/:installationId`;
- authenticated subscription creation and revocation beneath that
  installation; and
- `POST /v1/subscriptions/:subscriptionId/notifications` to submit one generic
  intent with the subscription send secret.

The send route never accepts a provider target. Installation and send secrets
are random 256-bit values returned once and retained by the broker only as
SHA-256 verifiers. Revocation prevents later requests; a provider submission
already in flight cannot be recalled.

Defined JSON bodies are limited to 8 KiB and reject unknown fields. Mutation
responses use `Cache-Control: no-store`. Invalid bodies return `400`, missing
JSON content type returns `415`, oversized bodies return `413`, unknown or
unauthorized capabilities return `404`, subscription-cap exhaustion returns
`409`, and rate limits return `429` with `Retry-After`.

The credential-free provider contract waits at most ten seconds. Accepted
provider submissions return `202`, retryable failures return `503`, and
rejections return `502`. There is no broker-owned queue or retry loop.

The conservative process-local limits are:

- 120 mutation requests per minute per source IP;
- 10 installation registrations per hour per source IP;
- 30 notification submissions per minute per subscription;
- 120 notification submissions per minute per installation; and
- 20 active subscriptions per installation.

These counters are bounded in memory and reset on restart. Forwarding headers
affect their source-IP key only when the immediate peer is in the explicit
trusted-proxy configuration. Durable or distributed quotas remain deployment
work.

The fake provider is non-production only. FCM mode requires an explicit
Firebase project id and uses Application Default Credentials. The process
binds to loopback by default; explicit host, port, data directory, provider
timeout, log level, and trusted-proxy settings are authoritative.

## Delivery

The intended flow is:

```text
YA server
  -> authenticated notification request for one device push subscription
  -> YA-hosted push broker
  -> FCM
  -> YA Android app / Android notification tray
```

The broker authenticates the subscription, applies payload policy and rate
limits, resolves the current FCM delivery registration, and submits the
message. Notification requests do not choose an arbitrary FCM registration or
relay username.

The credential-free v1 submits directly to its configured provider and returns
only after that submission succeeds or fails. It has no durable delivery queue,
retry loop, acknowledgement protocol, or delivery guarantee. Those mechanisms
must be justified by observed live-provider behavior before being added.

The broker may store a normalized relay origin, relay username, and
username-derived server display label with the subscription. Those fields
support attribution, diagnostics, and secondary rate limits; they are not
notification authorization.

Primary abuse controls are based on the subscription, Android installation,
and source IP. Relay-origin/username limits may supplement them. The v1 limits
are recorded above; durable quotas, coalescing keys, retry policy, and
idempotency rules should be chosen with live broker evidence.

## Notification Privacy Modes

The Android package declares a dedicated transparent, single-color Y as FCM's
default small notification icon. System-posted background notifications must
use that status-bar-safe silhouette rather than flattening or tinting the
multi-layer launcher icon.

The architecture supports two user choices:

### Generic

The notification contains no user-generated content. The broker receives a
small intent such as "pending input" or "session finished" plus opaque routing
metadata, and sends fixed notification copy. Opening the notification fetches
details from the user's YA server over its normal authenticated connection.

This is the conservative default direction.

The v1 accepts four fixed intents: approval required, input required, session
completed, and session failed. New-client/security alerts remain deferred.
Optional `sessionId` and `eventId` fields accept only opaque base64url characters
and at most 128 characters each; `test` accepts only `true`. All other fields
are rejected, including URLs, project ids and user-generated title/body text.
The YA server resolves a session tap through its authenticated destination route.

Android retains a tapped notification while the paired host is temporarily
offline. It shows the host's ordinary reconnecting UI and resolves the tap when
the existing native connection becomes ready. It rechecks the enabled binding
before opening the authenticated destination; push data never supplies a project
path. Authentication rejection, revocation and definitive lookup failures end
the action. A newer tap or opening host management supersedes it.

The pending opaque subscription/session identifiers survive activity recreation.
Lookup work and its lease stop while the activity is backgrounded; foregrounding
resumes the pending action. Notification routing adds no background retry timer
or independent connection policy.

Android receives high-priority data messages. Its native service validates the
saved subscription binding and OS permission, deduplicates bounded event ids,
and posts fixed copy without starting a WebView or connecting to YA. Disabled,
forgotten, revoked and unknown bindings do not display or open a host.
Foreground activity suppresses ordinary messages; explicit test messages still
show. iOS receives an APNs alert with fixed copy and the same opaque data. iOS
can suppress unknown/disabled messages while active and fences every tap, but
an APNs alert already in flight can still appear while the app is suspended.

### Descriptive

The user explicitly opts into notification title/body text passing in
plaintext through the YA push broker and Google FCM. This may include bounded
project, session, question, or approval text. The UI must explain that
privacy/functionality trade-off before enabling it.

The broker should validate and forward descriptive payloads without becoming a
durable content store. Exact retention, logging redaction, payload size limits,
and user-facing consent copy belong to the implementation contract.

End-to-end-encrypted rich notification bodies are possible future work, not a
requirement for the first useful Android push path.

## FCM Registration Lifecycle

FCM's delivery registration can change over the lifetime of an Android
installation. The broad ownership rule is simple:

- the Android app uses the supported Firebase SDK lifecycle to learn its
  current delivery registration;
- the broker associates that current registration with stable YA device push
  subscriptions; and
- ordinary FCM refresh should not require the user to repeat SRP login or
  recreate otherwise-valid server/device relationships.

The Android probe pins Firebase Messaging `25.1.1` through BoM `34.16.0`, opts
into FID targeting, and receives the current FID through
`FirebaseMessagingService.onRegistered()`. Firebase auto-initialization
registered a clean app installation without activity code, a custom background
job, or a retry loop. Clearing the dev app's data caused a different FID to be
minted and delivered through the same callback.

The native foundation treats every `onRegistered()` callback as an opportunity
to create the broker installation or replace its target without recreating
future server-specific subscriptions. It does not log or persist the plaintext
FID.

The FID and broker installation capability are native installation state. A
web foreground client does not need either value. The preferred enrollment
path uses the native paired-server connection to install a server-specific send
capability. A future bundled app-assets control may initiate the same explicit
user action or carry the send capability over its own authenticated web
connection, but that is not required for native enrollment and must resolve the
same app-local paired-server profile. Mutable hosted-`latest` content remains
a separate trust decision. The FID and installation-management secret stay
native in every case.

The first native lifecycle has no timer, polling loop, durable job, or internal
retry loop. A missing or pending installation asks FCM to re-emit registration
on the next visible app-process start. Registration callbacks create one broker
installation or replace its target after a FID digest change. A broker `404`
causes one bounded fresh-installation attempt; other failures wait for a later
Firebase/app-start lifecycle trigger.

Real target replacement is proven. Offline app/broker recovery, reinstall or
cleared-app-data behavior, and eventual orphan/stale-record cleanup remain
unresolved and must be measured before broadening this bounded policy.

## Android Build Configuration

The public client configuration in
`packages/android/app/google-services.json` is tracked in Git. Fresh source
checkouts and all CI builds, including pull requests, use the official YA
Firebase project by default. The project id, app id, sender id and API key are
compiled into the distributed APK; they identify the Firebase project and
do not authorize broker sends. Firebase treats these values as
[public configuration](https://firebase.google.com/docs/projects/learn-more#config-files-objects).
Firebase-only API keys must retain appropriate
[API restrictions](https://firebase.google.com/docs/projects/api-keys).
Service-account private keys, app-signing keys and broker capabilities remain
secrets and must never be added to this file or committed.

To build without Firebase, pass `-PyaFirebaseEnabled=false` to Gradle. This
skips the Google Services plugin and sets `BuildConfig.FIREBASE_CONFIGURED`
to `false` even when the tracked config is present. The property defaults to
`true` and accepts only `true` or `false`. A missing config also retains the
Firebase-disabled fallback, with an explicit build message.

Operators building an alternate distribution can replace the client config
with their own Firebase project's file and explicitly configure their matching
broker through `-PyaPushBrokerUrl=https://their-broker.example/`. CI uses the
tracked client config directly; no Firebase config secret is required.

## Android Foundation Contract

The first-class Android project:

- applies Google Services only when
  `packages/android/app/google-services.json` exists and Firebase has not been
  explicitly disabled with `-PyaFirebaseEnabled=false`;
- builds without Firebase when disabled or when the config is absent,
  explicitly reporting that Firebase messaging is disabled;
- registers a non-exported native messaging service and does not require an
  Activity or WebView for receipt;
- creates an ordinary activity notification channel at process start;
- exposes coarse status and explicit permission requests only through the
  exact-origin, main-frame native host;
- keeps the broker installation capability and last target digest in
  app-private Android Keystore-backed storage excluded from backup;
- uses Firebase auto-initialization plus one app-start registration request
  only while installation work is absent or pending; and
- enrolls only after explicit per-host enable and the exact optional YA
  capability/origin check; ordinary receipt does not fetch YA state.

The plaintext FID is sent directly to the configured HTTPS broker and is never
persisted or returned to JavaScript. Debug builds log only coarse registration
outcomes and received data-key names plus notification presence. FIDs,
notification title/body, broker capabilities, and token values are never
logged. Release builds log none of this diagnostic material.

Each native app retains bounded subscription-to-profile metadata and the
installation management capability in backup-excluded native storage. The
send capability is transferred once to the authenticated YA server and discarded
by the app. Broker-origin changes fail closed; development installation records
from the earlier unbound Android envelope are reset, without changing host
credentials or continuity keys. A failed cleanup retains a disabled tombstone;
re-enrollment cannot overwrite it. Disable/forget retires local routing before
broker revocation, independently of YA host reachability. A source child that
cannot be deleted immediately is invalidated on its next broker `404`.
Permission and installed delivery state alone do not enroll any host.

Each server card on the native Servers screen shows the enrollment together
with Android's own notification state, re-read whenever the screen resumes.
A build without Firebase configuration shows no notification controls. When
Android will still show its permission dialog, Enable requests permission and
enrolls on grant. After a denial, or with app or channel notifications turned
off, the card says Android is blocking notifications and offers Android's
notification settings instead of an Enable action that cannot succeed; an
enrolled server says it is on but blocked, and hides Send test. Returning from
Settings with notifications allowed finishes the enable the user started there.

Adding a server offers notifications once, before the server opens, when
Android can show them or will still ask. Enable runs the same permission and
enrollment flow and then opens the server; Not now or a permission denial opens
it without enrolling. An enrollment failure keeps the Servers screen and its
error visible. Blocked devices and builds without Firebase get no offer.
Refreshes of the saved server and notification status preserve a completed
pairing and any pending offer.

Inside the Android and iOS apps, whose WebView has no Web Push, the web
Notifications settings replace the browser Web Push toggle with the app's
native notification status and, where the app supports
`notifications.manage`, a button that opens its Servers screen. The server
event toggles stay usable there even when no browser holds a Web Push
subscription, because native subscriptions honor the same toggles.

## First-Class Shell Live Verification

Completed on 2026-08-02 with the configured replacement APK and an attached
Pixel 7a running Android 17 / API 37:

1. A direct Firebase Console test to the current FID produced exactly one
   foreground service callback.
2. The public broker created a temporary installation and subscription,
   accepted `approval_required` with `202`, and produced exactly one foreground
   callback with the expected `intent` and `subscriptionId` data-key names.
3. The same public path accepted a second message after all YA Activities and
   the app process were absent. Android created the generic system notification
   without starting the diagnostic service callback.
4. Notification permission was granted by ADB only for this acceptance test;
   the product still has no permission prompt or enrollment UI.
5. Temporary broker capabilities were deleted, and the FID, Firebase
   configuration, and returned secrets were neither printed nor retained in
   the repository.

## Apple Delivery

The YA iOS app uses the same device push subscription and broker
service rather than introducing another public notification service.

The iOS integration uses Firebase Cloud Messaging's Apple-platform
integration. The iOS app registers through the FCM SDK, Firebase maps that
registration to Apple Push Notification service (APNs), and the broker submits
through the same FCM server interface used for Android. The Firebase project
must be configured with the YA app's APNs authentication material, but YA
servers continue to use the same provider-neutral subscription contract.

This keeps the first iOS delivery path small while leaving direct APNs delivery
as a possible later broker adapter. Adding such an adapter should not require a
new public hostname or a new YA-server subscription model.

iOS silent/background delivery is opportunistic and subject to platform
throttling. The dependable initial product path should use visible
notifications and fetch current details from the authenticated YA server when
the user opens them. The implemented iOS shell uses fixed APNs alert copy, protected per-host
Keychain bindings and an authenticated destination lookup after native resume.
Six push tests, the full simulator suite and signed phone native/UI regressions
pass. Acceptance catalogs use separate push storage, preserving ordinary saved
bindings during QA cleanup. First enrollment waits for APNs/FCM and protected
broker registration after permission returns. This is one event-driven wait
with a 15-second deadline; backgrounding or cancellation ends it, and registration
failure remains retryable. The native list's Enable/Disable and Send test controls
act independently; testing must not disable the host's enrollment.

Private development setup now registers the explicit YA bundle with Push
Notifications and the corresponding Firebase Apple app. A sandbox, topic-specific
APNs key is uploaded to Firebase's development slot. Private configuration and
key backups remain outside Git. Debug provisioning must contain the development
APNs entitlement. The signed phone proves two-host enrollment and generic
background session-event presentation. Eight focused native push tests pass on
simulator and phone. Live system-notification taps remain under validation;
the current controller reports them non-hittable and its tap attempts do not
open YA. Production APNs credentials and App Store/TestFlight signing remain
separate release gates in the delivery plan.

## Self-Hosted And Configured Variants

The mainstream path is:

- published YA Android app;
- official YA Firebase project and push broker;
- any user-operated YA server; and
- either the hosted relay, a self-hosted relay, or a direct connection.

A source-built Android app may expose build-time configuration for alternate
service URLs and may use an operator-owned Firebase project and push broker.
That is an advanced distribution path, not a requirement for ordinary
self-hosting of YA servers and relays.

Explicit broker, relay, and server configuration is authoritative. A client or
server must not silently replace an operator-selected endpoint with the hosted
default.

## Deferred Implementation Decisions

- Hardware Android Key Attestation and Play Integrity remain optional future
  assurance above the required v1 Android Keystore continuity key. Public or
  fingerprinted server installation identity remains deferred as unnecessary
  for the first native lifecycle.
- Live transient-provider-failure validation.
- Registration refresh, invalidation, offline recovery, and stale cleanup.
- Durable quotas, coalescing, acknowledgement, and delivery-result semantics.
- App-attestation requirements for official and source-built distributions.
- Exact generic/descriptive notification settings and disclosure copy.
- Push alerts for failed authentication/proof attempts; v1 keeps rate-bounded
  evidence in the server audit ledger to avoid attacker-controlled alert spam.
- Whether a later iOS release continues through FCM or adds direct APNs as a
  broker delivery adapter.

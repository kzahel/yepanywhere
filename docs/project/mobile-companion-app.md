# Mobile Companion App

## Status

Approved product direction with the first-class Android shell complete. The
local-bundled and hosted-`latest` Android asset channels, exact-origin native
host, App Link, and minimal FCM registration/receive probe exist. The
Gradle/Kotlin replacement has landed and Tauri Mobile has been removed; its
validation evidence and CI contract are recorded in
[`080-first-class-android-shell.md`](../tactical/080-first-class-android-shell.md).
Native pairing, concurrent multi-host summaries, settings, and relay-mux/fallback
behavior have since landed and passed Pixel validation in
[`084-android-native-multi-host-runtime.md`](../tactical/084-android-native-multi-host-runtime.md).
Broker installation registration also exists; server-specific push enrollment,
notification presentation, and native Conversation detail remain later slices.

The native foreground direction selected on 2026-08-02 remains Compose with
Conversation-view session detail and SwiftUI on iOS. On 2026-09-12 the development
sequence changed: first prove a [Simple Client API](../../topics/simple-client-api.md)
with a minimal multi-server web demo at an unlisted Latest URL, experimenting
with machine/project/issue grouping. Kotlin and Swift decoding and small native
consumers follow immediately so web, Android, and iOS shape the same contract.
The existing full web client remains a permanent full-fidelity alternative.
The exact schema and compatibility review remain open in the
[three-client plan](../tactical/130-simple-client-api-and-three-client-demo.md).

The Android notification path is specified separately in
[`topics/android-fcm-push.md`](../../topics/android-fcm-push.md).
Local paired-server profiles, paired-device ownership, native credentials,
resume-authenticated direct/relay selection, LAN discovery, and the bundled
WebView's logical lease on native transport are specified in
[`topics/mobile-server-pairing.md`](../../topics/mobile-server-pairing.md).
The current packaged app's password-manager association is specified in
[`topics/android-credential-sharing.md`](../../topics/android-credential-sharing.md).
The shared semantic boundary and current web-only compiler checkpoint are in
[`topics/portable-transcript-compiler.md`](../../topics/portable-transcript-compiler.md),
and the selected compact session presentation is specified in
[`topics/conversation-view.md`](../../topics/conversation-view.md).

## Motivation

Yep Anywhere already supports browser push notifications through Web Push/VAPID,
but mobile browser delivery can be delayed when the device is locked, idle, or in
a pocket. For time-sensitive agent events such as pending input or task
completion, the desired user experience is closer to a native messaging app:
install, authenticate to a YA server, grant notification permission, and receive
reliable alerts without thinking about browser power-management behavior.

The companion app should also provide a small mobile surface for checking agent
activity across one or more YA servers without reimplementing the full web UI.

## Default User Journey

The primary path should optimize for users who do not want to understand mobile
push infrastructure.

1. Install the YA desktop/server app.
2. Install the YA mobile app.
3. Add a YA server in native onboarding and authenticate with its existing SRP
   username/password flow.
4. Enable native notifications for that authenticated server.
5. Grant notification permission.
6. Receive native mobile notifications and see a minimal activity dashboard.

An optional QR may carry route hints and the SRP username so the user does not
type URLs, while Android still asks for the SRP password. A future passwordless
grant requires step-up authorization and a separate security and compatibility
review.

Source builds and `adb install` should remain possible for advanced users, but
they are not the product-defining path.

For WebView credential discovery, the Android app declares a
Digital Asset Links association with `yepanywhere.com`. This lets compatible
password managers recognize the app's SRP login as the same credential surface
as the hosted Remote Access login. The initial association covers the
maintainer-signed debug APK for device testing; a public app needs its official
distribution certificate added before release.

## Bundled And Hosted Web UI

The complete web interface is a permanent Android presentation alongside the
focused Compose experience. The ordinary production build packages
release-approved client assets inside the signed APK and serves them through
Android's app-assets HTTPS origin. Users may prefer this interface, and native
surfaces may open it for rich tools, settings, or other functionality they do
not reproduce.

A separate testing build may load a fixed YA-hosted client instead of packaging
the assets. Hosted `latest` is a transitional distribution/testing mechanism,
not the trust model for the permanent full-web presentation.

Any hosted build uses a fixed HTTPS URL rather than a runtime-selected origin.
A future stable hosted channel could use a path such as
`https://yepanywhere.com/mobile/`, with an independent cache scope, release
policy, headers, and later mobile-specific behavior. The ordinary production
channel remains bundled.

Local Android development and debug APKs bundle the current checkout's client
assets. They do not depend on a website deployment, so locally edited
JavaScript can be tested immediately. A separate release-channel build may use
`https://latest.yepanywhere.com/` for Play internal or closed testing, where
each successful main-branch push should reach installed test builds without a
new APK. Selecting that mutable channel for an early public release is a
deliberate release decision, not a consequence of building in debug or release
mode. A later stable hosted release uses `yepanywhere.com`, bundled assets, or
the native UI.

Benefits:

- The login form has a real `yepanywhere.com` web origin, which should give
  password managers the most direct path to matching website credentials.
  This remains a physical-device acceptance test rather than an assumption.
- Client fixes can ship with a website release instead of waiting for a new app
  store review.
- The APK does not duplicate the web client assets.
- Native FCM receipt and notification display remain independent of the
  WebView. The app does not need to create a WebView while its UI is closed.
- The full web UI remains a supported user preference and full-fidelity path
  while native summary and inbox surfaces are developed incrementally.

The bandwidth cost is bounded but real. When this option was recorded, the
current core JavaScript and CSS entry assets were approximately 0.83 MiB
compressed. Hashed assets should normally be reused from the WebView HTTP cache
until a website release changes them; fonts and locale bundles are loaded as
needed rather than on every launch. Cache eviction and the first launch after a
release can still require a network download.

Constraints:

- Hosted JavaScript is part of the login trust boundary. A compromise of the
  hosted origin could read an SRP password or resume credential before the
  protocol protects it. This has the weaker trust model described in
  [`topics/trusted-client-packaging.md`](../../topics/trusted-client-packaging.md).
- The official app must not accept an arbitrary remote UI URL by default. A
  source or development build may expose an explicit build-time override.
- Hosted content must not inherit general Android native privileges. The
  planned web/native channel is exact-origin, main-frame-only, versioned, and
  limited to explicit high-level operations; ordinary browsers receive no
  native host.
- An HTTPS page cannot connect directly to an insecure `ws://` YA endpoint
  without weakening mixed-content protections. Relay or other `wss://`
  connections work naturally. Do not enable production-wide mixed content to
  recover insecure direct connections; use a native transport bridge or a
  source-built bundled client if that use case becomes necessary.
- A cold launch can fail when the host is unavailable or the cache has been
  evicted. The app should present an honest retry/offline state.
- Hosted client releases must preserve the stable-server capability gates and
  fallbacks documented in
  [`topics/remote-hosted-compatibility.md`](../../topics/remote-hosted-compatibility.md).
- The published app must deliver meaningful companion functionality rather
  than relying on a generic website wrapper. Native notifications, server
  status, inbox/deep-link handling, and the planned native summary surface are
  part of that product value.

A conservative rollout keeps the low-memory native notification path, lets the
user choose the focused Compose or complete bundled-web presentation, and uses
hosted `latest` only in an explicitly selected testing channel. Before any
hosted channel is adopted beyond testing, verify on a physical device that
website credentials are offered, repeat launches reuse cached assets, no
unintended native IPC is exposed, and background FCM delivery does not start a
WebView.

The first-class shell and WebView host are planned in
[`080-first-class-android-shell.md`](../tactical/080-first-class-android-shell.md).
The subsequent notification lifecycle and foreground-activity staging remain
in
[`071-android-wrapper-notification-integration.md`](../tactical/071-android-wrapper-notification-integration.md).

## Product Shape

The app is a lightweight native companion, not a replacement YA client.

Core surfaces:

- Authenticated server profiles and notification status.
- Native notifications for pending input, task completion, halted sessions, and
  similar user-visible events.
- A minimal inbox/activity dashboard.
- Aggregation across multiple paired YA servers.
- Native add, select, reauthenticate, and remove flows for paired servers;
  selecting a visible server does not disconnect other servers still needed
  for aggregation or notifications.
- Native Conversation-view session detail for routine monitoring, followed by
  basic text response once the read-only projection and transport are proven.
- An explicit complete-web presentation for users who prefer it, and for rich
  activity, tool inspection, settings, and surfaces outside native coverage.
- Optional foreground-service mode on Android for users who explicitly want a
  persistent activity subscriber.

The app should feel like a companion device, not like a second place where the
entire YA interface must be learned.

Compose is the primary mobile surface. The complete bundled client is a
permanent escape hatch for settings, uncommon rich renderers, and other
capabilities not yet native; avoiding a duplicate login is required usability,
but it should not pull native product priorities toward optimizing every
WebView-only workflow.

The bundled client's host catalog comes from native paired profiles. Switching
host selects a source-scoped native transport lease rather than returning to
the web login screen or maintaining a second browser-only list of servers.

## Non-Goals

- Do not reimplement the full YA web UI in native mobile screens.
- Do not require a WebView for the main product value.
- Do not route all YA traffic through the phone by default.
- Do not require users to create Firebase, APNs, or other push infrastructure.
- Do not make Android foreground service behavior mandatory or always on.
- Do not make localhost or local-network bridging part of the core data path
  unless a concrete benefit justifies the added auth and proxy surface.

## Native And Full-Web Session Direction

Android should provide a focused native session-detail experience without
removing the complete full-screen web presentation. Android renders the native
surface with Compose; an early iOS consumer renders the same semantic projection
with SwiftUI. Platform renderers share projection schemas, generated data types,
stable identities, fixtures, pagination and fallback meanings. They do not
share layout widgets or aim for pixel identity.

Conversation view makes the native scope useful without requiring a port of
every rich tool renderer. Its baseline retains user prompts,
agent-authored text, status and boundary rows, important failures, media, and
one compact activity summary per assistant turn. Expanding routine activity may
initially use bounded generic tool rows. A deliberate **Open full activity**
action enters the packaged web client when the user needs rich diffs, file
viewers, provider-specific tools, or settings.

The first native renderer slices should be read-only and consume the same typed
fixtures as the new web demo, then connect to the live API before that demo grows
into a larger client. This supersedes waiting for an Android-first foreground
implementation before beginning iOS. Basic text response follows after
foreground connection and reconciliation behavior are established. An approval
that requires command, diff, or other rich context must open the full web
presentation until the native renderer can show enough information for an
informed decision; the compact native surface must not offer
an under-explained approval action.

The server-compiled projection is the preferred efficient path. Native clients
should not independently reimplement provider normalization in Kotlin and
Swift. The exact bounded envelope, projection schema, capability gate,
older-server fallback, and connection-core ownership remain a separate
compatibility-reviewed implementation decision.

## Hosted Push Model

For the published app, YA should own one mobile app identity and one hosted push
path. The normal model is not "each relay owns an FCM project". It is:

- The published Android app belongs to the YA Firebase project.
- The app maintains an FCM delivery registration with a YA-hosted push broker.
- After native SRP login and durable device pairing, the app creates a
  server-specific device push subscription and gives its send capability to
  the trusted YA server over the encrypted connection.
- A YA server sends a small push intent to the broker when a subscribed device
  should be notified.
- The broker sends an FCM notification to the Android device. Exact Android
  priority and wake behavior remain live-device validation work.
- The app displays a notification or wakes briefly and fetches details from the
  paired YA server.

The credential-free broker service is implemented as a separate package and
runtime at `https://push.yepanywhere.com`. A physical Android build has
registered through Firebase's current FID API, received a direct Firebase
Console test message, and received a temporary generic notification through
the deployed broker. Android now owns a Keystore-backed broker installation
whose target follows FID replacement. Server-specific subscription enrollment
and user-visible native presentation remain unimplemented. The broker may
share physical hosting with the relay, but it does not share the relay's
process, event loop, database, or delivery credentials. The relay is encrypted
transport, while the broker is a token registry and notification dispatcher.

Payloads should be generic by default. A user may explicitly opt into bounded
notification text passing in plaintext through the YA push broker and Google
FCM. End-to-end-encrypted rich notification bodies remain possible future work,
not a first-release requirement.

## Server Pairing And Push Enrollment

The existing SRP login authorizes creation of a durable relationship between
one mobile app installation and one YA server. Android gives the relationship
an app-local profile id; the server later gives the device relationship its own
opaque id. The paired-device record is distinct from an expiring SRP resume
session, and native push is an optional child rather than its definition.

Likely relationship data:

- App-local profile id and user-visible server label.
- A set of relay and direct connection routes.
- Server-issued mobile device id, display name, and revocation metadata.
- Expiring native SRP resume credentials stored under Android Keystore.
- Optional broker device push subscription id and send secret.

While the resume credential remains valid, its challenge-bound server proof is
sufficient to attach direct and relay routes to the same local profile. Without
resume, the app requires explicit SRP reauthentication and profile selection;
it does not infer installation equality. Public/fingerprinted installation ids
and the relay-ownership `installId` are not part of the mobile contract. A
discovery-only QR may bootstrap routes, but manual SRP password authentication
remains the initial authorization. The complete model and current
resume-session limits are in
[`topics/mobile-server-pairing.md`](../../topics/mobile-server-pairing.md).

## Multi-Server Inbox

The dashboard should be modeled as an aggregated version of the YA inbox.

Each paired server contributes a small activity feed:

- Sessions needing input.
- Recently completed tasks.
- Halted or failed sessions.
- Recent active agents.
- Connection and freshness state.

The app should preserve server boundaries in the UI. Aggregation is for scanning
and triage, not for hiding which machine owns a session. Opening a routine item
enters that server's native Conversation-view detail. Full activity and
unsupported detail remain available through the corresponding packaged web
route.

This aligns with the existing multi-host direction in
`docs/project/multi-host-plan.md`.

## Android-First Capabilities

Android is the first target because it enables the behavior that motivated this
idea:

- FCM high-priority native push for time-sensitive notifications.
- A foreground service for explicitly enabled persistent activity subscription.
- A Kotlin connection core for Compose and foreground-service use without a
  WebView or JavaScript runtime.
- Optional bounded local-network discovery for direct-route candidates.
- A Compose dashboard and Conversation-view session surface without relying on
  browser service-worker delivery.

Foreground service mode should be default-off and clearly user controlled. It is
useful for "keep activity live" behavior, but it carries battery and notification
surface costs.

LAN discovery is an auxiliary candidate source, not authentication. mDNS or an
equivalent scan must be bounded to a visible owner, advertise no credentials,
sessions, or installation identity, and attach a route automatically only after
resume proves continuity with the selected profile. Without resume, full SRP
and explicit user selection establish the route. Native direct traffic may use
that authenticated route; the bundled web client normally consumes it through
an independent WebView lease on the Kotlin connection manager.

## iOS Compatibility

The core companion concept is compatible with a future iOS app:

- Native push notifications.
- Pairing and server status.
- Aggregated inbox/dashboard.
- SwiftUI Conversation-view session detail.
- A complete full-web alternative for user preference and rich or unsupported
  detail.

The Android foreground-service activity subscriber is not portable to iOS in the
same form. A future iOS implementation would likely rely on APNs-backed push,
background refresh where available, and foreground app activity rather than a
persistent background service.

The initial iOS delivery direction is to use the same hosted push broker through
FCM's Apple-platform integration, which forwards notifications through APNs.
This avoids a second public notification service and preserves the same
YA-server device push subscription model. Direct APNs delivery may later be
added as a broker-internal adapter without changing that public contract.

To keep that path open, shared backend concepts should be platform-neutral:

- Device registration.
- Pairing records.
- Push intents.
- Inbox snapshots.
- Event freshness and acknowledgement metadata.
- Transcript projection nodes, stable identities, coverage, and pagination.
- Generic fallback and action-eligibility meanings.

Platform-specific delivery details can live below that shared model.

## Self-Hosted and Source Builds

The primary product should assume the published YA app and YA-hosted broker.
Advanced paths can be supported later:

- Build from source and install with `adb`.
- Use the standard YA-hosted broker with a source-built compatible app.
- Bring a custom FCM project/service account for a fully independent build.
- Run without broker push and rely only on foreground-service subscription.

These should be documented as advanced modes. They should not be required for
the normal desktop-plus-phone setup.

## Security and Privacy Notes

The broker should not become a transcript service.

Default broker-visible data should be limited to routing and delivery metadata:

- Mobile registration tokens.
- Device/server association ids.
- Push intent type.
- Timing and delivery attempts.

The phone should fetch sensitive details from the authenticated YA server over the
normal authenticated/encrypted path in generic mode. In descriptive mode, the
user explicitly accepts that bounded notification text is processed in
plaintext by the YA push broker and Google FCM.

Revocation must be first-class:

- Server can remove a mobile device.
- Mobile app can forget a server.
- Device push subscriptions can be revoked or replaced.
- Lost phones should be removable from the desktop/server UI.

## Open Questions

- What is the smallest inbox snapshot API that supports useful aggregation
  without pulling in the full web app session model?
- What is the minimum versioned Conversation-view projection that preserves
  failures, media, coverage, generic tool detail, and safe fallback behavior?
- What exact capability-gated protocol advertises authenticated public server
  identity and creates/revokes durable paired-device records?
- Do representative measurements ever justify offering an independently
  authenticated bundled-WebView transport alongside the native proxy, and if
  so should it be automatic or an explicit advanced mode?
- Should notification acknowledgement be recorded by the app, the server, the
  broker, or all three?
- Beyond the verified clean-install and cleared-app-data FID callbacks, what
  refresh and invalidation behavior is required against the live broker?
- How much local page-open/event handoff is worth building before there is a
  concrete use case?
- What is the minimum source-build story that is acceptable without making it
  look like the supported mainstream path?

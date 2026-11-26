# Mobile store preparation

Initial store assets reuse the existing green Y identity. The English copy in
[`listing.en-US.txt`](listing.en-US.txt) is shared across stores; keep claims
consistent with the shipped build. Private console identifiers, developer
account details, credentials and signing configuration belong in the private
dotfiles runbooks, not here.

## Reusable assets

| Asset | Source / dimensions |
| --- | --- |
| Apple app icon | [`packages/ios/App/Assets.xcassets/AppIcon.appiconset/icon.png`](../../../packages/ios/App/Assets.xcassets/AppIcon.appiconset/icon.png), 1024 × 1024 opaque PNG, bundled in the app |
| Google Play icon | [`packages/android/artwork/play-store-icon.png`](../../../packages/android/artwork/play-store-icon.png), 512 × 512 PNG |
| Google Play feature graphic | [`feature-graphic.png`](feature-graphic.png), 1024 × 500 opaque PNG; editable [`SVG`](feature-graphic.svg) |

Regenerate the feature graphic with librsvg and ImageMagick:

```sh
rsvg-convert docs/distribution/mobile/feature-graphic.svg \
  -o docs/distribution/mobile/feature-graphic.png
magick docs/distribution/mobile/feature-graphic.png -alpha off \
  PNG24:docs/distribution/mobile/feature-graphic.png
```

The graphic is branding, not a simulated app screenshot. Capture actual native
apps against owned sample hosts for store screenshots; do not resize unrelated
browser screenshots or expose real projects, credentials or notification tokens.
Use the console's current accepted device sizes, including iPad for the
universal iOS app. The October 5 Android captures in
[`android-screenshots/`](android-screenshots/) show the actual native app on an
owned phone connected to the isolated synthetic reviewer server. iOS screenshots
remain open.
See [Google's preview asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151)
and [Apple's screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications/).

## Initial internal distribution

As of October 3, 2026, both store draft records exist. Apple has saved initial
metadata and an internal TestFlight group. Google Play has saved the English
listing text, app icon and feature graphic as a draft, plus a dedicated internal
tester list. The first local upload artifacts are built from committed source:
Android 0.1.0 / version code 1000 is active and available to the selected
internal testers; its opt-in page was verified with the maintainer account.
On October 4, the first installed Android release exposed a UI-initiated TLS
login failure: the OS verifier attempted certificate revocation network work
on Main before SRP started. Android 0.1.1 / version code 1001 moves native
connection setup to IO without relaxing certificate verification. Its signed
bundle from committed source is now published to the existing internal track;
Google Play shows **Available to internal testers** with 1001 as the latest
release. Physical acceptance covers Main-initiated public TLS relay login,
the bundled WebView, and a separate isolated package built with production
Release shrinking rules. The earlier background/plaintext probes missed this.
Android 0.1.2 / version code 1002 is also available to internal testers. It
fixes stale sign-in state after interrupted resume/host switching and duplicate
WebView system-bar insets. The Play signing certificate is now associated with
website passwords; Google Digital Asset Links verifies the association. These
fixes passed isolated-host physical-device regressions and browser checks.
Acceptance on the tester's updated Play installation remains open.
iOS 0.1.0 / build 1 uploaded through Xcode's TestFlight Internal Only flow and
now shows **Ready to Test** after saving the encryption questionnaire with
France excluded. The existing account holder is enrolled in the Internal group.
Google Play's Tools category and public support contact are saved; Developer
Tools is saved on Apple. Console links and account-specific inventory live in
private dotfiles.

### Android public setup, October 5–6

Google Play's 11 app-setup tasks are complete as saved changes: privacy URL,
no-ads/government/financial/health declarations, target audience, reviewer
access instructions, content ratings, Data safety, category/contact and listing.
The dedicated reviewer Linux VM uses the normal encrypted SRP relay login,
fictional projects and a canned provider. The English listing is saved with
both actual Android screenshots; the
feature graphic is labeled as AI-assisted. Native Android authentication, sample
history and persisted mock replies pass. Its container has no personal mounts
or provider credentials; guest firewall, resource bounds, restart and cold boot
acceptance pass. The reusable image and isolation contract are in
[`docker/reviewer/`](../../../docker/reviewer/). Exact inventory, credentials,
recovery and deployment journals remain private.

The maintainer reviewed and saved an all-ages content rating on October 6.
Preserve those answers; the earlier adult-content interpretation incorrectly
treated arbitrary user content as supplied graphic content. Data safety includes
startup notification identifiers and
optional content/activity on the developer-owned evaluation server, with a
deletion-request link. Server user creation is disclosed as username/password
account support; the updated policy explains server-owner and broker/demo
deletion requests. The publisher's [Yep Anywhere privacy policy](https://graehlarts.com/privacy.html#yepanywhere)
and [account/data deletion instructions](https://graehlarts.com/privacy.html#yepanywhere-data-deletion)
are live as of October 6. Play's privacy URL and both deletion URLs are saved
with those public links. The public contact is `graehlarts@gmail.com`.

The beta source is committed and integrated with current main at `7ea72be0c`.
Open testing has unlimited enrollment, 177 selected countries/regions with
France excluded, and `graehlarts@gmail.com` for feedback. Advertising ID use is
declared absent, matching the native app and merged manifest. Open beta 1 was
submitted for review on October 6 with signed code `57901` / `0.1.2-ci.479.1`,
English notes, and the native pre-login privacy link. The exact source passed
build/lint/inspection and WebView instrumentation in
[Android CI 37416431327](https://github.com/kzahel/yepanywhere/actions/runs/37416431327).

The maintainer selected **13 and older**: ages 13–15, 16–17, and 18 and over.
That declaration is saved and included in the 13 submitted changes. The
maintainer's saved all-ages content rating remains unchanged, verified as
Everyone / PEGI 3 / USK all ages and corresponding regional ratings.
Play approved and published the submitted release on October 6. A later
installation-link check found the open-testing track paused. Resume was saved,
and its separate activation change is now **in review**, verified after
reloading Publishing overview on October 6. Quick checks completed; the earlier
confirmation error did not prevent the change from eventually reaching review.
At that point, the public enrollment page still reported **App not available**.
The existing track uses the public
[beta enrollment link](https://play.google.com/apps/testing/com.yepanywhere.mobile).

On November 24, Play Console confirmed Open testing active in 177 countries
and regions, with Open beta 1 (`57901`) as the current release. Production had
no releases. Candidate `71501` passed build, lint and inspection in
[Android CI](https://github.com/kzahel/yepanywhere/actions/runs/45355298568).
The [native tab menu check](../../../gaps/android-control-instrumentation-repeatability.md)
failed and prevented internal publication. That candidate also reproduced an
intermittent fresh-pairing stall on Android 15. A delayed notification-status
read could restore the busy flag after pairing had completed.

Source `eea6fc72c` fixes that race and makes the long-press probe wait for
WebView visual state. [Android CI run 45379108599](https://github.com/kzahel/yepanywhere/actions/runs/45379108599)
passed all Android release gates and published `0.1.4-ci.616.1` / `71601`
to internal testing. The two hosted upload probes retained every character,
with maximum acknowledgements of 342.7 ms direct and 334.9 ms relay under
the emulator allowance. Physical-device typing at the 100 ms target awaits
measurement for this candidate. All 1,785 bundle entries matched the signed
upload, whose receipt records SHA-256
`7f88cd65a88483121586ce05fb5440cae7929d831b833f1baee9315f4868a7db`.
The exact bundle passed direct and public relay sign-in on Android 15 and
public relay on Android 16. An in-place upgrade from `57901` with locally
signed APKs preserved its saved server, including after a process restart.
Play's generated APK for `71601` carried the expected app-signing certificate.

On November 24 at 12:50 CET, Play Console accepted `71601` for review as a
full Open testing rollout across the existing 177 countries and regions.
Managed publishing is off. `57901` remains available while `71601` is in review.

An under-13 audience would require separate child-data and sharing readiness
under [Play Families requirements](https://support.google.com/googleplay/android-developer/answer/9893335?hl=en).
That expansion is not part of the selected 13+ beta.

A full public listing is not the first internal-testing prerequisite.
[Google permits internal testing before completing app setup](https://support.google.com/googleplay/android-developer/answer/9845334).
[TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
requires an uploaded, processed build and testers; external testing introduces
additional review requirements. A saved draft or processed upload alone does
not make a build installable; the testing track and tester enrollment must also
be active.

### Local upload path

The maintainer selected platform-managed distribution signing on October 3.
Initial uploads were local; the CI delivery path below is now enabled and
verified. Keep upload preparation separate from public rollout and use a
clean, committed source snapshot.

For Android, build the bundled Release AAB with the existing native/core and
frontend preparation. Sign the bundle with a dedicated upload key, then let
Google generate and retain the app signing key when configuring Play App
Signing. The upload key authenticates submissions; its certificate is not the
certificate Google uses for installed apps. Do not register the upload-key
fingerprint as the production password-manager association.

```sh
node packages/mobile-core/scripts/run.mjs android
pnpm --filter @yep-anywhere/android prepare-frontend
cd packages/android
./gradlew :app:bundleBundledRelease
jarsigner -keystore "$YA_UPLOAD_KEYSTORE" \
  -storepass:env YA_UPLOAD_STORE_PASSWORD \
  -keypass:env YA_UPLOAD_KEY_PASSWORD \
  -signedjar app/build/outputs/bundle/bundledRelease/yepanywhere-upload.aab \
  app/build/outputs/bundle/bundledRelease/app-bundled-release.aab upload
jarsigner -verify app/build/outputs/bundle/bundledRelease/yepanywhere-upload.aab
```

Provide the SDK/JDK environment and upload passwords privately; never place
passwords in command-line arguments, tracked Gradle properties or build logs.
Verify the AAB's signer against the upload certificate and retain its source
commit, version code and SHA-256 alongside the artifact. Upload the signed AAB
to the internal track; subsequent uploads need increasing version codes.
See [Google's signing guide](https://developer.android.com/studio/publish/app-signing).

### iOS CI internal delivery

Run the iOS workflow on main with the TestFlight input enabled:

```sh
gh workflow run ios-app-ci.yml --ref main -f testflight=true
```

The workflow tests the Rust core, live routes, exhaustive web recovery model and bundled app on an owned iPhone simulator. A passing run archives the device Release with the same revision, bundled Firebase configuration and a unique build number. The protected `ios-testflight` job downloads that archive and uses Xcode automatic distribution signing with App Store Connect API authentication. It verifies the signed IPA’s production APNs entitlement, application identifier, build number and disabled debugging entitlement before upload. Pushes, pull requests and scheduled checks run verification only.

On November 26, [CI run 45877362715](https://github.com/kzahel/yepanywhere/actions/runs/45877362715) delivered iOS **0.1.0 (167.1)** from `222763b88`. Apple processed the build and listed it in the Internal group with the existing account holder enrolled. The hosted simulator passed all 28 native tests and both UI tests. Its typing probe retained all 37 characters, peaked at 71 ms and observed 436 concurrent transcript updates. Installation and production notification delivery on a TestFlight phone remain open.

The GitHub environment is restricted to main. Configure `IOS_ASC_APP_ID` and `IOS_TEAM_ID` as environment variables, the matching `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID`, and `ASC_API_KEY_P8_BASE64` as secrets, and `IOS_GOOGLE_SERVICE_INFO_PLIST_BASE64` for the verified archive. Enable automatic distribution on the existing Internal group and add internal testers through App Store Connect.

CI waits for Apple processing and verifies the exact build's membership in Internal. Its receipt identifies the source commit, IPA SHA-256, Apple build ID, version and group. Once the upload job succeeds, retrying the processing check reuses that upload. If Apple requests the encryption questionnaire, CI verifies that France is still unavailable and that Apple recorded the reviewed answer on build 1, then applies it to the uploaded build. Revisit this logic when changing cryptography or territories. The [encryption declaration](#apple-encryption-declaration) records the algorithms and distribution decision. Check the uploaded build before starting another release. Production push also requires production APNs configuration in Firebase and a notification tap on a TestFlight device.

Before broader distribution, finish real screenshots, privacy/data-safety
disclosures (including optional native Firebase/broker push), age/content
ratings, review access to an owned sample server, pricing and availability.
Do not mark encryption absent merely because transport uses standard crypto:
the shared Rust core uses SRP and libsodium outside OS-only TLS. Resolve the
applicable declaration/documentation before distributing a build.

### Android CI internal delivery

The existing [Android workflow](../../../.github/workflows/android-app-ci.yml)
now produces a bundled Release AAB and has a publication job depending on both
build/lint/unit checks and WebView instrumentation. Publication requires both
`ANDROID_PLAY_PUBLISH_ENABLED=true` and a manual main dispatch with
`publish_internal=true` (default: false). The dedicated, keyless Google identity,
main/workflow/environment-restricted federation, app-only testing grant and
GitHub configuration are provisioned, the Android Publisher API is enabled,
and manually requested publishing is available. Pushes and nightly runs verify
without publishing.

[Hosted CI run 37202914083](https://github.com/kzahel/yepanywhere/actions/runs/37202914083)
passed build verification and WebView instrumentation, authenticated through
GitHub OIDC, and published `0.1.2-ci.464.1` / code `56401` from `fca9705a3`.
Google Play confirms **Available to internal testers**. The retained receipt
reports `published` on `internal`; its SHA-256 matches the signed upload, and
all 895 original bundle entries match the tested candidate. Only the signing
metadata was added. The [main CI suite](https://github.com/kzahel/yepanywhere/actions/runs/37202914085)
also passed, including both browser shards and iPad WebKit.

The Android tabs and warm-resume update was published by
[run 37226132033](https://github.com/kzahel/yepanywhere/actions/runs/37226132033)
as `0.1.2-ci.473.1` / code `57301`, from `72fbb38fc`. Both Android verification
gates and publication passed. Play confirms **Available to internal testers**;
the `published` internal-track receipt names that source commit and its SHA-256
matches the signed upload. CI repairs covered an emulator Pixel Launcher ANR
and WebView link names exposed as content descriptions. The separate browser caption-icon assertion was subsequently corrected in
[`3f54af6cd`](https://github.com/kzahel/yepanywhere/commit/3f54af6cd).

The October 8 Android lifecycle hardening build is available to internal
testers as `0.1.2-ci.513.1` / code `61301`, from `a079aa3f9`.
[Run 37712235822](https://github.com/kzahel/yepanywhere/actions/runs/37712235822)
passed build/lint/package inspection and complete hosted direct/relay
instrumentation before publishing. Its receipt reports `published` on
`internal`, names that source commit, and confirms Play's returned SHA-256
matches the signed candidate. Play confirms **Available to internal testers**.
The [experiment report](../../testing/android-lifecycle-hardening-2026-10-07.md)
records local Release/reboot acceptance, matched browser comparisons, failed CI
attempts and the remaining physical update/network/overnight/keyboard checks.
Public tracks and tester membership were unchanged.

The October 20 coordinated release published `0.1.2-ci.550.1` / code `65001`
from `e65db78de294a50b9941836f042bbd7940e7edc6` to internal testing.
[Run 39469337588](https://github.com/kzahel/yepanywhere/actions/runs/39469337588)
passed build/lint/package inspection and the complete direct/mux instrumentation
gates before publication. The retained receipt reports `published` on
`internal`; its signed-bundle SHA-256 is
`dcd32000a6f1adc772781e8aaf839b5675a2558831bd7990467748345a4b2129`.

All 964 entries in the tested candidate match the signed upload; only signing
metadata was added. The 100 MiB mux upload completed. The earlier nightly
[upload timeout](../../../gaps/android-ci-mux-upload-timeout.md) remains an
unexplained intermittent failure. Emulator typing maxima were 131.3 ms direct
and 142.7 ms mux under the existing software-renderer budget; this run does not
establish fresh physical-device acceptance against the 100 ms input ceiling.
Public tracks and tester membership were unchanged.

The October 24 coordinated release published `0.1.3-ci.567.1` / code `66701`
from `bcdd87c0f0a87193b81c8f7b5f52262960ffb4b0` to internal testing.
[Run 40107321514](https://github.com/kzahel/yepanywhere/actions/runs/40107321514)
passed build/lint/package inspection and the minified WebView direct/relay
acceptance gates before publication. Its receipt reports `published` on
`internal`, names that source commit and records signed-bundle SHA-256
`883d0228fbaa1e3790eb6030990cba228af32ab85a7c35775724cd7db90cefe9`.
The downloaded signed bundle matches the receipt; all 966 tested bundle entries
are unchanged, with only three signing entries added. Public-beta promotion
and the existing physical update/network/overnight/keyboard follow-ups remain
separate.

The main-only GitHub `android-internal` environment holds the existing upload
key as `ANDROID_UPLOAD_KEYSTORE_BASE64`, `ANDROID_UPLOAD_STORE_PASSWORD` and
`ANDROID_UPLOAD_KEY_PASSWORD`. The signing step checks its public certificate
fingerprint before signing. All builds use the public Firebase client config
tracked at `packages/android/app/google-services.json`, including PR builds;
the `ANDROID_GOOGLE_SERVICES_JSON` secret is no longer required. See
[Android build configuration](../../../topics/android-fcm-push.md#android-build-configuration)
for the Firebase-disabled option and alternate distributions. No app-signing key
is exported from Google.

To release a new internal test version, open **Actions → Android App CI → Run
workflow**, select **main**, and enable **Publish to Play internal testing after
verification**. The equivalent command is:

```sh
gh workflow run android-app-ci.yml --ref main -f publish_internal=true
```

This runs the build and tests, then publishes their exact AAB. A plain manual
run only verifies. Ordinary verification still runs on its existing push and
nightly cadence; newer runs on the same ref cancel obsolete verification work.
Explicit releases run separately and are not cancelled by subsequent pushes.
No release tag or trusted-publishing permission change is required.

One-time setup and acceptance procedure:

1. Create a dedicated Google service account with no general project roles.
   Enable the Android Publisher and IAM Credentials APIs in its project.
2. Configure GitHub OIDC Workload Identity Federation, restricting admission to
   the immutable repository/owner IDs, `refs/heads/main`, the Android workflow
   path on main, and the `android-internal` environment subject. Grant only
   `roles/iam.workloadIdentityUser` on this service account to that identity.
   Do not create a long-lived service-account JSON key.
3. In Play Users and permissions, give that account access only to
   `com.yepanywhere.mobile`: view app information and release to testing tracks.
   Do not grant production releases, account administration, financial data,
   subscriptions, or tester-list management.
4. Set GitHub environment variables `ANDROID_PLAY_WIF_PROVIDER` and
   `ANDROID_PLAY_SERVICE_ACCOUNT` to the provisioned identities. Set the repository
   variable `ANDROID_PLAY_PUBLISH_ENABLED=true` only after these are ready.
5. Dispatch Android App CI on main with `publish_internal=true` and verify
   a `published` receipt plus
   **Available to internal testers** in Play. An upload or draft alone is not
   successful delivery. A draft-app/API restriction must be resolved explicitly;
   the script never silently downgrades to a draft or chooses another track.

See [Google's Play API setup](https://developers.google.com/android-publisher/getting_started)
and [Google's GitHub authentication action](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account).
Account IDs and concrete provisioning commands belong in private dotfiles.
The [packaging contract](../../../topics/trusted-client-packaging.md#android-internal-ci-delivery)
owns versioning, stale-run protection and audience boundaries.

### Apple encryption declaration

The October 3 questionnaire uses the standard-encryption-outside-Apple-OS option:
the shared core implements SRP with SHA-512 and libsodium secretbox
(XSalsa20-Poly1305), in addition to TLS. These are published cryptographic
algorithms; the app must not be declared OS-only or encryption-free.
[Apple's overview](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance)
distinguishes proprietary/unpublished cryptography from published algorithms.

The maintainer deferred France on October 3. App Store availability is saved
for 174 countries or regions, with France **Not Available** and automatic
availability in future countries disabled. The build questionnaire retains the
standard-encryption option and answers **No** to France distribution; Apple
required no attachment and the build now shows **Ready to Test**. No Info.plist
encryption setting was changed.

**Deferred to-do — enable France:** clarify with ANSSI whether this app requires
a declaration or qualifies for an exemption, complete any required filing, and
obtain the documentation Apple accepts before enabling France and revisiting
the questionnaire. Apple's
[documentation matrix](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption)
explains the French documentation gate. The unsigned technical draft is retained
in private dotfiles; it is not an approval form and has not been filed or
uploaded. Private filing details and console inventory belong in that runbook.
Keep France excluded when configuring broader Android distribution as well.

Keep initial releases internal. App Store review submission and public Play
rollout are separate actions from preparing draft records and internal tracks.

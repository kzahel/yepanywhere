# Automatic authentication refresh for server connections

Status: implemented, 2026-11-01. Plan and backend committed separately; the final
Settings/enrollment slice completes the workstream. The user approved automatic refresh while
servers remain online and expiry after prolonged inactivity, rather than a fixed
30-day deadline from pairing. This supersedes plan 169's pairing expiry default;
explicitly time-limited manual grants and identity-service policy remain distinct.

## Existing boundaries

Build on [server connections](../../topics/peer-access.md#server-connections-settings),
[principals and grants](../../topics/principals-and-grants.md), and
[resource ownership](../../topics/architecture-mandates.md). This adds no agent
coordination lifecycle, central account requirement or browser owner-login
protocol. The source backend owns refresh; neither native agent environments
nor browsers receive peer credentials. Both directions remain independent.

Search found no existing peer-refresh implementation plan. Existing adjacent
failures remain separate: [Rendez restart observation](../../gaps/rendez-nested-watch-event-after-restart.md),
[Vite test timeout](../../gaps/vite-manual-reload-unit-timeout.md), and retained
[console/tool warnings](../../gaps/runtime-cutover-tooling-warnings.md). Do not
replace a failing run with retries or increase unrelated budgets.

Delivered: recoverable authentication state, direct/relay peer-v1 transport,
bounded profile scheduling, guarded historical migration, capability-gated owner
enrollment and nonsecret Settings status/recovery. Both implementation slices
received independent Sol 6.1 high and actual Daybreak Blue high correctness and
security approval. Both reviewers inspected final phone/desktop captures
individually. Explicit fixed grants and existing reverse-direction modes are
preserved; fresh owner login can explicitly change the selected direction.

Validation: full unit gates, isolated real direct/relay/native workflows,
restart/lost-reply/stale-source-deadline recovery, ordered replay, quiet-profile
renewal after day 30, cooldown/timeout/late-removal races and owner recheck after
remote upgrade. Three focused Chromium cases pass, including sequential typing
within 100 ms over 50 visible/64 total peers during metadata updates. Final
captures are in `.artifacts/ui-testing/2026-11-01-peer-refresh`; private evidence
and assistant-only reviews are in ignored `tasks/peer-refresh`. Lint, formatting,
typecheck, CSS and console checks pass with no new warning debt. Existing console
baseline and unit skips remain documented separately. Windows acceptance remains
deferred; this slice's runtime qualification is macOS/Node 22.

## 1 — Pair policy and recoverable authentication state

Keep stable source/target/pair UUIDs, permission policy, explicit selection and
owner revocation separate from authentication deadlines. Proposed initial
policy constants are one-hour access credentials, a 90-day inactivity window,
and refresh around 45 minutes with jitter. Successful accepted refresh extends
the inactivity deadline; reads, failed attempts, transport heartbeats and
idempotent replay do not. The target owns these deadlines and policy ceilings.

Retain the maintained per-pair SRP credential as the durable transport/refresh
proof. For refreshable pairings it is no longer an ordinary API bearer. API
requests require a short-lived opaque access credential bound to the same
verified pair and current permission generation. No new cryptographic primitive
or OAuth service is introduced. Owner/browser SRP remains unchanged.

Store target access hashes and bounded refresh receipts, not recoverable access
secrets. The source generates a random access secret and durably records its
candidate and request UUID before dispatch, then sends only its hash. The target
atomically accepts that exact operation and records its deadline/result. Repeat
of the same operation/hash returns the same result without reminting or sliding
time again. Source restart/lost reply recovers its durable candidate. Reusing an
operation UUID for another candidate conflicts. Bound retained access slots and
receipts; admitted requests can finish within their original short deadlines.

Use private versioned profile state and serialized, durable publication.
Authentication-only writes do not advance policy revisions, rotate launch grants,
replace transports or abort active observations. Revocation, selection, route,
permission and pairing-secret changes still fence queued work. At publication,
recheck the exact pair, secret/generation, enabled state and relevant policy;
late refresh must never recreate a removed/replaced pair.

## 2 — Versioned peer refresh over direct and relay transport

Add a peer protocol version/capability for refreshable authentication. Include
mode and current target deadline in authenticated server metadata, bound to
profile/pair UUID, credential generation and transport nonce. Keep legacy
fixed-expiry/identity-service peers on their existing protocol. Refuse unsupported new
pairing before mutation; never silently substitute a 30-day connection.

Provide a private HTTP refresh resource over the same SRP/NaCl peer transport.
Require the server-owned authenticated SRP context and exact pair proof. It can
mint access only for that existing pair and cannot change permissions, enroll
another peer, create a reverse direction or reach owner administration. Bind
normal access bearer validation to that same transport pair/generation.

Coalesce callers behind one source refresh per selected pair. Cancellation of a
caller stops its operation/wait, while profile-owned bounded refresh can finish
for other users or its scheduler. Removing/disabling/closing aborts owned work
and fences adoption. Never automatically resend an ambiguous native mutation;
authentication recovery happens before dispatch.

Qualify real direct and owned relay handshakes, old/new protocol combinations,
wrong UUID/generation/token, expiry, restart and revoke-during-refresh. Reuse
existing channel/body/crypto budgets and deadline ownership.

## 3 — Profile-owned scheduling, enrollment, UI and migration

Use one next-deadline scheduler per profile, bounded concurrency and per-pair
backoff/jitter. Startup resumes durable pending work; on-demand API calls join
that same work. An online but unused connection refreshes. Offline failures do
not extend target authority. There are no provider/session timers or transcript
scans. Disabling connections stops scheduling and re-enable does not revive old
native launch grants. Authentication expiry stops retries and keeps the saved
relationship visible for owner sign-in.

New UI pairings negotiate refresh support and use automatic authentication by
default. Reauthentication preserves identity, names, permissions, selection and
audit. Ambiguous outcomes remain explicit. Show automatic sign-in, last accepted
refresh, temporary unavailability or Sign in again; keep routine access-token
expiry out of the primary UX. Routine refresh must not flood audit history.

Migrate only identifiable UI-default pairings: both ends independently require
retained pairing provenance, a still-valid existing credential and unchanged
permissions. Mark new UI enrollment explicitly so future migration does not
infer intent. If provenance is missing/ambiguous, leave fixed policy unchanged
and offer an owner-authenticated upgrade. Preserve manually chosen deadlines,
scoped policies and identity-service ceilings. Already-expired authentication requires owner
sign-in; it must not be revived just from saved metadata. Retain history.

The optional UI contract must be distinguishable from the original
peer-connections capability. Review the latest-two/14-day stable corpus
(v0.11.0, v0.10.2, v0.10.1, v0.10.0 already reviewed for plan 169): absent new
support keeps existing direction views, disables new pairing with update
guidance, and sends no new pairing request/field.
Supported new builds show automatic-authentication behavior. No browser protocol
cutoff or reinterpretation of the old capability is introduced. This originating
request approves that guarded optional addition.

## Verification, review and commits

Use clock-injected pure state/HTTP tests for deadlines and races, actual SRP and
owned relay integration for transport, and meaningful profile restart tests for
pending publication. Include source/target crash boundaries, exact retry replay,
conflicting replay, concurrent callers, source/target removal/replacement,
manual/identity-service isolation, inactivity and automatic renewal across the former
30-day boundary. Check native create/message/follow and provenance after refresh.

Run independent Sol 6.1 high and actual Daybreak Blue high design/code reviews
through YA between slices; address material correctness/security findings.
Review final UI in separately identified Chromium with real typing under
populated/concurrent updates. Capture desktop 1000×600 and phone 375×812 through
the repository artifact facility and inspect individually. Preserve the primary
YA/provider host. Windows acceptance remains deferred unless separately exercised.

Run lint, format:check, typecheck, test, CSS/console checks and bounded relevant
browser tests. Typecheck and tests run sequentially. Commit this plan, reviewed
state/service work, reviewed transport integration, then the complete scheduled
and UI workflow with durable topic contracts and roadmap status. Keep exact
validation evidence in ignored tasks/peer-refresh; no push is requested.

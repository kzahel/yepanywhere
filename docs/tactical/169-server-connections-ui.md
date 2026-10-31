# Server Connections settings and owner-assisted pairing

Status: implemented and independently reviewed, 2026-10-31. The plan was
committed before implementation. Current behavior is owned by
[peer access](../../topics/peer-access.md#server-connections-settings).

## Intent and existing work

Deliver Settings → Server Connections beside Local Access and Remote Access.
The owner connects A to B through a direct or relay route using B's existing
owner SRP credentials. A's backend does the login and enrollment; the browser
stays on A and only supplies the settings form. Pairing creates a dedicated
credential; B's owner password is never saved. No separate approval on B.

Build on [plan 168](168-peer-access-and-enrollment.md),
[peer access](../../topics/peer-access.md#owner-ui-direction-relay-pairing-and-audit),
[principals and grants](../../topics/principals-and-grants.md) and the
[roadmap](../roadmap/README.md). Local records are in ignored tasks/peer-access.
The existing [legacy agent/password gap](../../gaps/agent-tools-lose-ya-api-under-local-password.md)
is separate from new owner administration. The known
[Vite verification timeout](../../gaps/vite-manual-reload-unit-timeout.md)
must not be hidden by retries or arbitrary deadline changes.

Trusted control means the ability to execute as the YA OS account. Do not
present project filters as confinement of unrestricted agents. The first UI
has no scope editor, read-only invitation flow, fleet/OIDC setup or mesh policy.
Keep those as follow-ups. Native agents keep their existing discovery and v0
workflow; no checkout, scheduler or custom delegation lifecycle is added.

## 1 — Identity, trusted control and owner enablement

Identify the logical profile by its verified server UUID. Show its existing
host icon, a friendly label, hostname, OS and architecture in the connection
list and details. Remote display facts are authenticated reports, not proof
that two machines with the same name are the same server. Escape and bound
all display strings; expose neither credentials nor verifier material.

Add durable, bounded connection metadata and audit events to the peer store.
Record creation/change/revocation/test outcomes, time, direction, immediate
server identity and owner initiation. Retain native session provenance links;
source-session claims remain source-attested. Policy and its successful audit
event publish together; failed/uncertain distributed outcomes remain explicit.
Listings display last observed verification, not fabricated live connectivity,
and start no all-peer scans or recurring per-peer loops.

The MVP trusted-control grant must include newly discovered projects, rather
than silently freezing an all-projects selection at enrollment. Keep existing
explicit project/operation credentials and fleet ceilings unchanged. A broad
control grant does not authorize another server's legacy owner API by accident.

Provide owner-authorized runtime enable/disable and inspectable disabled state.
Preserve explicit YEP_PEER_API_ENABLED overrides. Default remains disabled until
an owner enables/consciously connects; do not require editing an env var as the
normal UI path. Disabling closes admission/observations and retires peer agent
leases; re-enabling cannot revive revoked launch grants. Native local-only API
leases and the primary running server/provider host remain untouched.

SRP resume persistence defaults on for fresh/unset settings, retaining saved
opt-outs, as requested. Dedicated peer credentials are already independently
durable. Finish/review the paused default-change edits as a coherent slice.

## 2 — A short-lived owner SRP client on the server

Independent review selected the ordinary owner SRP exchange unchanged. A
retains no owner password or resume key. B applies its existing persistence and
five-session policy during login; pairing can evict the oldest saved login, and
a crash/lost reply can leave B-side resume state until normal expiry/revocation.
State that once in the form. Cleanup attempts to revoke only this authenticated
setup session with its own bounded lifetime; report cleanup confirmed or
unconfirmed separately from pairing. Browser-slot refinement is future work,
not a new PAKE/purpose-binding prerequisite. There is no restricted owner-login
authority claim and no new SRP message/proof construction.

Reuse maintained SRP and NaCl implementations and the existing owner protocol
for direct /api/ws or relay owner connections. Do not route setup through a
second browser connection. Existing owner SRP configuration is required on B;
a direct connection does not depend on a live relay. Keep browser protocol
compatibility and its previous-client grace paths unchanged.

Verify M2 and authenticated server metadata before any peer/settings mutation. Carry
normal encrypted sequence and request correlation, bounded buffers/body/header
sizes, bounded concurrent setup/signing work, cancellation and fixed request/
handshake lifetimes. No background reconnect, owner resume-key retention or
automatic mutation retry. Always close the temporary connection, retire its
temporary owner session where possible and remove listeners/timers. Never log
passwords, proofs, resume keys, peer secrets or invitation bodies.

Setup is owner-only even on auth-off/loopback sources; legacy agent bearers,
limited users and incoming peers cannot authorize it. Recheck live initiating
owner authority after queue waits and before local publication/remote sends.
Once remote work is dispatched it may commit: expose partial/uncertain state
without claiming a transaction or indiscriminately deleting another grant.

## 3 — Direct/relay pairing and direction changes

Use a dedicated backend controller and constructible HTTP adapter around the
peer manager, not provider/scanner startup. The selected route is explicit;
never silently overwrite a configured relay, race routes or fall back after an
ambiguous mutation. Refuse self-pairing and changed target UUIDs.

One Connect action authenticates B, verifies compatible support, reads its
identity, enables supported peer operation if necessary under owner authority,
creates the dedicated trusted-control grant, imports/preflights it on A and
records the outcome. Repeated setup inspects an existing pair and uses explicit
replacement/renewal semantics instead of silently exporting another secret.

Offer Also allow B to control this server, off unless explicitly selected.
Create and verify the reverse grant independently. Reuse an explicitly
configured peer relay or configure a separate registration at the chosen relay;
never reuse the browser registration identity or password. There is one peer
relay per profile: use an existing registration even if it differs from the
owner-login relay, and configure one only when absent and explicitly chosen.
A conflict yields a clear partial/reverse-route result instead of replacement.
Direct reverse
access needs an explicit reachable return address when no configured relay is
available. Do not guess that localhost or the hosted UI origin reaches A.

Either direction can be added/removed later. The source owner can immediately
stop local use and revoke locally enforced incoming access. Changes that need
remote owner administration request fresh login when necessary; peer execution
credentials do not silently become owner credentials. Show any remote cleanup
that cannot be confirmed separately. Preserve a completed first leg if the
second leg fails, and label it one-way. Keep accepted native work alive after
revocation. Human relay-password/username changes preserve established peer
credentials; offer a separate, explicit controlling-server revocation choice.

## 4 — Settings list, form, details and audit

Add a capability-gated category and API client using the current source's
transport. The page identifies This server with icon/hostname/OS. Each peer
appears once with both direction states, route, expiry and last verification.
Details show stable UUID, reported identity, audit history and sessions created
through that peer. Provide explicit Test connection, direction controls,
renewal/removal and honest errors/partial results. Put agent-use enablement and
its local API prerequisites within reach of this page.

Connect accepts Relay (configured relay URL, server name, owner password) or
Direct (server address, SRP username/password), optional friendly label and
bidirectional choice. Keep draft typing synchronous and independent of lists,
metadata fetches, scans and validation. No password persistence/localStorage.
Use existing settings components, icons and CSS Modules; no raw-debug default
surface or UUID wall. Retain practical phone targets and clear loading/disabled
states. The UI must remain on A throughout backend pairing.

Inspect the optional-feature stable corpus (v0.11.0, v0.10.2, plus v0.10.0 and
v0.10.1 within the current 14-day corpus). Introduce a distinct peer-connections
capability; absent support hides the category/search result and a direct URL
shows update guidance, sending no unsupported peer request. Supported but
disabled servers show owner enablement. Do not broaden old capabilities or
change existing browser login/client behavior. The user authorized this optional
new settings surface and its guarded server API in this request.

## 5 — Qualification, independent reviews and commits

Use isolated real profiles and owner authentication. Exercise direct and owned
relay pairing, both directions, owner/password changes, fresh/unset persistence
and explicit opt-out, restart, wrong target/self-pair, failed/lost replies,
partial completion, cancellation/logout, reverse-route failures, disable and
revocation during work. Verify native private-API create/message/follow and
provenance through a UI-created pair, including newly added projects. Keep
crypto/persistence/malformed/revocation coverage meaningful and bounded.

Add focused browser qualification using a separately identified test Chromium:
real sequential typing under concurrent updates and populated lists with each
keystroke visible within 100 ms; pairing form success/failure, direction changes
and audit visibility. Capture/inspect actual final settings UI at 1000×600 and
375×812 through the repository artifact facility, one image at a time. No
primary browser/server or provider-host restart. Platform-specific claims need
actual evidence; don't infer Windows qualification from POSIX tests.

Use independent Sol 6.1 high and actual Daybreak Blue high reviewers through YA
for design and working implementation. Check correctness, authority/privacy,
UI clarity and the maintainer's trust model; include the real captures in UI
review. Reconcile/fix material findings and re-review before committing. Run
lint, format:check, typecheck, test and applicable CSS/console checks; typecheck
and tests run sequentially. Commit coherent reviewed slices on the current
branch with required model attribution; no push/deployment is implied.


## Implementation and qualification record

Delivered owner-only Server Connections settings, authenticated host metadata,
ordinary server-side owner SRP, direct/relay enrollment, independently renewable
control directions, runtime enablement, current/future-project trusted grants,
nonsecret audit and recent session attribution. SRP disk resume defaults on for
fresh/unset profiles and preserves saved opt-outs. The existing owner password,
peer credentials and optional fleet identity remain distinct authenticators.

Both requested reviewers ran through the existing YA API: actual `gpt-6.1-sol`
with high reasoning and `gpt-6-sol` with high reasoning and Daybreak Blue.
They approved final source and captured UI after fixing original/reverse source
policy preservation, cross-request policy revision fences, session-specific
cleanup, relay readiness before rotation, exact-generation removal and stale
activity rendering. No new PAKE/purpose protocol was added.

Qualification uses isolated profiles and real SRP, production direct WebSocket
admission and an owned real relay. It covers one/two-way setup, independent
renewal, scoped-policy preservation, future projects, wrong/self identity,
password independence, old-password pending proofs, source logout/disable,
partial reverse failure and native create/message/follow with trusted provenance.
The dedicated connection tests also protect capacity recovery after malformed
addresses. Broader existing core tests retain malformed, persistence, selected
credential, revocation and lost-reply boundary coverage.

An earlier full non-Android workspace run passed: 6691 server tests, 7063 client tests,
962 shared, 139 relay and 45 push-broker tests, plus the other workspace packages.
The final added policy/handshake regressions pass in the focused 11-case
connection suite. The final focused core/auth/settings run passes 116 tests in
20 files (15.11 seconds wall time); retained connection scenarios cover real
protocol, persistence and policy boundaries without provider/scanner startup.
The latest full run has 6692 server passes and one known
[Rendez watcher failure](../../gaps/rendez-nested-watch-event-after-restart.md)
at the second prepared-image delivery after restart; all 7063 client tests pass.
It remains recorded as failed, with no retries, watcher changes or wider budget. Lint, formatting, typechecking, CSS ownership and console-budget
checks pass; the unchanged console baseline is recorded in the existing
[runtime warning gap](../../gaps/runtime-cutover-tooling-warnings.md).

Two focused browser cases pass: independent direction requests and typed-URL
compatibility, with no unsupported peer request on older servers. Sequential
real typing is checked with 50 visible peers/64 total and concurrent metadata
updates, requiring every character and measured acknowledgement within 100 ms.
Desktop 1000×600 and phone 375×812 page/form captures were produced through the
artifact facility, inspected individually and reviewed. Local evidence is under
`.artifacts/ui-testing/2026-10-31-server-connections-final/` and ignored
`tasks/server-connections/`. The primary server/provider host was not restarted.

Windows qualification remains deferred as requested; this POSIX/Chromium run
makes no new Windows acceptance claim. Rich audit pagination, in-flow bulk
revocation alongside human password changes, fleet/read-only UI and mesh remain
follow-ups. Remote Access currently explains password independence and links to
explicit incoming revocation; local Stop use explicitly leaves the remote grant.

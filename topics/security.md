# Security

> Security is YA's trust-boundary contract: ordinary authenticated access has
> the power of a single server-account operator, while public shares and relay
> operators do not inherit that authority.

Topic: security

## Authority Model

YA is a self-hosted agent supervisor with one full-authority principal, the
superuser. Apart from the optional limited users below, it has no roles,
project access-control lists, or authenticated read-only/operator split. A
valid superuser local password session, desktop session, or Remote Access SRP
session reaches the same operator-facing API, including changing or removing
the local password ([connection-safe settings](connection-safe-settings.md)).
When local authentication is disabled, anyone who can reach an admitted server
endpoint has that same authority without first presenting a credential. When it
is enabled, every `/api` route except the `/api/auth` login and status routes
refuses a request that carries no valid credential; no operator route answers
ahead of the host, CORS, custom-header, and authentication checks.

Password guessing at `POST /api/auth/login`, for the superuser and limited
users alike, is throttled in memory: each client address may sustain five
rejected passwords a minute (burst five) and all addresses together thirty
(burst thirty). Every attempt holds a slot until its outcome is known, so
concurrent guesses cannot outrun the limit, and only a rejected password
keeps its slot, so correct logins are never charged. A refused attempt gets
HTTP 429 with `Retry-After` before any password is checked. The address is
the TCP peer, never a forwarded header, so clients behind one reverse proxy
share its limit. Restart clears the counters.

Browser origins earn credentialed CORS and YA WebSocket access only when they
are the allowed host being requested, a built-in loopback/private-network/Tauri
origin, or an explicitly allowed host. Any web page can mint the opaque
`Origin: null` with a sandboxed iframe, and anyone can publish one under
`*.ts.net` with Tailscale Funnel, so neither is trusted on its own. A
`*.ts.net` name remains an allowed Host, and its own pages keep same-origin
access.

The practical trust boundary is therefore **can use normal authenticated YA,
including creating or controlling an ordinary session**. That authority should
be treated as the authority of the operating-system account running YA. An
ordinary unsandboxed provider process can generally:

- read and modify anything that account can read or modify;
- run programs and use same-account services, sockets, credentials, and SSH
  access available to its process environment;
- inspect session history and send, steer, interrupt, or approve agent work;
  and
- change server settings or create another session with different provider
  permission choices.

This is intentional. Provider permission modes and approval prompts remain
useful safety controls, but they are not roles separating mutually distrusting
YA users. Run YA under a dedicated least-privilege OS account, VM, or container
when the serving account itself must be isolated from other host state.

Any restricted principal requires its own credential, server-side
authorization, and an enforced execution boundary. Limited users are the first
such layer; § Limited Users states the boundary they claim. Delegated guests and general hosted issuance remain proposals. The
[peer API](peer-access.md) implements a separate immediate-peer principal and
target-local project/operation grants over distinct SRP credentials; these do
not enter the legacy operator API. The [[principals-and-grants]] sketch records
the broader shared vocabulary. Hiding
controls, selecting a project working directory, or assigning a
narrower-sounding permission mode would not establish that boundary.

## Mobile SRP Implementation Decision

The maintainer accepted pinned RustCrypto `srp 0.7.0-rc.3` for the shared
mobile Rust core on 2026-10-01. This changes client implementation, with the
existing owner principal, SRP credentials, server protocol and authority
unchanged. The accepted limits and production verification requirements are
owned by
[mobile connection ownership](mobile-server-pairing.md#existing-server-compatibility).
Neither passing compatibility vectors nor an AI engineering review establishes
a formal cryptographic audit or whole-protocol constant-time behavior. A
possible future OPAQUE migration remains separate protocol work.

## Limited Users

Limited users are default-off (`limitedUsersEnabled`) named principals that
the superuser creates in Settings → Users. The product contract, including
every route decision, is
[`limited-users.md` § Delivery v1](limited-users.md#delivery-v1--settings--users).
This section states the boundary that layer claims and what lies outside it.

**Login.** A limited user authenticates with their own password: a direct
cookie login naming the username, or Remote Access SRP with the username as
the SRP identity under the host's relay name. The relay learns nothing new,
and the principal is bound before any API call. While the feature is on,
`srp_hello` does not disclose which names exist:

- an unknown or disabled identity gets a challenge against a decoy salt and
  verifier and fails only at the proof step;
- the decoy salt is derived per identity from a server secret persisted in
  `limited-users.json`, so it is stable for a name across hellos and restarts,
  and differs between names, as real salts do;
- every hello response is padded to a fixed floor; and
- every identity has its own hello limiter. The limiter set is capped with
  least-recently-seen eviction, and a limiter that is currently blocking its
  name is evicted only when nothing else can be, so spraying fresh names does
  not lift a lockout.

With the feature off, `srp_hello` behaves as it did before limited users
existed: an unknown identity is refused immediately, and only the configured
superuser name has a per-identity limiter. Turning the feature off also
refuses every limited login already in progress, including cookies, relay
sessions, and sockets; none falls back to superuser authority. A superuser
using **Act as** remains the superuser underneath and regains full access on
logout. A limited user's logout ends the cookie or relay session it used, and
changing that user's password or deleting the user ends all of them,
including saved relay resume credentials; an already open connection is cut
off at once only by disabling the user.

**API.** One server-side middleware ahead of every route judges a limited
principal and denies by default: an unlisted path answers 403, and an
ungranted project or session answers 404. It judges the percent-decoded path
the router dispatches and takes project grants only from ids in that path. A
session resolves to its project through the live process or the retained
session catalog; a session that resolves to no project, or to two, is refused.
The following are refused outright:

- host administration and settings writes, plus the secrets and host inventory
  in the settings document;
- devices, public shares, operator app links and host-wide artifact grants;
- absolute-path file reads, file editing and bang commands;
- Issues & PRs; and
- remote-access and connection inventory.

A `/api/ws` socket acts for its whole lifetime as the login that opened it.
Its tunneled requests receive the same decisions as direct requests. A
subscription is judged by every id its channel reads. The activity channel,
filtered by event type and denying by default, passes an event only when it
names a project the user may read. Hiding a control in the client is cosmetic.

The explicit file-address exception under `/api/artifacts/vhost-sites` requires
Allow public apps and Start sessions access to the selected project. Its handlers
authorize the supplied project themselves, persist the authenticated creator,
refuse replacement or release of another creator's mapping, and confine all
served paths to that project's canonical root. Incoming requests recheck the
creator's current grants. Other artifact and public-file-share routes remain
refused. See [file vhosts](active-content-security.md#file-vhosts).

**Execution.** Every provider process a limited user starts or resumes runs
in the project-write sandbox on this host, under the user's
provider/model/effort lock. This covers create, resume, reactivate, a fork or
clone copy once it runs, Project Queue dispatch, and a template creation's
preparation session. The sandbox includes its network firewall, so the agent
cannot reach the YA listener, local-network services, or unauthenticated
localhost services such as the maintenance server. A new session is forced to
project-write with the firewall on, and a request that turns the firewall off
is refused; an existing session must already run sandboxed with its firewall
on. The same holds for acting in a session someone else started: a join grant
sends turns, approves tools, interrupts, and changes the permission mode only
of a session whose process runs that way, never of the superuser's unsandboxed
or firewall-off ones. Remote
executors and computer control are refused, as is every other session action
that launches a process, such as restart, recap, rewind, and clearloop. The
sandbox keeps its own preconditions: enforced authentication, Linux, and a
supported provider. When they are not met, the launch fails; it never falls
back to an unsandboxed process.

**Project creation.** A limited user adds a project only strictly beneath
the directory the superuser configured for them, judged where the filesystem
resolves it: symbolic links on the way are followed, and a project path that
is itself a symbolic link is refused. The check runs again once the directory
exists and before the project is registered, so a link swapped in during the
request can at worst leave an empty repository outside that directory; it is
never registered as a project. Creating a project grants its creator
new-session access to it, as an ordinary grant the superuser can revoke.

**Outside the boundary.**

- **The sandbox confines writes, not reads.** Files the server account can
  read remain readable to a limited user's agent, including other users'
  projects. The layer claims no confidentiality, credential-isolation, or
  exfiltration protection. Limited users' sessions spend the host's provider
  accounts, bounded only by their lock.
- **One process serves every principal.** All users share YA's process, event
  bus, and data directory. Isolation is authorization plus per-session
  filesystem confinement, not process-level tenancy. A defect in the
  middleware, or a route that answers before it, breaches the boundary for
  every limited user at once.
- **Unsupported hosts start nothing.** On a host where the sandbox cannot run,
  a limited user can view sessions but can neither start one nor act in one.

## File Access Is A Viewer Policy

Settings > Local Access > **File access** controls which directories YA's
authenticated HTTP file viewers may read through the local-file, local-media,
and absolute project-file routes. Its default omits the server account's home
directory, and path resolution prevents traversal or symlink escape from the
configured prefixes. This is defense in depth for the browser/API file doors.

It does **not** constrain provider tools, terminals, commands, source-code
processes, or an SSH-backed provider. Turning off **Home folder** therefore does
not prevent an authenticated operator from asking an ordinary agent to read a
home-directory file. Pinning `ALLOWED_FILE_PATHS` makes the viewer policy
read-only in Settings; it still does not create an agent sandbox. See
[`docs/tactical/018-file-access-scoping.md`](../docs/tactical/018-file-access-scoping.md).

The separate **Sandbox session / Project writes only** launch option is the
intended host-enforced boundary. On supported local Linux Claude-family and
Codex sessions, Bubblewrap prevents direct persistent writes outside the
canonical project and YA-owned private state. It is default-off and permits
reads outside the project. Its subordinate, default-selected **Network
firewall** preserves public IPv4 egress while denying host-local and private
destinations; explicit opt-out restores shared host networking. Neither mode
claims general hostile-code, confidentiality, credential-isolation, or
exfiltration protection. Unsupported providers, non-Linux hosts, and SSH
executors cannot use it.

Local operator authentication is not a prerequisite for **Project writes
only** (maintainer direction, 2026-09-27; it previously was, and blocked
relaxing auth while a sandbox ran). With password or desktop authentication
absent, `--auth-disable` on, or localhost-open access on, New Session shows a
standing warning on the enabled sandbox: an agent that reaches YA — readily
so with the network firewall off — can drive it and escape. Authentication
remains independent defense in depth, now the operator's choice.

`auth.json` fails closed, and so do `limited-users.json`,
`remote-access.json` and `project-metadata.json`, whose project ownership
backs limited users' grants. Each is saved by atomic replacement, never
rewritten in place, and only when its content changes: checking a login does
not write `auth.json` (it once stamped a last-active time and saved on every
request), and shutdown itself writes none of them. It only waits for
credential saves already under way (and the relay session cache's) before
exiting. A file that exists but cannot be read, or an `auth.json` with an
unrecognized version, stops startup with an error naming it; the file is left
as it is. Only a missing file means never configured. The other data-directory
state (relay session cache, browser profiles, network binding, recents, push
subscriptions, notifications) is also saved atomically but still starts fresh
when unreadable, since losing any of it costs a sign-in or a preference, not
an authorization decision.

Authentication startup failures name the file and distinguish empty,
zero-filled, invalid/truncated JSON, and unsupported format/version data.
They never include file contents or JSON parser excerpts. Recovery instructions
require preserving a backup first, then explicitly restoring a known-good file
or moving the damaged file aside and restarting to reset local access. A reset
invalidates previous local logins and requires reconfiguring local authentication;
startup never automatically resets or rolls back authentication.

Saves of local authentication, limited users, remote-access credentials, relay
resume credentials, and project ownership sync and close the staged file before
atomic replacement, then sync the parent directory where supported. A failure
before replacement leaves the previous file intact and removes staging. A
directory-sync failure after replacement is reported even though the new file
is already visible. File-sync failures are always fatal to that save. Windows
tolerates only the known unsupported directory-sync errors; it still flushes
file data, but does not claim the directory durability available on Linux/macOS.
Atomic replacement retries transient Windows sharing/permission errors with
at most 175 ms of total backoff; a permanent error still rejects the save and
preserves the previous file. Other-platform errors are propagated immediately.
Observed 2026-09-28: a restart interrupted an in-place save, the server
treated the empty file as a fresh install, and with no password left, a
browser holding the owner's desktop session was the owner again even while a
limited user was signed in there. Deleting `auth.json` is the deliberate
reset.

### Diagnostic SRP credential retention

The default-off Development option **Retain rejected SRP sessions for debugging**
extends the lifetime of locally stored authentication material after received
refusal or known protocol incompatibility. The retained base key may still be
valid: a plaintext refusal does not prove permanent invalidity. Retention is
bounded to 72 hours from first quarantine, one per exact endpoint/mode/server
name/identity, eight total, and requires Web Locks. Expiry is pruned when the
origin runs, not a promise of secure timed erasure while closed. Explicit logout,
host removal, opt-out and debugger forgetting erase it; fresh login may coexist.

The separate archive is never an automatic resume source or a portable backup.
The opted-in console helper returns metadata and bounded outcomes, never keys,
and probes with normal server-proof verification and protocol pinning. This adds
no permissions or authentication bypass. Same-origin script access to stored
keys is the existing storage risk extended in time. The [SourceTransport contract](source-transport.md#optional-rejected-session-diagnosis)
owns the storage and probe lifecycle; the [debugging runbook](../docs/development/debugging.md#rejected-srp-resume-credentials)
owns operation. Server refusal reasons remain local and structured; public
responses do not disclose validity details.

### Authentication audit

Every login, logout, password setup or change, authentication enable or
disable, localhost-access change, limited-user create, update, delete or
switch, remote-access credential or relay change, and `--setup-auth` password
reset is recorded in `<dataDir>/logs/auth-events.jsonl` (owner-only, rotated
with gzip at 10 MB) and in the server log as `event: "auth_event"`. An entry
names the event, outcome, account, a short failure reason, the transport
(`direct`, `relay` or `cli`), the client address and user agent. It never
carries a password, hash, cookie or token; an update records which kinds of
fields changed, not their values. Recording never blocks the action it
describes. This exists so a changed credential state can be attributed to a
request or to the command line after the fact: the 2026-09-28 empty
`auth.json` could be ruled out as a remote change only by elimination.

Browser bearer tokens never appear in `auth.json`; it stores domain-separated
SHA-256 verifiers of the random tokens instead. Provider environments omit the
auth-cookie secret, desktop token, and provider-runtime control credentials.
A sandbox may read password hashes and session verifiers, but that material
does not authorize an operator request. With the firewall enabled it also
cannot reach the listener, local-network services, provider control sockets,
or host abstract sockets. Public remote services remain reachable, so network
confidentiality, credential isolation, and exfiltration resistance remain
outside this boundary. See [`session-sandboxing.md`](session-sandboxing.md) and
[`session-sandbox-network-boundary.md`](session-sandbox-network-boundary.md).

Agent-authored active documents are therefore significant defense-in-depth
hardening—important, but not a new general trust boundary—specifically for a
provider process running inside that project-write sandbox. If the operator
opens such a document on YA's authenticated origin, its script can borrow the
operator browser's ambient YA authority and act outside the process's
filesystem confinement. For an ordinary unsandboxed local provider the borrowed
authority is not new: that provider already runs as the local server account.

An SSH-backed provider is different. It holds only the remote SSH account and
its selected session environment, but a document it authored, served from the
local YA origin, would act as the local YA operator—creating or controlling
local sessions, changing settings, and reaching the local server account.
Remote-authored active content served locally is therefore a cross-host
privilege escalation, and the scriptless response policy below is load-bearing
for SSH executors, not redundant hardening.

YA applies the cheap backstop everywhere: active HTML, XHTML, SVG, XML, and
XSLT file responses are downloads with `nosniff` and a scriptless response
policy across local, project, upload, and public-share routes. The classifier
uses only MIME type and extension; it does not scan or sanitize contents.
Additional precautionary sanitization that is computationally heavy is
reserved for enforced project-write sandbox sessions. See
[`active-content-security.md`](active-content-security.md).

## Authenticated Remote Access And The Relay

The Remote Access password is a full operator credential, not a limited remote
viewer password. Full login uses SRP-6a: the server stores verifier material,
the password is not sent over the connection, and the client verifies the
server's `M2` proof before accepting the derived key. Protocol-3 resume requires
a server proof under the saved base key bound to fresh client and server nonces;
the client also rejects a downgrade below the highest authenticated resume
protocol version it has seen.

Application frames then use per-connection keys with NaCl secretbox
(XSalsa20-Poly1305) authenticated encryption and sequence checks. The ordinary
relay forwards the resulting frames without receiving those keys. Relay mux
wraps several independently authenticated circuits in one physical WebSocket;
it does not share SRP or NaCl state between YA servers.

Given trusted client code and uncompromised client/server endpoints, a
malicious relay operator cannot passively read Remote Access application
contents or uploads, learn the password or session key, silently impersonate
the YA server after login/resume, or alter encrypted contents without
detection. The relay can still:

- observe endpoint addresses, relay usernames, channels/circuit grouping,
  server presence and advertised compatibility metadata, connection timing,
  and frame sizes;
- correlate hosts grouped on one mux connection and perform traffic analysis;
  and
- delay, drop, replay, reorder, or corrupt traffic, causing detectable failure
  or denial of service.

Remote Access is therefore content-private from the relay operator, not
anonymous, metadata-private, or availability-protected. This claim does not
cover public shares, which deliberately use a different plaintext relay path.

The server holds a relay connection only while Remote Access is enabled.
Disabling it keeps the password verifier and relay settings for re-enabling,
but closes the server's relay registration and does not reconnect, including
after a restart; only enabling, or saving a new Remote Access password,
connects again. Remote Access logins already established over the relay are
not ended by disabling. The relay may release a username that stays
unregistered for its reclaim period (90 days on the default relay).

The client is part of the trust root. Malicious JavaScript served by a hosted
client origin, a privileged browser extension, or a compromised packaged app
can steal a password or cached resume secret before transport encryption helps.
Use signed/bundled or locally served client assets when the threat model
includes compromise of both the relay and live hosted client delivery; see
[`trusted-client-packaging.md`](trusted-client-packaging.md).

## Multiple YA Servers And Orchestration

The implemented multi-host monitor and relay mux do not create server-to-server
trust. Each YA server retains an independent login, resume secret, encryption
key, source runtime, and failure lifecycle. A client compromise can still expose
every saved host credential available to that client, so adding hosts enlarges
the client's blast radius even though one host does not authorize another.

The proposed cross-host delegation service is a different boundary. Pairing a
server must create a distinct server-to-server principal rather than copy a
browser password, browser resume secret, or relay registration credential.
Grants remain explicit, directional, non-transitive, inspectable and revocable.
After enrollment, use by new eligible agent launches defaults on; the owner API
retains an opt-out. Local API opt-ins and immutable launch grants still apply. The relay remains an encrypted transport rather
than a peer registry or plaintext API proxy, and a controller must not receive
an arbitrary proxy to the worker's authenticated `/api/*` surface.

Most importantly, an incoming grant that can create or control an ordinary
unsandboxed session effectively delegates the target YA server account's full
authority. A project allow-list chooses an initial target; it does not stop that
session from reading or writing elsewhere. Provider and permission ceilings are
useful policy controls, but they are not an OS boundary. A grant may be called
"bounded" only when every path it authorizes is enforced at the target and its
remaining outside-read, network, IPC, credential, and privilege surface is
stated. Compromise of an armed controller must otherwise be modeled as
compromise of the worker's server account.

Federated super-session peers require an even stronger explicit trust decision.
They exchange sensitive transcript/provider bundles and transfer the right to
resume a session as the target account. The current proposal therefore calls
them mutually trusted peers; transport encryption and single-writer ownership
do not turn them into mutually untrusted tenants.

## SSH Remote Executors

Configured Remote Executors are aliases in the YA server account's
`~/.ssh/config`. YA launches the remote Claude-family provider through the
system SSH client with `BatchMode=yes`, runs it as the selected remote SSH
account, and synchronizes Claude session files with `rsync`. A home-relative
local project path is mapped to the remote account's home using the local
platform's path identity, including case-insensitive Windows drive paths; that
mapping selects a working directory and is not confinement.

An SSH-backed agent has the authority of the remote SSH account, subject only
to controls enforced on that remote host. Local **File access** settings do not
restrict it, and the current **Project writes only** sandbox is rejected for
remote executors because confining the local SSH client would not confine the
remote provider. YA may also forward a locally supplied `ANTHROPIC_API_KEY` to
the remote Claude launch. The remote host and account must therefore be trusted
with provider prompts, command/output contents, synchronized transcripts, and
any credentials deliberately made available to that launch.

Removing an alias from YA Settings removes the product entry point; it does not
revoke an SSH key, agent socket, remote `authorized_keys` entry, or other
host-level access. Restrict or revoke those at the SSH/OS boundary. A future
remote sandbox claim must be installed and attested by the remote execution
host before provider-controlled code runs.

## Desktop Loopback

The desktop loopback dashboard is authenticated local content, but a random
port or a localhost origin is not identity. The native shell must not expose a
long-lived desktop credential to renderer JavaScript.

Desktop v0 uses a private native/server startup secret to mint a short-lived,
single-use navigation code. Consuming that code establishes a host-only,
HttpOnly, SameSite=Strict session cookie. Bootstrap credentials and routes are
accepted only on the loopback listener, never optional LAN, relay, or
internally forwarded surfaces. Reload uses the cookie and must not require a
token in the URL, JavaScript module state, request header, or WebSocket query.

The implementation bounds bootstrap state to 16 codes with a 30-second
lifetime, 30 invalid attempts per minute, and 32 in-memory desktop sessions
with a 30-day server-side lifetime. State dies with the bundled server and is
never persisted. Because v0 serves plain loopback HTTP, its host-only cookie
cannot use `Secure`; it remains HttpOnly, SameSite=Strict, and path-rooted.

The loopback dashboard is a remote origin from Tauri's perspective and receives
no custom native-command capability. Packaged Tauri-origin diagnostic surfaces
receive narrowly scoped commands. See [`desktop-v0.md`](desktop-v0.md) for the
distribution, compatibility, lifecycle, and same-user-process threat model.

The signed macOS runtime grants `com.apple.security.cs.allow-jit` to Tauri's
executable signing targets because the bundled Bun/JavaScriptCore sidecar
cannot expose the JavaScript runtime required by the server under hardened
runtime without it. Tauri's shared signing configuration also puts the
entitlement on the native shell; it does not grant it to remote dashboard
content running in WKWebView. The release must not add the broader
unsigned-executable-memory, executable-page-protection, or
disable-library-validation exceptions.

## Public Read-Only Shares

Public shares are the deliberate exception to ordinary authenticated operator
access. They are default-off, unauthenticated bearer-link views: possession of
the full secret URL authorizes the selected live or frozen transcript and its
share-scoped file resources until the link is revoked. They do not authorize
session creation, messages, approvals, settings, source control, or the normal
authenticated file APIs. A per-tab viewer token is not identity and does not
prevent a bearer from reopening the URL.

This smaller authority still carries material disclosure risk. Shared
transcripts may already contain source code, secrets, file snippets, command
output, or crash logs. Live shares reveal later eligible content, and some
frozen shares must warn that linked files remain live when the filesystem cannot
provide the requested copy-on-write snapshot. Owners must review the content
and treat the bearer URL itself as a secret.

## Public Share File Access

Public read-only shares may open project files through a share-scoped public
route when the requested path is visible from the shared session content. The
viewer must not navigate into `/api/local-file`, `/api/local-image`, or
`/projects/.../file` directly, because those routes are authenticated/local app
surfaces and cause public viewers to fall into Remote Access login.

See [`attachment-storage`](attachment-storage.md) for the current legacy
project-relative `.attachments/` path and the app-data-only target. Physical
attachment location does not broaden these `/api/local-image` and
`/api/local-file` routes or constitute public authorization.

The current lightweight route serves project files whose relative or
project-root-absolute path is present in the shared transcript. Public clients
rewrite rendered local/project file links to `/share/:secret/file`, which fetches
`/public-api/shares/:secret/files` through the same relay and secret used for
the public session body. For rendered Markdown/HTML documents that are already
visible from the transcript, the route may also serve bounded local media assets
referenced by that document so public preview images do not fall through to
login-gated local routes.

Public authorization follows captured share-visible links; it is not a general
filesystem discovery facility:

- A frozen revision attempts a whole-project copy-on-write clone only when the
  actual project/app-data filesystem pair supports it. The clone is private
  app-data storage and does not authorize its unlinked contents. Authorized
  frozen file views resolve from the clone, so later source changes do not
  change those bytes.
- When CoW cloning is unsupported, retain the current behavior of resolving an
  authorized frozen link against the live project rather than making an
  unbounded physical worktree copy. Both the owner creation flow and public
  frozen viewer must persistently warn that linked files remain live and may
  expose later contents. An unexpected clone failure aborts creation instead
  of silently downgrading to that mode.
- A live share may refresh its allowed paths only from transcript-visible links
  or other deliberate share content, not from arbitrary project paths supplied
  by the public viewer. A frozen share may replay path-existence link decisions
  that were already known when captured, but it never answers new existence
  queries.
- The current transitive render-asset allowance is computed live from the
  referenced Markdown/HTML source. A CoW-backed frozen view resolves it within
  that frozen tree; a live-file fallback carries the same warning.
- Public endpoints should use captured opaque targets or exact allowed entries,
  not raw absolute paths, `..` traversal, or symlink-sensitive filesystem
  resolution chosen by the browser.
- CoW project snapshots omit symlinks. A symlink can otherwise escape the
  immutable clone and expose later external bytes while the share reports that
  linked files are frozen.

The design point is intentionally narrower than "the user could ask the agent to
cat that file." That argument applies to the authenticated operator, not to an
unauthenticated public share recipient.

Until a captured allowed-path set exists, public-share viewers must not follow
local/authenticated file links into the normal app. A share-scoped relay request
is acceptable for transcript-visible project files; otherwise blocking the click
with an explicit notice is preferable to falling through to Remote Access login,
which incorrectly suggests the public viewer should authenticate to read a
secret-link snapshot.

## Public Share Transcript Secrets

Public-share link scoping does not redact transcript text. `Read` snippets,
`Edit` context, and command output such as `env`, `printenv`, stdout, stderr,
test logs, and crash dumps can already contain secrets by the time a share is
created or served. Providers usually avoid reading or repeating obvious secrets,
but rare misses are expected over enough turns, so public-share safety must not
depend on provider restraint.

Interim UI contract: public share viewers warn that visible assistant
read/edit/command output should be considered public, with stronger wording for
live shares. Longer-term design should add content-aware censorship before
public share bodies are sent to unauthenticated viewers; see
[`public-share-content-censorship.md`](public-share-content-censorship.md).

## Public Share Relay Privacy

Normal authenticated Remote Access is relay-mediated but end-to-end encrypted.
Public shares are different: current public-share relay requests carry the
share URL secret, request path, and response contents as plaintext relay
payloads. The relay transport still uses WSS to protect the browser-to-relay hop
from ordinary network observers, and the current relay forwards without logging
share payloads, but a relay operator who inspects frames can see public-share
contents and bearer secrets. The operator can also modify or replay those
plaintext requests and responses; WSS authenticates only the browser-to-relay
hop. Public shares should therefore be described as unguessable bearer-link
read-only views, not as relay-operator-private or end-to-end authenticated
views. See
[`topics/relay-origin-and-share-gating.md`](relay-origin-and-share-gating.md).

## Review Contract

This topic states the intended security boundaries; it is not a certification
that every implementation path satisfies them. A security review should treat
an unexpected authority widening, public-to-authenticated route crossing,
relay plaintext leak, missing target-side enforcement, or misleading UI claim
as a finding. Ordinary superuser login and session creation still mean full
server-account authority. For a limited principal, § Limited Users is the
boundary: any path by which one reaches superuser or server-account authority
beyond its stated exclusions is a finding. So is any change that widens an
exclusion or adds a new restricted principal without first updating this
contract.

## Related Notes

- [`active-content-security.md`](active-content-security.md) records the
  confirmed same-origin active-document execution path, the scriptless file
  contract, and the isolated-origin requirement for agent-built applications.
- [`docs/tactical/000-relay-origin-and-share-gating.md`](../docs/tactical/000-relay-origin-and-share-gating.md)
  records the current public-share relay, opt-in, and revocation decisions.
- [`public-share-content-censorship.md`](public-share-content-censorship.md)
  records the proposed content-aware redaction layer for public transcript
  output.
- [`session-sandboxing.md`](session-sandboxing.md) defines the implemented
  Linux project-write mechanism, its localhost authentication invariant, and
  the additional admission work a future interactive “locked to this session”
  share would require.
- [`relay-client-mux.md`](relay-client-mux.md) keeps each host's authentication
  and encryption independent while sharing a physical relay connection.
- [`managed-runner-execution-targets.md`](managed-runner-execution-targets.md)
  records the default-off controller/subordinate trust shape, target-side
  runner lease, credential boundaries, and future restricted collaborator
  requirements.
- [`managed-remote-executors.md`](managed-remote-executors.md) defines the
  manual-SSH-first subordinate runner, controller-mediated Git transfer,
  no-forwarded-credential baseline, and target-account trust boundary.
- [`cross-host-delegation.md`](cross-host-delegation.md) and
  [`federated-super-sessions.md`](federated-super-sessions.md) record the
  proposed server-to-server trust and orchestration shapes.
- [`docs/project/remote-executors.md`](../docs/project/remote-executors.md)
  records the current SSH executor behavior and limitations.
- [`SECURITY.md`](../SECURITY.md) is the public security-policy entry point for
  reporting vulnerabilities and should stay operator-facing rather than carrying
  implementation-specific design contracts.

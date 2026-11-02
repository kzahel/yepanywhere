# Working Across Machines

> A discussion map for letting users and agents work beyond one machine:
> remote tools, execution placement, independent YA hosts, machine lifecycle,
> delegation, collaboration, and session migration.

Topic: multi-machine-architecture

Status: **architecture discussion and evidence index**, 2026-09-13. This is the
starting point for comparing approaches, not a selected implementation or a new
wire contract. The specialist topics linked below retain their decisions,
approval gates and support limits. The [roadmap](../docs/roadmap/README.md)
continues to prioritize app publication and continuous delivery.

On 2026-10-03 the maintainer selected **persistent, target-owned YA sessions
over the public relay** for their installed hardware. Explicit directional
relationships let agents coordinate work without making every saved host or
shared account mutually trusted. The
[first-slice plan](../docs/tactical/144-relay-peer-session-coordination.md)
narrows [cross-host delegation](cross-host-delegation.md) to local/remote worker
creation and supervision. Its detailed implementation remains proposed;
hosted issuance, managed SSH provisioning, and conversation migration are not
prerequisites. The broader alternatives below remain relevant to other needs.

## The question we are trying to settle

A user should be able to use the right computer, operating system, checkout,
or device for a task without rebuilding their workflow around each machine.
Sometimes that means inspecting a remote desktop. Sometimes it means running
an agent next to a compiler or attached phone. Sometimes it means continuing
one conversation somewhere else, or letting another person participate.

YA has explored SSH executors, an injectable managed runner, independently
paired hosts, cross-host delegation, and super-session jumps. Machine Control
answers a related question through target-native tools, readiness, claims and
VM lifecycle. bb supplies a concrete central-server/host-daemon/bridge example;
T3 Code and other projects supply additional remote-environment patterns.

These are partly alternatives and partly composable layers. Choosing “mesh,”
“daemon,” or “grants” alone does not choose an architecture. The most useful
starting question is: **which component owns the work when the initiating
machine disconnects?**

## Separate the design axes

| Decision | What it determines | Choices and distinctions |
| --- | --- | --- |
| User intent | What must happen elsewhere | Observe, operate tools, run a separate worker, continue a session, or collaborate |
| Session authority | Who owns the YA identity, catalog entry, control ordering and recovery | Initiating controller, execution node, central hub, or explicit transferable owner |
| Process lifetime | What must remain alive for accepted work to continue | Browser-independent, API-server-independent, controller-independent; these are separate guarantees |
| Deployment | What software the target needs | Existing full YA, headless YA service, dedicated subordinate daemon, injected single-session runner, or native tools only |
| Topology | Which components know and depend on one another | One controller with workers, directed peer relationships, several independent sources, or replicated mesh |
| Authorization | Who may request which operations | Local account, SSH account, machine/session grants, participant grants, sandbox-enforced limits |
| Resource arbitration | Who may use a contended resource now | Session command ordering, workspace ownership, exclusive machine claim; a usage claim is not an access credential |
| Transport | How authenticated operations reach an owner | Local IPC, SSH stdio/tunnel, direct LAN/Tailscale, encrypted relay, or managed proxy |
| Discovery and enrollment | How identity and authority are established | Explicit SSH alias, local target registry, browser-assisted pairing, server enrollment, optional account directory |
| Workspace placement | Which exact files the agent acts on | Existing target checkout, transferred committed base, managed Git worktree/clone, or VM filesystem workspace |
| Machine lifecycle | Who starts, wakes, claims, snapshots or removes resources | User, Machine Control adapter, infrastructure plugin, or external scheduler |
| Session continuity | What crosses an execution boundary | New worker with bounded context, fresh handoff thread, fork, or same-session provider-state migration |
| Collaboration | Which people/agents may observe or intervene | One operator, multiple viewers, scoped send/approval/control rights; execution location is independent |
| Extensibility | Who supplies agents, tools and infrastructure | Built-in adapters, native provider tools, external CLIs, or a general plugin SDK |

**Peer-to-peer** can mean independent ownership even when traffic goes through
a relay. **Mesh** additionally suggests broad connectivity or replicated
membership; neither is necessary for a few directed relationships. **Master**
and **worker** describe roles for some operation, not necessarily permanent
machine classes. A manager agent conversation is also distinct from the
server that stores and dispatches its work.

## Keep the coordinates explicit

A useful execution record needs to distinguish:

- **Session owner:** the service responsible for authoritative session state.
- **Execution machine:** where the provider adapter and harness run.
- **Project workspace:** the exact checkout/path/revision being used there.
- **System under test:** the computer, browser or device being controlled.
- **Infrastructure controller:** the endpoint that can start or recover that
  system, which may be a different hypervisor or device host.

A Mac agent can build from a Mac checkout and test an attached iPhone. A Linux
agent can operate a Windows resident remotely. A Windows worker can use the
same resident locally. A stock phone need not be able to run YA to be useful.
See Machine Control's [placement contract][mc-placement].

Likewise, a **Git workspace** and a **VM workspace** are different resources.
A Git worktree isolates repository files while sharing a machine; a derived VM
can isolate an entire filesystem and OS environment. A VM may contain several
Git workspaces. Their cleanup receipts and usage reservations should not be
collapsed into a generic “environment id” without preserving those meanings.

YA already has a concrete source-location defect: remote session links and
project views can resolve against local files. Any model must fix the
[remote project-view gap](../gaps/remote-session-project-views-use-local-files.md)
and preserve the same distinction for
[sibling worktrees](../gaps/session-worktree-file-links.md). Matching relative
paths are not proof that two files are the same resource.

## Compare the approaches by ownership

This table compares shapes. Implementation status is recorded separately below.

| Approach | Session / execution owner | Target requirement | Initiating machine disappears | Main benefit / cost |
| --- | --- | --- | --- | --- |
| Remote machine tools | Original agent stays where it is; target tools own individual operations | Machine Control/native resident, SSH, CDP, ADB, etc., according to capability | No further reasoning from the original agent; accepted target actions may already have happened | Reach another OS/device without starting another agent; remote tools and evidence need correct routing |
| Multi-server client | Each YA server owns its sessions; client combines views | Independent YA installations | Other servers remain independently useful | Easy incremental adoption; viewing several servers establishes no delegation trust |
| Released SSH executor | Controller owns YA session and adapter; remote Claude CLI executes | SSH/rsync, provider and corresponding checkout | No autonomous target YA session promised | Uses existing SSH setup; provider-specific filesystem and lifecycle assumptions |
| Managed injected runner | Controller owns YA identity/catalog; target runner owns one provider lease | Compatible injected artifact, runtime, provider and prepared workspace | Current baseline stops/resumes cooperatively; abrupt loss requires recovery/fencing | No second YA setup; controller remains authoritative and must recover uncertain execution |
| Central server + host daemons (bb) | Hub owns thread database; enrolled daemons own execution | Persistent daemon and provider environment | Loss of a viewing client differs from loss of hub; hub outage removes central API/control even if execution continues | One catalog and explicit placement; central availability and operational responsibility |
| Independent peer delegation | Target YA owns a new worker session; origin owns supervision relationship | Independent authorized target session service | Candidate policy can keep accepted worker work running; parent coordination pauses | No universal master; distributed authorization, discovery and result reconciliation |
| Super-session jump | One canonical session changes owner through explicit transfer | Compatible peer, workspace and portable provider bundle | Depends on which ownership generation committed; never permit two writers | Continuous conversation across OSes; transfer correctness and provider portability are substantial |
| Hybrid persistent services + disposable runners | Persistent nodes own local sessions; subordinate runners retain controller ownership | Service for everyday machines, injected runner for disposable targets | Defined per mode rather than inferred from transport | Adaptable deployment; two ownership profiles must remain visible and tested |

The last row is a **candidate synthesis from this discussion**, not an accepted
replacement for the managed-runner or delegation contracts. A persistent hub
may still be convenient for an always-on home server or lab. It need not become
a prerequisite for pairing two everyday machines.

## Machine Control's place in this map

Machine Control grew from ChromeOS testbed work into an owned interface for
native administration, desktop/device semantics, capture, input, lifecycle and
recovery. Its common CLI selects an authoritative adapter; that adapter may
use SSH, target-local IPC, a resident service, a hypervisor, CoreDevice, or ADB.
An arbitrary SSH endpoint therefore supplies some capabilities, not automatic
parity with every supported desktop/device target. [Overview][mc-readme],
[system map][mc-map], [readiness][mc-readiness].

Its important architectural contribution is that **operating a machine does
not require running an agent on that machine**. Agent placement is optional.
YA can delegate a Windows development task for local context and tools, or an
agent elsewhere can directly operate the Windows resident. Both use the same
native control contract. Outer hypervisor/KVM control remains a distinct
bootstrap/recovery route when the inner runtime is unhealthy.

| Layer | Current or proposed owner | Why it stays separate |
| --- | --- | --- |
| Provider conversation, transcript, approvals and worker result | YA session service | Machine control remains useful from CI, a terminal, or another coordinator |
| Machine readiness, start/stop and exact platform routing | Machine Control adapter | A running YA process is not proof that desktop/login/input is ready |
| Native UI, administration and observed effects | Machine Control resident/device provider | Target semantics matter whether the calling agent is local or remote |
| Exclusive VM use | Machine Control target-use claim | Prevents cooperative callers from interfering; does not authenticate a person or confer host authority |
| Disposable/candidate VM ownership and cleanup | Machine Control workspace receipt | Only the creating adapter with matching resource identity can safely remove it |
| Repository base, changes and integration | YA workspace mechanism plus ordinary Git/agent workflow | VM snapshots do not specify which source changes should return to a project |
| Session access and server-to-server delegation | YA grants (peer design still provisional) | Knowing a machine alias or holding a usage claim is insufficient authority |

The [claim contract][mc-claims] is implemented for accepted desktop VM adapters.
Claims expire, renew and carry fencing generations, but the current same-user
CLI profile coordinates cooperative callers. Claim attribution is self-asserted;
the opaque claim id is a selector, not bearer authentication. The
[workspace contract][mc-workspaces] separately supports persistent, isolated
and retained-candidate intent. These are reusable primitives, not substitutes
for YA's peer or participant grants.

The public source now lives in `machine-control`. Older `chromeos-testbed`,
`winvm-testbed`, `macvm-testbed` and related references in YA's appliance plans
are historical lineage, not instructions to resume development in legacy
repositories. Concrete target selection and availability belong in private
inventory; this discussion contains no deployed endpoints or target identities.

## Existing YA work and evidence

Use this map before starting another spike. `tasks/` was absent when this
synthesis was written; the related gaps and plans below were inspected.

| Work | Evidence / status (reviewed 2026-09-13; retirements updated 2026-10-26) | What it contributes |
| --- | --- | --- |
| [Released Remote Executors](../docs/project/remote-executors.md) | Removed 2026-10-26; historical Claude-family SSH/rsync implementation | SSH configuration and process transport experience; historical resume contract |
| [Reload-safe provider runtimes](reload-safe-provider-runtimes.md) and [host API](provider-host-api.md) | Implemented Linux/macOS Node source-checkout scope; distribution/runtime restrictions remain | Complete provider owner survives Hono replacement; local control, event sequencing and recovery |
| [Core service API](core-service-api.md) | Headless/embeddable service remains a proposal | Candidate boundary for sharing session services without requiring the full UI |
| [Managed remote executors](managed-remote-executors.md), [tactical 119](../docs/tactical/119-managed-ssh-executor-baseline.md) | Removed 2026-10-26; historical operator-only proof | Injected provider-neutral runner, manual SSH, exact-commit workspace round trip, Codex auth projection and transcript mirror |
| [Managed runner targets](managed-runner-execution-targets.md), [tactical 118](../docs/tactical/118-managed-runner-mvp.md) | Withdrawn with managed SSH retirement | Machine Control as a target provider around the managed-runner baseline |
| [Cross-host delegation](cross-host-delegation.md) | Product direction/provisional API; nonfunctional hosts preview removed | Separate target-owned worker sessions, directed non-transitive grants, relay-first transport |
| [Federated super sessions](federated-super-sessions.md) | Proposal with provider portability/ownership gates | Same-session terminal jump, canonical identity and single-writer transfer |
| [Super-session appliance](../docs/tactical/073-super-session-testbed-appliance.md) | Historical proposed lab/prototype direction, not a shipped federation service | Native OS proving ground and out-of-band recovery; use current Machine Control owners |
| [Client source runtimes](client-source-runtime-topology.md), [simple client API](simple-client-api.md), [demo plan](../docs/tactical/130-simple-client-api-and-three-client-demo.md) | Source isolation direction plus implemented experimental multi-server web/Android slices | Clients can observe several independent owners without introducing a global server catalog |
| [Relay mux](relay-client-mux.md) | Optional compatibility-gated multiplexing contract | Several separately authenticated circuits over one socket; no implicit membership or peer trust |
| [Optional Computer Control](optional-computer-control.md), [tactical 131](../docs/tactical/131-optional-windows-computer-control.md) | Windows Node/local Codex preview accepted 2026-09-12; release delivery pending | Direct Machine Control IPC, session-selected grants and shared native implementation without a remote worker |
| [Agent self](agent-self.md), [session access](agent-session-access.md), [ask-session](ask-session.md) | Self-inspection implemented; broader coordination/ask proposals retain their own gates | Agent-facing identity, scoped controls and bounded results |
| [Workstreams](workstreams.md) and [yacron](yacron.md) | Proposed lanes; [general scheduler gap](../gaps/sketches/yacron-scheduler.md) remains | Workspace parallelism and durable dispatch are adjacent decisions, not consequences of multi-host connectivity |

Older high-level proposals can lag completed spikes. In particular, the managed
runner targets topic still contains early missing-protocol language; use
managed-remote-executors and tactical 119 for the accepted operator evidence.
Conversely, passing those diagnostic gates does not establish public placement
UI, all-provider coverage, active-turn reload survival or autonomous workers.

Manual directional peer enrollment has a [reviewed implementation contract](peer-access.md)
under [plan 168](../docs/tactical/168-peer-access-and-enrollment.md). It keeps
manual SRP credentials independent of the optional Identity Service; production
transport and enrollment qualification remain pending.

## External approaches and inspirations

This is an architectural reading map, not a refreshed feature leaderboard.
Dates identify the existing reviews being reused. bb and Machine Control have
source snapshots for this discussion; older rows are leads with the evidence
limits of their linked notes. A feature not described here is not proven absent.

| Project / family | Approach relevant here | Useful comparison / evidence |
| --- | --- | --- |
| [bb](../docs/competitive/bb.md) | Central SQLite server, enrolled execution daemons, provider bridges; plugins for providers, environments and workflows | Separates host/workspace/thread; concrete headless worker shape; central catalog remains authoritative. Source review 2026-09-13 |
| [T3 Code](../docs/competitive/t3code-remote-sessions.md) | Target-owned environment servers, credentials and workspaces; client catalog; direct/Tailscale/Connect and desktop-managed SSH | Independent services outlive clients; launcher-owned SSH servers have separate cleanup behavior. Fresh source review 2026-10-03 distinguishes reconnect from provider recovery. |
| [Paseo](../docs/competitive/paseo.md) | Daemon plus web/mobile/desktop/CLI; multiple host profiles and E2E relay | A client can know several daemons without implying daemon-to-daemon delegation. Source notes 2026-03-16 |
| [HAPI](../docs/competitive/hapi.md) | CLI wrappers communicate with a hub; hub serves web clients and routes machine RPC | Wrapper/hub split differs from provider ownership on an autonomous peer. Older note has an explicitly unverified repository URL; re-audit before deriving lifecycle guarantees |
| [Happy](../docs/competitive/happy.md) | Local CLI and mobile/web client with encrypted relay | Remote supervision can preserve content privacy without moving execution. Historical review 2026-02-03 |
| [emdash](../docs/competitive/emdash.md) | PTY/terminal-oriented agent workspaces; existing ecosystem notes also identify SSH | Terminal compatibility and worktree management are different from structured provider sessions; exact remote lifetime needs a fresh audit |
| [Conductor](../docs/competitive/conductor.md) | Parallel agents in local isolated workspaces | Parallel work need not involve several machines; historical local-workspace reference |
| [AionUi](../docs/competitive/aionui.md), [Codexia](../docs/competitive/codexia.md) | Desktop/web supervision, scheduling and remote/messaging surfaces in existing reviews | Alternate entry points and automation do not establish peer ownership or session portability |
| [ssh-to-go](../docs/competitive/community-projects.md#ssh-to-go), [ClawIDE](../docs/competitive/all-projects.md) | tmux/terminal access and persistent shell-oriented work | Reattachment to a terminal is a useful baseline, with different semantic control and history guarantees |
| [CodeRelay, Codex Pocket](../docs/competitive/all-projects.md) | Mobile web access to provider control through a private network | Low-friction access without requiring fleet membership; retain the distinction between remote client and remote executor |
| [claude-devtools](../docs/research/claude-devtools.md), [Farfield](../docs/competitive/community-projects.md#farfield) | Read provider history remotely or expose an existing desktop session through local IPC | Observation or attachment can avoid owning a new runtime; capability depends on what the original owner exposes |
| [Codex App](../docs/competitive/codex-app.md), [Claude desktop/Remote Control](../docs/competitive/claude-code-desktop.md), [remote-control discussion](../docs/blog/claude-code-remote-control.md) | First-party local/remote/cloud entry points described in existing reviews | Hosted execution, remote UI and same-session continuity must be evaluated separately; historical references, not a current protocol audit |
| [Gas City / Gas Town / Mission Control](../docs/ecosystem/gas-city.md) | Roles, worker routing, desired-state reconciliation and an operator UI discussion | A principal/manager agent is an orchestration policy, not inherently the server authority or network topology. Discussion 2026-08-30 |
| [Subtrate](../docs/ecosystem/subtrate.md), [agent mail / queues](../docs/ecosystem/README.md) | Durable identity, messages, work records and cooperative file leases | Coordination can happen above native sessions; a mailbox is not execution placement, and a file lease is not a host grant |
| [Composio Agent Orchestrator, agtx, ccswarm, AgentYard, Claude Octopus](../docs/ecosystem/README.md) | CLI-agent orchestration and parallel workspaces in the research catalog | Worker scheduling and work distribution can be separate consumers of YA's runtime |
| [Claw runtimes](../docs/competitive/README.md#the-claw-ecosystem-adjacent-category), [workflow/framework projects](../docs/ecosystem/README.md) | OpenClaw and relatives own agent loops; n8n/Dify/Langflow and LangGraph/CrewAI/AutoGen own workflows or agent composition | Potential callers/coordinators; neither an LLM loop nor a workflow graph determines machine ownership |

The [complete project catalog](../docs/competitive/all-projects.md),
[community notes](../docs/competitive/community-projects.md),
[competitive index](../docs/competitive/README.md) and
[ecosystem index](../docs/ecosystem/README.md) retain the remaining known names,
including messaging bridges and device/desktop clients. Follow those indexes
rather than duplicating every project as a superficially equivalent architecture.
Machine Control also maintains [adjacent-project research][mc-research] for
native controls and remote-desktop implementations.

## What to take from bb's daemon and plugin boundaries

bb separates the server's thread model, the host's execution/workspace model,
and the provider bridge's semantic translation. YA's reload-safe worker already
provides a related process-lifetime seam. Making it remotely reachable does
not automatically supply enrollment, workspace routing, grant enforcement,
version distribution or independent session recovery.

A dedicated daemon may be simpler to deploy than the entire YA application.
It is not automatically a simpler ownership model. If the daemon depends on a
hub for its catalog, approval routing, credentials and accepted input, the hub
remains an availability dependency even while provider processes survive.

An autonomous **headless YA service** would need a larger subset: stable
identity, durable session records/native transcript access, local control
ordering, authorization, reconnectable observation, and direct client access.
The candidate is shared implementation with the ordinary installation, not
another independently maintained provider stack. Whether this is one package
with optional surfaces or a smaller distribution is an open packaging decision.

bb's plugins are a separate architectural axis. Its Tasks plugin combines UI,
persistent records, agent CLI and instructions; environment plugins add machine
or workspace provisioning. That explains their value beyond adding tools to a
prompt. YA can learn from those contracts or call Machine Control through an
adapter without adopting a general plugin platform. A public plugin SDK adds
compatibility, lifecycle and trust obligations of its own.

## Candidate hybrid and its limits

The candidate discussed on 2026-09-13 is:

1. Persistent everyday machines can own their local YA sessions independently.
2. Another YA service may receive an explicit directed grant to create and
   supervise worker sessions there. Relationships need not be reciprocal or
   transitive, and no full mesh is required.
3. Clients may observe multiple authorized owners directly; a preferred home
   server can aggregate convenience views without silently owning every session.
4. Disposable targets may instead use subordinate runners whose controller
   retains session ownership. SSH or Machine Control can supply access and
   readiness according to the selected profile.
5. Shared provider/session machinery supplies both deployment modes, while
   ownership and failure semantics remain explicit to callers.

This retains an optional star topology without requiring one permanent master
for all work. It also preserves a cheap execution-substrate option. The main
cost is maintaining two honest lifecycle profiles and a user experience that
explains when the initiating controller must remain available.

Example: a laptop delegates a Windows build to a persistent desktop, then
sleeps. Under the proposed independent-worker policy, the desktop finishes
accepted work, retains its result and may accept a separately authorized phone
connection for approvals. The laptop reconciles when it returns. Its manager
agent cannot continue coordinating while asleep unless that agent itself runs
somewhere available. A daemon removes one dependency; it does not provide
universal failover or migrate reasoning automatically.

## Optional hosted discovery and grant issuance

Maintainer-agreed direction, 2026-10-31, extending the 2026-09-13 candidate:
an optional hosted or self-hosted account service can introduce clients to
enrolled YA servers. Authentication may use basic administrator-managed local
username/password accounts, an external OIDC provider, or a managed service
such as Clerk. OIDC and a central account service are not prerequisites for
YA or manual peer enrollment. The
[replaceable-authentication sketch](principals-and-grants.md#replaceable-authentication-and-a-basic-local-configuration)
owns that boundary, including a production-usable minimal backend and isolated
testing. No vendor or library is selected, and hosted issuance remains
unimplemented. Each target explicitly chooses issuer trust and its local
ceiling; the relay acquires no authorization authority. Exact enrollment,
credential and grant protocols remain proposals.

| Hosted role | Authority delegated by the owner |
| --- | --- |
| Relay only | Forward encrypted traffic; no right to admit clients or peers |
| Discovery/account directory | Help find enrolled servers and candidate routes; each target still separately approves access |
| Trusted grant issuer | Issue access grants within an explicitly enrolled server's local policy; target verifies issuer, recipient, scope, validity and revocation |

These roles may share infrastructure without sharing credentials or authority.
The configured login backend establishes identity to the account service;
each YA server would separately opt into trusting its issuer key and define
permitted access.
A candidate grant binds an authenticated client/peer key to a target and action
set; possession of the corresponding private key must be proved. An issuer's
signing key is distinct from both Google's credentials and endpoint encryption
keys. Exact enrollment, handshake, key rotation and recovery remain design work.

Endpoint encryption can still keep the forwarding relay from passively reading
traffic. However, if the issuer may authorize a new endpoint key, a malicious
or compromised issuer can potentially grant itself access within its allowed
scope. That is the explicit trust tradeoff, not the existing relay-only privacy
model. Requiring an owner-controlled signature for new device keys is a stricter
alternative with additional enrollment friction; Tailscale's
[Tailnet Lock design](https://tailscale.com/docs/concepts/tailnet-lock-whitepaper)
is relevant prior art for separating directory service from device admission.

Convenient discovery does not require a network mesh. YA peers can establish
authorized encrypted circuits through the existing relay first, connecting
when needed rather than keeping every possible peer pair live. Direct
LAN/Tailscale or later NAT traversal can be additional routes for the same
identity and grants. [Hyperswarm/HyperDHT](https://github.com/holepunchto/hyperdht)
is a networking reference for discovery, hole punching and encrypted streams;
it would not settle YA session ownership, authorization or input ordering.
No P2P stack is selected here.

A useful earlier proof is two YA services communicating over an isolated relay,
then exercising relay restart, peer restart, reconnect, credential expiry,
revocation and duplicate-request recovery. Keep durable peer authorization,
expiring authentication credentials and per-connection encryption keys separate.
Current [SRP resume](mobile-server-pairing.md#current-srp-resume-facts) refreshes
idle validity and derives fresh connection keys, but retains an absolute
credential lifetime; resuming is not indefinite grant renewal. The
[peer credential questions](cross-host-delegation.md#identity-connectivity-and-grants)
remain open, including persistent unattended authentication. Hosted-service
outage policy must state which existing grants remain usable, when new access
or renewal stops, and how long revocation can take to reach an offline peer.
This is a proposed proof and trust option, not an executed test or approved
authentication protocol.

### Concrete hosted-account precedents

Source audit on 2026-09-13: both competitors already connect hosted identity to
machine admission, with different enforcement boundaries. Source pins and the
live login-configuration check are recorded in the linked reviews.

| Question | [T3 Connect](../docs/competitive/t3code.md#hosted-login-and-admission-authority) | [bb connect](../docs/competitive/bb.md#hosted-login-and-admission-authority) | Candidate YA issuer |
| --- | --- | --- | --- |
| Account login | Clerk; public configuration enables Google, GitHub, Apple and Microsoft | Better Auth with GitHub | Optional identity provider; Google is one possible choice |
| Explicit enrollment | Install linked user, relay issuer and cloud mint public key on the environment; enable managed endpoint | Redeem account pairing code; server holds outbound-tunnel credential | Owner installs issuer trust and local policy |
| New-client admission | Cloud signs a client-key-bound request; environment checks it and issues a short-lived credential | Hosted proxy checks account session or machine credential against destination ownership | Target verifies a key-bound grant within local policy; protocol undecided |
| Permission boundary | Fixed standard environment scopes, including terminal operation | Same-account access with some machine-route restrictions | Target/action scopes still to design |
| Hosted authority | Can authorize new client keys for the enrolled account | Can admit clients and proxy application traffic | Explicit opt-in admission authority, distinct from relay-only service |
| Multiplayer implication | Reviewed managed flow binds an owner; no project/session invite policy established | Reviewed checks require the same account; no second-user role policy established | Sharing roles require an additional policy model |

T3 is particularly close to the proposed trust enrollment: local issuance of
the final credential preserves local validation but does not remove the cloud's
power to admit a client. Neither social login nor a hosted directory requires
a permanent user-selected master machine or a P2P mesh. The hosted option still
depends on service availability for new admissions, and the target runtime must
be reachable. A transport route and an access grant remain separate decisions.

## Multiplayer and participatory sharing

The existing [Participatory Live Share sketch](relay-origin-and-share-gating.sketches.md#participatory-live-share)
now proposes shared human discussion, owner-reviewed suggestions, and optional
explicit send, queue, and separate steer grants for one session. Multiple
participants fit the model; synchronized composer previews and grids are later
presentation candidates. [Session notes and discussion](session-notes-and-discussion.md)
owns the human-only space, also useful as a personal scratchpad. These are
proposals, not implemented participatory sharing.
[Restricted collaboration](managed-runner-execution-targets.md#future-restricted-collaboration)
separately explores read-only versus writable session/workspace grants.

These fit the collaboration axis regardless of where execution runs: two
people can share one session on one server, while one person can use many
machines. Participant grants govern human access; peer grants govern remote
delegation. The session owner sequences accepted input, while shared draft
text, typing indicators and cursor/selection presence need their own bounded
visibility and reconnect rules. Seeing someone type does not grant permission
to submit their text or control the provider.

Project-wide read/write sharing and live pointer/caret sharing remain open
extensions; the existing sketch specifies synchronized composer text, not
those broader contracts. Zed's Delta is the nearest external prior art for a
live multi-person agent thread; the
[DeltaDB review](../docs/competitive/deltadb.md) compares it and motivates
[named participant seats](../gaps/sketches/named-participant-seats.md) as the
display-attribution work alongside authenticated principals. “Write” must
distinguish sending agent input from editing files, approving tools, managing
sessions or publishing changes.
Today's [public bearer-link shares](relay-origin-and-share-gating.md#public-share-authorization)
remain read-only and must not silently acquire these rights.

Invitation-to-account convergence belongs to
[principals and grants](principals-and-grants.md#session-collaboration-and-future-accounts).
The hosted-discovery section above remains the optional issuer/trust discussion;
email invitations and external login do not themselves grant session access.

## Authority and failure questions to resolve

**A grant, claim, and ownership generation serve different purposes.** A grant
permits an authenticated principal to perform operations. A claim reserves a
contended resource for a period. An ownership generation fences an obsolete
session writer or controller. Expiring one must not silently redefine the other
two. Existing [security](security.md), [session ownership](session-ownership.md),
[delegation](cross-host-delegation.md) and [Machine Control claims][mc-claims]
are the constraints for a concrete design.

In particular, a project allow-list is not containment for an unsandboxed
provider with the remote account's filesystem, credentials and shell authority.
Future multiplayer needs actual restricted principals and enforcement; pairing
two personally trusted machines does not establish multi-tenant isolation.

Before selecting the hybrid or a simpler model, resolve these observable cases:

| Scenario | Decision or proof needed |
| --- | --- |
| Browser closes / phone sleeps | Execution continues independently; reconnect does not duplicate accepted input |
| Initiating laptop sleeps | Does accepted worker work continue? Who can answer approvals, renew resource claims and retrieve results? |
| Controller dies after a create request was accepted | Durable operation identity and target-side deduplication; timeout is not permission to launch a second worker |
| Target becomes unreachable | Distinguish unknown state from stopped; prevent a second provider writer or duplicate external effect |
| Target comes back under a new address | Stable authenticated identity independent of URL, relay username and inventory alias |
| Grant expires or is revoked during work | Define creation, observation, control, active execution and in-flight data delivery separately; state the local continuation/stop policy |
| A second controller or participant sends input | One authoritative ordering and explicit approval/interrupt rights; no informal takeover |
| Server/provider/daemon versions differ | Capability negotiation and accepted-artifact policy; who upgrades what without interrupting unrelated work? |
| Controller-held provider credentials expire | Which service owns refresh and may keep executing? Authentication portability is separate from provider protocol compatibility |
| Work finishes on a remote checkout | Preserve exact artifact/file source and result retention; fetching commits is separate from integration |
| VM claim expires or cleanup starts | Resource arbiter and session owner agree on bounded use, process lifetime and retention; no deletion inferred from a lost socket |
| Guest YA/native control fails | An independent Machine Control recovery route remains available where the platform supports it |
| The same conversation must move | Explicit provider bundle transfer and single-writer handoff; reuse the super-session gates rather than relabel a new thread |

The minimum persuasive experiment should demonstrate a useful user workflow
through disconnection and recovery, not only a successful remote start. The
[relay peer plan](../docs/tactical/144-relay-peer-session-coordination.md)
now proposes that bounded experiment for installed hardware. The accepted
managed-SSH spike remains separate evidence for controller-owned execution;
it does not need further expansion before peer work.

## Suggested reading paths

- **Choosing ownership and topology:** this document →
  [cross-host delegation](cross-host-delegation.md) →
  [managed remote executors](managed-remote-executors.md) →
  [bb comparison](../docs/competitive/bb.md).
- **Reusing existing execution code:** [provider host API](provider-host-api.md)
  → [reload-safe runtime](reload-safe-provider-runtimes.md) →
  [managed SSH evidence](../docs/tactical/119-managed-ssh-executor-baseline.md)
  → [core service proposal](core-service-api.md).
- **Using other computers and devices:** [Machine Control system map][mc-map]
  → [placement][mc-placement] → [readiness][mc-readiness] →
  [claims][mc-claims] → [VM workspaces][mc-workspaces].
- **Continuing or sharing a conversation:**
  [participatory live sharing](relay-origin-and-share-gating.sketches.md#participatory-live-share)
  → [restricted collaboration](managed-runner-execution-targets.md#future-restricted-collaboration)
  → [security](security.md). For moving the same conversation between machines,
  follow [super sessions](federated-super-sessions.md). Multiplayer authority
  remains a distinct open design, not an implemented consequence of federation.

## Evidence maintenance

Machine Control references below are pinned to the inspected public-source
commit `44afda2b8be70c267d7ad9986286fb32c188973c` (2026-09-12).
The bb analysis pins `cf51227e1135309a3c9c0baf5630be1ca7ba2714` (2026-09-13).
T3's broad comparison retains its 2026-09-04 snapshot; the focused
[remote-environment review](../docs/competitive/t3code-remote-sessions.md) pins
freshly fetched `fed41fa88bb27cb4325cb208d571393850bc63c2` (2026-10-03) and
details target-owned workspaces/credentials, SSH cleanup and restart recovery.
It informs these alternatives without selecting a YA runtime. This discussion
does not claim a new live runtime or cross-machine test run.

Update this map when an ownership decision is accepted, a spike gains live
support, or external evidence materially changes. Keep exact protocols and
platform acceptance in their owning topics; keep priorities in the roadmap.

[mc-readme]: https://github.com/kzahel/machine-control/blob/44afda2b8be70c267d7ad9986286fb32c188973c/README.md
[mc-map]: https://github.com/kzahel/machine-control/blob/44afda2b8be70c267d7ad9986286fb32c188973c/SYSTEM-MAP.md
[mc-placement]: https://github.com/kzahel/machine-control/blob/44afda2b8be70c267d7ad9986286fb32c188973c/topics/delegation-and-agent-placement.md
[mc-readiness]: https://github.com/kzahel/machine-control/blob/44afda2b8be70c267d7ad9986286fb32c188973c/topics/target-lifecycle-and-readiness.md
[mc-claims]: https://github.com/kzahel/machine-control/blob/44afda2b8be70c267d7ad9986286fb32c188973c/topics/target-use-claims.md
[mc-workspaces]: https://github.com/kzahel/machine-control/blob/44afda2b8be70c267d7ad9986286fb32c188973c/topics/vm-workspaces-and-storage-policy.md
[mc-research]: https://github.com/kzahel/machine-control/blob/44afda2b8be70c267d7ad9986286fb32c188973c/research/adjacent-projects.md

# Optional Computer Control

Topic: optional-computer-control

Status: direction and reference findings, recorded 2026-09-12. An isolated
MCP experiment passed; YA product integration and direct local transport are
not implemented by this work. Implementation is tracked in
[Tactical 131](../docs/tactical/131-optional-windows-computer-control.md).

## Intended experience and ownership

**Decision:** Computer control is an optional installed capability, default-off
and available only to eligible, authorized sessions. Installing or globally
enabling the component must not load its full instructions, start a worker, or
register a computer-control MCP server in every provider session. The requested
experience resembles Computer Use: discover a small capability description,
load its instructions when needed, and start the actual control machinery on
first use.

The primary deployment places YA, the agent execution environment, and the
Machine Control resident on the same machine. Use direct local IPC for that
path. A remote testbed transport is useful for validation but must not become
the mandatory product route.

Machine Control owns signed native packages, providers, the typed desktop
contract, generation checks, and optional privileged unlock enforcement. YA
owns installation controls, supervision, session eligibility and authority,
agent-facing advertisement, and result presentation. Existing Machine Control
CLI/appliance use must remain independent of YA. Unlock retains its separate
native installation, UAC approval, grant, and credential-custody flow.

This is an optional out-of-process native component, not a proposal to reopen
the banked general-purpose [server plugin architecture](server-plugin-arch.md).
Launch-time delivery and defaults belong to
[new-session agent tooling](new-session-agent-tooling.md); the existing
[agent command runtime](agent-command-runtime.sketches.md) remains a possible
CLI entry point.

## What the MCP experiment established

**Current evidence:** A separate YA server with temporary provider profiles
exposed four small MCP tools over authenticated, stateless Streamable HTTP.
Real Codex and Claude sessions discovered tool definitions, performed one
semantic Windows fixture action each, and consumed screenshot image results.
Independent fixture state confirmed the effects. No YA provider or resident
source changes were needed. Stale generations, unknown references and revoked
credentials were refused. The temporary processes, profiles and VM workspace
were cleaned up.

The controller and YA ran on macOS; Windows control went through the common
testbed CLI and SSH to the signed user resident. Tool calls took approximately
8–60 seconds. Cua became unhealthy and native UIA/PrintWindow fallbacks supplied
the accepted actions and captures. These are remote testbed measurements,
not local IPC performance or successful Cua-health acceptance.

**Limit:** Providers were explicitly configured with the MCP URL in their
temporary profiles. Lazy tool-schema discovery did not prove lazy process
startup, session-selective availability, or dynamic attachment to an already
running session. Model/transcript image acceptance also did not establish YA
browser rendering acceptance. The experiment is evidence for a possible adapter,
not a decision to make MCP the required product integration.

Exact versions and execution findings live in the
[Machine Control spike](../../machine-control-spike/docs/ya-computer-mcp-findings.md).
Native package ownership and acceptance live in Machine Control's
[distribution topic](../../machine-control/topics/native-distribution.md).

## Codex and Sky reference mechanics

**Observed installed implementation:** The application bundle serving the
investigated session contained Node 24.19.0, a persistent `node_repl` executable,
and `@oai/sky` version `0.6.17-202608171537-pr-1300023-7efba775c041`. The runtime
was under the ChatGPT app bundle; do not generalize that physical packaging to
every Codex desktop release.

The installed Computer Use skill supplies `import("@oai/sky")` explicitly. The
package is already in the host's module environment; the agent does not invent
its path or install it from npm on each use. The observed sequence is:

1. The agent sees the small skill description and reads the full API instructions
   when the task needs computer control.
2. The agent submits JavaScript to the host-provided persistent Node REPL.
3. Importing Sky sets up a proxy through `nodeRepl.rpc("sky", ...)`; the trusted
   service dispatches the SDK operations.
4. The Mac SDK lazily imports its native client on the first computer operation.
   A request creates/reuses the native transport.
5. The transport tries a local socket. If unavailable, it requests
   `ensureService` for `computer-use` through host services, or falls back to
   macOS Launch Services to start the installed service.
6. The native connection uses length-prefixed JSON-RPC with typed requests and
   a version handshake. Text and explicitly emitted screenshots return through
   tool results to the model.

Reinspection paths, relative to the installed `@oai/sky` package:
`package.json`, `dist/project/cua/sky_js/src/sky.js`, `service.js`, and
`targets/mac/{lazy-client,client,native-pipe}.js` under that same source directory.
These are distributed implementation observations, not a claim that Sky is an
open-source library available for redistribution.

**Current public-source evidence:** The audited Codex checkout was
[`ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8`](https://github.com/openai/codex/tree/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8).
Keep these execution layers distinct:

| Layer | Mechanism and evidence |
| --- | --- |
| Rust agent and App Server | The agent owns conversation/tool dispatch. A UI or supervisor connects through bidirectional JSON-RPC. The public repository includes this engine and protocol, not the complete desktop/Sky implementation. |
| Code Mode | JavaScript for orchestrating tool calls; current `codex-rs/code-mode-runtime/src/runtime/mod.rs` creates V8 runtimes. This is not the persistent Node package environment. |
| External Node REPL | Current `codex-rs/protocol/src/mcp.rs` recognizes `node_repl` and `cua_repl` tools. The installed skill/SDK use this persistent environment for Sky. Those hooks do not establish the desktop's exact process-launch implementation. |
| Historical built-in JS REPL | The older Rust implementation spawned a Node child with a kernel script and piped stdin/stdout, with configured module directories and lazy initialization. It was removed by commit `8a559e7938` on 2026-04-24. Do not describe that historical code as current desktop wiring. |

The installed Computer Use plugin also registered a launcher invoking
`SkyComputerUseClient mcp`. Therefore the observed distribution contains MCP
plumbing even though the SDK-to-native control connection uses separate local
IPC. The exact current desktop ownership and startup timing of the Node worker
were not established by inspecting the public repository.

The [App Server documentation](https://learn.chatgpt.com/docs/app-server)
also describes experimental `dynamicTools` and the `item/tool/call` exchange:
a client can implement tools and return content, including images, over its
existing Codex connection. This is a candidate YA integration mechanism, not
evidence that Sky uses that particular hook or that YA already handles it.

## Candidate YA implementation and acceptance questions

**Proposal:** Supply a compact discoverable skill plus a bundled SDK or CLI.
Start a supervised persistent JavaScript worker only when needed, if that
provider benefits from a REPL, and have its SDK reach the signed resident over
direct local IPC. Codex dynamic tools could expose the execution surface
without a dedicated computer-control MCP server. Other providers need their
own proven adapter; an MCP adapter may remain optional. Do not assume their
tool registration, mid-session activation, or image channels are identical.

Treat these as separate gates: package installed; feature enabled; session
eligible and authorized; instructions loaded; worker started; resident connected.
Only the last gates should incur runtime cost. Define bounded idle cleanup,
resume and crash behavior under [resource quiescence](architecture-mandates.md).
Preserve resident generation/reference checks and distinguish delivery from
independently observed effect. Never automatically retry uncertain input.

**Open:** Prove the direct local path and its latency; choose per-provider
registration and activation mechanisms; validate native image delivery and YA
rendering; define session grants, revocation and worker ownership; then scope
install/enable controls. Reuse YA's existing runtime where suitable and verify
Node/Bun and packaged-distribution behavior before adding another bundled runtime.
A general JavaScript evaluator is not same-user containment, and its existence
must not grant arbitrary privileged service execution.

## Agreed development and validation placement

**Decision:** Develop the next Windows slice in a native Windows development
session, with YA and Machine Control checkouts inside a claimed isolated VM
workspace. Local editing, builds and tests avoid a repeated Mac-to-Windows copy
cycle and exercise the intended same-machine deployment.

The controller first runs Machine Control's doctor and acquires the workspace
and exclusive claim. A Windows YA server owns the development session. The
controller may reach its authenticated loopback API through an SSH port forward
to create the session, observe events and send guidance. SSH carries supervision,
deployment and independent diagnostics; agent computer-control calls under test
must use local IPC inside Windows. The controller retains independent Machine
Control access for verification and recovery.

The requested development model is **GPT-6 Astra with high reasoning**. Resolve
and verify the Windows provider's actual model ID and reasoning support before
launch; do not silently substitute another model or effort level.

Commit the instructions, findings and relevant source before handoff. Push
repositories with configured remotes and check out recorded commits in Windows.
A local-only experiment repository may travel as a committed Git bundle or
tracked-source archive instead; verify its commit or digest after transfer.
Do not copy local authentication, inventory, grants, captures, ignored caches or
the controller's dependency directories into the source handoff.

Use a separate temporary YA profile for acceptance sessions. Check ordinary
sessions create no computer-control worker, authorized first use starts it,
reuse does not multiply workers, and disable/revocation/idle cleanup work.
Exercise real discovery, semantic action and screenshot consumption with an
independent fixture effect check. After local development, repeat acceptance
against exact signed CI artifacts without a source checkout. Release all test
sessions, profiles and the VM workspace when finished.

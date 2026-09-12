# Optional Windows computer control

Owning topic: [Optional Computer Control](../../topics/optional-computer-control.md).

Status: implementation in progress, 2026-09-12.

## Objective

Implement a Windows-first optional computer-control integration that works
locally, activates on demand for authorized sessions, and preserves independent
appliance control. Codex is the first provider acceptance target. Use the pinned
provider's dynamic-tool interface where supported; do not require a dedicated
computer-control MCP server or a new general JavaScript evaluator.

## Completion conditions

- An operator can configure/install a verified signed workstation preview,
  enable or disable computer control, and inspect honest readiness. Public
  release-feed publication is a separate release operation; preview acceptance
  may use an explicitly selected authenticated local package.
- Ordinary sessions receive no computer-control authority and start no worker.
  Eligible opted-in Codex sessions discover a compact native tool surface;
  resident startup is deferred until a control operation needs it.
- The installed resident is reached locally, with explicit user/instance/session
  selection and no appliance fallback. Refusals preserve native meaning;
  uncertain mutations are not replayed. Images reach both the model and YA UI.
- Disable, revocation, idle cleanup and session termination release owned
  resources. Candidate failure leaves SSH, the stable YA supervisor and the
  appliance controller available.
- Focused negative/lifecycle tests, repository checks, real Windows provider
  acceptance and source-independent signed payload acceptance pass. Relevant
  code and durable findings are committed and pushed before workspace cleanup.

## Boundaries

YA owns consumer lifecycle, provider integration, settings and presentation.
Machine Control owns native contract/runtime changes if evidence requires them.
Keep privileged unlock separate; do not modify the established appliance
installation, SSH, account policy or independent control service. Never grant
arbitrary privileged shell execution. No provider version bump is planned.

The Windows development worker uses GPT-6 Astra with high reasoning, verified
against the installed provider catalog. A pinned stable YA supervisor owns it;
candidate servers have separate profiles and ports. Claims, endpoints,
credentials, transcripts and screenshots stay in private execution storage.

## Ordered work

### 1 — establish independent Windows supervision

Doctor and claim an isolated workspace. Transfer committed sources, start a
stable interactive-session YA supervisor and verify the requested model.
Install a distinct user-resident instance; stop it and confirm independent
administration and appliance control remain healthy before development.

### 2 — implement local lifecycle and native tools

Implement verified preview installation/configuration and explicit per-session
eligibility. Use the existing native user IPC contract, bounded requests and
artifact handling. Prove lazy startup, ownership, revocation and no replay.
Integrate pinned Codex dynamic tools and normalized image/text results without
changing vanilla sessions. Preserve unsupported-provider/platform refusal.

### 3 — expose operator and session controls

Add default-off Computer Control settings and session opt-in with readiness,
disable/removal and honest unsupported-platform behavior. Follow existing
settings, capability, provider-host and rendering ownership. Test desktop and
narrow client presentation, including native screenshot results.

### 4 — accept the complete Windows path

Run separate real candidate sessions: discover, inspect, act once, capture and
independently verify fixture effects. Test cold/idle lifecycle, expired
references, revoked grants and candidate failure while supervisor/control
health remains available. Measure local latency separately from supervision.
Repeat with the signed resident package requiring no Machine Control checkout.

### 5 — review, publish source and clean up

Review Windows-authored commits on the controller; run all applicable lint,
format, type, unit and UI checks. Update the owning topic and execution evidence,
commit and push changed projects, retain portable patches/bundles where no
remote exists, and verify remote commit identities. Stop test sessions and
services, remove temporary authentication and discard the claimed workspace.

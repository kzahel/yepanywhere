# Optional Computer Control

Topic: optional-computer-control

Status: installed desktop consumer and legacy retirement complete, 2026-10-03.
Mac and Windows native/browser model use, full-app live/reloaded media and
YA close/restart/crash isolation are accepted. Linux x64 installed CLI/core
desktop use is accepted. [Tactical 142](../docs/tactical/142-machine-control-desktop-consumer.md)
owns implementation and exact acceptance records.

## Ownership and authority

**Decision:** YA consumes Machine Control's installed Python CLI. MC owns
installation, updates, resident lifecycle, native approvals/arming, grants,
claims, capabilities and agent instructions. YA owns verified discovery on the
execution host, session eligibility/selection, launch context and result
presentation. MC works without YA or a source checkout. Python remains the
intended CLI implementation so command development needs no Rust toolchain.

**Decision:** session selection advertises the installed command; it issues no
MC grant. Closing a YA session, stopping its provider or removing advertisement
does not revoke independently granted MC access. Native Stop, actual grant
expiry or MC restart revokes access. This intentionally replaces the older
YA-owned per-session tool lease; it is not lease parity or same-user shell
containment. A YA session ID is attribution, not bearer authority. Native sudo
remains independently selected and authenticated by the OS.

YA neither starts nor supervises the installed MC resident. If it is absent,
the CLI returns the native typed refusal and the operator opens MC. YA shutdown
and crash leave the independent app alone. No sandbox is widened to deliver MC.

## Discovery and configuration

**Current:** default-off local launches discover standard installed locations:
`/Applications/Machine Control.app`, `Machine Control` under Windows
`LOCALAPPDATA`, and `/usr/share/machine-control` on Linux. `YEP_MC_APP` explicitly
selects another app/product resource root; extracted AppImages use their
`usr/share/machine-control` root. Publisher authority is independently configured
with `YEP_MC_TEAM_ID` on Mac or `YEP_MC_PUBLISHER` on Windows. Linux uses the
pinned MC updater key shipped with YA to authenticate `files.json.sig`.
`YEP_MC_CONTROL=1` can seed programmatic launch advertisement; an explicit
session `false` overrides it. Restart YA and its shared provider host after
changing launch configuration.

YA authenticates the package and full CLI dependency inventory before executing
its offline identity probe. Mac checks the signed app and team. Windows checks
native runtime/provider signatures, catalog and matching product/runtime/client
identities; desktop 0.5.3 uses the publisher-signed CLI catalog to authenticate
the inventory, with every byte checked and unexpected files refused. Signed GUI
version selects the format; newer failures cannot fall back to the old verifier.
Linux verifies the signed receipt and every client dependency. Revalidation at
launch prevents a discovery result from authorizing a replaced installation.
Missing, tampered or incompatible selected installations refuse launch.

Windows runtime catalog verification uses a bounded temporary copy because
PowerShell cannot hash the running resident executable. Both catalogs retain
publisher checks; links and excessive depth/entries/bytes are refused. Nothing
from the copy executes, and cleanup runs on success and failure. A selected
Windows agent receives the verified product directory for native browser-host
setup, rather than inheriting an arbitrary helper override.

Run `pnpm exec tsx --conditions source scripts/probe-machine-control.ts --app
APP --publisher TRUSTED_PUBLISHER` for offline installation, identity,
instructions, context, relocation and negative checks. Omit publisher on Linux.
Reading identity/instructions neither requests access nor mutates the desktop.

## Session selection and compatibility

**Current:** permanent optional capability 112, `installed-machine-control`,
exposes authenticated read-only `GET /api/machine-control`. It reports bounded
`{ available, version? }` readiness without private paths, settings mutation,
resident startup or grants. Installation readiness is separate from eligibility.

The advanced New Session options offer default-off Machine Control to eligible
local Claude-family sessions outside plan mode and unrestricted local Codex
sessions. Remote executors, YA sandboxes and fixed launches are ineligible.
Selection resets on source/eligibility changes. Immediate explicit launches
carry optional boolean `machineControl` through all four session routes and
supervisor/provider composition. Existing context and child environment survive.
The exact safely quoted command path accompanies PATH because login shells
may replace PATH. Native sudo remains independent.

When capability 112 is absent, the client hides the picker and sends neither
readiness requests nor the field, including to older servers advertising legacy
IDs 70/71. The reviewed optional corpus is v0.9.0, v0.9.1 and v0.9.2; the new
contract is introduced in 0.9.4. Selected queue submission is disabled with an
explanation; turning it off restores ordinary queue submission.

## Native Mac delegation (retired)

**Current (2026-11-07):** retired. Machine Control no longer advertises
`desktop.delegation.v1`, and YA no longer injects delegation or exports a
proxy. YA agents use the ordinary MC CLI path. MC Tactical 161 replaces this
with an MC-owned, opt-in verified-caller mode. The last YA revision with the
proxy is tagged `mc-delegation-v1-final`. The text below is history.

**Decision:** native MC trust is a separate, default-off operator choice. A
compatible MC identity advertises `desktop.delegation.v1`; older installations
retain CLI advertisement. The existing session-selection boolean is not a
grant. Native MC authenticates the particular signed YA broker and MC owns
Pause, Stop, scopes, finite ownership and resource generations.

**Current, source and fixture evidence:** native YA validates its sealed app
before creating a UID-private registration socket. Only the exact kernel
process incarnation of the bundled server that native YA launched can connect.
The locator in the existing private bootstrap frame is public metadata, not
bearer authority. A fresh runtime socket avoids inheriting a writable authority
channel into agents; the actual bundled Bun child-descriptor probe passed.

The server derives a nonserializable launch proof only from actual owner
credentials, excluding permissive authentication, limited users and agent API
tokens. Eligibility still excludes plan, sandbox and remote execution. Each
actual local provider PID/start time is registered privately. The agent proxy
checks that registered lifetime and kernel ancestry together; public labels,
paths or ancestry alone do not authorize anything. Native MC rejects forged
attribution, protected/outer requests, lost trust and stale generations.

Closure removes delegation before abort/detach; root death, private-channel
loss and MC transport uncertainty close connections without replay. Stop
suspends standing trust across restart; Pause retains it. Independent legacy
MC consent remains independent. Detached provider hosting is explicitly
unsupported for automatic delegation and never silently changes placement.

**Current, bounded signed ordinary acceptance:** actual native YA, its
credentialed local launch and installed CLI drive the full signed MC operator
app and independent AX effects. Native enrollment, Pause/fresh Resume,
Stop/reconnect/resident restart, signed Bun/forged-attribution refusal and
provider/native-integration loss pass through owned protocol fixtures. No LLM
runs. [Tactical 145](../docs/tactical/145-native-mac-machine-control-delegation.md)
links the MC execution record and precise revisions. Further replacement/load
qualification and positive covered composition remain open.
The first trusted profile is the ordinary unlocked local desktop. It does not
implicitly unlock or arm protected use. This source result does not establish
same-user shell containment or distribution acceptance.

## Legacy retirement

**Decision:** withdraw advertisements for permanent IDs 70/71; their numbers
remain reserved. Old authenticated `/api/computer-control` routes return bounded
410 guidance. A true legacy session selection is rejected before any provider
launch or discovery; false/absent remains ordinary. Old settings, installer,
updater, resident supervisor, Windows Job Object and deferred tool are removed.
Generic live/persisted native image normalization remains useful independently.
[Tactical 131](../docs/tactical/131-optional-windows-computer-control.md) is the
historical execution record, not the current installation workflow.

Startup first persists legacy enablement and auto-update off. A bounded cleanup
can authenticate the old manager and remove only the exact package/state for
this YA data-directory instance. It refuses other instances, desktop installs,
links, changed active-package identity and invalid publisher signatures before
execution. A held resident lock requires the signed manager's scoped Stop;
cleanup never guesses PIDs or kills the installed desktop. Failure retains the
disabled locator for a later startup retry and never opts into the replacement.
Unsupported hosts also retain disabled metadata. No legacy setting means no
cleanup activity. No downloads, resident startup or recurring supervisor remain.

## Accepted evidence and remaining cells

| Platform | Accepted scope |
| --- | --- |
| macOS ARM64 appliance | Signed installed CLI, native approvals/refusal/expiry/Stop, semantic and browser independent effects; actual YA Codex native/browser capture consumption; full-app live/reloaded HTTP and desktop/phone media; YA close/restart/crash isolation and signed replacement to public 0.5.3 |
| Windows x64 appliance | Public signed 0.5.3, live/relocated production discovery and negatives, ordinary interactive native and browser approval/effects/capture/Stop; actual source-independent YA Codex native/browser turns and image consumption; custom product location and browser restart/reconnection; full-app live/reloaded HTTP and desktop/phone media, YA close/restart/crash isolation |
| Linux x64 GNOME Wayland appliance | Public Debian 0.5.3 production receipt/discovery/negatives and 46 bounded installed CLI checks: approval/refusal/expiry, portal consent, capture hash, independent GTK semantic/pointer/Unicode effects, restart/sharing closure and operator loss |

These are separate cells, not physical-workstation or every-provider acceptance.
Windows handle-bound semantics currently use the native JSON command route;
`desktop snapshot --target APP` handle resolution is not established. Linux's
broader Stop-shortcut checkbox was unaccepted under isolated state; the accepted
core slice excludes startup/shortcut settings. Linux model/browser and further
lifecycle cells, actual Claude model use, other desktop architectures and remote
or sandbox delivery remain separate. All six packaged targets have authenticated
payload/relocation smoke; that does not establish GUI/model parity.

Existing probes own the executable evidence: `probe-machine-control-native.ts`,
`probe-machine-control-browser.ts`, `probe-machine-control-model.ts` and
`probe-machine-control-lifecycle.ts`. The full-app model probe verifies exact
native PNG bytes with `private, no-store`, stops its provider, rebuilds the app
and media store from the persisted transcript, and checks live/reloaded desktop
and phone image viewers. Durable media preservation stays off and the owned
source capture remains until cleanup. A Windows run can select built client
assets, a separately identified test browser and the complete Codex executable.
Type-check manual probes with `pnpm exec tsc -p
scripts/tsconfig.machine-control-probe.json`. Keep credentials, private inventory,
claims, captures and transport logs out of public Git.

# UI Testing

> Browser-first visual QA is the default for client UI changes: capture
> and inspect the result at 1000×600 and a phone width (375×812), one image
> at a time, unless the user explicitly takes ownership of visual verification
> or asks to skip screenshots or visual validation.

Topic: ui-testing

## Principle

By default, a request that changes what the client renders — a UI tweak,
layout or spacing fix, control/toolbar placement, grouping, or interaction
semantics — is **done** only after real browser screenshots of the final result
are captured at desktop and phone widths, inspected by the agent against the
request, and archived where a human can review them. In-progress captures are
optional while implementing (worthwhile at milestones); final-result captures
are required when visual verification remains agent-owned.

Inspection is the point: read and inspect captures sequentially, one image per
tool call, and finish the notes for one before reading the next. Never batch
multiple images into one read. Check spacing, flow, and control placement against
the request — "route loaded, nav visible" is not enough. Captures exist to catch
the agent's own wrong spatial/aesthetic guess; models routinely one-shot UI that
is functional but mis-spaced with misplaced controls (instituted 2026-07-26 after
a commit-browser build landed exactly that way).

## User-owned visual verification

The user may explicitly take ownership of visual verification for a request or
a stated iteration series. Phrases such as "I will check it," "no screenshots,"
or "skip visual validation" are an intentional handoff, not a conflict with
this topic.

When the user makes that handoff:

1. Do not capture screenshots or launch a browser solely for visual QA.
2. Continue relevant nonvisual checks such as lint, typecheck, and focused
   automated tests unless the user also changes that scope.
3. Do not infer or report that the result was visually confirmed by the agent.
   State in the final response that visual verification was left to the user.
4. Do not wait for the user to report back before handing off the implemented
   change; their explicit acceptance of the visual check completes the agent's
   visual-QA responsibility.

Apply the handoff only to the scope the user stated. A handoff for an iteration
series may persist across its related tweaks, but do not silently carry it into
an unrelated request or a new session. Conversely, do not infer a handoff from
the user's presence, response speed, device, or presumed access to a live
build. When there is no explicit handoff, use the default capture workflow.

## Browser-first check protocol

1. Confirm that the user has not handed visual verification off to themselves.
   If they have, use the user-owned workflow above and stop this protocol.
2. Start a fresh dev-server process from the current worktree on an unused
   port; do not reuse an already-running process. Use a disposable data
   directory when isolation is needed to avoid disturbing the user's live
   server. When launching that server, set `VITE_DISABLE_ONBOARDING=true` and
   `VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS=true` so first-run and CLI-update
   dialogs cannot obscure the surface under test. These are Vite startup
   inputs; setting them only on the later screenshot command has no effect.
3. Navigate to the affected view (page, panel, or control).
4. Produce the captures through the artifact capture facility, never a raw
   screenshot call. It writes both required sizes, desktop width exactly
   `1000x600` and narrow mobile width exactly `375x812`, and it presents them
   beside the tool call so the maintainer sees the pictures without asking.
   Read and inspect the desktop image alone and finish its notes before reading
   the mobile image. Never pass multiple images to one image-reading call.
5. For each screenshot, confirm:
   - the requested change is present and correctly placed,
   - control rows and their descriptive text are grouped together,
   - active control state is visually clear,
   - no element overflows, crowds its row, or wastes obvious space.
6. Archive reviewed screenshots under a readable path (for example,
   `.artifacts/ui-testing/<yyyy-mm-dd>-<topic>/...`), and cite the
   file names in the final response (and the task note when one
   exists). Archiving is bookkeeping, not delivery: a path in the final
   response is something the maintainer has to go open, so it never replaces
   step 4's presentation.
7. Leave a short reviewer note about what changed and what was
   visually confirmed.

Any capture containing the `Server changed` banner or another stale-runtime
indicator is invalid. Restart from the current worktree and recapture rather
than treating the banner as unrelated visual noise.

## Recommended automation

### Browser integration fixture isolation

Each Playwright invocation owns a unique temporary directory, passed from
setup to workers and teardown through `YEP_E2E_RUN_DIR`. No machine-wide
session-pointer file selects another run's ports, profiles, or provider host.
Built local/remote clients live inside that run directory, and failure evidence
uses a unique subdirectory of `test-results`, so another invocation cannot
replace served assets or delete its reports while it is running.
Auxiliary servers that serve the built client use `e2ePaths.clientDist`;
they must not depend on a pre-existing workspace `packages/client/dist`.

The shared E2E installation seeds both transcript files and successful-provider
enrollment through `InstallService`. Retained collection reads intentionally
exclude never-used stores; transcript fixtures alone do not establish the
install history needed by sidebar and inbox tests.

Browser CI runs at the supported Node 22.16.0 server floor. The old Node 20.12
recursive-watcher deletion failure is outside the new server runtime contract.

Feature-specific Playwright fixtures start Vite through
`packages/client/e2e/support/vite-server.ts`. Each server owns a temporary
dependency cache, removed when it closes; starting a different fixture must
not invalidate modules served by the suite's long-lived remote client.
Optimized modules stay beneath `node_modules` so React/Babel treats them as
dependencies. These fixtures explicitly disable unrelated onboarding and CLI
update overlays, independent of test order or developer shell settings.
Backend fixtures launch the current Node executable with a file-URL `tsx`
loader, so Windows does not depend on spawning a `pnpm.cmd` shim. Teardown
stops the owned process group on POSIX or the exact fixture process tree on
Windows and permits bounded retries while file handles close.
Navigation URLs use the server's bound loopback address: a listener bound to
`127.0.0.1` is opened at that address, since `localhost` may resolve to an
unrelated IPv6 listener using the same port.

That helper also picks each server's port. Asking Vite for port 0 does not
work: it tests the configured port with `!port`, so the "let the operating
system choose" request silently becomes Vite's 5173 default, and a fixture
inheriting `strictPort: true` from `vite.config.ts` then fails outright the
moment anything else in the run holds 5173. The helper therefore reserves a
real free port itself and leaves `strictPort` off, so a fixture asking for an
arbitrary port gets one whatever else is running on the machine.

Test servers also need their own provider-host runtime directory. The default
path lives under `XDG_RUNTIME_DIR` and is shared by every YA server the user
runs, so a developer's own YA holds it with a host built from whatever sources
that server started with. A test server finds an incompatible host there,
correctly declines to replace it, and then serves the entire suite in its
degraded "provider host is not running" mode, whose banner covers the app
header and swallows clicks on it. Global setup names a directory inside the
run's temp directory through `YEP_PROVIDER_HOST_RUNTIME_DIR`, per-test servers
share that same one, and global teardown stops the resulting host: it detached
into its own process group, so the signals aimed at the server processes never
reach it and nothing else would ever reclaim that directory.

Export checks build their required mockup bundle from the checked-out source;
they must work without pre-existing `.artifacts` output. The relay artifact
fixture accepts its dedicated generated HTTPS certificate in its browser
context. This fixture setting does not change production certificate checks.
After a failed E2E job, CI retains `test-results` screenshots and traces for
seven days in the run's `e2e-failures-<attempt>` artifact.

### Browser capture command

Capture through `pnpm -s artifact:capture`. One call serves both audiences:
the agent opens the returned PNGs to judge the result, and the maintainer
examines the same capture through the links and image previews that the call
presents beside its own output. A hand-rolled `playwright screenshot` pair
writes files only the agent can read, so the maintainer sees nothing and has
to ask for the pictures.

This facility is repository-owned: the command, the browser dependency, and the
presentation helpers all live in this checkout, so it applies to every clone
and every harness. There is nothing to configure and nothing to detect. When
the user's YA has an isolated artifact origin the result also carries an
interactive link, and when it does not the same call still delivers the images
with a stated reason. So route captures through it unconditionally rather than
deciding first whether delivery will succeed.

That default is what "use headless Chromium" means here: any reason to open a
headless browser against this UI goes through this command, or through a
`packages/client/e2e/` case that records with `recordUiCapture`. Whether an
interactive artifact is actually created is the YA installation's decision,
carried by its own configuration and the launcher's environment, and the
capture reports which way it went. It is never a question the caller answers by
inspecting configuration first.

#### A file the user cannot see is not a handoff

Three invocations write correct images and present nothing, which reads to the
agent as success and to the user as an empty answer:

- `--local-only` disables every YA request by design. Reserve it for when the
  server must not be contacted at all, not as a precaution: the capture command
  neither restarts nor mutates the running server.
- `page.screenshot()` inside a `packages/client/e2e/` case writes a PNG and
  emits no manifest, links, or commentary. Use `recordUiCapture` from
  `e2e/support/ui-capture.ts` with `YEP_E2E_UI_CAPTURE_DIR` set, so global
  teardown presents the run.
- Images already on disk, from any producer, are packaged and presented by
  `writeCapturePreview` and `emitCapturePreview` from
  `packages/client/scripts/artifact-capture.ts`.

Naming a path in a message is not delivery. `AGENT_ARTIFACT_VIEWER_ORIGIN`
names the session's artifact origin when the launcher published one, and its
presence means presentation is available and expected. Observed 2026-09-10: a
settings pane and a session header were captured with `--local-only` and with
bare `page.screenshot()`, so the maintainer saw only file paths until the same
images were re-emitted through the helper.

Use an available browser-control capability for interactive web UI checks.
If setup or discovery reports no browser, or the browser inventory is empty,
immediately fall back to the repository's installed Playwright dependency,
which is what the capture command already uses. Do not stop or keep retrying a
desktop-only backend.

For multi-step interaction testing, add or run a focused `@playwright/test`
case under `packages/client/e2e/`.

Choose an unused base port and its next two ports for the server under test;
the example uses 4000–4002. That port belongs to the throwaway server being
photographed and never appears in the handoff. Launch it in its own shell with
separate data, a private provider-host runtime directory created mode `700`,
and the overlay suppressions. Without that private directory the launcher
refuses to start beside an already-running YA server.

```bash
UI_DIR="$PWD/.artifacts/ui-testing/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$UI_DIR/host" && chmod 700 "$UI_DIR/host"
PORT=4000 \
YEP_DATA_DIR="$UI_DIR/server" \
YEP_PROVIDER_HOST_RUNTIME_DIR="$UI_DIR/host" \
VITE_DISABLE_ONBOARDING=true \
VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS=true \
pnpm dev
```

Once that server is ready, capture from another shell:

```bash
pnpm -s artifact:capture http://127.0.0.1:4000/settings/providers --json
```

Address the server by `127.0.0.1` rather than `localhost`, which can resolve
to an unrelated IPv6 listener on the same port. The command writes
`desktop.png` at 1000×600 and `phone.png` at 375×812 into a fresh directory
and returns their absolute paths. Those paths are the whole delivery: the YA
client resolves an absolute path through its own file viewer on the standard
YA port, so the maintainer opens the images from the tool output without a
grant, an artifact origin, or any reference to the port under test. `--ya-url`
is rejected for URL input and is not needed. `topics/ui-design.md` owns the
command's full contract.

When the target sits below the fold or needs a driven state, pass
`--interact <module.mjs>`; the module receives `{ page, viewport }` and runs in
each viewport before the screenshot. Scrolling a settings row into view is
enough:

```js
export default async ({ page }) => {
  const item = page.locator('[data-settings-item="provider-codex-plan-tool"]');
  await item.waitFor({ state: "visible", timeout: 20000 });
  await item.scrollIntoViewIfNeeded();
};
```

Read and inspect `desktop.png` alone and finish its notes before making a
separate image-read call for `phone.png`. Presentation to the maintainer is
not a substitute for that inspection, and it is not a read receipt.

When the state needs a whole Playwright test to reach it — a mocked transport,
a streaming provider, seeded authentication — the capture command's `--interact`
module is often still enough, and a `@playwright/test` case that owns its own
browser is covered too. In a case under `packages/client/e2e/`, call
`recordUiCapture` from `e2e/support/ui-capture.ts` instead of `page.screenshot`.
It writes the PNG and records its viewport, and global teardown then presents
the whole run through the same helper the capture command uses. Recording is
opt-in through `YEP_E2E_UI_CAPTURE_DIR`, so an ordinary test run writes and
presents nothing:

```bash
YEP_E2E_UI_CAPTURE_DIR="$PWD/.artifacts/ui-testing/$(date -u +%Y%m%d)-<topic>" \
  pnpm --filter @yep-anywhere/client exec playwright test e2e/<spec>.spec.ts
```

For a browser workflow outside that harness, import `writeCapturePreview` and
`emitCapturePreview` from `packages/client/scripts/artifact-capture.ts` and hand
them the PNGs already written. They produce the same `capture.json`, `links.md`,
and image presentation without navigating, recapturing, or touching the caller's
browser; `topics/ui-design.md` owns their contract. Either way, a spec that
writes screenshots and stops there has verified nothing the maintainer can see.

A bare screenshot pair with no presentation step remains allowed, because a
partly delivered check beats a skipped one. Its cost is that the maintainer
sees nothing, so say plainly in the handoff that the images were not presented,
paste the paths, and treat it as the exception rather than the shape to reach
for.

For multi-step flows, add or run a focused `@playwright/test` case under
`packages/client/e2e/`. If Playwright itself is unavailable, use another
browser automation path or a manual browser session:

1. Open the target page directly in a browser.
2. Resize viewport to desktop + mobile dimensions.
3. Capture screenshots via the tool or OS-level capture.
4. Attach the files where reviewers can review them directly.

### Emoji need a font on the capture host

Headless Chromium draws emoji only from a color emoji font installed on the
host, and Linux servers commonly ship none. YA uses emoji in its own UI — the
Emoji settings-icon style is a whole icon set — and transcripts carry them
constantly, so a font-less host photographs them as blank or monochrome boxes
that read as a UI defect rather than a missing font.

Both capture paths therefore call `ensureColorEmojiFont` from
`packages/client/scripts/emoji-font.ts` before they launch a browser. It asks
local fontconfig first, so a host that already has an emoji font makes no
network request at all. A host without one downloads a pinned, digest-checked
Noto Color Emoji once into `~/.cache/yepanywhere/fonts`, installs it into the
user font directory, and is found locally from then on: at most one request per
machine, never one per capture, and no root. macOS and Windows supply their own
and are left alone. When the install cannot happen — no fontconfig, no network
— the capture still succeeds and carries the reason in its warnings, and emoji
in those images say nothing about the UI.

## Verification acceptance checklist

Complete either the agent-owned or user-owned branch.

### Agent-owned visual verification

- [ ] The requested change is visible and correctly placed in both
      captures.
- [ ] A single logical setting row does not span a control row and its
      status/explanation.
- [ ] A setting change has a matching explanatory text line directly
      below the control row.
- [ ] Preset buttons remain clickable and clearly indicate the current
      selection.
- [ ] Layout works at the mobile width without horizontal overflow.
- [ ] Screenshots at 1000×600 and 375×812 were captured, read one image at a
      time, inspected by the agent, and cited for human review.
- [ ] The captures were presented beside a tool call through the artifact
      capture facility, or the handoff states that they were not and why.

### User-owned visual verification

- [ ] The user explicitly took ownership of the visual check or asked
      to skip screenshots or visual validation.
- [ ] No browser or screenshot work was performed solely for visual QA.
- [ ] Relevant nonvisual verification still ran unless separately waived.
- [ ] The final response identifies visual verification as user-owned
      and does not claim independent visual confirmation.

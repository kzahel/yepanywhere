# Deliberate Departures From Standard Web Practice

> YA relaxes several standard browser-hardening defaults and declines several
> current web-platform recommendations on purpose. Each departure is listed
> here with the feature that needs it, what compensates for it, and the topic
> that owns the detail, so a hardening or modernizing change is weighed
> against a recorded reason instead of a checklist.

Topic: web-practice-exceptions

Status: register first written 2026-11-15 from the policies and comments in
the tree at that date. It covers the main client document and the frames it
embeds. Public-share documents are owned by
[relay origin and share gating](relay-origin-and-share-gating.md) and
[security](security.md#public-read-only-shares) and are not restated here.

This is a register, not a second contract. Where an entry and its owning
topic disagree, the owning topic is right and this entry is stale. An entry
records a decision; it is not a claim that the departure is free.

## How to use this register

Before tightening a policy below, or replacing a custom component with the
platform primitive a guide recommends, read the entry and its owner. A change
that removes the stated need may remove the departure. A change that keeps
the need must keep the feature working in every delivery mode: direct on
localhost, LAN or Tailscale, the desktop shell, and the hosted client over the
relay.

When adding a new departure, add its row here in the same change, with the
need and the compensating control. A loosening with no recorded need is a
defect to fix or to justify, not a precedent.

## Browser support stance

Nearly all YA use is in Chromium-based browsers (maintainer statement,
2026-11-15). YA builds to what Chromium permits, notably for microphone
capture and speech, and keeps basic compatibility elsewhere where that is
cheap. Two consequences:

- A feature that only Chromium ships is acceptable when the other engines
  degrade to something usable. It is not acceptable as the only way to reach
  a core function.
- The native iOS shell runs older WebKit. A layout or positioning primitive
  that it lacks cannot be the single implementation path; see the scripted
  popover placement below.

The CSS floor is already recorded in
[CSS architecture](css-architecture.md#css-lint-rules): the client requires
`color-mix()`, so dynamic viewport units need no fallback.

## Security loosenings

### The app document's content security policy

The built client carries two policies and the browser enforces both, so the
effective policy is their intersection:

- a `<meta>` policy written at build time by
  `packages/client/vite-plugin-csp.ts`, which lists the hashes of the
  packaged inline scripts; and
- a response header from `packages/server/src/frontend/static.ts`, a
  constant that cannot carry per-build hashes and therefore allows inline
  script and style.

In a production build, injected inline script and inline event handlers are
refused by the `<meta>` policy. The header's wider script allowance governs
only a document served without that `<meta>` policy, so a new HTML entry
document must go through the plugin or declare its own policy, as
`play.html` does. Development builds allow inline script for the dev server's
hot reload.

| Departure | Needed for | What still holds |
|---|---|---|
| `script-src` admits `blob:` | Explicitly granted remote browser diagnostics run as a short-lived Blob script; chosen over an inline or `eval` allowance. Owner: [remote browser diagnostics](remote-browser-diagnostics.md). | No inline script, no `eval`, no third-party script origin. |
| `style-src 'unsafe-inline'` | Styles injected by the bundler, critical CSS, and component `style` attributes. | Styles execute nothing; `data:` stylesheets are refused. |
| `connect-src` admits any `http:`, `https:`, `ws:`, `wss:` | The hosted client connects to whatever server address the user enters (LAN, Tailscale, relay), so localhost and public relay URLs work from one build. The local build probes the operator-configured artifact origin. | The script policy is what keeps injected code from using this; every YA endpoint still authenticates. |
| `frame-src` admits any `http:`, `https:`, `blob:` | Served apps and artifacts are framed from an origin the server selects at runtime. A statically hosted build cannot know it, and it can change while a client stays open. | The viewer validates the server-selected origin before embedding and always applies a sandbox. |
| `frame-ancestors` admits the desktop shell origins | The desktop app frames the client. | Set only by the response header, since a `<meta>` policy cannot carry it; a statically hosted client depends on its host for this directive. |
| Trusted Types not enforced | Not adopted; no decision against it is recorded. | By convention only output of the owning reviewed renderer or sanitizer is inserted as HTML, through `InnerHtml` and `useInnerHtml`. Owner: [active content security](active-content-security.md#sanitized-rich-text-fragments). |

Trusted Types is the natural next tightening: the insertion points are
already few and named, so one policy at that boundary would turn the
convention into a browser-enforced rule.

### Transport and cookies

| Departure | Needed for | What still holds |
|---|---|---|
| Session cookies are `Secure` only when the request is HTTPS, and use `SameSite=Lax` without a `__Host-` prefix | Direct access on localhost, LAN and Tailscale is plain HTTP. | Cookies are host-only and HTTP-only; mutating requests need the `X-Yep-Anywhere` header. See [SECURITY.md](../SECURITY.md). |
| The Host and Origin allowlist accepts loopback, private address ranges and `*.ts.net` without configuration | The same server is reached by several names on a private network. | A Tailscale name is trusted as an Origin only when it is the host being requested; other hosts need `ALLOWED_HOSTS` or the in-app setting. |
| The main app sets no HSTS or cross-origin isolation headers | No decision is recorded. Direct delivery is plain HTTP on loopback and private addresses, where HSTS does not apply. | The identity service pages set their own stricter headers. |

### Frames that run code

[Active content security](active-content-security.md#executable-application-origin-contract)
owns these decisions; the rows only name what departs from the usual rule.

| Departure | Needed for | What still holds |
|---|---|---|
| Artifact and served-app frames combine `allow-scripts` with `allow-same-origin` | Operator and agent apps need their own storage and same-origin requests. | The pair is safe only because the frame's origin is a separate host that holds no YA cookie, credential or API. It must never be used for content on a YA origin. |
| The artifact origin's own policy allows inline script, `eval`, and any `http:`/`https:` source | These are arbitrary web apps; a script allowlist cannot make a boundary on a shared origin. | Origin isolation is the boundary. The response `sandbox` directive grants no popups or top-level navigation. |
| Artifact frames allow downloads | Maintainer decision 2026-10-09: an artifact may save a file it builds. | A download confers no YA origin, opener or navigation. |
| Running project- and session-app frames also allow forms, popups that escape the sandbox, and the microphone (`SERVED_APP_SANDBOX`, `SERVED_APP_FRAME_ALLOW` in `packages/shared`) | Maintainer decision 2026-11-19: a running app is the operator's own and should work in the pane as in its own tab, including recording audio (read-me) and "open in a new tab" links. | Same isolated origin as above; the app's own `Permissions-Policy` still governs the microphone. Accepted cost: a popup the app opens keeps an opener and could navigate the YA tab, the reverse tabnabbing that artifact frames refuse. |
| The scriptless HTML preview is `allow-same-origin` | The trusted viewer searches the previewed document. | It never also allows scripts, and its own policy denies them. |
| The MCP app proxy frame is `allow-scripts allow-same-origin` | It relays messages using the artifact origin's script authority. Owner: [MCP apps](mcp-apps.md). | The view inside it has an opaque origin. |

## Departures from web-platform guidance

Current browser-vendor guidance (for example the Chrome team's
`modern-web-guidance` guides) prefers platform primitives over scripted
equivalents. YA follows much of it: container queries, `:has()`, `inert`,
`:focus-visible`, dynamic viewport units, reduced-motion handling, and
composition-safe `Enter` handling (`isComposing` with the `keyCode === 229`
fallback) are all in routine use. The cases below are where YA does
otherwise.

| Guidance | What YA does | Why | Revisit when |
|---|---|---|---|
| Modal overlays use native `<dialog>` with `showModal()` | `Modal` is a portaled `div` that contains Tab, is named by its title and returns focus to its opener (`packages/client/src/components/ui/Modal.tsx`) | A modal `<dialog>` makes everything outside it inert and draws above it. The tooltip layer, hover cards and selection actions portal into `body`, so they would be covered and dead inside any dialog. | Every floating layer can render inside the open dialog or the top layer together. |
| Menus and dropdowns use the `popover` attribute and CSS anchor positioning | `Popover` is a portaled, script-positioned surface (`packages/client/src/components/ui/Popover.tsx`); placement rules are in [shared UI controls](shared-ui-controls.md#desktop-dropdown-panel-placement) | The top layer would cover tooltips and toasts; `Modal`'s capture-phase Escape handler cancels the key before a native popover's close request; `popover="auto"` light dismiss races React-owned open state on the trigger's own click; anchor positioning is missing from the older WebKit in the iOS shell, so one scripted path serves every engine. | The modal moves to the top layer, and the iOS shell's floor includes anchor positioning. |
| Tooltips use native `title`, or hint popovers with interest invokers | One `TooltipLayer` owns timing, placement, dismissal and accessibility association, and in Themed mode takes over `title` attributes. Owner: [tooltip interactions](tooltip-interactions.md). | One appearance and timing preference across every hint, keyboard reachable, with a Native mode kept as the fallback. Interest invokers are Chromium-only. | Not planned. |
| Order the cascade with `@layer`; avoid naming conventions | CSS Modules with three global files, and lint checks for class and attribute liveness. Owner: [CSS architecture](css-architecture.md). | Modules scope class names per component, and the checks require every selector to have a live emitter. Cascade layers provide neither. | Not planned. |
| Skip off-screen rendering with `content-visibility: auto` | The transcript uses a measured-height render window over a bounded data window. Owner: [transcript virtualization](transcript-virtualization.md#retired-experiment-content-visibility-auto). `content-visibility` remains in use for the blame browser's uniform file rows. | Tried 2026-07-09 and retired 2026-08-26. Variable-height rows in a bottom-anchored view corrected their placeholder heights on first reveal, which moved the reader's scroll position, and a long-session reload showed severe main-thread amplification. It also leaves every row in the DOM, so it cannot bound loaded history; the load-older and auto-trim window does that. | Rows have known heights before first paint, which transcript content does not. |
| Sanitize in the browser with the Sanitizer API | HTML is rendered and sanitized on the server and inserted as inert fragments. Owner: [active content security](active-content-security.md#sanitized-rich-text-fragments). | The server renderer is the single reviewed sanitizer, and the mobile-first client bundle prefers server-side rendering. | Not planned. |
| Load a polyfill or library from a public CDN when a feature is missing | Never. Runtime code is packaged, or pinned by version and content hash and served same-origin. | The script policy admits no third-party origin, and the [minimalist runtime](../DEVELOPMENT.md#contribution-ethos-minimalist-runtime) rule prefers a small hand-written fallback. | Not planned. |

Not yet decided either way: yielding inside long main-thread work with
`scheduler.yield()` is unused, and Forced Colors Mode and `prefers-contrast`
have almost no handling. These are gaps, not decisions; adopting them needs
no exception.

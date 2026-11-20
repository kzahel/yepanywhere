# Open a YA session inside a Rex workspace

Sketch as of 2026-11-20. Start with an opt-in Rex action that opens an
existing Yep Anywhere (YA) session. A useful first workspace puts the YA
conversation next to a Rex shell and a preview of the app the agent is
building. Keep YA responsible for the agent, transcript, composer and approval
queue. Rex arranges the workspace and owns the shells it starts.

## Rex layouts and extension APIs

Superlogical describes Rex as a durable workspace spanning applications and
hosts, with structured data and actions. It uses the Ghostty project's
libghostty for its terminal foundation.
[Superlogical](https://www.superlogical.com/) ·
[Hashimoto's announcement](https://mitchellh.com/writing/superlogical)

The beta documents a session/window/block model, tiled and floating layouts,
Lua actions, a server API, and layout change events. The docs show how to export
a session view as JSON. Rex saves layouts across server restarts, which end
the running programs. Layout export gives us something to inspect and compare
across clients. Import across hosts and restoration of app state still need
their own contracts.
[Server API](https://www.superlogical.com/rex/docs/reference/api) ·
[Events](https://www.superlogical.com/rex/docs/reference/events) ·
[Layout export](https://www.superlogical.com/rex/docs/automate/lua-scripts) ·
[Restart behavior](https://www.superlogical.com/rex/docs/linux/upgrading)

The public `rex.ui` guide covers text prompts and pickers. The CLI documents
executable block discovery and port forwarding. An early web frame is a
plausible route. Check the host API, supported clients and auth behavior
before depending on an embedded view.
[Custom UI](https://www.superlogical.com/rex/docs/customize/custom-ui) ·
[CLI reference](https://www.superlogical.com/rex/docs/reference/cli)

## Launch an existing YA session from Rex

- Use a user-invoked Lua action with a configured YA origin and an existing
  session URL. Open it in the browser using the normal YA login. Try the same
  URL in a Rex web block once there is a supported way to host it. Put a shell
  in the same Rex workspace. Start with direct access, then check the existing
  hosted relay path independently.
- Keep the association as a reference to the YA server or saved source and
  its canonical session ID. Rex labels, block IDs and focused panes are
  placement data. Opening the same reference twice or closing its Rex view
  should leave the original YA session and any active turn intact.
  [YA session identity](../../topics/session-identity.md)
- Use Rex's existing forwarding for a preview served on the Rex host and YA's
  existing App and artifact paths for content served by YA. Keep YA login
  and app access out of Rex layout exports and launch arguments. A saved
  preview should resolve through its owning source on reopen so a reused
  loopback port or an expired grant cannot silently select another app.
  [YA session right pane](../../topics/session-right-pane.md#vhost-tool-urls)
- Prove the slice with one live session: open it from Rex, detach and reattach
  the client during a turn, and confirm the same session remains reachable
  from the ordinary YA client. Reopen the saved layout, including a case
  where an app or host is unavailable. Close the Rex view and finish the
  turn in YA.

## If Rex gains semantic blocks

The longer-term target is a tmux-like workspace with proportional text,
mixed content and inspectable state. A Rex window could tile a shell beside
an agent conversation, a diff, an image or a live preview. The same pieces
could be selected or stacked on a phone. Rex already has window-manager-like
placement inside its own windows. Treat desktop-wide window management as
a separate question.

Try a read-only YA conversation block first. Use bounded transcript items
with stable IDs, roles, code, links and media references. Let the client
choose typography, layout and accessibility behavior. If Rex publishes a
durable block contract for typed data and named actions, try a diff with an
explicit jump-to-file action. The action takes a file reference and line
number. The app can store the selected hunk by ID. Rendering and restoring
the same view across clients from those records would test whether an
explicit data model can replace a browser app for this kind of UI.
[YA portable transcript compiler](../../topics/portable-transcript-compiler.md) ·
[YA MCP Apps](../../topics/mcp-apps.md)

For migration, try a versioned recipe with a layout tree, app types and
stable resource references. Each app declares which state it can restore,
such as a transcript anchor or selected diff, and the destination resolves
the references using its own host mappings and authorization. A live terminal
can reattach to its original owner while that owner survives. A destination
without that owner can offer an explicit relaunch from an approved recipe.
Keep import inert until the user chooses to open or launch its contents.

Revisit when a Rex build is available for a live launch experiment, and again
when a documented block API can pass the read-only transcript and
save/reopen checks across two clients.

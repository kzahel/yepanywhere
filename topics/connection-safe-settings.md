# Connection-safe settings

Status: implemented behind the version-implied `connection-safe-settings`
server capability (introduced in 0.11.1). Owners of the code:
`packages/server/src/network/` (listeners, connection path, impact),
`packages/server/src/routes/network-binding.ts`, the Remote Access and auth
routes, and the Local Access / Remote Access settings panes with
`packages/client/src/api/connectionImpact.ts`.

Settings must not silently differ by how a client is connected, and a change
must not silently cut off the client that makes it. This topic owns both
contracts and the runtime listener behaviour they depend on.

## Same settings over every connection

- Local Access and Remote Access render the same server settings for a direct
  client (cookie or desktop login) and a Remote Access (SRP) client. There are
  no direct-only settings. What legitimately differs is not a setting: each
  connection's own logout, Switch Host, and read-only information about the
  current connection (host, relay URL). Render tests compare the settings'
  `data-settings-item` IDs between the two connection types, so a setting
  added to only one of them fails.
- A Remote Access login acting as the superuser has the operator authority of a
  superuser cookie session ([security](security.md#authority-model)). It may
  change, remove and open the local password
  (`POST /api/auth/change-password`, `/disable`, `/localhost-access`). Limited
  users never reach these routes.
- Against a server without the capability, the Remote Access view still shows
  every setting, but the local password and listening controls render
  read-only with an update note and none of those writes is sent: such a
  server refuses the password write, and a failed rebind can exit it, leaving
  a Remote Access client nothing to reconnect to.

## Asking before cutting off the caller

The server judges only the requesting client's own connection; it never asks
one client about another. It knows how each request arrived:

- **relay**: SRP over the relay, independent of this server's listening
  sockets;
- **listener**: the local address and port of the socket the request (or, for
  a request tunneled over an application WebSocket, that WebSocket) arrived
  on, and the `Host` it used;
- **unknown**: server-originated requests, which are never refused.

| Change | Refused unconfirmed when |
| --- | --- |
| `PUT`/`DELETE /api/network-binding` | a socket serves the caller's address now and none would afterward (`listener-closed`) |
| `PUT /api/settings` with `allowedHosts` | the caller's `Host`, or the `Origin` its page came from, would no longer be allowed (`host-not-allowed`) |
| Remote Access password (`POST /configure`) | the caller is an SRP login of that identity (`remote-session-ended`) |
| Relay URL or username (`PUT /relay`) | a username change ends the caller's SRP login; any change drops a relay caller's connection (`relay-disconnected`) |
| Disable or clear Remote Access | any SRP caller (`remote-access-off`; clearing also ends the login) |
| Remove relay configuration (`DELETE /relay`) | any SRP caller of that identity; relay callers also lose the relay |
| Revoke all logins, or revoke this login | the caller's own SRP login would end |

A refusal is HTTP 409 with `reason: "connection-impact"`, an `error` sentence
readable on its own, and `connectionImpact.reasons`. The client names those
reasons and, once the user accepts, repeats the request with the query
parameter `confirmConnectionImpact=1` (a query parameter because the relay
tunnel carries no body on `DELETE`). One prompt covers all requests of a single
user action, such as Local Access **Apply connection changes** or one Remote
Access save.
Declining leaves the refused change unapplied, still pending in the form, and
shows no error. Writes that can be refused go first; Local Access sends its
listener change last, because it can move the page's own server, so declining
it leaves only that change pending. A listening change re-reads, judges and
applies the live listeners as one serialized step, so concurrent changes never
plan against stale state.

A server not known to have the capability (including while its version is
still loading) may apply such changes without checking. Before sending a
listening, allowed-hosts or Remote Access credential change to it, the client
asks a generic question and then sends the change already confirmed. A client that predates the
structured reasons shows the refusal's `error` and cannot apply that change
until it is updated; the change is refused, never applied unannounced.

### Who each change can cut off

| Client | Reaches the server through | Cut off by |
| --- | --- | --- |
| Browser on the host | loopback listener | loopback port change |
| Browser over LAN, Tailscale or a reverse proxy | network socket or a proxy into loopback | interface/IP or network port change, network socket off, allowed hosts |
| Desktop app | loopback; its `PORT` makes the port read-only | allowed hosts; a wildcard same-port socket only interrupts it |
| Hosted remote client | SRP over the relay | Remote Access password, username, relay URL, disable/clear, revocation |
| Native apps | SRP over the relay or a direct route | relay route as above; direct route as a LAN browser |
| Local agent tools and API tokens | loopback HTTP | loopback port change |
| Paired servers | peer API over relay or a direct route | the same as the route they use |

## Runtime listener changes

- A change binds every new socket before giving up an old one. A taken port or
  an unbindable address returns the bind error, saves nothing and leaves the
  existing sockets serving. A runtime change never exits the server.
- A wildcard (`0.0.0.0`, `::`) network socket on the loopback port replaces the
  loopback listener. Because such a socket cannot share the port with a
  loopback bind everywhere, a socket being replaced on the same port is
  released first and rebound if the change fails.
- A replaced socket stops accepting at once. Its existing connections,
  including HTTP keep-alive, application WebSockets and peer connections, are
  closed 1.5 seconds later, which lets the response describing the change
  reach its client. Clients then reconnect to whatever now serves them.
- At startup, readiness work (the desktop ready signal, the port file,
  opening a browser) runs once the socket serving loopback listens. A saved
  or `--host` wildcard socket on the loopback port is bound directly as that
  socket, falling back to loopback alone if it cannot bind, so readiness never
  announces a listener that is about to be replaced. Other network sockets
  are bound afterwards. Settings can change the listeners only after startup
  binding has finished.
- A network socket with no saved port follows the loopback port when only the
  loopback port changes, as it would after a restart.
- A browser whose URL names the moved socket's port directly is redirected to
  the same host on the port that now serves its address. Requests through a
  proxy that maps another port, and tunneled requests, get no redirect.
- Successful changes emit `network-binding-changed`; an open Local Access pane
  refreshes the binding it shows.

## Not yet

Automatically reverting a listening change that the client does not confirm
from its new address is a possible follow-up; it is not implemented.

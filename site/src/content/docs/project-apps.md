---
title: Project apps and vhosts
description: Open project apps, manage their addresses, and distinguish them from local port forwards.
---

An app can have a browser address without being a port forward. Yep Anywhere
supports both project apps and manually configured local services.

## Which settings control my app?

**Settings → Apps → Vhosts** lists the local services you configured by name
and port. For example, a Plannotator skill can start a local server and use a
configured vhost to reach it from another device. Yep Anywhere forwards requests
to that port; adding the row does not start the local program.

**Projects → a project's settings → App** manages that project's app and its
reserved address. A static app serves built files, so it has no listening port
or process to start. A process app has its own Start and Stop controls. Project
reservations are stored separately from the manually configured vhost rows.

Administrators also see **Project apps** immediately below Vhosts in
**Settings → Apps**. It lists app status and reserved names; **Manage** opens
the same app controls inline. **Refresh apps** reloads the inventory. Retained
reservations remain visible when their project is unavailable, with a separate
Release address action. This does not delete project files.

The App controls are inline with sharing and new-session defaults. Open **App**
from the project card to use the app itself. Reserving a hostname is optional:
the normal App viewer can open a usable app without one.

## Service state and address state

A project's app and its reserved address have separate controls:

| Action | What it changes |
| --- | --- |
| Start or Retry | Starts the project's declared process service. Static apps do not need this. |
| Stop | Stops that process. It retains the reserved address and project files. |
| Reserve address | Claims an available name. If you may serve app addresses, the address serves at once and still requires its private link. It does not start the app. |
| Serve at this address | Enables the reserved hostname for the app, when reserving did not already. A process service must also be running. |
| Stop serving | Disables the hostname while retaining its reservation. |
| Public and Save access | Changes whether the hostname requires a private link, without changing whether it is serving. |
| Release address | Frees the name and invalidates its address token. It does not delete the project or stop its process. |

A stopped app can still have a reserved address. A running app can have an
address that is not serving. Addresses from a previous wildcard domain remain
reserved until explicitly released; changing the domain does not transfer them.

## Private and public links

**Private link required** means the URL contains an access token. Anyone given
that complete link can use it; it does not mean only the owner can open it.
Use **Copy viewer link** beside the address to copy the full URL. While you
browse a private app, each page you open keeps the token in its address, so
the address bar always holds a link to the page you are on.

**Public** means the hostname works without an access token. To take a public
address private, clear Public and choose **Save access**. If the owner's
permissions require private links, the settings explain that restriction
instead of offering a Public checkbox that cannot be used.

In **Settings → Users**, the administrator controls two separate permissions:

- **Allow public apps** defaults off for limited users.
- **Allow copying private app links** defaults on.

Turning off public-app permission also makes the user's existing public
addresses require a token again. Address release remains administrator-only.
Viewing a project, starting its app, publishing its address and copying a
private link are separate permissions.

## Older servers

The hosted client may be newer than your installed server. It hides controls
and links whose capabilities the server does not advertise. After updating
server code, restart the server to expose its new capabilities; refreshing the
hosted page alone does not update the server.
Older servers keep their Vhosts controls and show an update note in place of
the project-app inventory.

## Where the app runs

Static apps are built files served by YA on an isolated app origin. YA checks
that the declared files stay inside the project; opening them does not execute
a project server on the host.

Process apps run in a separate YA-owned project sandbox with its network
firewall enabled. This also applies when an administrator starts a limited
user's app. YA forwards HTTP requests through a private sandbox connection;
it does not expose the process on a host listening port or adopt a server
started independently by an agent.

A reserved hostname's tunnel or router reaches YA first. YA checks private
link or public-access policy, then serves the static app or forwards to the
sandboxed process. Making the address public changes access, not confinement.

HTTP, server-sent events and WebSockets work through this path, including
Live preview's hot module replacement (HMR). Process apps currently require
Linux's project sandbox and network firewall.

With the optional [provider host](/docs/updating#keep-work-running-during-server-reloads)
enabled, process apps and Live preview survive a web-server reload with the
same process and URL. Without it, they stop with the web server. Stopping the
host itself also stops its apps; choose Start to run them again. These actions
retain working files, and a retained reservation alone does not restart an app.
A configured hostname also needs working DNS and tunnel routing, separately
from the app's readiness.

Static address opens redirect to an expiring artifact link. To keep the
app's own address in the location bar instead, add `"staticAddress": "frame"`
beside `"service"` in `.project-template/app.json`: the address then frames
the app, and a path after it opens the same path inside the app. Navigation
inside a framed app does not change the address shown, so copying the address
does not link to the page you are on; a process app keeps both. Taking the
address private or releasing it changes access through that address; already
issued artifact links retain their own expiry and revocation rules.

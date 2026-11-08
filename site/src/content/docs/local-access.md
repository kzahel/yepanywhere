---
title: Local access and passwords
description: Require a password for direct browser access, see what it changes, add limited users, and recover a lost password.
---

Local access is how a browser reaches the server directly, on the same machine
or across a LAN or private network. It has its own password, separate from the
[Remote Access](/docs/remote-access) relay credentials. Configure it in
**Settings → Local Access**.

## Require a password

1. Open **Settings → Local Access**.
2. Turn on **Require Password**. Directly beneath it, **Password** and
   **Confirm Password** fields appear, marked **Not active yet**.
3. Enter a password of at least 6 characters in both. The block says whether
   they match, then choose **Require password** beside them.

The page you are on immediately sends you to the login screen: the Yep
Anywhere logo, **Enter your password to continue**, a single **Password**
field and a **Login** button. There is no username. Sign in with the password you just set.
That browser then stays signed in for 30 days (`AUTH_SESSION_TTL_DAYS`) or
until you sign out.

The password applies to every browser, including one on the host itself at
`http://localhost:3400`. Reloading there after your session expires shows the
same login screen.

For a headless machine, set the password from the command line before starting
the server:

```bash
yepanywhere --setup-auth "use-a-long-unique-password"
```

The command writes the password and exits; start the server normally
afterwards.

Leave **Require Password** on whenever the server listens beyond localhost,
such as with **Local Network Access** or behind your own reverse proxy.

## What a password changes

- **Remote Access** is unaffected. The relay keeps using its own username and
  password.
- **Ports** do not change. The server, artifact viewer and app hosts keep
  their ports.
- **Artifact and app links** keep working. Each link carries its own access
  token, so opening one needs no YA login, and existing links stay valid. A
  signed-in YA page creates new links as before.
- **Programs on the host** that call the YA API directly, such as an agent
  tool asking YA for an artifact link, are refused until they sign in. Tools
  talking to the provider host are unaffected.
- **Sandboxed sessions** carry no warning. Without a password, New Session
  shows a warning under the sandbox option, because a sandboxed agent that
  reaches YA could control it.

## Changing settings from another device

**Local Access** and **Remote Access** show the same settings whether you are
on the local network or connected through Remote Access, and the owner can
change the local password from either.

A change that would disconnect the device you are using asks first and says
why: for example moving the port or turning off the network address it
connects through, removing its hostname from **Allowed Hosts**, or changing
the Remote Access password from a relay connection. Changing the port from a
browser that opened the page on that port moves the page to the new port.

## Desktop app: Allow Localhost Access

The macOS and Windows apps protect the server with a desktop credential even
when **Require Password** is off. While it is off, **Allow Localhost Access**
drops that credential, so other browsers on the computer can connect. It
admits every request that reaches the server, so with **Local Network Access**
on it also opens the server to your network. Use **Require Password** instead
when other devices can reach it.

## Limited users (preview)

**Settings → Users** creates password-protected accounts for trusted family or
collaborators and grants each one selected projects. Limited users need
**Require Password** on.

With limited users enabled, the login page asks for a username: leave it blank
to sign in as the owner. Your Remote Access username also signs you in as the
owner, so a browser that fills it in from a saved relay login still works.
Over the relay, enter the limited username in **Log in
as** at [yepanywhere.com/remote](https://yepanywhere.com/remote); the server name
stays the same. To give a limited user an app icon on an iPad or iPhone, see
[iPad and iPhone Home Screen](/docs/home-screen).

This preview helps prevent accidental access. It is not hardened isolation
between people who do not trust each other.

## Recover a lost password

1. Stop the server. It reads the password file only at startup, and a running
   server can overwrite a change made underneath it.
2. Set a new password:

   ```bash
   yepanywhere --setup-auth "your-new-password"
   ```

3. Start the server and sign in with the new password.

To get in once without a password, for example to change settings, start the
server with `yepanywhere --auth-disable` or the environment variable
`AUTH_DISABLED=true`. Every request is then accepted without signing in, so
restart normally when you are done.

The password is stored as a hash in `auth.json` in the data directory. See
[Security and privacy](/docs/security-and-privacy) for where that directory
lives.

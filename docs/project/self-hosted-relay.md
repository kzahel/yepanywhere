# Self-Hosted Relay

Run the relay and the remote client entirely on your own VPS — no dependency on `yepanywhere.com`. Good fit if you already have a server with a domain name and prefer to control the full stack.

For context on the relay architecture, see [relay-design.md](relay-design.md).

## What You'll Run

| Component | Where | Role |
|-----------|-------|------|
| `packages/relay` | Your VPS (systemd) | WebSocket pipe between phone and local machine |
| `packages/client` (`dist-remote/`) | Your VPS (static files behind nginx) | Remote client SPA, served at `/remote/` |
| nginx | Your VPS | TLS termination + WebSocket proxy to relay |
| `yepanywhere` | Your local dev machine | Registers with *your* relay instead of `yepanywhere.com` |

## Prerequisites

- VPS with a public IP and a domain (e.g. `yep.example.com`)
- Node.js 20+, `pnpm`, `nginx`, `certbot`
- DNS A record pointing `yep.example.com` to the VPS

## 1. Build Relay + Remote Client on the VPS

```bash
git clone --depth 1 https://github.com/kzahel/yepanywhere.git /opt/yepanywhere
cd /opt/yepanywhere
pnpm install
pnpm --filter shared build
pnpm --filter relay build

# IMPORTANT: set VITE_BASE to the path where the SPA will be served.
# This emits HTML that references /remote/assets/* (matching where files
# actually live on disk). Without it, the HTML references /assets/* and
# you have to paper over the mismatch with nginx aliases.
VITE_BASE=/remote/ pnpm --filter client build:remote
```

Deploy the built remote client:

```bash
mkdir -p /var/www/yep-remote/remote
cp -r packages/client/dist-remote/* /var/www/yep-remote/remote/
cp packages/client/public/{favicon.ico,icon-192.png,icon-512.png,manifest.json,sw.js} \
   /var/www/yep-remote/remote/
```

The built entry point is `remote.html`. The SPA fallback in nginx (below) references it directly — no rename needed.

## 2. Relay as a systemd Service

`/etc/systemd/system/yep-relay.service`:

```ini
[Unit]
Description=Yep Anywhere Relay
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/yepanywhere/packages/relay
ExecStart=/usr/bin/node dist/index.js
Environment=NODE_ENV=production
Environment=RELAY_PORT=4400
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now yep-relay
journalctl -u yep-relay -f   # tail logs
```

## 3. nginx Config

`/etc/nginx/sites-available/yep-anywhere`:

```nginx
server {
    server_name yep.example.com;
    root /var/www/yep-remote;

    # Relay WebSocket
    location /relay/ {
        proxy_pass http://127.0.0.1:4400/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    # Remote client SPA (static files + SPA fallback)
    location /remote/ {
        try_files $uri /remote/remote.html;
    }

    # Redirect bare / to /remote/
    location = / {
        return 302 /remote/;
    }

    listen 80;
}
```

Enable + provision TLS:

```bash
ln -s /etc/nginx/sites-available/yep-anywhere /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d yep.example.com
```

> If you built **without** `VITE_BASE=/remote/`, the emitted HTML references `/assets/...` and `/favicon.ico` at the server root. You'll need extra nginx `alias` rules to map those to `/var/www/yep-remote/remote/assets/` and friends. Rebuilding with `VITE_BASE=/remote/` is simpler.

## 4. Local Machine

Point your local `yepanywhere` at your own relay:

```bash
npm i -g yepanywhere
yepanywhere --setup-remote-access \
  --username myserver \
  --password "yoursecret" \
  --relay "wss://yep.example.com/relay/ws"

# Start (from a clean terminal — see note below)
yepanywhere
```

> **`CLAUDECODE` env var**: if you launch `yepanywhere` from inside a Claude Code session, the `CLAUDECODE=1` env var inherited by spawned Claude subprocesses causes them to exit immediately. Launch from a fresh terminal, or prefix: `CLAUDECODE= yepanywhere`.

## 5. Phone

Open `https://yep.example.com/` → redirects to `/remote/`.
On the login screen → **Show Advanced Options** → set **Custom Relay URL** to `wss://yep.example.com/relay/ws` → enter username + password.

## Updating

When upgrading the relay or remote client:

```bash
cd /opt/yepanywhere && git pull
pnpm install
pnpm --filter shared build
pnpm --filter relay build
VITE_BASE=/remote/ pnpm --filter client build:remote

rm -rf /var/www/yep-remote/remote
mkdir -p /var/www/yep-remote/remote
cp -r packages/client/dist-remote/* /var/www/yep-remote/remote/
cp packages/client/public/{favicon.ico,icon-192.png,icon-512.png,manifest.json,sw.js} \
   /var/www/yep-remote/remote/

systemctl restart yep-relay
```

**Restart your local `yepanywhere` too** after updating the npm package — a running process won't pick up changes to its own package or to `@anthropic-ai/claude-code` that were installed underneath it.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Grey screen at `/remote/`, 404s for `/assets/*.js` in browser console | Built without `VITE_BASE=/remote/` | Rebuild: `VITE_BASE=/remote/ pnpm --filter client build:remote` |
| `/remote/` returns 404 | nginx `try_files` points at a filename that doesn't exist on disk | Ensure the fallback matches the actual file in `dist-remote/` (default: `remote.html`) |
| `"Claude Code process exited with code 1"` in local `yepanywhere` output | `CLAUDECODE` env var is set in the parent shell | Launch from a clean terminal or use `CLAUDECODE= yepanywhere` |
| Phone stuck on "Sending..." after updating `claude-code` or `yepanywhere` | Running process is older than the installed packages | Kill and restart `yepanywhere` — running version is visible in relay log `appVersion` on pair events |
| `unknown_username` in relay log | Phone entered wrong username | Re-enter username used during `--setup-remote-access` (case-sensitive) |
| Relay OK but phone can't reach it | Wrong relay URL on phone | Use `wss://yep.example.com/relay/ws` in Advanced Options |

## Security

- **SRP-6a**: username/password never leave the local side in plaintext; the relay stores only the verifier.
- **NaCl XSalsa20-Poly1305**: all session traffic is end-to-end encrypted; the relay forwards opaque ciphertext.
- TLS via Let's Encrypt protects the transport to/from the relay.

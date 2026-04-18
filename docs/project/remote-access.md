# Remote Access

Yep Anywhere runs on your development machine. To access it from your phone or another device outside your local network, you'll need to set up remote access.

## Secure Relay

The easiest way to access Yep Anywhere remotely. Zero-config, no port forwarding required.

**Setup via Settings UI:**
1. Go to Settings → Remote Access
2. Enter a username and password
3. Connect from anywhere at `yepanywhere.com/remote`

**Setup via CLI (for headless/automated deployments):**
```bash
yepanywhere --setup-remote-access --username myserver --password "secretpass123"
```

**How it works:**
- Your yepanywhere server connects to our public relay
- Your phone connects to the same relay and authenticates with SRP-6a (zero-knowledge password proof)
- All traffic is end-to-end encrypted with TweetNaCl — the relay only sees opaque blobs
- You can [run your own relay](self-hosted-relay.md) if you prefer (full end-to-end self-hosted setup)

**Security:**
- The relay never sees your password or session keys
- Traffic is encrypted with XSalsa20-Poly1305 (same as Signal, Keybase, etc.)
- No accounts or sign-ups required — just a username/password you control

See [relay-design.md](relay-design.md) for technical details.

---

## Alternative Options

If you prefer not to use the relay, here are other options. All require you to trust some external party with routing your traffic.

## Option 1: Tailscale (Recommended)

[Tailscale](https://tailscale.com) creates a private network between your devices. Zero port forwarding, zero firewall config.

**Setup:**
1. Install Tailscale on your dev machine and phone
2. Sign in with the same account on both
3. Access Yep Anywhere at `http://<tailscale-ip>:3400`

**Pros:** Dead simple, encrypted, works behind NAT, free for personal use
**Cons:** Requires Tailscale account, app on each device

**Note:** On Chromebooks, the Tailscale Android app may have installation issues. Consider the Cloudflare Tunnel option instead.

## Option 2: Cloudflare Tunnel

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) exposes your local server through Cloudflare's network. No port forwarding needed.

**Setup:**
1. Create a free Cloudflare account
2. Add a domain (or use a free `*.trycloudflare.com` URL for testing)
3. Install `cloudflared` on your dev machine:
   ```bash
   # macOS
   brew install cloudflared

   # Linux
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
   chmod +x cloudflared
   ```
4. Run the tunnel:
   ```bash
   # Quick test (random URL, no account needed)
   cloudflared tunnel --url http://localhost:3400

   # Persistent (requires CF account + domain)
   cloudflared tunnel create yep-anywhere
   cloudflared tunnel route dns yep-anywhere claude.yourdomain.com
   cloudflared tunnel run yep-anywhere
   ```

**Pros:** Free, handles HTTPS automatically, no port forwarding
**Cons:** Requires Cloudflare account for persistent URLs

## Option 3: Caddy + SSH Tunnel (Self-Hosted)

If you have a server with a public IP (like a Raspberry Pi with port 443 forwarded), you can use Caddy for HTTPS and an SSH tunnel for connectivity.

**On your public-facing server (e.g., Raspberry Pi):**
1. Install [Caddy](https://caddyserver.com)
2. Point a DNS A record to your home IP
3. Create `/etc/caddy/Caddyfile`:
   ```
   claude.yourdomain.com {
       reverse_proxy 127.0.0.1:3400
       basicauth /* {
           youruser $2a$14$hashedpassword
       }
   }
   ```
   Generate the password hash with `caddy hash-password`
4. Start Caddy: `sudo caddy start --config /etc/caddy/Caddyfile`

**On your dev machine:**
Set up a reverse SSH tunnel to forward the local port to the server:
```bash
# One-time
ssh -N -R 3400:localhost:3400 yourserver

# Persistent (install autossh)
autossh -M 0 -N -o "ServerAliveInterval 30" -o "ServerAliveCountMax 3" \
    -R 3400:localhost:3400 yourserver
```

For a systemd service, create `~/.config/systemd/user/claude-tunnel.service`:
```ini
[Unit]
Description=SSH tunnel for Yep Anywhere
After=network.target

[Service]
ExecStart=/usr/bin/autossh -M 0 -N -o "ServerAliveInterval 30" -o "ServerAliveCountMax 3" -R 3400:localhost:3400 yourserver
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Then:
```bash
systemctl --user enable claude-tunnel
systemctl --user start claude-tunnel
```

**Pros:** Full control, no third-party accounts
**Cons:** More complex setup, requires existing server infrastructure

## Security Considerations

- Yep Anywhere has access to your codebase. Only use remote access methods you trust.
- Always use HTTPS for remote access (all options above provide this).
- Consider adding authentication (basic auth, Cloudflare Access, etc.) as an extra layer.
- The server listens on localhost by default. Remote access methods tunnel to localhost rather than exposing on all interfaces.

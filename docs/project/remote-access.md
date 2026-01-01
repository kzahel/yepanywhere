# Remote Access

Claude Anywhere runs on your development machine. To access it from your phone or another device outside your local network, you'll need to set up remote access using one of the options below.

All options require you to trust some external party with routing your traffic. Choose based on your comfort level and existing setup.

## Option 1: Tailscale (Recommended)

[Tailscale](https://tailscale.com) creates a private network between your devices. Zero port forwarding, zero firewall config.

**Setup:**
1. Install Tailscale on your dev machine and phone
2. Sign in with the same account on both
3. Access Claude Anywhere at `http://<tailscale-ip>:3400`

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
   cloudflared tunnel create claude-anywhere
   cloudflared tunnel route dns claude-anywhere claude.yourdomain.com
   cloudflared tunnel run claude-anywhere
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
Description=SSH tunnel for Claude Anywhere
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

- Claude Anywhere has access to your codebase. Only use remote access methods you trust.
- Always use HTTPS for remote access (all options above provide this).
- Consider adding authentication (basic auth, Cloudflare Access, etc.) as an extra layer.
- The server listens on localhost by default. Remote access methods tunnel to localhost rather than exposing on all interfaces.

# Comment review: docker, part 1

[Index and review procedure](README.md)

Snapshot: `3fe898ce5`. 24 blocks. Every item starts unreviewed.

Check an item only after recording **remove**, **keep**, or **rewrite/move** and a brief reason. Then apply and verify the corresponding source change.

- [ ] `525a399e05e7b04d` [docker/Dockerfile:1–3](../../../docker/Dockerfile#L1-L3) — **unreviewed** — ` # Lightweight sandbox for yep-anywhere + Claude # Build: docker build -t yep-sandbox docker/ # Run: docker compose -f docker/docker-compose.yml up `
- [ ] `271edbb2cf6b23ae` [docker/Dockerfile:7](../../../docker/Dockerfile#L7) — **unreviewed** — ` # Install essentials `
- [ ] `a6c8aa1c9186c529` [docker/Dockerfile:16](../../../docker/Dockerfile#L16) — **unreviewed** — ` # Install pnpm `
- [ ] `008e64e7b3c9214d` [docker/Dockerfile:19](../../../docker/Dockerfile#L19) — **unreviewed** — ` # Install Claude CLI globally `
- [ ] `34439f0e16957d56` [docker/Dockerfile:22–23](../../../docker/Dockerfile#L22-L23) — **unreviewed** — ` # Create non-root user (UID/GID passed at build time) # Default to 1000:1000 - the node image already has group 1000, so use --non-unique `
- [ ] `e3e19e7f844e42b3` [docker/Dockerfile:30](../../../docker/Dockerfile#L30) — **unreviewed** — ` # Switch to non-root user `
- [ ] `59aa75ed4ca66a74` [docker/Dockerfile:34](../../../docker/Dockerfile#L34) — **unreviewed** — ` # Default command - can be overridden `
- [ ] `df563d48717b028b` [docker/docker-compose.yml:1–12](../../../docker/docker-compose.yml#L1-L12) — **unreviewed** — ` # Sandboxed yep-anywhere environment # # Profiles: # sandboxed (default) - Full network, restricted filesystem/privileges # isolated - Localhost-only network (no outbound internet) # # Usage: # docker compose -f docker/docker-compose.yml up # sandboxed # docker compose -f docker/docker-compose.yml --profile isolated up # isolated # # First time setup: # docker compose -f docker/docker-compose.yml run --rm yep-sandbox pnpm install `
- [ ] `d7ec9ab78976dab9` [docker/docker-compose.yml:23–24](../../../docker/docker-compose.yml#L23-L24) — **unreviewed** — ` # Port forwarding (host:container) # Only forward main server - it proxies to Vite internally `
- [ ] `15d183e7fe658da8` [docker/docker-compose.yml:28](../../../docker/docker-compose.yml#L28) — **unreviewed** — ` # Security: drop all capabilities, no privilege escalation `
- [ ] `6ceae32ec79837d5` [docker/docker-compose.yml:34](../../../docker/docker-compose.yml#L34) — **unreviewed** — ` # Shared mounts `
- [ ] `2468eab57feb6087` [docker/docker-compose.yml:36](../../../docker/docker-compose.yml#L36) — **unreviewed** — ` # Code directory (read-write) `
- [ ] `e897facb8ca16fc6` [docker/docker-compose.yml:39](../../../docker/docker-compose.yml#L39) — **unreviewed** — ` # Claude SDK data `
- [ ] `a84dc5a2ef123e4f` [docker/docker-compose.yml:42](../../../docker/docker-compose.yml#L42) — **unreviewed** — ` # Yep-anywhere data `
- [ ] `7794f9b82d1b056f` [docker/docker-compose.yml:45](../../../docker/docker-compose.yml#L45) — **unreviewed** — ` # Git config (read-only) `
- [ ] `a744168a2b66f770` [docker/docker-compose.yml:49](../../../docker/docker-compose.yml#L49) — **unreviewed** — ` # Environment `
- [ ] `09ff86384f5cb31c` [docker/docker-compose.yml:53](../../../docker/docker-compose.yml#L53) — **unreviewed** — ` # Bind to all interfaces (fixes IPv4/IPv6 mismatch) `
- [ ] `5182a7e0e3f81beb` [docker/docker-compose.yml:55](../../../docker/docker-compose.yml#L55) — **unreviewed** — ` # Don't prompt for corepack downloads `
- [ ] `6901c202505d0af5` [docker/docker-compose.yml:58](../../../docker/docker-compose.yml#L58) — **unreviewed** — ` # Working directory `
- [ ] `cecbe69e112e627a` [docker/docker-compose.yml:61](../../../docker/docker-compose.yml#L61) — **unreviewed** — ` # Interactive terminal `
- [ ] `9db9d8962ac07c4d` [docker/docker-compose.yml:65](../../../docker/docker-compose.yml#L65) — **unreviewed** — ` # Start yep-anywhere by default `
- [ ] `81fad1391a5cf67a` [docker/docker-compose.yml:68](../../../docker/docker-compose.yml#L68) — **unreviewed** — ` # Isolated variant - localhost only, no outbound internet `
- [ ] `42129ac2d1802c93` [docker/docker-compose.yml:75](../../../docker/docker-compose.yml#L75) — **unreviewed** — ` # Extra isolation: block DNS to prevent any sneaky resolution `
- [ ] `8969c5a9a8a5ed01` [docker/docker-compose.yml:79–80](../../../docker/docker-compose.yml#L79-L80) — **unreviewed** — ` # Internal-only network: containers can talk to host via ports, # but cannot reach the internet `

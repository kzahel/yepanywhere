# Debugging

[Contributor guide](../../DEVELOPMENT.md) · [Development docs](README.md)

Commands and code paths below are relative to the repository root unless stated
otherwise.

## Server Logs

Server logs are written to `{dataDir}/logs/` (default: `~/.yep-anywhere/logs/`):

- `server.log` - Main server log (dev mode with `pnpm dev`)
- `e2e-server.log` - Server log during E2E tests

To view logs in real-time: `tail -f ~/.yep-anywhere/logs/server.log`

`server.log` and `sdk-raw.jsonl` rotate by size: past 100 MiB the file
becomes `.1`, the previous `.1` becomes `.2`, and the older `.2` is
deleted, so each log holds at most about 300 MiB
(`packages/server/src/logging/rotating-file-stream.ts`). A file already over
the limit rotates on the first write after a restart.

All `console.log/error/warn` output is captured. Logs are JSON format in the file but pretty-printed to console.

Environment variables:
- `LOG_DIR` - Custom log directory
- `LOG_FILE` - Custom log filename (default: server.log)
- `LOG_LEVEL` - Minimum level: fatal, error, warn, info, debug, trace (default: info)
- `LOG_FILE_LEVEL` - Separate level for file logging (default: same as LOG_LEVEL)
- `LOG_TO_FILE` - Set to "true" to enable file logging (default: off)
- `LOG_PRETTY` - Set to "false" to disable pretty console logs (default: on)

## Client Console Logs

Remote collection of browser `console.log/warn/error` from mobile clients. Useful for debugging connection issues on devices where you can't open DevTools.

**Enable:** Developer Mode settings → "Browser Diagnostics" toggle.

**Storage:** `{dataDir}/logs/client-logs/` (default: `~/.yep-anywhere/logs/client-logs/`). One JSONL file per device per day, named `client-{YYYY-MM-DD}-{deviceId}.jsonl`. The device UUID is persisted in the client's `localStorage`. Files older than 14 days are deleted on the first post of each server day, and a device's file stops at 32 MiB for that day; further posts answer `{ received: 0, dropped: n }`.

Each line is a single log event:
```json
{"timestamp":1770790157738,"level":"log","prefix":"[SecureConnection]","message":"[SecureConnection] Closed: 1006","_receivedAt":1770790161477}
```

A `[ClientInfo]` entry is written on each session start with user agent, screen size, DPR, and language.

```bash
# List device log files
ls ~/.yep-anywhere/logs/client-logs/

# View today's logs for a device
cat ~/.yep-anywhere/logs/client-logs/client-$(date +%Y-%m-%d)-<deviceId>.jsonl

# Follow incoming logs
tail -f ~/.yep-anywhere/logs/client-logs/*.jsonl
```

**Implementation:** `packages/client/src/lib/diagnostics/ClientLogCollector.ts` (client), `packages/server/src/routes/client-logs.ts` (server `POST /api/client-logs`).

## Rejected SRP resume credentials

Before reproducing a lost-login problem, enable **Settings → Development →
Retain rejected SRP sessions for debugging** on the affected browser origin.
This default-off preference is independent of **Browser Diagnostics**; enable
both to retain the key locally and upload safe attempt evidence. Enabling Browser
Diagnostics queues client info and telemetry immediately and flushes if a transport
is ready; the POST acknowledgement is the receipt, not a separate ping.
Neither setting recovers evidence from an earlier failure.

Use Chrome remote debugging/CDP (ADB for an authorized phone) on the exact hosted
tab. Keep keys inside the browser; do not print or copy raw localStorage.
The only operator interface is the opt-in console helper:

```js
const records = window.__YA_RESUME_DEBUG__.list(); // safe metadata; no keys
const id = records[0].id;
await window.__YA_RESUME_DEBUG__.probe(id); // { outcome: "authenticated" } or bounded failure
window.__YA_RESUME_DEBUG__.cancel(id);
window.__YA_RESUME_DEBUG__.forget(id);
```

A probe uses the saved endpoint and identity with fresh nonces and normal
verification, checks an encrypted request and closes its socket. It does not
change route, active credentials or source. A fresh password login can coexist
with the retained copy, so diagnosis can continue after access returns. The copy
expires after 72 hours from first quarantine; repeats do not renew it. At most
one per scope/eight total and eight observations per record are kept. Reads and
startup prune expired material; a closed origin cannot perform physical deletion.
Opt-out, host removal, explicit logout and debugger forgetting purge copies and
cancel probes. Switch Host does not purge them. Without Web Locks, no diagnostic
credential is retained. The helper is absent when opted out.

Correlate `SrpResume` entries in client logs with server-local
`event: "srp_resume_refused"` by session ID, identity and time. Server entries name
init/proof phase and known refusal cause without keys/proofs. An uploaded
pre-authentication refusal is evidence received, not cryptographic proof the key
is permanently invalid. A successful probe is useful evidence of a transient or
incorrect rejection; it does not identify the original cause by itself.

The October 11 morning-login report remains unproven: the old phone session was
still valid on the running server, but client diagnostics were enabled afterward.
Retaining evidence prepares the next reproduction; it is not a regression fix.

## Maintenance Server

A separate lightweight HTTP server can run on PORT + 1 (conventionally 3401) for out-of-band diagnostics, which is exactly when the main server is unresponsive. It is **off unless `MAINTENANCE_PORT` names a port** — set it at launch, because a server that is already wedged cannot be told to open it.

```bash
# Check server status
curl http://localhost:3401/status

# Enable proxy debug logging at runtime
curl -X PUT http://localhost:3401/proxy/debug -d '{"enabled": true}'

# Change log levels at runtime
curl -X PUT http://localhost:3401/log/level -d '{"console": "debug"}'

# Enable Chrome DevTools inspector
curl -X POST http://localhost:3401/inspector/open
# Then open chrome://inspect in Chrome

# Trigger server restart
curl -X POST http://localhost:3401/reload
```

Available endpoints:
- `GET /health` - Health check
- `GET /status` - Memory, uptime, connections
- `GET|PUT /log/level` - Get/set log levels
- `GET|PUT /proxy/debug` - Get/set proxy debug logging
- `GET /inspector` - Inspector status
- `POST /inspector/open` - Enable Chrome DevTools
- `POST /inspector/close` - Disable Chrome DevTools
- `POST /reload` - Restart server

Environment variables:
- `MAINTENANCE_PORT` - Port for maintenance server (default: 0, meaning no maintenance server; PORT + 1 is the usual choice)
- `PROXY_DEBUG` - Enable proxy debug logging at startup (default: false)

# Disk Full Degraded Mode

> Disk pressure must not make optional YA diagnostics process-fatal. The
> server should keep relay and local control paths alive where possible, while
> surfacing which disk-backed features are degraded and preserving clear errors
> for writes that are part of the user's requested action.

Topic: disk-full-degraded-mode

Status: Problem statement / latent proposal. The immediate stream-hardening
trigger has been witnessed; broader degraded-mode and rotation work should be
scoped deliberately. Use this document before changing log writers, upload
streams, disk-backed service persistence, relay liveness under local failures,
or maintenance/status reporting for disk pressure.

## Problem

YA is a server-owned process supervisor. Remote relay access only works while
the local YA server process remains alive and registered with the relay. If an
optional file writer emits an unhandled Node `error` event, Node treats that as
an uncaught exception and exits the process. A disk-full `ENOSPC` from such a
writer therefore drops the relay connection, even though the relay client
itself has reconnect and keepalive behavior.

This is not primarily a relay reconnect problem. Once the process exits, there
is no local server to keep the relay registration alive, answer SRP handshakes,
or serve the remote UI. The first target is process survival under disk
pressure.

The important distinction is critical vs. noncritical writes:

- **Noncritical diagnostics** such as raw SDK logs, debug logs, and client log
  collection should degrade or disable themselves when disk writes fail.
- **User-action writes** such as uploads and attachment staging should fail the
  specific request, notify the client, and clean up partial files.
- **Configuration, auth, and security-sensitive persistence** should not
  silently ignore write failures. They should return a clear error to the
  mutating route and leave the in-memory state rules explicit.

## Observed Failure

On 2026-07-05, a development server exited with:

```text
Error: ENOSPC: no space left on device, write
Emitted 'error' event on WriteStream instance
```

The server package exited, and remote relay clients could no longer connect.
The local environment had `LOG_SDK_MESSAGES=true`, and the YA logs directory
contained multi-gigabyte diagnostic logs:

```text
~/.yep-anywhere/logs/sdk-raw.jsonl  ~3.0G
~/.yep-anywhere/logs/server.log     ~721M
~/.yep-anywhere/logs                ~4.2G total
```

The exact crashing stream was not named in the Node stack, but the failure
shape matches a long-lived `WriteStream` without an `error` listener. The
primary suspect was the raw SDK message logger because it was enabled and does
not attach a stream-level error handler:

- `packages/server/src/sdk/messageLogger.ts`
- `packages/server/src/codex/correlationDebugLogger.ts`
- `packages/server/src/uploads/AttachmentStagingService.ts`

The main server pino file logger already attaches an error listener. The relay
package has the same pattern split: telemetry has a stream error listener, but
the relay file logger does not.

## Current Surfaces

### Long-Lived Streams

These can crash the process if they lack an `error` listener:

- `packages/server/src/sdk/messageLogger.ts` writes `sdk-raw.jsonl`.
- `packages/server/src/codex/correlationDebugLogger.ts` writes
  `codex-correlation-debug.jsonl`.
- `packages/server/src/uploads/AttachmentStagingService.ts` writes staged
  upload temp files.
- `packages/relay/src/logger.ts` writes `relay.log` when relay file logging is
  enabled.

The older upload manager already has a stream error listener, although it only
marks state as `"error"` and the promise path still needs careful review for
settlement and cleanup under asynchronous stream failure.

### Promise-Based Writes

Most state persistence uses `fs.promises.writeFile`, `appendFile`, `rename`, or
`rm`. Those errors usually reject the active request or background save rather
than crashing the process. The policy still needs to be explicit because
several services mutate memory before saving:

- remote access and auth settings;
- server settings;
- session/project metadata;
- queues and workstreams;
- session indexes and project scan caches;
- client log ingestion;
- approval audit logging;
- speech audio retention.

These sites do not all need one abstraction immediately, but if disk-pressure
handling repeats across them, a small shared helper may be warranted.

## Trigger Conditions

### Already Met

- A YA server process exited after `ENOSPC` from an unhandled `WriteStream`
  error.
- The process exit made relay access unavailable even though the relay client
  code has reconnect behavior.
- A noncritical diagnostic writer was enabled and had grown to multi-gigabyte
  size.

These conditions justify a narrow hardening pass for long-lived streams.

### Trigger For Log Caps Or Rotation

Add diagnostic log caps, rotation, or retention when any of these is true:

- a single optional YA diagnostic log exceeds a documented cap;
- `LOG_SDK_MESSAGES=true` or debug correlation logging is used for more than a
  targeted investigation window;
- users need file logging on by default in a packaged/runtime setting;
- repeated support reports involve `~/.yep-anywhere/logs` consuming enough disk
  to threaten server liveness.

Observed 2026-11-06 on the maintainer's macOS host: `server.log` reached
8.0 GB in about seven weeks, mostly debug-level Codex scan lines, at roughly
480 MB a day; see
[Codex's native thread index](../docs/research/codex-native-thread-index.md#logs).

### Trigger For Disk-Pressure Health Reporting

Add a disk-pressure status model when any of these is true:

- remote users need to diagnose a degraded local server without shell access;
- multiple writers start independently suppressing or degrading themselves;
- the maintenance endpoint needs to distinguish "server alive but disk-backed
  features failing" from ordinary health;
- a disk-free threshold warning would have prevented an observed outage.

### Trigger For A Shared Persistence Helper

Extract shared write/error handling only after the third meaningful duplicate
policy appears. Two isolated call sites can stay local. The helper earns its
place when it centralizes real policy, such as error classification, temp-file
cleanup, metric emission, and rate-limited warnings.

### Trigger For Process-Level Exception Guarding

Consider a process-level `uncaughtException` guard only after stream-local
handlers have been added and a separate library still emits process-fatal
`ENOSPC` from an optional path. This is a last-resort containment layer, not the
primary design. Recovering from arbitrary uncaught exceptions can leave process
state ambiguous.

## Solution Options

### Option A: Harden Optional Streams

Attach `error` handlers to noncritical diagnostic streams. On `ENOSPC`, `EIO`,
or `EACCES`:

1. close or destroy the stream;
2. set the feature to disabled/degraded in memory;
3. emit one rate-limited warning to stderr or the console logger;
4. avoid retrying every log event until an explicit re-enable or restart.

This is the smallest fix for the witnessed crash. It keeps the server process
and relay client alive while losing only best-effort diagnostics.

### Option B: Fail Uploads Gracefully

For upload and staged attachment streams, an async stream error should settle
the pending upload operation exactly once, mark the upload failed, clean up
partial files best-effort, and send the client an upload error. The server must
not keep the upload in an active state after the disk has rejected writes.

This is user-action failure, not silent degradation. The user needs to know
that the file was not staged or uploaded.

### Option C: Log Budget And Rotation

Add caps for high-volume diagnostic logs, especially `sdk-raw.jsonl` and
correlation debug logs. Possible approaches:

- size-based rotation with a small retained count;
- date-based files plus retention by age and total bytes;
- a hard maximum that disables the writer until restart;
- a startup warning when a diagnostic log is already above its cap.

Prefer a small local implementation unless YA needs a broader logging package
for reasons beyond rotation.

Done 2026-11-09 for `server.log`, `sdk-raw.jsonl` and
`codex-correlation-debug.jsonl`: size rotation at 100 MiB keeping two
archives (`packages/server/src/logging/rotating-file-stream.ts`). Client logs
keep 14 days and stop a device's daily file at 32 MiB. The relay log is not
capped yet.

### Option D: Disk-Pressure Status

Expose disk pressure and degraded writers in server status surfaces:

- maintenance `/status`;
- app settings or diagnostics;
- remote-access status returned over the relay while the server is still alive.

Status should distinguish:

- disk almost full but writes still succeeding;
- optional diagnostics disabled after write failure;
- critical persistence failed on a user action;
- upload/staging unavailable because the data directory cannot accept writes.

### Option E: Critical Persistence Policy

For settings, auth, remote access, queues, metadata, and audit logs, decide the
policy per surface:

- mutating API routes should return clear write-failure errors;
- in-memory updates should either be rolled back or explicitly marked as
  runtime-only until the next successful save;
- security/audit writes should not be silently discarded without a visible
  warning and a reasoned policy;
- background caches such as session indexes may drop the failed save and
  rebuild later.

This option is larger because it touches user-visible state guarantees.

## Recommended First Pass

1. Add stream `error` handlers to `messageLogger`,
   `correlationDebugLogger`, staged uploads, and the relay file logger.
2. Disable best-effort diagnostic streams after `ENOSPC` and log one warning.
3. Add focused tests that simulate async `WriteStream` errors and assert the
   process-local behavior: no throw, writer disabled, upload rejected, cleanup
   attempted.
4. Document operational mitigation: turn off `LOG_SDK_MESSAGES` after targeted
   debugging and prune large logs when disk pressure appears.

Do not add a broad persistence abstraction in the first pass unless the
implementation naturally repeats enough policy to justify it.

## Testing Checklist

- Simulate `WriteStream` `error` events after stream creation; `try/catch`
  around `.write()` is not enough.
- Cover `ENOSPC` specifically and at least one generic stream error.
- Verify repeated log attempts after disable do not spam warnings.
- Verify relay client state is unaffected by a disabled diagnostic writer.
- Verify staged upload write failure returns an upload error and removes the
  active upload state.
- Verify ordinary `pnpm lint` and targeted server tests emit no warnings.

## Operational Mitigation

Until code hardening lands, the safest local mitigation is:

- set `LOG_SDK_MESSAGES=false` or remove it from `.env` outside short debug
  sessions;
- keep `LOG_TO_FILE` intentional and note that the dev `.env` parser does not
  strip inline comments from values;
- prune or archive large files under `~/.yep-anywhere/logs`;
- check `df -h ~/.yep-anywhere` when remote relay access unexpectedly drops.

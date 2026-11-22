# Antigravity cold replay drops the transcript tail

Opening a stopped Antigravity session can show a stale progress update as
the last reply even though the native transcript contains the work and its
final report. The session-detail API returns the prefix as complete
(`pagination.hasOlderMessages: false` in the observed case), and the cold
reader can reuse that prefix from its cache.

[The reader](../packages/server/src/sessions/antigravity-reader.ts#L563)
collects ACP `session/update` notifications from an `agy acp` subprocess
while making a `session/load` request. As soon as the RPC resolves,
[`withRuntime`](../packages/server/src/sessions/antigravity-reader.ts#L198)
closes the subprocess. [The transport](../packages/server/src/sdk/providers/antigravity-runtime.ts)
sends `SIGTERM` to the process group. `agy` can reply to the RPC while it
is still replaying updates over stdout, so the reader can terminate it
before the reply text arrives.

## Original reproduction

Reproduced on macOS with `agy` 1.5.14 and YA at `eb520d058`. Open the
stopped **Anti-Gravity Testing Background Task** session on the original
host (YA ID `233c7697-6083-469a-a9c8-73a3a2bf77e7`, native ID
`466c3170-44d9-49b3-88f9-c127380ae4b3`). The localhost detail API
`GET /api/projects/<projectId>/sessions/<YA id>?provider=antigravity`
returned 323 messages. The last displayed reply was waiting for Slice 2
Round 4. Step 1271 of the native
`antigravity-cli/brain/<native id>/.system_generated/logs/transcript_full.jsonl`
contains the final report at 22:26:32 CET on November 21, after all three
commits (`91959d261`, `578d42f9d`, `eb520d058`).

For another session, use its native ID, project cwd, and a phrase known
to be in its final native reply. Run the probe from the checkout root
after the live owner has exited, using the same installed `agy` and
profile as YA. The probe sends only `initialize` and `session/load`.
Native loading can update continuation metadata.

```bash
AGY_REPRO_PROJECT="$PWD" \
AGY_REPRO_NATIVE_ID=466c3170-44d9-49b3-88f9-c127380ae4b3 \
AGY_REPRO_TEXT='subagent support is implemented end-to-end' \
pnpm --dir packages/server exec node --import tsx --conditions source --input-type=module - <<'JS'
import { setTimeout as delay } from "node:timers/promises";
import {
  AntigravityRuntime,
  findAntigravityRuntime,
} from "./src/sdk/providers/antigravity-runtime.ts";

const { AGY_REPRO_PROJECT: cwd, AGY_REPRO_NATIVE_ID: sessionId, AGY_REPRO_TEXT: marker } = process.env;
const command = await findAntigravityRuntime();
if (!cwd || !sessionId || !marker || !command || command.layout !== "cli") {
  throw new Error("Set the project, native ID, and final reply marker and select agy");
}

const runtime = new AntigravityRuntime();
let updates = 0;
let tail = "";
let sawFinal = false;
runtime.onUpdate = (update, id) => {
  if (id !== sessionId) return;
  updates++;
  const text = update.content?.text;
  if (update.sessionUpdate === "agent_message_chunk" && typeof text === "string") {
    const candidate = tail + text;
    sawFinal ||= candidate.includes(marker);
    tail = candidate.slice(-marker.length);
  }
};
try {
  await runtime.connect(command.command, cwd, command.args);
  await runtime.call("session/load", { sessionId, cwd, mcpServers: [] });
  console.log({ phase: "session/load reply", updates, sawFinal });
  await delay(2000);
  console.log({ phase: "two seconds later", updates, sawFinal });
} finally {
  await runtime.close();
}
JS
```

The first probe observed 315 updates at the reply and 857 two seconds
later. Rerunning the command above observed 355 and 858. In both runs,
the final report arrived after the RPC reply. Counts vary with the
interleaving.

The early [backend reload](antigravity-backend-reload-interrupts-active-work.md)
was a separate interruption. The session resumed afterward and finished.

The replay completion signal still needs to be qualified across supported
runtimes. Verify that a late final reply survives cold replay and that a
read with uncertain completion cannot cache or serve a prefix as complete.
The two-second observation was diagnostic evidence.

The [upgrade checks](../topics/native-provider-testing.md#checking-an-antigravity-upgrade-candidate)
now observe frame order on a short transcript from real `agy`. A controlled
ACP peer independently holds the final frame after the load reply. YA's cold
reader returns the prefix and reuses it on a second read without starting
another load. The controlled case reproduces the reader defect independently
of the size or timing of a native transcript.

Found 2026-11-22 while investigating an Antigravity session that appeared unfinished.

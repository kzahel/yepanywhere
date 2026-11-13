# Every forwarded peer request pays a full handshake

`SrpPeerTransport` (`packages/server/src/peer-api/srp-client.ts`) opens "a fresh
mutually authenticated channel per request": each v0 call to a peer makes a new
WebSocket and a new SRP exchange. Over loopback between two standalone servers
on an Apple-silicon Mac, every forwarded read took about 330 ms where the same
read locally took about 1 ms; the mesh testbed's 66 forwarded reads take about
20 seconds, on macOS and on native Windows x64 alike. Over the public relay the
target's log shows one relay connect, register and claim per request.

An agent following remote work issues a receipt or conversation follow every
few seconds, and each one repeats the handshake on both servers. The cost is
latency for the agent and CPU on both ends, and on a relay route it is also
relay connection churn.

Not changed here because one channel per request is a deliberate boundary: no
reconnect or resend logic, and revocation takes effect at the next request. A
repair would keep an authenticated channel for a short idle period and would
need to re-establish what the per-request design gives for free, including
revocation and credential-generation fencing and the per-target handshake
serialization a legacy relay needs. Measure a real relay route before choosing.

Found 2026-11-13 while running the local mesh testbed.
Contributing-model: claude-fable-5-2

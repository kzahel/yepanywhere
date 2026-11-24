# Rejected desktop bootstrap strands the dashboard window

Yep Anywhere Desktop displayed `Invalid or expired desktop bootstrap` on
the Tart macOS testbed. The route returns that response when the one-time
code is missing, expired, or already exchanged. Both expiry and replay
reproduce the response. The trigger on the testbed is unknown.

The native shell records the dashboard as current when it starts navigation.
Opening the dashboard again can therefore focus the error page without
obtaining a new code. Recover within the current server process by observing
the navigation outcome and retrying once with a fresh code.

Found 2026-11-24 while investigating the reported desktop startup error.

# Relay sidebar test is blocked by a server update notice

`packages/client/e2e/relay-integration.spec.ts` test
`!! Commands sidebar category stays on its relay route` can time out clicking
Open sidebar because the floating `remote-compatibility-notice` covers it.
The failure snapshot showed an Update available notice for v0.8.1 while the
isolated server reported `v0.8.0-75-g43e725aa6`.

The combined relay/tooltip run passed 13 tests and failed only this click.
The notice is outside the tooltip typography work, so neither its layout nor
the relay fixture was changed. Make the navigation test control update-check
state or explicitly dismiss the unrelated notice before opening the sidebar;
retain separate coverage for the notice itself. Do not force-click through it.

Found 2026-09-06 while verifying the tooltip size offset and specimen.
Contributing-model: 6-Astra

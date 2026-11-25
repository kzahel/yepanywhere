# `agy` 1.5.17 did not present the routed profile's stand-in login

A routed Antigravity resume failed with `agy` 1.5.17 on macOS, and a probe
showed that version presenting a different login from the one in its
profile. YA writes a stand-in login into the routed profile
(`prepareAntigravityRoutedProfile`), and its loopback proxy accepts only
that stand-in. `agy` 1.5.14 presented it in a live run the same day.

Observed 2026-11-25 on macOS arm64:

- **Routed resume.** The launch logged language server version 1.5.17; the
  two launches an hour earlier logged 1.5.14, and the binary had changed in
  between. `agy acp` logged "token refreshed" with an expiry one hour ahead.
  The proxy rejected `loadCodeAssist` with 401 before forwarding it, and AAR
  logged no Antigravity request. The session ended with "Provider session
  completed before reporting a session id". The stand-in file was absent
  from the profile afterwards.
- **Probe.** `agy models` ran with `GEMINI_HOME` naming a new directory that
  held only a stand-in token file and `settings.json`, and `CLOUD_CODE_URL`
  naming a loopback listener that answered 401. The listener received 11
  requests in about six seconds. None carried the stand-in. It received five
  distinct 260-character values beginning with `ya29.`. Setting
  `SSH_CONNECTION` gave the same result. The probe's token file remained.

Where those values came from is not known. The user's default `agy` profile
on that machine holds no token file. The proxy forwards nothing on a failed
check, so what `agy` sent went no further than loopback.

The launch flags and the minimum version check (`1.5.13`) still pass, which
is why the failure is late and unhelpful. AAR's standalone bridge supplies
the same kind of stand-in and has not been tried with 1.5.17.

Not fixed in place because the cause inside `agy` is not known and its
`--help` lists no option for the login source. Likely next steps: find out
whether a machine with no other `agy` login still reads the file, and
whether a release note explains the change. Until then YA could refuse a
routed launch on an untested `agy` version with a message that names it.
AAR's opt-in for experimental Antigravity routing is off by default
([plan 198 step 4](../docs/tactical/198-aar-binding-transport.md#4--put-experimental-provider-opt-in-in-aar-settings)).

Found 2026-11-25 while checking that opt-in against a live account.

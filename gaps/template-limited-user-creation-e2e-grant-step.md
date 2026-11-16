# Limited-user template creation browser case fails at its grant step

`packages/client/e2e/project-template-creation.spec.ts` has two launch cases
that run only with `USE_MOCK_SDK=true`, which neither CI nor a default local
run sets, so both are normally skipped. Run with that variable, the superuser
case passes and the limited-user case fails before any creation:

```text
Locator: getByRole('group', { name: 'New projects from templates', exact: true })
           .getByRole('radio', { name: 'Any configured template', exact: true })
Expected: checked
Error: element(s) not found
```

The step is in Settings → Users (`/settings/users`), where the test opens the `template-user` chip and expects the template
grant radio group. The strings still exist (`usersTemplatesHeading`,
`usersTemplates_any`), so the group's role, name or placement has probably
changed since the case last ran. Because the case never runs in CI, it has
drifted without notice and no longer protects limited-user template creation.

Not fixed in place: the failure is in user-grant settings, unrelated to the
creation-recovery repair that surfaced it. Update the locator to the current
grant control, then decide whether these launch cases should run in CI or be
replaced by a cheaper check under
[test value and CI cost](../docs/development/testing.md#test-value-and-ci-cost).

Found 2026-11-16 while verifying template restore after reload.

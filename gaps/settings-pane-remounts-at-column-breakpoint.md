# Settings pane remounts when the column layout changes

`packages/client/src/pages/settings/SettingsLayout.tsx` renders the active
category pane under a different parent in each layout: the narrow detail view
nests it in `main > [data-page-content-inner]` (around line 568), the two-column
view in `main > .twoColumn > .contentPanel` (around line 618). The layout
follows `shouldUseSettingsTwoColumn` of a measured container width, so a resize
across `SETTINGS_TWO_COLUMN_MIN_WIDTH` (tablet rotation, window resize, docking
a pane) unmounts and remounts the whole pane. Focus and any uncommitted local
field state are lost, which brushes against the rule that typed input is never
dropped.

The browser evidence: `provider-steering.spec.ts:12` failed first attempts in
five CI runs from 2026-11-09 to 11-12 with `scrollIntoViewIfNeeded: Element is
not attached to the DOM`, a select located just before the phone-width remount.
The spec now waits for the layout to settle (`[data-settings-category-nav]`
count) before using the pane, which removes the test race but not the remount.

Cheap fix if the layout allows: keep the pane at one tree position and switch
only the surrounding wrappers' classes, or key-stable the pane via a portal.
Verify with sequential typing in a field while crossing the breakpoint.

Found 2026-11-13 while diagnosing first-attempt CI failures.

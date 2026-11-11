# New project from New session

Static proposal (2026-10-08) for making **New project** the one entry point
for a folder YA has not seen, with **Empty folder** as a peer of the template
choices. Typing an unused path into the project search opens the same panel,
replacing today's separate "Use typed path" row. Five states: pick existing,
new project (empty folder, optional Git init), new project from a template,
typed unused path, and problems (missing parent; one `mkdir`, never `-p`).

This is a single HTML file with values copied from the dark theme in
the shared purpose styles and component modules. It does not mount the real form, and nothing in it
creates folders or sessions. A typed path already creates one folder (a
missing parent is refused, except under a limited user's project root) and
always runs `git init` with an empty first commit
(`packages/server/src/routes/project-creation.ts`). The new server piece is
making that Git step optional; the "Create ~/work too" offer would also need
an explicit request flag.

Capture one state (the tab label's number selects it):

```sh
printf 'export default async ({ page }) => { await page.getByRole("tab", { name: /2 ·/ }).click(); };\n' > /tmp/state.mjs
pnpm -s artifact:capture packages/client/mockups/new-project-flow/index.html \
  --interact /tmp/state.mjs --ready-selector '[data-ready]' --json
```

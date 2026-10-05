# Private M.E build

This branch combines the 22 selected Marinara Engine contributions on staging
`35621d44bbe7bf3336943e1076e4e8065a8b835a`. Optional features start **OFF** and
can be enabled separately in Features. Turning a feature off preserves saved data.

Included areas: memory controls, campaign Wiki and indexing, scene continuity,
private notebook, authoring and dice tools, recaps, Keeper, profile links,
draft rewrites, campaign roster, portraits, gallery, audio and speech, editable
game prompts, prompt cache affinity, diagnostics, backups, update tools,
inventory stacks, game guide, and mobile HUD/accessibility.

## Run

Use Node 24–26 and the pinned pnpm 10.34.5:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm start
```

The app uses local storage. Start with a separate empty data directory when
evaluating this branch; keep backups of any existing installation.

## Validation and limits

The combined source passed `pnpm check`, including localization, formatting,
lint, types and the production build. Focused native checks cover feature
admission, ownership, rollback, storage safety and preserved data. Runtime
validation uses isolated synthetic data and automated browser interaction;
it is not human manual verification or a real-provider test.

This is a private evaluation branch, not an upstream release. Historical
CodeRabbit and Luna reviews of individual contributions do not certify this
combined tree. Review findings still requiring follow-up include retry-all
planning concurrency, canonical directional relationship mapping, legacy recap
revelation migration, and recap review handling of truncated transcripts and
cancellation refresh. These features remain opt-in.

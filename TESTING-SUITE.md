# Fork combined-suite tester setup

This is a tester snapshot for the two fork branches below. It is not an upstream-approved release.

- Engine: `SirAdoni/Marinara-Engine`, branch `combined-suite-2026-09-20`
- Agents: `SirAdoni/Marinara-Agents`, branch `combined-suite-2026-09-20`

The tester inventory is documented at [`docs/contribution-suite.html`](docs/contribution-suite.html).

## Fresh checkout

Run these commands from PowerShell. The Engine launcher requires Node.js 24 or newer.

```powershell
$root = Join-Path $PWD "combined-suite"
New-Item -ItemType Directory -Force $root | Out-Null
git clone --branch combined-suite-2026-09-20 https://github.com/SirAdoni/Marinara-Engine.git (Join-Path $root "Marinara-Engine")
git clone --branch combined-suite-2026-09-20 https://github.com/SirAdoni/Marinara-Agents.git (Join-Path $root "Marinara-Agents")
```

## Build the self-contained suite catalog

From the Agents checkout, generate the suite catalog. It combines the existing Engine 2 catalog and preview catalog, deduplicates by package ID with preview entries taking precedence, rewrites fork artifact/artwork URLs, and verifies every referenced local ZIP's declared size and SHA-256 digest.

```powershell
Set-Location (Join-Path $root "Marinara-Agents")
node scripts/build-suite-catalog.mjs
```

The output is `catalog/suite.json`.

## Build and start the Engine

Set the catalog override and an isolated data directory before launching. Port 7861 avoids the normal 7860 default.

```powershell
Set-Location (Join-Path $root "Marinara-Engine")
$env:DATA_DIR = Join-Path $root "combined-suite-data"
$env:PORT = "7861"
$env:HOST = "127.0.0.1"
$env:AUTO_OPEN_BROWSER = "false"
$env:MARINARA_AGENT_CATALOG_URL = "https://raw.githubusercontent.com/SirAdoni/Marinara-Agents/combined-suite-2026-09-20/catalog/suite.json"
cmd /c .\start-local.bat
```

The launcher installs the pinned dependencies, builds the checked-out Engine, and starts the server. Open `http://127.0.0.1:7861` after it reports readiness.

For a manual setup, the verified Engine scripts are:

```powershell
corepack pnpm install
corepack pnpm build
corepack pnpm start
```

Keep the same environment variables in the server process when using the manual path.

## Validation

Open **Agents â†’ Download Agents** and compare the displayed package inventory and versions with `docs/contribution-suite.html`. Install a representative package, exercise its documented surface, restart the server, and confirm the installed package remains available.

The suite catalog is generated from the fork branch and points at that branch's artifacts and artwork. It remains a tester snapshot until the normal upstream review, publication, and release gates are complete.

## Source snapshot and checks

Engine base: `41a60e30a` from upstream staging. Agents base: `e28f527b` from upstream staging. This branch preserves the combined local source state on 20 September 2026; it does not claim to contain later upstream changes.

Checks performed for this snapshot:

- Frozen dependency installation: passed after reconciling the lockfile with existing package settings.
- Engine production build: passed (shared, server, and client).
- Engine localization and lint: passed; lint reports one React dependency warning.
- Clean-data startup: the built server started on a separate port and the browser rendered the home screen and first-run tutorial.
- Agents standard catalog validation: passed.
- Suite catalog: all 39 package archive sizes and SHA-256 hashes verified.
- Sanitized fixture checks: scene-presence and character-reference matching passed.
- Staged changes scanned for private campaign names, personal paths, and common credential patterns; private fixture names were replaced with neutral examples. No campaign saves or credentials are included.

The full `pnpm check` command stops at the Impeccable contributor-tooling check because the contributor skill path is unavailable in this Windows checkout (Git materialized the upstream skill symlink as a pointer file). The build, localization, and lint checks above were run separately; this is not a full-suite pass. Provider generations and all campaign workflows were not exercised for this fork publication. The attached inventory contains additional known limitations, including layout, migration, and regression-test follow-up work.

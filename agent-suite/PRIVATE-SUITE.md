# Private agent suite

This directory preserves the downloadable-agent side of SirAdoni's test build alongside the Engine. It is a standalone Marinara-Agents source snapshot, not another Engine workspace package. The Engine's source remains in the repository root.

## Contents and provenance

- All 40 current package directories, their manifests and source, build helpers, captured Engine build inputs, schemas, artwork, catalog lanes and regression fixtures are preserved.
- Only the current ZIP for each package is retained under `artifacts/`; old ZIP versions, dependencies, logs, databases, campaign data, backups and local tooling state are excluded.
- `snapshot.json` records the source baseline, enclosing Engine commit, byte-level capture digest, package versions, archive hashes and modified support paths.
- The snapshot takes the latest working-file contents, including changes newer than the source checkout's Git index. Maps is 1.4.29; Long-Term Memory is 1.3.6.
- Fourteen package directories carry private changes: card-evolution-auditor, character-tracker, continuity, custom-tracker, director, hierarchical-maps, inventory-tracker, long-term-memory, lorebook-keeper, memory-nag, persona-stats, prose-guardian, quest and world-state.
- The nested `sources/engine/` tree supplies captured build inputs. It does not overlay the enclosing Engine or change the running installation.
- Upstream licenses, attribution and contribution guidance remain with the captured source. This snapshot does not claim to match the latest upstream Agents staging branch.

## Rebuilding from a fresh checkout

Use Node 24 or a compatible version allowed by both projects. Install the Engine's pinned dependencies from the repository root:

```powershell
corepack pnpm install --frozen-lockfile
Set-Location agent-suite
npm ci
$env:MARINARA_ENGINE_ROOT = (Resolve-Path ..).Path
```

Read this directory's `CONTRIBUTING.md` before rebuilding. The existing scripts default to the captured `sources/engine/` tree; keep that default when reproducing this private snapshot. `MARINARA_ENGINE_ROOT` points at the enclosing Engine to resolve build dependencies, not at a new sibling checkout.

The agent-only catalog builder regenerates its agent definitions and catalog lanes. The feature builder accepts package IDs, so a focused rebuild is possible:

```powershell
node scripts/build-agent-catalog.mjs
node scripts/build-feature-packages.mjs hierarchical-maps long-term-memory memory-nag
```

These commands update package payloads, manifests, archives and catalogs. They do not start the Engine or install packages into its data directory. Re-run integrity checks after a rebuild and update the snapshot provenance if publishing new generated outputs.

## Validation

```powershell
npm run check
node scripts/test-catalog-lanes.mjs
node scripts/validate-package-locales.mjs
node scripts/validate-catalog.mjs
node scripts/tests/catalog-release-notes.regression.mjs
```

The publication audit compared every copied file with its source and checked the 40 current ZIPs against their manifests and payload hashes. That confirms capture and archive integrity; it is not a claim that every agent was exercised in a live campaign.

Catalog download URLs remain those recorded by the source repository. Merely archiving this directory does not configure a private download feed or replace any installed package. Use the current local archives for the preserved private payloads rather than assuming an upstream download URL serves them.

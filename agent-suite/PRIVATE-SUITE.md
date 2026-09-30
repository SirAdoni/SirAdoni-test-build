# Private agent suite

This directory preserves the downloadable-agent side of SirAdoni's test build alongside the Engine. It is a standalone Marinara-Agents source snapshot, not another Engine workspace package. The Engine's source remains in the repository root.

## Contents and provenance

- The original capture contained 40 package directories, manifests, source, build helpers, captured Engine inputs, schemas, artwork, catalogs and regression fixtures. The integration adds upstream packages and reconciles upstream source removals; current inventory belongs to the separate integration receipt.
- The original capture retained one ZIP per package and excluded old ZIP versions, dependencies, logs, databases, campaign data, backups and local tooling state. During integration, original archives remain recovery evidence until rebuilt archive/catalog integrity is recorded. No historical upstream ZIP collection is imported.
- `snapshot.json` is the immutable original capture receipt: its versions, hashes and digest describe the captured files, not the integrated tree. Keep it unchanged. `UPSTREAM-INTEGRATION-20260930.json` records integration inputs, applied source hashes and current source and generated-output verification; A local off-repository removal ledger records audited source removals and recovery hashes.
- The original snapshot took the latest working-file contents, including changes newer than the source checkout's Git index. Captured Maps was 1.4.29 and Long-Term Memory 1.3.6. The reconciled archives are Maps 1.4.30, Long-Term Memory 1.3.34 and private Slurp2 0.3.7. All42 current ZIP manifests and declared payload bytes were audited against their package folders and catalogs; see GENERATED-INTEGRITY-20260930.json. This is archive integrity, not a full TypeScript or live-campaign claim.
- Fourteen package directories carry private changes: card-evolution-auditor, character-tracker, continuity, custom-tracker, director, hierarchical-maps, inventory-tracker, long-term-memory, lorebook-keeper, memory-nag, persona-stats, prose-guardian, quest and world-state.
- The nested `sources/engine/` tree supplies captured build inputs. It does not overlay the enclosing Engine or change the running installation.
- Upstream licenses, attribution and contribution guidance remain. Integration compares original source baseline `e28f527ba2b57ce193da3f22046ad8f8afe8cb2f` with upstream Agents staging `e6c59592198f1ab760928d699cacb96ed85d3aa7` and the later bounded Slurp2 delta `4e10fb9044f6a3758356526648dbd3fec71df161`, preserving private changes. It is a reconciled private tree, not an unmodified upstream checkout.

## Rebuilding from a fresh checkout

Use Node 24 or a compatible version allowed by both projects. Install the Engine's pinned dependencies from the repository root:

```powershell
corepack pnpm install --frozen-lockfile
Set-Location agent-suite
npm ci
$env:MARINARA_ENGINE_ROOT = (Resolve-Path ..).Path
$env:MARINARA_ENGINE_SHARED_ROOT = $env:MARINARA_ENGINE_ROOT
```

Read this directory's `CONTRIBUTING.md` before rebuilding. The existing scripts default to the captured `sources/engine/` tree; that default preserves package-owned source. `MARINARA_ENGINE_ROOT` resolves enclosing Engine dependencies. `MARINARA_ENGINE_SHARED_ROOT` uses its already-built current shared index plus retained typed package-owned game exports. Build the enclosing shared package first through the Engine workflow; agent builders do not rebuild it. The original capture receipt remains unchanged. Any reconciled captured-source helper repairs belong to the separate integration/hash receipt, not a rewritten original capture receipt.

The agent-only catalog builder regenerates its agent definitions and catalog lanes. The feature builder accepts package IDs, so a focused rebuild is possible:

```powershell
node scripts/build-agent-catalog.mjs
node scripts/build-feature-packages.mjs hierarchical-maps long-term-memory memory-nag
```

These commands update package payloads, manifests, archives and catalogs. They do not start the Engine or install packages into its data directory. Re-run integrity checks after a rebuild and update the separate integration receipt with current package/catalog/archive hashes. Never replace the original capture receipt with new hashes.

## Validation

```powershell
npm run check
node scripts/test-catalog-lanes.mjs
node scripts/validate-package-locales.mjs
node scripts/validate-catalog.mjs
node scripts/tests/catalog-release-notes.regression.mjs
node scripts/tests/package-shared-entry.regression.mjs
node scripts/tests/typecheck-launch.regression.mjs
node scripts/tests/summary-tail-shared-compat.regression.mjs
node scripts/tests/internal-route-sdk-contract.regression.mjs $env:MARINARA_ENGINE_ROOT
node scripts/typecheck-packages.mjs --engine-root $env:MARINARA_ENGINE_ROOT --build-proof-root $env:MARINARA_FEATURE_METAFILE_DIR noodle slurp2 long-term-memory hierarchical-maps
```

The original capture audit compared every copied file with its source and checked its 40 ZIPs. That evidence applies to the original capture only. Current integrated-source tests, rebuilt archive checks and catalog hashes must be recorded separately. Passing source or archive checks does not establish live-campaign correctness.

Catalog download URLs remain those recorded by the source repository. Merely archiving this directory does not configure a private download feed or replace any installed package. Use the current local archives for the preserved private payloads rather than assuming an upstream download URL serves them.

The default package typecheck remains a narrow syntax/missing-name/import gate. For the exact current-host mode, choose a NEW EMPTY `MARINARA_FEATURE_METAFILE_DIR` and rebuild the selected four features with the dependency/shared flags above. The builder retains actual esbuild inputs, source hashes and generated entry wrappers. The runner verifies captured/package-owned source hashes, uses separate production client/server strict options and records complete raw diagnostics plus compiler/support roots. It must not substitute a fresh host source overlay. The complete strict matrix still fails: Noodle 492, Slurp2 2,916, Long-term Memory 88, and Hierarchical Maps 0 diagnostics. Both actual activation SDK harnesses pass after the callback annotation repair. Exact strict diagnostics and remaining defects are retained in a local off-repository CURRENT-HOST-TYPECHECK-ASSESSMENT-20260930.md handoff; that machine-specific receipt is not shipped. The latest rebuilt Slurp2 archive passed isolated install/startup/selfCheck, and the latest rebuilt Maps archive passed the full lifecycle fixture with25verified historical versions. Noodle startup/LTM browser and recovery proofs are retained for unchanged archive bytes with their recorded historical environments. Command owns remaining compatibility scope and live readiness. Manifest builtAgainst fields describe captured Engine provenance, not a claim that the archive was rebuilt against that exact historical commit; GENERATED-INTEGRITY-20260930.json identifies current artifact and fresh shared hashes.

Local off-repository INSTALL-UPGRADE-*-20260930.json handoffs contain exact catalog entries, machine-specific ZIP paths and expected installed versions for the10 read-only observed upgrades; these are not shipped files or portable install commands. Command owns installation and runtime state. Preserve newer/live-only packages, existing prompts/settings/connections/data and optional-package absence; health metadata alone does not prove same-version byte equivalence.

Latest bounded delta: only Slurp2 and Maps were rebuilt; unchanged Noodle/LTM archives and exact build-input receipts were retained. The approved private Slurp2 numeric version remains0.3.7, so use the exact ZIP/source SHA256s in the integration receipt to distinguish this payload from public0.3.7. All 13 changed Slurp2 regressions and final formatting/lint checks passed (0 errors and 821 retained warnings). No live/provider validation is claimed. Machine-specific diagnostic, removal and upgrade receipts are local off-repository handoffs; portable provenance and exact artifact hashes remain in the shipped integration/integrity receipts.

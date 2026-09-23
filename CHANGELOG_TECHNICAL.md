# Technical changelog

## 2026-09-21

### Mobile Game Mode presence, widget tray, and narration bounds

- `packages/client/src/components/game/GameSurface.tsx` — moved the mobile scene-presence strip out of document flow below the map/party controls. Previously `FloatingGamePanel` returned its children inline below 1024px, adding presence height ahead of an already full-height game surface and pushing the composer below the viewport. The strip retains the existing portrait/count menu and exposes Campaign Wiki through an accessible icon button. Desktop rendering still uses the original floating panel and saved placement.
- `packages/client/src/components/game/GameSurface.tsx` and `GameWidgetPanel.tsx` — the narration widget slot now combines left/right widgets into one non-wrapping horizontal scroll row with non-shrinking 44px targets. Horizontal-mode expansion uses the existing modal, widget body, character linking, and value editor; dismissing or editing does not expand the tray or displace narration. Existing choice-stage vertical rails retain their previous behavior.
- `packages/client/src/components/game/GameNarration.tsx` — reserved mobile header clearance and constrained the flexible controls/narration region. Controls retain their natural height within a bounded scroll area rather than overflowing a zero-height flex item when narration is long. Narration keeps its own scrolling, and the sprite-stage measurement wrapper and both exploration/travel slots remain intact.
- `packages/client/src/components/game/GameStoryboardViewer.tsx` — capped the inline viewer against the remaining mobile height, keeping its close/header area reachable and leaving room for narration on short or landscape screens. Desktop viewer sizing is unchanged.
- No settings, database schemas, stored panel coordinates, campaign messages, provider requests, or generation behavior are changed by this UI patch. Existing localization keys are reused; no new English-only product strings were introduced.
- Regression coverage: `scripts/ui-fixtures/game-hud/component-entry.tsx` and `run.mjs` add synthetic mobile widgets at 320x568 and 390x780, covering one-row layout, target sizes, horizontal reachability, real modal-panel bounds, dismissal, and stable tray geometry. These focused assertions passed.
- Verification: `corepack pnpm check` passed after removal of an obsolete horizontal comparison in the vertical-only branch. This includes formatting, localization, ESLint, TypeScript, and client/server/shared builds; the existing translation-effect dependency warning remains. Browser geometry was checked at 320x568, 390x780, 658x1280, 768x1024, 844x390, and 1440x900. On the saved campaign, the composer and send control were reachable, widget expansion/edit controls stayed in bounds, and mobile document width did not overflow. The production server served the newly built client bundle without a backend restart.
- Validation boundary: browser viewport emulation is not a physical-phone/soft-keyboard test. The full `node scripts/ui-fixtures/game-hud/run.mjs` fixture passed, including the new mobile assertions and existing desktop/reload/right-anchor checks. Earlier desktop runs intermittently failed; both the unchanged HEAD fixture in an isolated temporary worktree and the completed patched fixture passed on the subsequent comparison, so the earlier failure was not reproduced. No GitHub publication was performed.

### Align ChatGPT cache-session header with the official transport

- `packages/server/src/services/llm/providers/openai-chatgpt.provider.ts`: changed the outgoing stable cache-session header from `session_id` to `session-id`. HTTP header names are case-insensitive, but underscore and hyphen are distinct; the request header merge preserved the legacy spelling unchanged.
- Rationale: OpenAI Codex's official `build_session_headers` writes `session-id`, and merged OpenAI PR #44862 explicitly identifies that header as the ChatGPT Responses cache-affinity input. Sources: https://github.com/openai/codex/pull/44862 and https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/requests/headers.rs .
- Historical compatibility: OpenAI PR #21757 (https://github.com/openai/codex/pull/21757) added hyphenated headers alongside the older underscore spelling in May 2026 for consumers that normalize or reject underscore headers. The current official builder sends the hyphenated spelling. This history and the successful legacy probe prevent concluding that the old header was universally ignored.
- Kept the existing chat-scoped session value, JSON `prompt_cache_key`, prompt contents, model settings, authentication, and reported usage unchanged. No campaign data changes, migrations, added dependencies, Claude changes, or cross-turn reuse of provider turn-state headers.
- Incident evidence: the saved positive-hit request and following zero-hit request had identical instructions, request options, cache key, and all 173 preceding input items as an exact prefix of the subsequent 181 items. The failing request later returned 336,128 cached tokens from 336,368 input tokens when resent unchanged. This demonstrates cacheability, not a guaranteed hit or a proven explanation of the original miss.
- Live transport comparison: six sequential synthetic requests, three per spelling with appended input, completed through the configured ChatGPT route. Both variants started cold and then reported 24,064 cached tokens of 24,250 and 24,263 input tokens. This validates acceptance and warm reuse with the corrected spelling; it did not reproduce intermittent misses or establish a comparative hit-rate improvement. Synthetic probes did not create RP messages or modify campaign data.
- Verification: `scripts/regressions/full-lore-context.regression.ts` passed using synthetic authentication, the actual ChatGPT delegate, and its actual OpenAI transport pointed at a local HTTP server. Assertions cover emitted header spelling/value, stable same-chat affinity after lore changes, separate-chat isolation, omission for ordinary prompts, and unchanged request bodies. Temporarily restoring the legacy production header made this regression fail at the intended outgoing-header assertion; the corrected source was restored. Full `corepack pnpm check` passed, including formatting, localization, lint/type checks and production builds. `git diff --check` passed. Deployment: after user approval, all 17 chats reported inactive and no tracked generation jobs were running immediately before the managed restart request. The replacement server returned healthy, started after the corrected provider build, and reported the previous session ended through restart/exit 75. The corrected header is loaded; sustained RP cache-hit behavior remains unverified.
- Limitation: the header mismatch is a verified transport compatibility discrepancy and a plausible contributor to unstable routing. Whether the backend accepts the old spelling as a legacy alias is not established. Provider routing, eviction, and other causes of the historical zero-cache events remain unobservable from the available responses. This change must not be described as proving that every zero-cache event is fixed.

### Preserve an established ChatGPT replay chain after a cache miss

- `packages/server/src/services/generation/prompt-history-replay.ts`: a finite, nonnegative zero cached-token count no longer disables an already-established replay chain. Previously this caused the next turn to return to canonical history, changing an otherwise reusable prefix after an intermittent miss.
- Initial enrollment still requires a positive partial cache hit and at least 200,000 prompt tokens. Missing, negative, non-finite, and impossible usage values remain ineligible. This change does not treat unavailable telemetry as zero or change reported usage.
- Source-message, swipe, scope, descriptor hash, text-only, context-fitting, and replay-overhead guards remain unchanged. Retained overhead remains limited to the smaller of 500,000 characters and half the canonical prompt size; preserving a chain can therefore retain bounded extra input when provider cache reuse is unavailable.
- No campaign records, history, schemas, provider parameters, or Claude behavior are changed. No database migration is required.
- Evidence boundary: a controlled same-turn comparison through the configured ChatGPT route completed with both canonical and replay prompts. The previously failing replay request later reused its cache when resent byte-for-byte. That establishes that the request is cacheable, not that initial misses are solved. The recovery change addresses the subsequent local prefix reset only.
- Capability probes: the ChatGPT subscription endpoint rejected both `prompt_cache_retention` and `prompt_cache_options` with HTTP 400 unsupported-parameter responses. No unsupported retention or diagnostic parameters were added to production requests.
- Verification: all four `prompt-history-replay` regression files passed, including the production eligibility gate followed by actual Responses mapping across a positive-hit / zero-hit / next-turn sequence. `corepack pnpm check` completed successfully (formatting, localization, lint, TypeScript checks, and client/server/shared builds). The PowerShell validation wrapper needed native-stderr handling corrected so a pnpm configuration warning did not abort validation. Deployment: after explicit user approval, the managed server restarted gracefully through its admin restart endpoint. Health returned OK, the previous session reported restart/exit 75, and the new process started after the compiled replay helper was updated. Post-deployment RP cache behavior remains unverified.
- Remaining limitation: initial provider-reported zero-cache results with an unchanged prefix remain unexplained by the available response metadata. This patch does not promise a cache hit or claim to prevent provider-side misses.

## 2026-09-20

### ChatGPT Game Mode history-cache reuse with changing state

#### Problem and scope

The affected ChatGPT Game Mode requests could keep reusing a static lore prefix while their total input grew. A declining cached-input percentage alone is not proof of a cache failure; request inspection also identified two local blockers: replay rejected legitimate system-role runtime snapshots, and eligibility counted configured tools even when a separate tool connection owned them.

This patch changes the existing replay implementation. It does not introduce a second caching service, promise provider cache retention, or alter Claude's cache placement.

#### Changed production modules

- `packages/server/src/services/generation/prompt-history-replay.ts`: seeds a snapshot-scoping preamble in the canonical prompt before the first current-turn injection. The first archived request therefore already contains the boundary needed for later append-only replay.
- The preamble remains at system priority and identifies snapshots as applying to the following user turn. The newest snapshot replaces previous snapshots, including fields no longer present. Standing instruction priority remains unchanged.
- Replay permits system-role injections only when their internal metadata contains both the runtime marker and the explicit snapshot marker. A generic runtime marker alone is insufficient. Unknown system messages fail closed.
- These markers are internal producer contracts, not an authentication mechanism or permission for arbitrary user-authored instructions.
- Replay retains the exact previously sent expanded prompt, then appends the intervening assistant history, new scoped state and current user turn. Descriptor construction continues to use the canonical prompt, separately from the expanded provider prompt, so offsets do not drift on successive turns.
- Replay scope version increases to 2 to invalidate descriptors using the old boundary contract. Descriptor shape version remains 1. No database migration, chat rewrite or deletion is required.
- `packages/server/src/services/generation/prompt-cache-layout.ts`: adds an explicit optional snapshot opt-in to the existing runtime-message wrapper. Its default remains off; only newly inserted system messages are marked when requested.
- `packages/server/src/services/generation/game-gm-prompt-runtime.ts`: explicitly identifies producer-owned dynamic GM context as a replay snapshot.
- `packages/server/src/routes/generate.routes.ts`: opts spatial context and continuity snapshots into the contract, seeds eligible canonical messages before fitting and descriptor creation, and counts tools on the actual narrator request. When a separate Game Mode tool connection owns tools, narrator tool count is zero; otherwise the responder's tool definitions determine eligibility.
- Rationale comments document scope invalidation, producer boundaries, preamble priority, canonical-versus-expanded persistence and actual narrator tool ownership.

#### Preserved boundaries and compatibility

- Eligibility remains restricted to the existing ChatGPT merged Game Mode path for an ordinary explicit user turn. Regeneration, continuation, impersonation, autonomous turns and tool follow-up iterations remain excluded.
- Narrator requests carrying tools remain excluded. Model, scope, source-message, swipe, hash, text-only and context-budget checks remain in place.
- Existing entry criteria remain: a sufficiently large prompt (200,000 characters), reported cached input greater than zero, and a cached-input fraction below 80 percent. An established valid replay chain may continue above that fraction. These are local replay heuristics, not provider cache specifications.
- Added historical-state overhead remains bounded by the smaller of 500,000 characters and 50 percent of canonical prompt characters. Requests that cannot satisfy existing guards fall back to canonical construction.
- No new provider API parameters, dependencies, persisted schema fields or Claude-specific changes are introduced.

#### Regression coverage

- `scripts/regressions/prompt-history-replay.regression.ts`: existing replay guards and the revised seeded-boundary contract.
- `scripts/regressions/prompt-history-replay-route.regression.ts`: actual route eligibility expression, including separate tool ownership and narrator tools.
- `scripts/regressions/prompt-history-replay-snapshots.regression.ts`: producer-owned snapshots, first-turn seeding, marker rejection and compatibility boundaries.
- `scripts/regressions/prompt-history-replay-wire.regression.ts`: the actual OpenAI message mapper across successive turns, exact previous-prefix preservation and mixed user/system state with a removed roster entry.
- Fixtures are synthetic. Tests do not contain saved campaign content, credentials or private installation paths.

#### Verification and limitations

- Frozen-lockfile installation and full `pnpm check` passed in the destination checkout, including formatting, lint/type checks and production builds.
- All four targeted replay regression files passed in the destination checkout.
- All 16 cache-filtered regression files passed, along with context-fit, prompt-attachments and the broad prompt regression: 23 regression files passed in total including the four targeted replay files. The broad prompt regression passed in this fork checkout; a separate earlier source-checkout failure is not attributed to this destination build.
- Deterministic tests establish request construction and guard behavior. They do not establish an improved live provider cache-hit rate or guarantee model adherence to snapshot instructions. The first eligible request establishes the revised boundary; subsequent compatible turns can reuse it. Provider eviction, expiry and changing canonical context can still reduce reuse.

#### Operational privacy

The local installation transfer is separate from this source contribution. Active data was copied and hash-verified with the source stopped; originals were retained. Backup archives, old diagnostics/logs and disposable caches were excluded. Generated dependency junctions were recreated against the destination. Private data, connection secrets, encryption keys, environment files and migration manifests are not part of the commit.

### Follow-up: align replay eligibility with ChatGPT transport tool omission

- Live post-deployment requests still reported the same cached-input count as input grew. Their saved replay descriptors were null and their prompts lacked the seeded preamble. The previous change had not activated replay for this incident; deterministic validation did not establish a live cache improvement.
- Both affected saved prompt arrays passed offline snapshot seeding and descriptor creation. Replaying the second against the first preserved the complete previous prompt prefix under the configured context budget. Private request contents remained local and were not added to fixtures or source control.
- The remaining mismatch is between configured responder tools and serialized provider requests: the ChatGPT Responses builder deliberately omits native tool schemas, while the route counted those definitions as a replay exclusion. The separate Game Mode tool-connection correction did not cover that transport behavior.
- The generation route now evaluates the ChatGPT transport's effective native tool count. This is narrowly scoped to its existing tool-omission contract; it does not change tool execution, enable native ChatGPT tools, alter Claude handling or expand replay to other providers.
- Existing final-prompt hash checks still prevent persisting a descriptor if later tool execution or other processing changes the actual request. Existing source/swipe, scope, snapshot trust and budget guards remain authoritative.
- Debug-mode diagnostics report eligibility booleans/counts, snapshot seeding, descriptor creation, source guard/threshold decisions and final persistence. They contain no prompt text, character names or credential values.
- Regression coverage exercises the actual Responses request builder with configured tools, alongside the production route's tool-count expression, so provider omission and route eligibility cannot silently diverge again.
- Verification: full `pnpm check` passed, including formatting, lint/type checks and production builds. All 23 replay, cache, attachment, context-fit and broad prompt regression files passed. The real Responses request-builder fixture confirms that configured tools are absent from ChatGPT requests and present on ordinary OpenAI requests. Actual provider cache-hit improvement remains unverified until the rebuilt server handles successive eligible turns.

### Follow-up: compact identical replay snapshot sections

#### Motivation and behavior

- Live provider telemetry after the transport-eligibility correction showed approximately 94 percent cached input on consecutive compatible requests. The provider reused nearly the entire preceding request, but newly appended context still repeated large unchanged state sections. This follow-up reduces that avoidable appended input instead of changing the displayed percentage or suppressing updated state.
- `packages/server/src/services/generation/prompt-history-replay.ts` labels producer-owned system snapshot sections with deterministic SHA-256 identities. Identities bind role, exact content and producer metadata; eligibility for replacement additionally checks the complete message fingerprint. User dialogue, assistant history, unmarked instructions and stable-prefix messages are not deduplicated.
- An appended section can become a compact same-role reference only when the retained previous prompt contains its exact full labeled payload. References never target other references. Changed sections remain full payloads. Small sections remain inline when a reference would not save space.
- The snapshot preamble defines references as unchanged sections of the newest snapshot. Sections or fields omitted from that newest snapshot are absent, not implicitly inherited. A removed section can reappear by reference only when its complete content matches an earlier retained full section.
- Previously sent messages remain byte-for-byte unchanged. Canonical descriptor fingerprints continue to describe full current state separately from the compact expanded prompt actually sent, preserving successive-turn offsets and edit detection.

#### Compatibility, integrity and privacy

- Replay scope version increases from 2 to 3 because visible snapshot labels and preamble semantics change. Old descriptors fail the existing version guard and fall back to normal canonical construction; the first compatible request seeds the new layout. No database migration, saved-chat rewrite, new dependency or provider API parameter is required.
- Provider/model/scope, source-message/swipe, previous-prompt hash, text-only, actual tool ownership, context-fit and bounded-overhead guards remain in force. Claude cache behavior is unchanged.
- Hash labels are internal consistency identifiers, not credentials or an authorization mechanism. Private campaign contents and request captures remain local and are excluded from source control.

#### Verification boundaries

- Read-only offline replay of an actual consecutive request pair reduced appended text from 86,467 to 34,619 characters: 51,848 characters avoided across two unchanged system sections. The retained prior prefix was identical. This measures request construction, not provider token billing or a promised future cache percentage.
- Regression coverage: four replay files passed, including a seven-turn fixture that reconstructs the newest snapshot from visible backward references, exercises unchanged/changed/removed/reappearing state and changed producer metadata, preserves repeated dialogue and unmarked instructions, and asserts actual appended-character savings. The actual OpenAI mapper preserves each earlier serialized prefix while sending references for unchanged sections. The existing route fixture uses sufficient static context to test persistence without unintentionally hitting the unchanged overhead ceiling.
- Full `pnpm check` passed: formatting, localization, lint/type checks and production builds. All 19 broader cache, context-fit, attachment and prompt regression files passed (23 files total). The final diff passed whitespace validation and a targeted added-line privacy scan. No live provider call was made by this verification. Model adherence to the reference instructions and the resulting live cache percentage still require subsequent real turns. Fresh dialogue, changed state, prompt edits, cache expiry and provider eviction can all limit reuse.

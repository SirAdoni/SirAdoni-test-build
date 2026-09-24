# Technical changelog

## Fork feature inventory (vs upstream Pasta-Devs staging)

A standing list of everything this fork carries over upstream `Pasta-Devs/Marinara-Engine` `staging`, so no feature is forgotten. Every user-visible feature, shortcut, route, setting and behaviour gets its own bullet. Update this list whenever a feature lands, changes its switch or is dropped.

- Baseline (2026-09-24): branch `memory-system-finish` at `1f04fede6`; merge base with `upstream/staging` is `60ed7ec80` (upstream sync 2). `git log upstream/staging..HEAD` lists 163 fork commits (158 without merges). Most of the Game Mode base (storyboards, Contact Book, scene timeline, continuity, first Campaign Wiki) arrived in one large commit, `44fba2b25` (2026-09-20, 770 files).
- Switch rule: every addition can be turned off. On (the default) is this build's behaviour; Off restores upstream's. Generation job tracking and a few older opt-ins start off. Pure bug fixes carry no switch. Reference: `docs/configuration/features.md`; audit of what still lacks a switch: `review-2026-09-22/optional-settings-audit_v1.0.md` (outside the repo).
- User-facing wording for most items is in `CHANGELOG.md` `[Unreleased]`; the dated sections below hold the technical detail.

### Engine, logging, robustness and performance (18)

- Request trail logging: every line in a request carries `requestId`, returned as the `x-request-id` header; one `request.end` line per request, `request.slow` and `request.aborted` lines. Files: `server/src/lib/http-diagnostics.ts`, `log-events.ts`; spec `docs/development/logging.md`, `LOGGING.md`. No switch.
- Startup timeline: `startup.phase` timing, the failing phase named, one `startup.ready` summary (activated, failed and skipped capability packages) also reported by `/api/health`. File: `server/src/lib/startup-timeline.ts`. No switch.
- Build integrity check: startup verifies the running `dist` matches its sources; the build fails when compiled output is missing for a source module. Files: `server/src/lib/build-integrity.ts`, `server/scripts/write-build-meta.mjs`. No switch.
- One error line per failure: cause chains, AggregateError members and system error details kept; cancellations at info, client mistakes at warn; repeated warnings rate-limited with a suppressed count; silent catches replaced by logged best-effort helpers (`server/src/lib/best-effort.ts`, `logSuppressed`). No switch.
- Runtime memory telemetry: heap, external memory, event-loop p99, stalls and host freezes logged once per episode with worker gauges. Files: `server/src/lib/runtime-diagnostics.ts`, `worker-gauges.ts`. No switch.
- Prompt debug output only under `logs/prompt-debug/` (never the main log files; debug level no longer unredacts prompts). Files: `server/src/lib/rotating-sink.ts`, logger config. No switch.
- Startup inject gate: early `app.inject()` calls are held until route registration ends, fixing "Root plugin has already booted" startup deaths. Files: `server/src/lib/fastify-inject-gate.ts`, `app.ts`. Always on (bug fix).
- Capability packages keep their installed version and status on host lifecycle errors, so the next start retries them. File: `services/capability-packages/capability-module-runtime.service.ts`. Always on.
- Storage flush skips byte-identical shards and `manifest.json` and serializes large shards in event-loop-yielding slices. File: `server/src/db/file-backed-store.ts`. Always on.
- Windows boot id cached per boot (about 1.5 to 2 s saved at startup). File: `server/src/db/writer-host-identity.ts`. Always on.
- Bounded shutdown: per-step timed stops, a timed-out step logs `outcome failed / reason timeout`, crashes keep their nonzero exit code. Files: `server/src/lib/shutdown-steps.ts`, `shutdown-signals.ts`. Always on.
- Admin runtime diagnostics endpoint (startup, build integrity, memory and worker gauges). Files: `routes/admin.routes.ts`, `routes/diagnostics.routes.ts`. Always on.
- Provider retry of transient failures (connection refused, 502, 503) up to twice before any output, on the next DNS address; nothing replayed after the upstream accepted. Switch **Retry failed provider calls** (`providerRetry`, default on; env `PROVIDER_RETRY_TRANSIENT_ERRORS` wins).
- Background call cap: hourly cap on automatic model calls; continuity backfill uses a share and pauses on its own, live turns keep running, local endpoints exempt. File: `services/generation/background-call-budget.ts`. Switch **Background call cap** (`backgroundCallCap`, `backgroundCallsPerHour` default 600; env `MARINARA_BACKGROUND_CALLS_PER_HOUR` wins).
- Lorebook scan compaction: full scan text only on the newest message row; swipes store ids, keys and scores; Active Context and agent retries fall back to the stored entry text. Files: `services/lorebook/lorebook-scan-compaction.ts`, `services/storage/chats.storage.ts`, `routes/generate/retry-agents-route.ts`. Always on (no switch yet; listed in the audit).
- Reviewed server bug fixes from the 2026-09-22 whole-fork review (39 files) and the 2026-09-23 non-game server review (batches 0 to 57, one dated entry each on 2026-09-23), each batch with a `server-hunt-b<N>` or `bughunt-*` regression: runtime-config `.env` reload diff, fatal-error flush, IP allowlist CIDR and IPv6, per-route rate limits, SSRF reserved-address checks, background uploads, export name collisions, backup central directory cap, storage pre-shard restore and writer lease, importers, providers, textual tool-call parsing, sidecar downloads, deleted built-in regex scripts staying deleted. Always on.
- Launcher safety: `scripts/preserve-untracked-src.mjs` runs from `start.bat`, `start.sh` and `start-termux.sh` before their `git clean -fd -- packages/*/src`, backing up untracked source to `.tmp/untracked-src-backups/`; `scripts/pnpm.cmd` keeps the pinned package manager for nested Windows builds; `scripts/open-when-ready.cmd`, `scripts/verify-installed-build.mjs`. Always on.
- Regression runner isolation: `scripts/run-regressions.mjs` gives each file its own temporary `DATA_DIR`, `FILE_STORAGE_DIR` and an empty `MARINARA_ENV_FILE`; `fixtures/server-shared.ts` shares the server's `@marinara-engine/shared` instance; all fixtures use invented names.

### Prompt caching (9)

- Claude subscription history cache marker: the marker goes on the last completed assistant turn whenever everything after it is injections plus the one current user turn (game prompts ending on the player canon check had no history marker; 61% cached on a 520k-token prompt before the fix, about 93 to 95% reported by the coordinating session afterwards). File: `server/src/services/llm/providers/claude-subscription/jsonl-entries.ts`. No switch (bug fix).
- Claude Opus 5.5 (`claude-opus-5-5`) in the Anthropic and Claude subscription model lists and the history-level system text list; Agent SDK 0.3.280. Files: `shared/src/constants/model-lists.ts`, `anthropic.provider.ts`, `server/package.json`.
- ChatGPT history replay: Game turns resend the exact previous expanded prompt and append the newest state; producer-marked snapshots only, backward references for unchanged sections (scope version 3), the chain survives a zero-cache turn, bounded overhead. Files: `services/generation/prompt-history-replay.ts`, `routes/generate.routes.ts`, `services/llm/providers/openai-chatgpt-cache.ts`. Switch **ChatGPT history replay** (`chatgptHistoryReplay`, default on).
- ChatGPT cache key: full-lore requests send the `session-id` header and a JSON `prompt_cache_key`. File: `openai-chatgpt.provider.ts`. Same switch as replay.
- Cache-friendly layout: World Maps `<spatial_context>` and other runtime blocks move to the current turn on all providers, the full-lore prefix leads, and decision-derived GM and lore text stays in the volatile tail. Files: `services/generation/prompt-cache-layout.ts`, `game-lore-prompt.ts`. Switch **Cache-friendly prompt layout** (`cacheFriendlyPromptLayout`, default on).
- Full-lore default on subscription providers (keyword scan otherwise unless a chat turned full lore on). Same switch as the layout.
- Stable lorebook picks: the inclusion-group winner is seeded by chat id, group and candidate set instead of `Math.random`. Files: `services/lorebook/keyword-scanner.ts`, `group-pick-policy.ts`. Switch **Stable lorebook picks** (`stableLorebookGroupPicks`, default on; env `LOREBOOK_STABLE_GROUP_WINNERS` wins).
- Cache send guard: a send is held with a question when the predicted cache hit is below the threshold; covers ChatGPT full-lore prefixes and isolated planners. Files: `services/generation/cache-send-guard.ts`, `client/src/lib/cache-guard-warning.ts`, `AdvancedParametersSection.tsx`. Chat metadata `cacheSendGuard` (`enabled` default true, `thresholdPercent` default 80), shown as **Warn before a low-cache send**.
- Cache diagnostics and next-turn preview: `claude-cache-diagnostics.ts`, `openai-cache-diagnostics.ts` (per-item lines need `MARINARA_CACHE_DIAGNOSTICS=1`); reported cache usage per turn in `GenerationTokenUsage.tsx`; Peek Prompt `layoutAsNextTurn` returns `layout: "next-turn"` (`routes/chats.routes.ts`).

### Feature switches (Settings > Advanced > Features, 12 + job tracking) (14)

- Mechanism: `server/src/services/features/feature-settings.ts` (`isFeatureEnabled`, app setting `features`, JSON of booleans and numbers), `shared/src/schemas/feature-settings.schema.ts`, `client/src/components/panels/settings/FeatureSwitchesSettings.tsx`, `hooks/use-feature-settings.ts`; game switches in `services/game/game-feature-switches.ts` and `shared/src/utils/game-feature-switches.ts`. Precedence: environment variable, then saved value, then default on. Changes apply without restart. Searching settings for `features` opens the section.
- App: **ChatGPT history replay** (`chatgptHistoryReplay`, on).
- App: **Cache-friendly prompt layout** (`cacheFriendlyPromptLayout`, on).
- App: **Stable lorebook picks** (`stableLorebookGroupPicks`, on).
- App: **Retry failed provider calls** (`providerRetry`, on).
- App: **Background call cap** (`backgroundCallCap`, on; **Calls per hour** `backgroundCallsPerHour` 600).
- App: **Message trash** (`messageTrash`, on; **Days kept in Trash** `messageTrashDays` 30).
- App: **Usage and activation stats** (`usageAndActivationStats`, on).
- App (browser): **Send client error reports** (`clientErrorReports`, on).
- Game (Chat settings > Agents in a Game chat): **Scene timeline** (`gameSceneTimelineEnabled`, on).
- Game: **Extended HUD widgets** (`gameExtendedWidgetsEnabled`, on; off hides extended widgets without deleting them and renders upstream's widget block verbatim).
- Game: **Automatic scene media** (`gameAutoSceneMediaEnabled`, on).
- Chat (Chat settings > Advanced Parameters): **Warn before a low-cache send** (`cacheSendGuard`, on, 80%).
- Plus **Keep generating when the tab is closed** (generation job tracking, own app setting `generationJobTracking`, **off**), in this section since 2026-09-24.

### Memory, continuity and Campaign Wiki (41)

Campaign memory:

- Campaign-wide memory projection: a new Game session reads the facts, knowledge and last known state of every earlier session of the same game through a read-only merged view. File: `services/game/campaign-memory-campaign-scope.ts`. Opt out per chat with `gameCampaignMemoryScope: "session"`.
- One wiki page per person across sessions: a character card, a tracked NPC of the same name and a one-word name that uniquely matches a full name fold into one entity.
- Readable GM memory block: names instead of ids, each fact tagged `[fact id S#]`, state as "last known X (S#)", relevance order present characters, then characters named in the latest message, then keyword matches, then recent; the same reviewed record never repeated. Files: `services/game/campaign-memory-context.ts`, `continuity-context.ts`, `services/generation/game-gm-prompt-runtime.ts`. Budget `gameCampaignMemoryMaxCharacters`, default 10,000.
- Pinned canon first: facts pinned as canon (`value.pinned` plus `manualLock`) lead the memory block, tagged "canon".
- Retract and lock: a fact marked wrong is hidden in every session and never republished.
- Regenerate and Continue build memory with the same budget, focus and dedupe as a normal turn, from the story-point state.
- "Previously on" recap checked against verified campaign memory so names, possessions and relationships stay exact; recap timeout 20 minutes (was 5). Files: `services/game/session-summary-*.ts`, `session-conclusion-salvage.ts`.
- Party members in a new session receive their own memory from earlier sessions.
- Lorebook Keeper campaign book: ongoing and end-session Keepers share one campaign book; memory On replaces the Keeper unless Keeper ownership is saved. Files: `game-keeper-lorebook.ts`, `lorebook-keeper-batches.ts`.
- Memory caches bounded: the projection cache keeps the 4 most recently read chats; earlier-session memory evicts expired and excess entries.
- Campaign memory store: facts, knowledge, relationships and commitments with expected revisions (409 on conflict), undo that also clears added fields, status changes after the cited message was edited or deleted. Schema `db/schema/campaign-memory.ts`, `services/game/campaign-memory-*.ts`, `services/storage/campaign-memory.storage.ts`.

Wiki and memory API:

- `GET /api/game/:chatId/memory/facts`: campaign-scope fact list, `?pinned=true` feeds the Canon page, `?q` searches, `offset`/`limit` up to 100, newest session first, items carry `originChatId` and `originSessionNumber`.
- Entity list: `kindTotals`, `?sort=kind`, archived pages last, empty "Game continuity N" lorebook mirrors hidden. File: `routes/campaign-memory.routes.ts`.
- Entity detail: `?factQuery`, `?factKind`, `?session` filters with `factSessions` and `factKinds` counts.
- Timeline: readable event text instead of transition ids, `?order=desc`, `originSessionNumber` and `originChatId` on events.
- Mutual relationships shown once.
- Wiki edits: true partial patches, cross-session id mapping (a reference to a person with no page in the write session answers 409 `CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE`), edits to earlier-session facts show immediately. Files: `routes/campaign-memory-write.routes.ts`, `campaign-memory-commitments.routes.ts`.

Continuity:

- Continuity pipeline (extract, review, publish, repair, retire) per game, off until turned on. Files: `services/game/continuity-*.ts`, `services/storage/game-continuity.storage.ts`, schema `db/schema/game-continuity.ts`.
- Later sessions publish into the campaign Keeper book (sessions 2 and later previously failed with `CONTINUITY_MEMORY_ENTRY_CHAT_MISMATCH`).
- Publish-only retry: a receipt that failed only at publication is republished without a model call.
- Model-output salvage: lenient conditions and keys, quote-drift repair (curly quotes, dashes, ellipsis, whitespace) to the exact source slice, a bad record dropped instead of the whole batch, missing dispositions filled. File: `continuity-review.ts`.
- Truncated answers: a batch cut off by the length limit is split into halves and re-queued instead of failing and being paid again; stage output caps 16k, 20k and 16k. File: `continuity-runtime.ts`.
- Per-chat parking: a chat with no usable continuity connection is parked on its own (retried every ten minutes, or at once with Retry) instead of pausing continuity everywhere, and a send in that chat no longer fails.
- Config changes re-freeze queued and verified work instead of discarding it; one failed publish no longer blocks backfill (publish isolated per receipt).
- Continuity status reports `verifiedThroughAt` and `connectionAvailable`.
- Hourly background cap, jittered per-item backoff, parking on rejected API keys (see the engine group).
- Campaign indexing and historical backfill: resumable, cancellable, one run per game, deleted sessions skipped, failed ranges requeued. Files: `routes/campaign-index.routes.ts`, `routes/game-continuity-backfill.routes.ts`, `CampaignIndexDialog.tsx`, `scripts/backfill-campaign-history.mjs`.

Campaign Wiki reader (`client/src/components/game/CampaignWiki*.tsx`, `campaign-wiki-ui.tsx`):

- Front page: hero, stat tiles, people grid, latest in the story, open promises, places, recently changed, quick links, tools behind a disclosure.
- Page list grouped by kind (People, Player characters, Places, Organizations, Items, Quests, Lore, Notes) with counts; ranked search; identical names collapse into one row.
- Article pages: large portrait, infobox (Right now, Connections, Open promises, On this page), facts grouped by session with search and kind chips, withdrawn facts folded.
- Fact row actions: Pin as canon, Unpin, Correct (opens the editor on that fact), Wrong (retract and lock).
- Campaign timeline: Story events and Promises tabs grouped by session and day with a jump bar.
- Review duplicates: versions side by side across session chats, best version preselected, resolved in the fact's own session.
- What links here: pages that mention this one, grouped by kind.
- Canon page: every pinned fact across the campaign, with search, load more and unpin.
- Evidence and commitments views, create-record form, owner links.

Memory panel and related:

- Memory panel: health headline, progress, filtered batch list, "How the GM uses memory" with Replace the Lorebook Keeper (`gameContinuity.ownership`), recaps of earlier sessions (`gamePromptRecentSessionLimit`, All by default, or last 1, 2, 3, 5, 10), memory scope (`gameCampaignMemoryScope`, campaign by default) and GM memory budget (`gameCampaignMemoryMaxCharacters`, default 10,000, clamped 1,000 to 100,000). Files: `GameMemorySettings.tsx`, `GameContinuityPanel.tsx`.
- Scene timeline: background scene review after each GM turn feeding presence, the Scenes tab and the recap scene index. Files: `services/game/scene-timeline.service.ts`, `scene-timeline-model.ts`, `GameSceneTimeline.tsx`. Switch **Scene timeline**.
- NPC Biographer recovery of missing characters from current and earlier transcripts. Files: `npc-backfill.ts`, `npc-retroactive.ts`.
- Stable NPC ids shared by client and server (`shared/src/utils/game-npc-id.ts`), with the legacy slug id as a lookup fallback.
- Isolated NPC knowledge (per game, off) and NPC auto-create (per game, on). Files: `game-isolated-turn.ts`, `isolated-game-presence.ts`, `npc-character-sync.ts`.

### HUD widgets (8)

- 19 extended widget types: checklist, obligations, schedule, calendar, note, clock, pips, countdown, tug of war, tier track, stages, tags, ledger, log, rumor board, turn order, scoreboard, bars, charges. Files: `shared/src/utils/hud-widget-extended.ts`, `client/src/components/game/ExtendedWidgets.tsx`, GM catalog in `services/game/gm-prompts.ts`, type enums in `routes/game.routes.ts`. They reuse the existing `[widget:]` keys (add, remove, check, uncheck, text, value, max, stat) and restore on branches. Switch **Extended HUD widgets**.
- List capacity 100: lists keep every entry up to a safety bound of 100; an explicit `config.max` still limits on purpose, with an eviction toast naming the widget. Files: `shared/src/utils/hud-widget-lifecycle.ts`, `GameWidgetPanel.tsx`, `services/game/branch-state.ts`. No switch.
- Model-created widgets show their type's default icon in the phone tray, tucked panel and headers.
- Widget editor: live preview, draft-mode setup editor (typed spaces kept), accent limit 64 characters, "1,500 gold" balances parse, the editor keeps its draft across model turns.
- Edge tucking: widgets tuck into edge tabs and reveal on hover, click or a changed value.
- Vertical widget stacks and grow-to-fit sizing by default (fixed height needs an explicit choice).
- Custom widget bookmarks show their icon and move along the chosen edge in Edit layout.
- Status widget (Persona Stats and custom RPG fields) and Contact Book widget. Files: `GameStatusWidget.tsx`, `game-status-widget.ts`, `GameContactBookWidget.tsx`.

### Game Mode UI and layout (28)

Edit layout (`GameLayoutEditToolbar.tsx`, `GameLayoutPopover.tsx`, `lib/game-layout-editor-store.ts`, `game-layout-geometry.ts`, `game-layout-snapshots.ts`, `game-layout-tidy.ts`; no switch yet):

- Edit mode shows a grid, outlines and a name tag per panel; Esc leaves edit mode.
- Drag a panel from anywhere; resize from every edge and corner with a live size readout.
- Snapping to screen edges, centres and neighbours with guide lines; hold Alt to place freely.
- Collisions switch: on, a dropped panel settles into the nearest free space; off, panels overlap on purpose and a click brings one to the front.
- Undo and redo: Ctrl+Z, and Ctrl+Shift+Z or Ctrl+Y, 50 steps (AltGr chords ignored).
- Keyboard nudge: arrow keys on the name tag move a panel 10px (40px with Shift; Ctrl, Alt and Meta ignored); move and resize handles carry the panel name for screen readers.
- Lock all and unlock all; Panels menu to hide and bring back panels.
- Saved layouts: name, apply, rename (Esc cancels), delete, share as JSON, reuse in any game (stored globally in localStorage `marinara-game-layouts:v1`; Snap and Collisions default on); imports over 512K characters refused; storage failures roll back instead of half-applying.
- Reset all to defaults.
- Tidy: packs panels into non-overlapping columns keeping their rough side and order.
- Shift+click selection with align left, right, top and match width; each action is one undo step.
- Per-panel options menu on the name tag: lock, reset, growth, collapse to an edge, widget stacks, narration bottom pin, toolbar top-centre pin.
- Manual heights survive content growth and crowded reflow; crushed heights are never persisted; the storyboard fills its box.

Layout and phones:

- Layouts follow the campaign across sessions (edge bookmarks, collapsed state, stacks, pins). Layout state is device-local in localStorage (`marinara-game-panel:<scopeId>:...`, `marinara-game-panel-stacks:<scopeId>`), never in chat metadata. Files: `lib/game-panel-layout.ts`, `hooks/use-map-layout.ts`.
- Phone widget tray: one horizontally scrolling row of widget tabs with 44px targets, fading edge, Game status as a tray tab that opens a sheet (`GameMobileStatus.tsx`).
- Phone Arrange sheet: reorder, hide and show widgets, stored per device under its own key prefix. Files: `GameMobileArrange.tsx`, `lib/game-mobile-panel-arrangement.ts`.
- Phone presence strip: Currently Present as one row of whole-name chips with the Campaign Wiki button; joins the top row on landscape phones while the toolbar folds into the actions menu.
- Phone storyboard: a slim closed tab under narration that opens a sheet above the composer; the composer is pinned to the bottom of narration.
- Landscape phones (below 1024px wide and 32rem tall): map, party, the tab tray, a storyboard icon and the actions button share one top row; Currently Present and the image retry line become tray tabs that open sheets; the composer stays one line until focused; narration gets 65 to 69% of the height.
- World map popover on phones and tablets sizes to the visible viewport (browser bars, keyboard, safe area) instead of a 68dvh cap; its header is marked so the music bubble avoids it.
- Floating music widget docks to the right edge on phones (UI persist v101 to v102 moves only the untouched old default) and avoids elements marked `data-floating-widget-avoid` without rewriting the saved position. Files: `lib/floating-widget-avoid.ts`, `hooks/use-floating-widget-avoid.ts`, `LocalMusicPlayer.tsx`, `YouTubePlayer.tsx`, `SpotifyMiniPlayer.tsx`.

Scene, combat and server guards:

- Storyboards: adaptive frame counts, concurrent image requests, per-stage timing, full-screen images, recoverable background work, continuity. Files: `services/game/storyboard-*.ts`, `StoryboardContinuitySettings.tsx`, `GameStoryboardTimings.tsx`.
- Automatic scene media queue after each GM turn. File: `services/game/automatic-game-media.ts`. Switch **Automatic scene media**.
- Presence and portraits: library portraits with saved crops, full-screen portrait preview, character names in narration open their profile. Files: `game-scene-presence.ts`, `game-speaker-avatar.ts`, `ui/CharacterPhoto.tsx`.
- Game server guards: bad model maps return `422 MAP_INVALID` (`services/game/game-map-validate.ts`); journal edits answer `409 JOURNAL_ENTRY_MOVED` (`journal-entry-guard.ts`); reputation applies once per source message (last 200 remembered); party removal by `characterId`; boss `hp_threshold` mechanics fire once; inventory rows matched by item id (`inventory-item-identity.ts`, `game-inventory-identity.ts`).
- Party bar HP bars inside avatars and tactical combat range preview on hover; journal search over Timeline and Library (case and accent insensitive).
- Legacy node maps convert to World Maps at startup when the package is available, originals kept. Files: `services/capability-packages/automatic-legacy-game-map-migration.ts`, `shared/src/utils/legacy-game-map.ts`.
- In-game help: chaptered features guide to layouts, widgets, maps, memory, Status and the Contact Book (`GameFeaturesGuide.tsx`).

### Game tools (Session panel Tools tab and command palette) (10)

- Dice log: every roll from the dice tray, GM narration and skill checks with dice, total and crit or fumble flags; summary strip, per-face distribution, session or whole-game view; logging never blocks a roll. Files: `GameDiceLog.tsx`, `services/game/dice-roll-log.ts`, table `game_dice_rolls`, `routes/game-tools.routes.ts`.
- Initiative tracker: combatants from cards, lorebook entries or typed names, initiative rolls into the Dice Log, rounds, HP and conditions, saved encounters per game, **To input** drops the current turn into the chat input as an OOC note. Files: `tools/InitiativeTracker.tsx`, `routes/game-initiative.routes.ts`, `shared/src/utils/initiative-tracker.ts`.
- GM prep board: private per-game board (strong start, scenes, secrets and clues, threads, NPCs, locations, treasure, notes), used checkboxes, tags, links to cards and entries, drag or arrow-key reordering, carry-over to the next session, never sent to the model, JSON import and export. Files: `GamePrepBoard.tsx`, `routes/game-prep-board.routes.ts`, `shared/src/utils/prep-board.ts`.
- Random tables and yes/no oracle: dice or weighted tables, nested `[[Table Name]]` rolls up to five levels, global or per game, JSON import and export, built from a lorebook folder or tag, five starter packs. Files: `tools/RandomTablesTool.tsx`, `routes/random-tables.routes.ts`, `shared/src/utils/random-tables.ts`, `client/src/lib/table-packs/*.json`.
- Name generator: offline, four styles plus names learned from a lorebook or the library, seeded, lockable. Files: `tools/NameGenerator.tsx`, `lib/name-generator.ts`.
- In-world calendar: custom months, weekdays, era, leap years and moons, dated events and deadlines, anchored to the Game Mode clock through chat metadata `gameCalendar`; per game, off until created; the GM time line is byte-identical without a calendar. Files: `tools/GameCalendarTool.tsx`, `routes/game-calendar.routes.ts`, `shared/src/utils/game-calendar.ts`, `docs/game/calendar.md`.
- Chapters: titled chapter markers at any Roleplay or Conversation message, a Chapters tab in chat search, "Go to chapter" in the palette, headings in story exports; marked from the campaign log in Game Mode; never sent to the model. Files: `chat/MessageChapters.tsx`, `lib/chat-chapters-events.ts`.
- Campaign codex export: Markdown or JSON (format version 2) from the campaign projection; read only. File: `services/game/campaign-codex.ts`.
- Campaign log reader: every session in order as a story, campaign-wide search, session and speaker filters, chapter list; `/goto` and global search results open it. Files: `modals/GameLogModal.tsx`, `services/game/campaign-log.ts`, `GET /api/game-tools/log/:chatId`.
- Contact Book: full-screen book of encountered characters with numeric opinions, relationship statuses and local nested categories. Files: `GameContactBookWidget.tsx`, `services/game/game-contact-book.ts`, `game-contact-book-state.ts`.

### Library (17)

- Nested folders up to six levels for lorebooks and characters (server support for presets and agents): drag onto a folder, New subfolder, Move folder to, remembered open state, search opens matching folders. Files: `panels/library/LibraryFolderTree.tsx`, `shared/src/utils/library-folder-tree.ts`, `services/storage/character-folders.ts`; `parentId` on `library_folders` and `character_groups`.
- Campaign picker and campaign sections above the Characters and Lorebooks lists; campaign badges that filter on click. Files: `LibraryCampaignBar.tsx`, `LibraryCampaignSections.tsx`, `LibraryCampaignBadges.tsx`.
- Manual campaign links from selection mode or the row button. Route `routes/library-campaigns.routes.ts`, table `library_campaign_links`.
- Campaign roster: GM, party and linked NPC chips when filtering Characters to one campaign. File: `LibraryCampaignRoster.tsx`.
- Lorebook folder power switch: enables or disables every lorebook in a folder subtree after confirmation, with exact Undo; all-off folders dimmed. Route `POST /api/lorebooks/bulk-enabled`; file `use-lorebook-folder-toggle.tsx`.
- Lorebook selection Enable and Disable with exact Undo. File: `LorebookSelectionEnableActions.tsx`.
- In-chat dot on lorebooks that feed the open chat.
- Check lorebook: empty entries, missing keys, duplicate keys and content, unsafe regex, overlong, disabled and weak keys, with severity filters. Files: `LorebookLintPanel.tsx`, `shared/src/utils/lorebook-lint.ts`.
- Lorebook scan test: runs the real scanner on pasted text or the current chat and explains every hit and hold-back. Route `POST /api/lorebooks/:id/test` (1 MB body limit); files `LorebookScanTest.tsx`, `services/lorebook/test-scan.ts`.
- Activation stats: fired count, last activation, last 20 chats, **Fired** sort, **Never fired** and **Stale** filters. Files: `services/lorebook/activation-stats.ts`, `activation-backlinks.ts`, table `lorebook_entry_activation_stats`, `LorebookEntryFiredIn.tsx`. Switch **Usage and activation stats**.
- Lorebook bulk edit: Shift+click range select, Select all matching, enable, Constant, folder, keys, probability, order and depth in one all-or-nothing step; single-request bulk delete. Files: `LorebookBulkEditPanel.tsx`, `shared/src/utils/lorebook-bulk-edit.ts`.
- Lorebook Markdown and CSV import (previewed, line-numbered errors, skip, rename or overwrite) and export. Files: `LorebookTextImportDialog.tsx`, `routes/lorebook-text.routes.ts`, `services/lorebook/text-import.ts`, `shared/src/utils/lorebook-text-format.ts`.
- Explicit Move and Copy target for lorebook entries ("Choose a lorebook" instead of preselecting the first).
- Character duplicates finder with field-by-field compare; nothing deleted automatically. Files: `CharacterDuplicatesModal.tsx`, `shared/src/utils/character-duplicates.ts`.
- Bulk tags: add, remove or rename tags on selected characters with a review summary. Files: `CharacterBulkTagsModal.tsx`, `character-tag-edits.ts`.
- Character usage and **Unused**: where a card is used and cards in no chat. Files: `services/characters/character-usage.ts`, `routes/character-usage.routes.ts`, `CharacterUsageSection.tsx`, `CharacterUnusedModal.tsx`; catalog `ids=` filter for folder members beyond loaded pages.
- Character quick reference: hover or tap a linked name for a small card (Enter opens, Escape closes). Settings > Advanced > Character quick reference, off by default. Files: `NpcQuickReference.tsx`, `lib/npc-quick-reference.ts`.

### Chat and productivity (24)

Keyboard shortcuts:

- **Ctrl+K** (Cmd+K on Mac) or the top-bar search button: command palette for chats, characters, personas, lorebooks, presets, Settings tabs, actions and every fork tool; recent picks first. Files: `command-palette/CommandPalette.tsx`, `CommandPaletteHost.tsx`, `lib/command-palette.ts`, `stores/command-palette.store.ts`.
- **Ctrl+Shift+F** (Cmd+Shift+F): Search All Chats.
- **?** (while not typing): keyboard shortcuts overlay, grouped by where each works. Files: `command-palette/KeyboardShortcutsOverlay.tsx`, `lib/keyboard-shortcuts.ts`.
- Text snippet triggers: type a trigger such as `;ooc` then Space or Tab to expand; Ctrl+Z undoes an expansion.
- Reading mode keys: arrow keys, J and K, Home and End turn pages.
- Game input: Up in an empty box recalls the last sent turn; Enter confirming an IME candidate does not send.
- Session replay: Left and Right change turn, Esc exits.
- Journal edit dialog: Ctrl/Cmd+Enter saves, Escape closes.
- Edit layout shortcuts are listed in the Game Mode group (Ctrl+Z, Ctrl+Shift+Z, Alt, Shift+click, arrows, Esc).

Features:

- Search All Chats: quoted phrases, filters for mode, character, sender and date range, highlighted snippets that open the chat at the message. Files: `modals/GlobalSearchModal.tsx`, `routes/chat-insights.routes.ts`, `services/chat-insights/chat-insights.service.ts`, `shared/src/utils/chat-search-query.ts`.
- Markdown and HTML story exports in the branch menu (active swipe, hidden and system messages left out, standalone HTML with light, dark and print styles). Files: `services/chat-insights/transcript-document.ts`, `transcript-avatars.ts`.
- Chat stats (branch menu): words per speaker, reply length, messages per day, reported tokens, play time by sittings. Files: `modals/ChatStatsModal.tsx`, `shared/src/utils/chat-stats.ts`.
- Activity overview (pulse button): yearly heatmap, streaks, totals, play time, most played chats. File: `modals/ActivityOverviewModal.tsx`.
- Message bookmarks with optional labels and a Bookmarks tab in chat search. Files: `chat/MessageMarks.tsx`, `ChatMessageMarksPanels.tsx`, `shared/src/utils/message-marks.ts`.
- Private message notes: never sent to the model; left out of exports unless "Include private notes in exports" is on (off by default).
- Pin to context: up to 10 pinned messages per chat stay in the prompt past the context message limit (`applyContextMessageLimitWithPins`); Peek Prompt shows the result.
- Message Trash: Roleplay and Conversation deletes go to a per-chat Trash tab with restore, delete forever and empty; purged after 30 days; Game and helper chats keep permanent deletes. File: `services/storage/message-trash.storage.ts`, table `message_trash`. Switch **Message trash**.
- Text snippets: defined in Settings > General > Text Snippets, `{{cursor}}` and macros, also insertable from Quick replies and the palette, synced across devices. Files: `settings/TextSnippetsSettings.tsx`, `lib/text-snippets.ts`, `hooks/use-snippet-expansion.ts`; app setting `text-snippets` (empty means off).
- Usage dashboard (Settings > Advanced): reported tokens by connection, chat and day, optional cost estimate from entered prices. Files: `settings/UsageDashboardSettings.tsx`, `routes/usage.routes.ts`, table `generation_usage`, `services/usage/usage-aggregation.ts`. Switch **Usage and activation stats**.
- Reading mode for roleplay chats: full-screen paged reader, bookmarks as chapters, remembered page, adjustable text size, width, spacing and font. Files: `modals/ReadingModeModal.tsx`, `lib/reading-mode.ts`.
- Private notebook per chat. Files: `chat/PrivateNotebookPanel.tsx`, `routes/private-notebook.routes.ts`, `services/private-notebook.service.ts`.
- Generation parameter panels follow the selected provider and model (for example topK hidden while Anthropic budget thinking is on; reasoning effort and verbosity for Claude, ChatGPT and OpenRouter). File: `shared/src/constants/generation-parameter-relevance.ts`.
- Game narration honours the token-usage display setting, including reported cache usage.
- Chat list, home and message avatars fall back to a placeholder instead of a broken image (`characters/AvatarImage.tsx`).

### Generation jobs, E02 (5)

- Job records: image, sprite and video jobs keep a saved status, result link and log trail and finish with no browser connected; a restart marks running jobs interrupted (not retried); kept 7 days, up to 300; deleting a chat deletes its jobs. Files: table `generation_job_records`, `services/generation/generation-job-tracker.ts`, observer seam in `services/generation/generation-jobs.ts`, `routes/generation-job-records.routes.ts`.
- Generation jobs viewer with kind, chat, age, run time, error code and log trail; palette command "Open generation jobs". File: `modals/GenerationJobsModal.tsx`.
- Top-bar activity dot while jobs run and return announcements for jobs that finished while away. Files: `generation-jobs/GenerationJobsActivityDot.tsx`, `GenerationJobsRecoveryHost.tsx`, `hooks/use-generation-recovery.ts`.
- Logging: each transition logged once; `withoutEchoedPrompt` strips quoted prompt text from failure lines (capped at 300 characters).
- Setting: **Keep generating when the tab is closed** in Settings > Advanced > Features (`generationJobTracking`, off). Docs: `docs/development/generation-jobs.md`.

### UI and accessibility (17)

- Phone top nav: below 640px Home, Chats, Characters and Settings stay as buttons and the rest move into a labelled More menu (44px rows, arrow, Home, End and Escape keys, jobs dot). File: `layout/TopBar.tsx`.
- Landscape phones: the chat list scrolls as one column; Settings uses one row of tabs beside Quick Access.
- Touch floor: `panels/panel-phone-floor.ts` gives 36px controls and 11px text on narrow and touch screens to side panels and the connection, agent, regex and tool editors (opt out with `data-touch-compact`).
- Touch-only text step: 0.5625 to 0.625rem text becomes 0.6875rem on coarse pointers in modals, tools, editors and the wiki.
- Toggle switches get an invisible 38x38 hit area; small icons and markdown links get invisible hit extensions.
- Touch tablets (768px and wider): `getChatTouchToolbarButtonClass` and 36px composer, swipe and header controls.
- Tablets and landscape phones: 36px touch targets for the avatar generator, avatar tile, Upload, sprite tabs and expression chips in the character and persona editors; a single slim Library category bar below 500px height; 36px lorebook row chevrons; Campaign Wiki navigation, chips and links at 36px with People cards that wrap to fit.
- Compact editor header on short landscape screens; command palette opens at the top on short screens with shortcut hints hidden on touch.
- Composer caps on short screens (30% of height, max 200px roleplay and 160px conversation); opaque emoji, GIF and sticker picker on phones.
- Side panels: opening one moves focus into it, Escape closes it and returns focus to the toggle (`layout/use-panel-keyboard-focus.ts`).
- Dialogs: only the topmost dialog traps Tab; Escape during IME composition does not close a dialog; menus render above dialogs.
- Shared panel states: loading skeleton and error with Retry (`ui/PanelStates.tsx`), used by Connections, Personas and the chat list.
- Localization: settings strings through `en.json`, 115 em dash values rewritten, labelled buttons, keyboard-reachable profile and SillyTavern imports.
- Onboarding on phones: the helper bubble no longer covers Skip and Get Started.
- Background crossfade that waits for the new image and the correct first sprite pose on speaker change (`DirectionEngine`, `SpriteOverlay.tsx`).
- Client performance: the live accent animation holds above 6000 elements (`client/src/App.tsx`); memoized lorebook entry rows with deferred search (`LorebookEntryListItem.tsx`); memoized character editor sections; debounced library search with a normalized index (`LibrarySearchInput.tsx`, `character-search-index.ts`).
- Client error reports to the server log (`client/src/lib/client-diagnostics.ts`). Switch **Send client error reports**.

### Dev MCP, outside the repo (4)

- `marinara-dev` MCP v2.x at `D:\Marinara Engine Staging\marinara-dev-mcp-v2.0` (`server.mjs`, `lib/`), shared by Claude Code and Codex. Tools: `engine_status`, `git_status`, `journal`, `list_chats`, `read_messages`, `chat_settings`, `get_prompt` (exact saved request or free next-turn preview), `cache_report`, `diff_prompts`, `logs`, `lookup_error`, `continuity_status`, `list_connections`, `find_characters`, `get_character`, `edit_character`, `set_chat_metadata`, `typecheck`, `run_regressions`, `build`, `restart_engine`, `api_request`, `sandbox_refresh`, `sandbox_stop`.
- Sandbox (`marinara-sandbox`, port 7862): sanitized copy of the live store with keys blanked, remote URLs closed and subscription logins absent, so it cannot spend quota or post anywhere.
- Safety: shared engine lock (`.dev-mcp\engine.lock`), quiet wait of 150 s before live restarts, dist backup and rollback on failed builds, backups of every edited card and chat setting.
- Journal `.dev-mcp\journal.jsonl` for every write, build and restart; launches run `run-server.mjs` directly instead of `start.bat`.

### Not in main (local branches)

- `contrib/dev-foundations` (local only, not pushed; 7 commits on top of `upstream/staging`, head `4a2b7f968`): a separate upstream contribution that re-packages parts of this work as opt-in changes (stable lorebook group winners and compact stored lorebook scans, robustness settings with runtime diagnostics, the startup inject gate, a Dev MCP, and a docs note). Nothing on it is part of the fork's main; the rest of this file describes main only.

## 2026-09-24

### Claude subscription: diagnosis of a one-off cache drop from a named-card fold (no code change)

- Investigated a Game turn that re-read only the system prompt (about 56% of a 561k-token prompt) right after the history-marker fix below. Cause: `packages/server/src/services/game/named-card-cache.ts` keeps named-character library cards byte-stable in the cached head of the prompt and parks newly named people in an uncached tail. It folds them into the head (one planned history rewrite) once 6 cards or 30,000 characters are waiting, or at once when a single turn names that many people. One turn named 19 people; the stored snapshot went from 27 to 46 cards. This is the intended one-time cost, not a regression.
- The three turns examined all ran on a build that predated the history-marker fix (the provider module was rebuilt after them), so they do not measure the fix. Expected after the fix: from the second consecutive turn within the one-hour cache TTL, about 93-95% of the prompt is re-read. A drop remains possible after a named-card fold or a gap of more than an hour between turns.
- Diagnostic method, reusable and free: see "Claude request capture without a model call" under 2026-09-23.

### List widget capacity 100

- Files: `packages/shared/src/utils/hud-widget-lifecycle.ts` (`listWidgetCapacity`, `LIST_WIDGET_MAX_LIMIT`, `LIST_WIDGET_DEFAULT_MAX`), `packages/client/src/stores/game-mode.store.ts`, `packages/server/src/services/game/branch-state.ts`, `packages/client/src/components/game/GameWidgetSetupEditor.tsx`, `packages/client/src/components/game/GameWidgetPanel.tsx`, `packages/server/src/services/game/gm-prompts.ts`.
- Behaviour: list widgets keep every entry they are given, up to a safety bound of 100. They used to keep only 5, so a GM adding an 18-name roster silently kept the last five while narrating success. An explicit `config.max` (1 to 100) still limits a list on purpose. The list renderer shows every entry in a scrollable box (it stopped at 8). Hand-edited lists keep every line; a stored max below the typed entries grows to fit.
- Commands: `[widget: id, max: N]` sets a list's limit; create with `max: N`.
- Prompt: the GM instructions (Extended widgets ON) say lists keep every entry; with the switch OFF the upstream widget block is rendered verbatim.
- Tests: `scripts/regressions/hud-widget-list-capacity.regression.ts` (default keeps 18, max 5 still drops its oldest, bound 100, create with max, branch replay).

### List eviction toast

- Files: `packages/client/src/stores/game-mode.store.ts`.
- Behaviour: when an add pushes older entries out of a list (a list limited on purpose, or the bound), a toast names the widget, its limit and how many entries were removed, so narration can no longer claim a change that did not stick. One toast per widget per update.
- Locale: `ui.game.widgets.listOverflow`.

### Regression fixes after the staging-2 merge

- Files: `packages/server/src/services/game/gm-prompts.ts`, `scripts/regressions/game-dice-roll-log.regression.ts`, `scripts/regressions/open-issues.regression.ts`.
- game-switch-extended-widgets: the Extended widgets OFF block is upstream's text again, and the list summary fill count was removed.
- game-dice-roll-log: the Session panel tab check accepts the conditional tab list (scene timeline switch).
- open-issues: the journal timeline check accepts the search-filtered entries prop.

### Phone widget tray, Game status sheet, readable Currently Present, landscape stacking
- Commit: eee40df22.
- Files: `components/game/GameMobileArrange.tsx` (new `MobileWidgetTray`), `components/game/GameMobileStatus.tsx` (new), `components/game/GameSurface.tsx`, `components/game/GameWidgetPanel.tsx`, `components/game/GameSpecialPanels.tsx`, `components/game/GameNarration.tsx`, `localization/locales/en.json` (`ui.game.mobilewidgetarrange.showFirstWidgets`, `showMoreWidgets`).
- Behaviour below 1024px:
  - The widget tray hides its scrollbar, snaps tab by tab and only shows whole tabs. It fades the edge where more tabs wait, and a chevron with a "+N" count pages through the rest. Arrange sits outside the scroller, so it is always on screen.
  - "Game status" becomes a tray tab that opens the stats in a sheet, instead of rendering inline across the top half. Desktop and tablet keep the normal panel.
  - Currently Present uses a people icon (with the text kept for screen readers) and whole-word name chips that scroll sideways, in one 62px row.
- Test: `scripts/regressions/game-mobile-layout.live.mjs` (live, against a dev server): both test chats at 360x740, 390x844, 412x915, 844x390 and 915x412. It checks page width, clipped tabs, readable labels, and that narration plus composer get at least 50% of the height.

### Storyboard never covers the composer on phones; debug details folded everywhere
- Commit: f5cd40182.
- Files: `components/game/GameStoryboardViewer.tsx`, `components/game/GameNarration.tsx`, `components/game/GameSurface.tsx`, `localization/locales/en.json` (`game.storyboard.details`, `friendlyDegraded`, `friendlyFailure`, `hideViewer`, `ui.game.gamesurfacecomponent.dismiss`).
- Cause: below 1024px the viewer rendered inline after the narration as a non-shrinking flex item (up to 40% of the column), pushing the composer under it.
- Behaviour:
  - On phones the storyboard is a slim tab under the narration, closed by default, with status and a small X. Opening it shows a sheet in the largest free space that excludes the composer, with a close button and Esc. The tab steps aside while typing.
  - On every screen size, timings, request errors, ready counts and generation details sit in one "Details" disclosure, closed by default. A failure shows one friendly line ("Couldn't draw this scene.") with Retry.
  - The composer is pinned to the bottom of the narration panel on phones.
  - The "Image generation failed" retry banner becomes a compact line at the bottom of the Game column, clear of narration and composer, with a labelled dismiss.
- Tests:
  - `scripts/regressions/game-storyboard-phone.browser.mjs` (new): 360, 390 and 412 wide, landscape, and the keyboard simulated. elementFromPoint at the composer centre must hit the textarea.
  - Updated: `storyboard-error-details.browser.mjs`, `storyboard-fullscreen.browser.mjs` (CSS built from source), `storyboard-request-error.browser.regression.mjs`.

### Music bubble keeps clear of Game controls
- Commits: 854989034, fa8ddf74b, plus the storyboard tab and sheet in f5cd40182.
- Files: `components/game/GameSurface.tsx`, `components/game/GameStoryboardViewer.tsx`.
- Behaviour: the phone Currently Present strip, the widget tray, the phone "Game actions" (...) button, and the storyboard phone tab and sheet carry the inert `data-floating-widget-avoid` attribute. The floating music bubble moves off any element that has it.

### GM prep board touch targets on phones
- Commit: d1ec31bbc.
- Files: `components/game/GamePrepBoard.tsx`.
- Behaviour:
  - On touch screens every control is at least 36px: buttons, inputs, menu items, drag handle, done box, search clear, link chips and tags. Small labels step up to 11px.
  - Controls under 36px went from 24-50 per view to 0. Desktop is pixel-identical.
- Test: `scripts/regressions/prep-board-touch-targets.browser.mjs` (needs a dev URL and a game chat id): 360x740, 390x844, 412x915, 844x390 and 1440x900. Probe writes are blocked.

### Landscape phones: one top row, narration keeps the room
- Commit: 5bf5ff31f.
- Files: `components/game/GameSurface.tsx`, `components/game/GameInput.tsx`, `components/game/GameNarration.tsx`, `components/game/GameMobileArrange.tsx`, `components/game/GameMobileStatus.tsx`, `components/game/GameStoryboardViewer.tsx`.
- Applies below 1024px wide and 32rem tall. Portrait and desktop are unchanged.
- Behaviour:
  - Map, party, the tab tray, a storyboard icon (with warning or spinner state) and a 44px actions button share one top row.
  - Currently Present becomes a tray tab with a count badge that opens the strip in a sheet. The image-retry line becomes an amber tab whose sheet has Retry and Dismiss.
  - The actions menu opens as a row.
  - The composer stays one line until focused, and the story-location row appears on focus.
  - The narration column gets 67% of the height at 844x390, 69% at 915x412 and 65% at 740x360 (it was about 74px).
  - The Logs, Inventory and Combat row stays visible, because it carries the narration segment navigation.
- Tests: `scripts/regressions/game-mobile-landscape.live.mjs` (new, 6/6); `game-mobile-layout.live.mjs` and `game-storyboard-phone.browser.mjs` updated.

### Edit layout keyboard test race
- Commit: 92528c1c1.
- File: `scripts/regressions/game-layout-edit-mode.browser.mjs`.
- Applying a saved layout remounts every panel. On a loaded machine the remount could land after the test's Shift+Arrow press, so the step failed intermittently. The test now waits for the panel to hold still before nudging. This was a test-only fix; there was no product bug.

### Mobile music widget dock and floating-widget avoidance
- Commits: afbfb69bc, 7d83a801c, 16c55356f, d9e519954.
- Files: `stores/ui.store.ts`, `lib/ui-persistence.ts`, `hooks/use-settings-sync.ts`, `components/chat/YouTubePlayer.tsx`, `LocalMusicPlayer.tsx`, `components/spotify/SpotifyMiniPlayer.tsx`, `lib/floating-widget-avoid.ts` (new), `hooks/use-floating-widget-avoid.ts` (new); regressions `scripts/regressions/ui-store-music-widget-migration.regression.ts` and `floating-widget-avoid.regression.ts` (new).
- Behaviour:
  - Phones: the collapsed YouTube, local music and Spotify bubble docks to the right edge instead of covering left-aligned message avatars; `resolveMobileWidgetX` makes the open panel and drag start use the real on-screen x.
  - The bubble is clamped inside the screen with room for the composer and re-positions on rotation and keyboard changes.
  - It avoids any element marked `data-floating-widget-avoid` (Game mode marks its phone Currently Present strip with the Campaign Wiki button, the widget tray and the Game actions button): an overlapping spot moves to the nearest free spot on the right edge, else the left; a free spot, including one the user dragged to, only gets clamped; no free spot keeps the clamped position; the saved position is never rewritten.
  - At 768px and wider the player sits in the top bar instead; on touch its buttons and volume slider get 36px hit areas.
- Settings and defaults: `DEFAULT_MOBILE_MUSIC_WIDGET_POSITION` = `{x: 10000, y: 144}` (clamped to the right edge). UI persistence version 101 to 102 moves only the untouched old default `{16, 144}`; the server-synced copy (no version, replaces local state on load) gets the same move in settings sync and is written back (`staleSyncedShape`). Positions the user dragged stay.
- Tests: regressions `ui-store-music-widget-migration`, `floating-widget-avoid`, `music-dj-and-floating-ui`.

### Mobile and tablet: top nav and shell
- Commits: a4049498b, e82a2d1f8.
- Files: `components/layout/TopBar.tsx`, `PersonalExtensionContributionsMenu.tsx`, `RightPanel.tsx`, `ChatSidebar.tsx`, `components/ui/Modal.tsx`, `TouchDragHandle.tsx`, `MacroTextarea.tsx`, `EmojiPicker.tsx`, `components/chat/HomeBrowserHub.tsx` (widget drag handles), `components/command-palette/CommandPalette.tsx`, `KeyboardShortcutsOverlay.tsx`, `lib/markdown.tsx`, `styles/globals.css`.
- Behaviour:
  - Top nav below 640px: Home, Chats, Characters and Settings as 38px buttons plus a labelled More menu (Search and commands, Personas, Lorebooks, Presets, Connections, Agents, Generation jobs, extension buttons) with 44px rows, active check, jobs dot, arrow, Home and End keys, Escape and focus return, closes on rotate; an item opened from the menu shows on the bar. At 640px and wider (landscape phones, tablets) the full bar stays, 38px on touch. Top bar height unchanged (51px).
  - Touch: modal and side panel close buttons, drag handles, editor actions (38px), section jumps and chat message actions reach 36px or more; textarea tool icons get an invisible 37px hit area; markdown links get an invisible vertical hit extension without changing line spacing.
  - Short landscape screens (height 500px or less): the chat list sidebar scrolls as one column with a pinned header; the editor header is one compact row (lorebook, preset and persona header 107 to 48px at 740x360); the command palette opens at the top with its list capped to fit and hides shortcut hints on touch.
  - The emoji picker is opaque on phones and touch.
  - The update toast on touch sits below the chat and editor headers (phones and tablets); Refresh 38px and close 36px hit area on touch.
- How to reach: any screen on a phone or touch tablet.
- Tests: Playwright probes at 360x740, 390x844, 412x915 portrait and landscape, tablets 768x1024, 820x1180, 1024x768, 1180x820, 1366x1024 (touch and mouse), and 1280 desktop; no horizontal overflow anywhere.

### Mobile and tablet: chat and composer
- Commits: 7d83a801c, 4909d11f7, d9e519954.
- Files: `components/chat/ChatInput.tsx`, `ConversationInput.tsx`, `ChatMessage.tsx`, `SwipeJumpControl.tsx`, `ChatToolbarControls.tsx` (new `getChatTouchToolbarButtonClass`), `ActiveLorebookEntriesButton.tsx`, `ChatMessageSearch.tsx`, `ChatRoleplaySurface.tsx`, `PrivateNotebookPanel.tsx`, `ConversationView.tsx`, `RoleplayHUD.tsx`, `ChatBranchSelector.tsx`, `ConversationPresenceCard.tsx`, `QuickConnectionSwitcher.tsx`, `QuickPersonaSwitcher.tsx`, `ChatSettingsDrawer.tsx`.
- Behaviour:
  - Composer caps at 30% of the screen height on short screens (roleplay max 200px, conversation max 160px) and re-sizes on keyboard or rotation, so long drafts no longer cover the header or hide send, attach and emoji.
  - The conversation emoji, GIF and sticker picker is opaque on phones.
  - Touch tablets (768px and wider get the desktop layout): chat header buttons, composer buttons, quick connection and persona switchers, swipe arrows and chat settings controls are 36px or more on touch; the shared default toolbar size is untouched, so Game mode's buttons are unchanged.
  - Roleplay timestamps and the player subtitle read 11px on touch; branch count badges read 11px on touch through a local class (the shared badge style is untouched).
  - Undersized controls on tablets: conversation 23 to 25 down to 8 to 9, roleplay 20 to 22 down to 2 to 3.
- Tests: Playwright probes at phone and tablet sizes with a simulated keyboard (55% height); no overflow.
- Known, not changed: on portrait phones the roleplay message action row (11 buttons) squeezes each to 32 to 36px wide. A wrapping grid was tried and rejected because it reserved about 41px of empty space under every message.

### Mobile and tablet: side panels, settings and editors
- Commits: 0b05da7f2, e8c42afc9.
- Files: `components/panels/panel-phone-floor.ts` (new), `AgentsPanel.tsx`, `CharactersPanel.tsx`, `ConnectionsPanel.tsx`, `LorebooksPanel.tsx`, `PanelLoadMoreBar.tsx`, `PersonasPanel.tsx`, `PresetsPanel.tsx`, `SettingsPanel.tsx`, `library/LibraryCampaignBadges.tsx`, `library/LibraryFolderTree.tsx`, `settings/SettingControls.tsx`, `settings/BackgroundPicker.tsx`, `components/connections/ConnectionEditor.tsx`, `components/agents/AgentEditor.tsx`, `RegexScriptEditor.tsx`, `ToolEditor.tsx`, `FeatureAgentDetailHost.tsx`.
- Behaviour:
  - `panel-phone-floor.ts`: shared classes on each panel and editor root give buttons, selects and inputs a 36px minimum and small text 11px on narrow and touch screens (opt out with `data-touch-compact`; `!important` is needed because the app's chrome classes otherwise win). Toggle switches (38x21 labels around hidden checkboxes) get an invisible 38x38 hit area.
  - List rows (lorebooks, presets, personas, connections, characters, agents): actions sit beside the text instead of over it and wrap to a second line when narrow, so names are no longer cut to a few letters.
  - Settings on short landscape screens: one row of six text tabs beside Quick Access and a compact search header; content area about 35px to about 170px at 740x360.
  - Load more bar sits at the end of the list on short screens; selection checkboxes and campaign badges get 36px hit areas; library folder header actions 36px (folder drag and Move to... stay usable on touch); selection bar labels unchanged.
  - Connection and agent editors: 11 small controls and 32 small labels at 390 in the connection editor are gone; settings description text and background picker chips read 11px on touch.
- Tests: regression `selection-action-bar-compact` and all regressions referencing the panel files; Playwright probes at phone and tablet sizes; desktop unchanged.

### Mobile and tablet: modals, tools, editors and wiki window
- Commit: ad7a61ad1 (55 files).
- Files: `components/modals/*` (About me, Activity, Agent write approval, Character card update, Chat stats, Create character, connection, lorebook, persona, preset, Decision model, Docs viewer, Game log, Global search, Import character, lorebook, persona, preset, Model download, Reading mode, SillyTavern bulk import, What's new), `components/tools/GameCalendarTool.tsx`, `InitiativeTracker.tsx`, `NameGenerator.tsx`, `RandomTablesTool.tsx`, `components/characters/*`, `components/personas/PersonaEditor.tsx`, `components/presets/ChoiceSelectionModal.tsx`, `PresetEditor.tsx`, `components/lorebooks/*`, `components/game/CampaignWiki*.tsx`, `campaign-wiki-ui.tsx`.
- Behaviour: touch-only readability and target fixes. Text at 0.5625 to 0.625rem reads 0.6875rem on touch; small icon buttons and h-7 or h-8 buttons and inputs reach 36px (overriding chrome control sizes where needed). The initiative tracker encounter select no longer clips its label. At 360px, flagged small text 1547 down to 511 and small targets 1021 down to 342 across the compared modals; no modal overflowed.
- Tests: Playwright probes at six phone sizes and desktop.

### Tablets and landscape phones: editor targets, category bar, wiki fit
- Commit: 795b87b66.
- Files: `components/characters/CharacterEditor.tsx`, `components/personas/PersonaEditor.tsx`, `components/lorebooks/LorebookEntryRow.tsx`, `LorebookFolderRow.tsx`, `components/game/CampaignWikiOverview.tsx`, `CampaignWikiRail.tsx`, `CampaignWikiWindow.tsx`.
- Behaviour: Generate avatar with AI gets a 36px hit area on touch (added from the editors; the shared button file is unchanged); avatar tile, Upload, sprite tabs, Images tab and expression quick-add chips are 36px on touch. The character editor Library category bar is a single slim row below 500px screen height (about 56 to 44px at 740x360). Lorebook entry and folder row chevrons get 36px hit areas on touch. Campaign Wiki: Hide navigation 36px wide, filter chips at least 36px on touch, Latest in the story entity links 36px on touch, tighter top bar below 500px height, People cards wrap to fit (names were cut at 768).
- Tests: Playwright probes at 768x1024, 820x1180, 1024x768, 1180x820, 1366x1024 and 740x360; no overflow; dialogs sized sensibly.

### Upstream sync 2 (Pasta-Devs `60ed7ec80`)

- Commits: `97d306088` (merge of 67 upstream commits), `d5e6ef88f` (fork branch into `integrate/upstream-staging-2`), `abace0b87` (make the sync green).
- Brought in from upstream: the Decision model feature (Decision model connection default, `decision:` and `decision_choice:` macros, lorebook Decision Require and Trigger, agent activation questions, group-chat Smart order) and the modal backdrop-dismiss fix.
- Conflicts: 18, resolved keeping both sides. Decision-derived GM and lore text stays in the volatile tail of the fork's cache layout, so it does not break the cached prefix.
- `abace0b87` files: `packages/server/src/services/sidecar/decision-process.service.ts`, `decision-runtime.service.ts`, regressions. Linux-only decision runtime cases run only where `isDecisionRuntimeSupported()` and otherwise assert the unsupported preflight; `PATH` joined with `path.delimiter`; the `roleplay-regeneration-context` fixture disables the fork's pre-send cache guard; decision sidecar empty catches log through `logSuppressed` (empty-catch ratchet back to 224).
- Settings and schema: upstream's own only.
- Verification (journal): three TypeScript checks, locales and builds green; regression suite 761 of 766 passing, with the remaining failures already present before the merge.

### Live data operations (no code)

- A list widget that the old 5-entry cap had emptied was restored to 24 entries through the Dev MCP `set_chat_metadata` (key `gameWidgetState`), after approval, with a backup under `.dev-mcp\backups`.
- The coordinating session reports example widgets set up in a science-fiction test game, as live data only.

### Generation job tracking moved into Features

- Commit: `d91c5d395`.
- Files: `packages/client/src/components/panels/settings/FeatureSwitchesSettings.tsx`, `GenerationJobTrackingSettings.tsx`, `packages/client/src/components/panels/SettingsPanel.tsx`, `docs/configuration/features.md`, `docs/development/generation-jobs.md`.
- Behaviour: the job tracking switch moves from its own Settings > Advanced row into Settings > Advanced > Features as **Keep generating when the tab is closed**, with the Generation jobs button under it.
- Setting: app setting `generationJobTracking` (`"true"` or `"false"`), default off; key and default unchanged, so no migration.

### Game map popover fits the visible viewport on phones and tablets

- Commits: `b5741831d`, `1f04fede6`.
- Behaviour: below 1024px the World map popover was capped at min(68dvh, 26rem), which cut the capability map view (place details, linked places, travel buttons) in half. It now sizes from its top to the bottom of the visual viewport, following browser bars, the on-screen keyboard and the bottom safe area, with the body as the scroll container. Desktop unchanged.
- Behaviour (`1f04fede6`): the phone map popover header (title and close button) carries `data-floating-widget-avoid`, so the floating music bubble moves off it.
- Boundary: package-side layout issues in the maps capability are reported upstream, not patched.

### Built-in helper popup left unchanged

- Commit: `d2a7e9094`.
- Behaviour: reverts the helper minimize and search size changes that `a4049498b` made, at the user's request; the helper popup, its position and behaviour stay as they were. The home widget drag-handle fix in the same file is kept.

### Changelog note for the job tracking move

- Commit: `bcb5006ea`. `CHANGELOG.md` now says the job tracking setting lives in Settings > Advanced > Features.

### Validation boundary for the 2026-09-24 phone and tablet work

- All rules key off `pointer: coarse` or narrow widths; the commits record desktop with a mouse as unchanged. No settings or schema changes.
- Checks were browser viewport emulation, not a physical device or soft keyboard test.

## 2026-09-23

### Claude subscription: keep the history cache marker when a Game turn ends on an injection

- `packages/server/src/services/llm/providers/claude-subscription/jsonl-entries.ts` (`selectHistoryBreakpointIndex`): the history cache marker was placed only when the prompt's final message was the current user history turn. Game prompts sometimes end on a per-turn injection placed after the user turn (the player canon check), and the order varies between turns. Those requests carried no history marker. The Claude CLI's own markers then sat after the volatile runtime blocks, so the next turn could reuse only the system prompt and rewrote the whole history.
- Measured before the fix on a long Game session with Claude Opus 5.5: every turn re-read exactly the same 317,850 system tokens and wrote about 200,000 history tokens (about 61% cached).
- New rule: the marker goes on the last completed assistant history turn whenever everything after it is injections plus exactly one current user history turn, in any order. A tail containing a second, completed user turn is still refused. The existing guards (full-lore marker required, no leading dynamic system block, no tools, media or explicit cache controls) are unchanged.
- Verification without a model call: the CLI's real request bodies were captured for two consecutive saved Game prompts, before and after the change. Before, the earlier request's markers (API messages 164 and 166) sat after the first message where the two requests differ (163). After, the earlier request also carries a marker at 162, inside the prefix the next request shares.
- Regression coverage: `scripts/regressions/claude-cache-prefix.regression.ts` adds a Game-layout case (weather/map injection, user turn, memory and continuity injections, trailing canon check), where the marker is on the assistant, and a two-user-turn tail, where no marker is set. `claude-cache-prefix`, `claude-subscription` and `prompt-history-replay` suites pass.
- Commit b8a7b6967.

### Claude request capture without a model call (diagnostic technique)

- To see exactly what the Claude subscription path sends: take a message's saved `extra.cachedPrompt`, run `ClaudeSubscriptionProvider.chat` on it with `ANTHROPIC_BASE_URL` pointed at a local HTTP server, record only the JSON body and answer HTTP 400. No request reaches Anthropic and nothing is billed. Headers are never recorded, because they carry the subscription token.
- Diff consecutive turns, then compare `cache_control` positions with the first differing message: a turn can only re-read cache written at a marker that lies inside the prefix it shares with the previous turn.

### Claude Opus 5.5 support (model lists, Agent SDK 0.3.280)

- `packages/shared/src/constants/model-lists.ts`: `claude-opus-5-5` added to `ANTHROPIC_MODELS` and to `CLAUDE_SUBSCRIPTION_MODELS` as "Claude Opus 5.5" (1M context, 128k output). The existing adaptive-only/no-sampling check already matches the id.
- `packages/server/src/services/llm/providers/anthropic.provider.ts`: `claude-opus-5-5` added to the models that accept history-level system text.
- `packages/server/package.json`: `@anthropic-ai/claude-agent-sdk` ^0.3.273 moved to ^0.3.280. 0.3.280 is the first version whose bundled CLI knows the model id; the id was confirmed by scanning the Windows binary of both versions. `pnpm-lock.yaml` updated.
- `pnpm-workspace.yaml`: `minimumReleaseAgeExclude` exempts only `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/claude-agent-sdk-*` from the 24-hour minimum release age, because the vendor publishes those packages directly. Every other package keeps the guard.
- Live Claude model discovery (`claude-subscription/live-models.ts`) reads models from the SDK, so the picker lists Opus 5.5 once the client is rebuilt. Connections can be set to it through the API meanwhile.
- Verification: a direct SDK call answered as `claude-opus-5-5` on the subscription, and the engine log shows `requestedModel`/`effectiveModel` `claude-opus-5-5` with `sdkVersion` 0.3.280. The server loads the SDK at runtime, so a new `node_modules` version takes effect at the next engine start.
- Commit 04ad7c3f3.

### Campaign memory processed on Claude Opus 5.5 (data operation)

- The campaign's Claude subscription connection was switched to `claude-opus-5-5`. All 12 session chats of the campaign were set to use it as continuity extractor and verifier through `PATCH /api/game/:chatId/continuity`, including sessions that previously had no connection.
- The campaign index job was started through `POST /api/game/campaign-index/run` with owner registration, backfill and publication of verified batches. The plan listed about 810 unprocessed turns, most of them in three sessions (418, 148 and 195 turns).
- Operational note: that route can take more than 10 minutes to answer for a large campaign, because owner registration and the first session's enqueue run synchronously. Check `GET /api/game/campaign-index/status?gameId=` instead of re-posting.

### Continuity: split a batch whose model answer was cut off

- `packages/server/src/services/game/continuity-runtime.ts`: new `isOutputTruncated` walks the error cause chain for a `FINISH_length` stop. The runtime otherwise sees only `CONTINUITY_STAGE_FAILED`. A truncated batch covering two or more messages now goes through the existing overflow split: two halves are re-queued under deterministic ids, and the original is journaled as stale with `splitInto`. Before, it failed, and every retry paid for the same cut-off answer again.
- A single-message batch still fails normally, so a turn can never loop.
- Regression: `scripts/regressions/game-continuity-truncation-split.regression.ts` (two-message batch split into halves; single-message batch not split). `game-continuity-context-split` still passes.
- Commits: code in e8e485270 (runtime), regression 8041fe7b4.

### Continuity: salvage model output instead of failing the batch

- `packages/server/src/services/game/continuity-review.ts`:
  - `locateContinuityQuote` repairs typographic drift in evidence quotes to the exact source text: curly quotes, dashes, ellipses, collapsed or doubled whitespace, and a stray surrounding quote mark. It tries the full quote before the trimmed one.
  - Fresh extraction drops only a record whose primary-source quote still cannot be located; the other records survive.
  - Targeted repair keeps strict rejection (`dropUnlocatedRecords: false`, passed from `continuity-repair-patch.ts`): silently dropping a repaired record would delete the record being repaired, and the repair loop needs the rejection as feedback.
  - Review: a finding whose quote cannot be located is dropped instead of failing the whole review.
  - `completeDispositions`, for extraction and review: a missing primary-message disposition is filled in (covered if a record cites the message, otherwise no durable facts), and duplicates or unknown ids are dropped.
  - `looseStringList` for record conditions and keys: accepts null (empty list), a single string, a map of named conditions, numbers and booleans, arrays, and objects that carry their text in text/condition/description/value/key/name/label/content at any depth up to two. Items with no text at all are still rejected.
  - An uncited "covered" disposition becomes "no durable facts" when other primary messages are cited, and stays "unresolved" only when no record cites anything. Before, it became "unresolved", which no repair could clear, so the batch ended unresolved and its good records were never published.
- `packages/server/src/services/game/continuity-provider.ts`: stage output caps raised from extract 8000 / review 12000 / repair 8000 to 16000 / 20000 / 16000. The 16 generic stage failures counted in one night's log were 8 real failures, each logged twice, and all were `FINISH_length` (7 extract, 1 review).
- Regression: `scripts/regressions/continuity-extraction-leniency.regression.ts` covers blank and wrapped items, the other shapes, quote drift and unlocatable quotes, dropped findings, filled dispositions, and genuinely malformed lists that must still fail. The review, repair-patch, withheld-records and runtime suites pass.
- Commit e8e485270.

### Continuity: later sessions can publish into the campaign Lorebook Keeper book

- `packages/server/src/services/game/continuity-memory-publication.ts`: `assertContinuityMemoryEntry` required the entry's lorebook to belong to the receipt's own chat. A campaign has one Keeper book, bound to the session chat that created it, and every later session writes into it, so every receipt from session 2 onward failed with `CONTINUITY_MEMORY_ENTRY_CHAT_MISMATCH`. New `continuityBookBelongsToChat` also accepts the Keeper book of the same campaign, compared through `campaignIdentity`.
- Recovery: the 30 receipts that had failed this way were republished through the publish-only retry below, one at a time; every attempt count was unchanged, so no model call was made.
- Regression: `scripts/regressions/continuity-keeper-later-session.regression.ts`.
- Commits e8e485270, 6f72a1c8e.

### Continuity: publish-only retry for failed batches

- `packages/server/src/services/game/continuity-runtime.ts` (`retry`): a failed batch that has records, a review with no findings, and an error code starting with `CONTINUITY_MEMORY_`, `CONTINUITY_PUBLICATION` or `CONTINUITY_LOREBOOK` is put back to verified and published again, with no re-extraction. Other failures still re-extract.
- `POST /api/game/:chatId/continuity/retry` with `{ batchId }` uses this path. The status listing omits records, so check the storage table before assuming a retry would re-extract.
- `packages/server/src/services/storage/game-continuity.storage.ts`: a batch published late clears its old `errorCode`/`error`.

### Continuity: per-chat parking when a chat has no connection

- `continuity-runtime.ts`: `CONTINUITY_CONNECTION_UNAVAILABLE` used to pause the whole runtime every hour, so every other chat's batches waited too. It now parks only that chat's items, with a 10-minute unpark timer. `resumeChat` clears the parked items and reconciles missed turns.
- `enqueueCommittedTurn` catches the same code: a turn sent while the connection is missing is no longer failed after the player's message was saved, and it is queued once a connection is set.
- Regression: `scripts/regressions/game-continuity-unavailable-admission.regression.ts` (a healthy chat keeps processing, the chat without a connection is parked, and the runtime does not pause).

### Continuity: configuration changes keep finished work

- `continuity-runtime.ts`: a queued batch with no records has lost no model work, so it is re-frozen to the current configuration instead of being retired as stale `CONTINUITY_CONFIG_CHANGED`. A verified but unpublished batch is published after a configuration change, because publication does not depend on the extraction configuration.
- Regression: `scripts/regressions/continuity-config-refreeze-publish-retry.regression.ts`. `game-continuity-runtime` accepts "published" for a batch that is republished at startup.

### Continuity: one failed publish no longer blocks a backfill

- `continuity-runtime.ts` (`publishHistoricalBackfill`): each batch is published in its own try/catch; a failure is recorded on that batch (failed, or stale for stale-type codes) and the backfill continues. Before, one error stopped the loop, and the campaign index job retried the same error on every 30-second tick.

### Continuity status: verification watermark and connection availability

- `packages/server/src/routes/game.routes.ts` (`GET /api/game/:chatId/continuity`): adds `verifiedThroughAt` (the time of the last verified message) and `connectionAvailable` (whether a continuity connection currently resolves). The client Memory settings panel uses them.
- `POST /api/game/:chatId/continuity/retry` returns 409 `CONTINUITY_BACKFILL_RERUN_REQUIRED` for a stale historical-backfill batch, instead of a 500.

### Retracted canon stays retracted

- `continuity-memory-publication.ts`: a statement the user retracted and locked (fact status retracted with `manualLock`) is never published again by continuity. The key is the normalized text plus the sorted distinct evidence message ids, so a re-read of the same turn (a new receipt, a backfill, a repair) matches whatever subject it lands on. The same sentence said later in a different message does not match, so a retracted rumour cannot hide the real event.
- `packages/server/src/services/game/campaign-memory-context.ts`: the GM memory block hides every copy of a retracted, locked statement with the same key, including twins and other sessions' copies.
- Retractions and edits are made through the existing mutations API with `{ status: "retracted", manualLock: true }`.
- Regressions: `continuity-retracted-canon`, `bughunt-continuity-retraction-false-positive`, and assertions in `campaign-memory-campaign-scope`.

### Pinned canon in the GM memory block

- `campaign-memory-context.ts`: a fact is pinned canon when it has `manualLock: true` and `value.pinned === true`. Pinned facts rank above every relevance tier, below the current-state section, and render as `[fact <id> S<n> canon] ...`. Helper: `isPinnedFact`.
- The wiki pins and unpins through the existing mutations API; no schema change was needed.

### Campaign fact list for the wiki Canon page

- `packages/server/src/routes/campaign-memory.routes.ts`: new `GET /api/game/:chatId/memory/facts` in campaign scope. Query: `pinned=true|false`, `q` (case-insensitive text over predicate and value), `offset`, `limit` (max 100). Newest session first; each item carries `subject { entityId, alias }`, `originChatId` and `originSessionNumber`.
- Regression: `campaign-memory-wiki-api` (list, subject name, pinned filter, invalid query).

### Wiki entity list: kind totals, people-first sort, archived last, mirror pages hidden

- `GET /api/game/:chatId/memory/entities`:
  - `kindTotals` gives counts for character, persona, location, organization, item, quest, lore and note, computed before the kind filter so one request labels every chip.
  - `sort=kind` lists people and places first, in that order; `sort=name` stays the default.
  - Archived pages are listed last.
  - Continuity lorebook mirror pages that are empty or named only "Game continuity N" are hidden when nothing references them, whether live continuity or the legacy import created them.

### Wiki entity detail: fact filters and per-session counts

- `GET /api/game/:chatId/memory/entities/:id`: new `factQuery` (text), `factKind` (a continuity record kind, else the predicate) and `session` filters; `factSessions` (count per session, newest first) and `factKinds` (count per kind) cover every fact about the entity, whatever the filters and page.
- The detail route checks source freshness only for the records the page shows, and indexes knowledge by fact, which removes two quadratic passes.

### Wiki timeline: readable event text, newest first, session grouping

- `GET /api/game/:chatId/memory/timeline`: event text comes from what the event's transition recorded (up to three fact texts citing the same quote, else the state it set, else the quote itself) instead of raw transition ids. `order=desc` pages newest first, and the cursor follows the same direction. Items carry `originSessionNumber` and `originChatId`.
- The fact dependents route uses the same text.

### Wiki writes: true partial patches and cross-session references

- `packages/server/src/routes/campaign-memory-write.routes.ts`:
  - The entity, fact, knowledge and relationship patch schemas are true partials. Before, defaults reset untouched fields (aliases, tags, status, lock) and required create fields rejected value-only edits.
  - An entity or fact id from another session of the same campaign is mapped to the matching record in the write chat. When no match exists the write returns 409 `CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE` with a readable message. Ids from unrelated chats are still rejected with 404 `CAMPAIGN_MEMORY_INVALID_REFERENCE`.
- `campaign-memory-mutations.ts`: successful writes clear the campaign memory caches, so an edit to an earlier session's record shows immediately.
- Regressions: `bughunt-projection-partial-patch`, `bughunt-projection-cross-session-write`, `bughunt-projection-stale-earlier-session`, `campaign-memory-write-api`.

### Session recap grounded in verified memory, with a 20-minute limit

- `game.routes.ts`: the "Previously on" recap now receives the verified campaign memory (up to 5,000 characters, focused on the resume point and the last ending beat) as a fact check. Where the summary contradicts memory, memory wins, and facts the summary does not mention are not added. A memory failure only skips the fact check.
- The recap gets its own 20-minute limit (`GAME_SESSION_RECAP_TIMEOUT_MS`) instead of the 5-minute generation limit, which slow models on long campaigns had exceeded, falling back to a generic opening.
- `packages/server/src/services/game/session.service.ts`: `buildRecapPrompt` takes the optional verified memory.
- Regression: `game-recap-verified-memory`.

### Party members read their memory from earlier sessions

- `game.routes.ts` (`resolvePartySpeakerCampaignMemory`): party-speaker memory resolves the character through the campaign projection. In a new session the character's memory lives in earlier session chats, so it previously fell back to legacy mode with no memory.

### Regenerate and continue use the same memory block as a live turn

- `packages/server/src/routes/generate.routes.ts`: the historical-cutoff GM memory block uses the chat's `gameCampaignMemoryMaxCharacters` (default 10,000; it was hard-coded at 6,000), the latest turns as focus, and receipt deduplication at the same continuity cutoff as the continuity block of that request.

### Campaign memory API and GM block: correctness fixes

- `packages/server/src/services/game/campaign-memory-campaign-scope.ts`:
  - A projected entity takes its owner, kind, revision and lock from the anchor row, so a library card folded with a tracked NPC keeps the card as owner. Party-speaker memory, scene presence and wiki edits all resolve the person again.
  - A statement re-read in a later session keeps the earliest copy, so a regenerate at an earlier point still finds it. `factIdAlias` resolves ids of dropped copies.
  - Current-state values replaced by a later session are kept as `supersededStates`, and the builder picks the newest value at or before the cutoff.
  - An abandoned branch no longer stands in for the real session: the current chat's lineage comes first, then the canonical session, then a branch.
  - A tracked NPC with a library card's exact name folds into the card even when both were registered in the same session; the NPC tracker registers card characters a second time.
  - The one-word fold ("Aria" into "Aria Vell") is refused when both groups appear side by side in one session, and it runs in linear time.
  - Mutual relationships recorded in both directions show once in the backlinks.
- `campaign-memory-context.ts`:
  - Twin copies of a continuity record resolve to the rendered copy, chosen among eligible copies only, and knowledge and world scope follow that copy.
  - Ended facts (`validToOrder`) are hidden on live turns.
  - A GM knowledge line that cites a fact which does not render carries the sentence itself.
  - The receipt deduplication compares only against records the continuity block actually renders on that request (`includedRecordKeys` from `continuity-context.ts`).
- Regressions: the `bughunt-projection-*` and `bughunt-gmcontext-*` suites, and `campaign-memory-campaign-scope`.
- Commits 9c1552c01, e8e485270, 20167a05b, 1bb910e91.

### Game-UI bug hunt: combat

- Files: `packages/client/src/components/game/GameCombatUI.tsx`, `TacticalCombatUI.tsx`, `RulesetCombatMenu.tsx`, `packages/client/src/hooks/use-directed-combat.ts`, `packages/server/src/services/game/combat.service.ts`, `packages/client/src/components/game/GameSurface.tsx`.
- Classic combat: items with target "any" (the sanitizer's default) can target allies; Enter or Space on a focused button, link or dialog no longer fires the highlighted action; a refused or failed special move returns to the menu instead of spinning on "resolving"; round animation and damage-popup timers are cleared on unmount; every queued party order is sanitized; the menu highlight resets per party member; the log scrolls only its own box; the acting combatant is highlighted per animated action; the ally picker opens only with two or more living allies.
- Boss mechanics: `hp_threshold` mechanics fired every round below the threshold. Classic fires on the round HP crosses the threshold (start-of-request HP vs after, including damage-over-time ticks); directed combat marks the mechanic `thresholdFiredRound` in its saved state and fires once per fight.
- Tactical: a late action response after leaving the chat is dropped; a quick Retry after a defeat no longer leaves a battle that cannot end; combat-end handoffs fire once per battle; Escape backs out one step; hovering a unit previews its movement and attack range.
- Ruleset and directed: a slow battle reload no longer overwrites a newer revision; a half-finished choice clears when its options change; Escape closes pay and target steps; cost and hit forecast stay visible while choosing targets.
- Tests: `scripts/regressions/combat-mechanic-threshold.regression.ts` (new); combat-director, combat-director-route, combat-conditions, combat-ai pass.

### Game-UI bug hunt: narration, input and parser

- Files: `packages/client/src/lib/game-tag-parser.ts`, `packages/client/src/components/game/GameNarration.tsx`, `GameInput.tsx`, `GameSurface.tsx`.
- Parser: an apostrophe inside a word no longer opens a quoted string, so tags such as `[aside: the guard's eyes narrow]` are stripped; whisper party-line headers (`[Name] [whisper:Target]`) survive stripping.
- Narration: interrupting on a segment that came from an inline-dialogue split cuts the saved message at that point; inline dialogue detection no longer treats pronouns or articles as speakers; an adopted roll is not logged twice; `[inventory:]` updates still pending when a turn's narration ends are applied then.
- Input: Enter that confirms an IME candidate does not send; a queued die rolled for a failed send is reused (no reroll, no second Dice Log row); switching chats clears attachments, queued dice and address mode; oversize or unreadable attachments say so; pasted images attach; failed sends go back to their own chat; slow translations never overwrite new text; Up in an empty box recalls the last sent turn.
- Choices: choice cards come back when sending the chosen choice fails.

### Game-UI bug hunt: game surface state

- Files: `packages/client/src/components/game/GameSurface.tsx`, `packages/client/src/hooks/use-game.ts`, `packages/client/src/hooks/use-generate.ts`, `packages/client/src/hooks/use-game-state-patcher.ts`.
- Scene analysis results, the 120 s fallback timer and asset installs are tied to the chat that started them (no cross-chat scene, no music after leaving the game).
- Starting the next session no longer wipes the previous session's saved background, music and ambient.
- Map, state-transition and reputation results only update the store when their chat is still open.
- Weather is keyed by turn (message plus swipe).
- A cancelled or failed Retry turn no longer reprocesses the old turn.
- Inventory: server-side changes (directed-fight item spends) are adopted from the chat refetch; the directed-fight save drops items at quantity 0; + and combat use match rows by item id; Use item sends the item name (it sent "[object Object]").
- NPCs: party removal is by id (new optional `characterId` on `/game/party/remove`); id-less NPC removal prunes a freshly fetched journal.
- A tracker change during a refresh shows a toast (`ui.game.gamestatepatcher.editBlockedWhileRefreshing`) instead of being dropped.

### Tag reapply after a chat switch

- Files: `packages/client/src/components/game/GameSurface.tsx`, `packages/client/src/hooks/use-generate.ts`.
- Behaviour: a GM turn that finished while its chat was not on screen (another chat open, or no game mounted) is processed when you return; before, the return was treated as a restore and the turn's widget, state, inventory, reputation and weather tags were never applied. The `marinara:generation-complete` event carries `receivedContent`; a module-level set records such chats; the on-screen chat clears its own entry. In memory only (a reload still loses it).

### Reputation once per message

- Files: `packages/server/src/routes/game.routes.ts` (`POST /game/reputation/update`), `packages/client/src/hooks/use-game.ts`, `packages/client/src/components/game/GameSurface.tsx`.
- Behaviour: reputation is a delta with no rewind, so the server records the source message id (`gameReputationAppliedMessages`, last 200) and ignores repeats. A regenerated swipe, a scene-analysis retry, or the scene model inferring a change the GM already tagged no longer adds it again. The client sends `messageId` from both the inline-tag and scene-model paths.

### Game-UI bug hunt: sheets, journal, inventory, party, dice, replay, maps, setup, audio

- Character sheet (`GameCharacterSheet.tsx`, `GameSurface.tsx`): edits survive game-state updates (reset only when the character changes); save and the ruleset half find the stored card leniently (accents, aliases) instead of saving a duplicate; typing a pool or attribute name keeps focus; Escape while editing no longer discards the draft; Copy as text button.
- Journal (`GameJournal.tsx`, `packages/server/src/services/game/journal-entry-guard.ts`, `game.routes.ts`): remounts per chat; load and notes-save errors shown with Retry; notes capped at 10,000; search box; edits and deletes send the expected entry and the server answers 409 `JOURNAL_ENTRY_MOVED` when it moved; accessible edit dialog.
- Inventory (`GameInventory.tsx`): search and a view-only sort; same-name rows no longer all highlight; rename and selection survive refreshes.
- Party bar (`GamePartyBar.tsx`): a single removable member can be removed on phones; the desktop remove button is visible; thin HP bars in avatars.
- Dice log (`GameDiceLog.tsx`): summary strip (most rolled die vs a fair die, nat 20 and nat 1 rates); 390px layout fixes.
- Replay (`GameSessionReplay.tsx`, `GameStoryboardViewer.tsx`, `GameSessionHistory.tsx`): Watch again replays a one-turn session; Left and Right change turn, Escape exits; replay audio stops when closed by a scene change.
- Maps (`GameMap.tsx`, `packages/server/src/services/game/game-map-validate.ts`): generation is single-flight with an error toast; the server validates generated maps (422 `MAP_INVALID`); nodes with missing coordinates no longer blank the map; pinch zoom.
- Setup wizard (`GameSetupWizard.tsx`, `use-game.ts`): field limits match the server; a retry after a failed setup does not create the game twice; Start ignores clicks right after a step change; a GM character is left out of the party; IME Enter guard.
- Audio and backgrounds (`game-audio.ts`, `DirectionEngine.tsx`, `SpriteOverlay.tsx`): a layer stopped while the audio context resumed no longer loops forever; crossfade and muted volume changes are kept; iOS resume; backgrounds preload and fade in over the old one; quoted `url()`; sprites show the right pose on the first frame.
- Contacts (`GameContactBookWidget.tsx`): no invisible categories after deleting the chosen parent; category actions reachable on touch and keyboard.
- Tests: `scripts/regressions/game-map-validate.regression.ts` (new); dice-log, inventory-identity, continuity-inventory pass.

### Edit layout rebuild (desktop Game mode HUD)
- Commits: f72a47763 (new modules), 7b19cd5d2 (wiring).
- Files: `components/game/FloatingGamePanel.tsx`, `components/game/DraggablePanel.tsx`, `components/game/GameLayoutEditToolbar.tsx` (new), `components/game/GameLayoutPopover.tsx` (new), `components/game/GameStoryboardViewer.tsx`, `components/game/GameSurface.tsx` (toolbar mount next to the Edit layout button, `layoutRevision` in GamePanelContext), `lib/game-panel-layout.ts`, `lib/game-layout-editor-store.ts` (new), `lib/game-layout-geometry.ts` (new), `lib/game-layout-snapshots.ts` (new), `localization/locales/en.json` (`ui.game.layoutEditor.*`).
- How to reach it: Game mode on desktop (1024px wide and up), the "Edit layout" button in the game toolbar. Esc leaves edit mode unless a popover is open.
- Behaviour:
  - Edit mode shows a 16px grid, a dashed outline and a name tag on every panel. Locked panels show a muted outline and a lock icon.
  - A hint with "Unlock all" appears when every panel is locked. It dismisses itself after 12 s.
  - Drag a panel from anywhere on it. A transparent drag layer keeps content clicks from firing. Arrow keys on the name tag move the panel 10px, or 40px with Shift.
  - Snapping to surface edges and centres and to other panels' edges, centres and adjacency lines, within 8px, with guide lines. Alt disables snapping. The 16px grid is the fallback.
  - Collisions switch:
    - On (default): a dropped panel that overlaps another shows a hatched overlap and a landing preview, then glides to the nearest free spot. It never moves another panel.
    - Off: panels overlap freely ("phase through"), the automatic reflow leaves intentional overlaps alone, and clicking a panel brings it to the front.
  - Resize from 8 handles (all edges and corners) with a live W x H readout, minimum sizes and snapping. A height drag switches the panel's growth mode to Fixed, so content growth cannot undo it.
  - The per-panel "..." popover on the name tag holds: lock, reset, growth (Grow down / Grow up / Fixed), collapse to edge with edge choice, widget stacks (stack with, new stack), narration bottom pin, toolbar top-centre pin, and Hide.
  - The Layout toolbar sits in the header strip above the HUD surface. It holds:
    - Done;
    - Undo and Redo (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y, 50 steps);
    - the Snap and Collisions switches;
    - Lock all and Unlock all;
    - a Panels menu to show or hide panels, with a hidden count (narration and toolbar cannot be hidden);
    - a Layouts menu to save, apply, rename, delete, export or import JSON, and Reset all.
  - The storyboard viewer fills the box it is given, so its 16:9 picture no longer drives the panel height or spills into neighbours.
- Settings and defaults:
  - Snap on and Collisions on by default. Both are stored globally in localStorage.
  - Saved layouts are global, in localStorage `marinara-game-layouts:v1`, so they are reusable across game chats.
  - Snapshots, undo and saved layouts copy every localStorage key under the chat's panel prefix plus the stacks key. Applying one remounts the panels through `layoutRevision`.
- Tests:
  - `scripts/regressions/game-layout-editor.regression.ts`: snapping, resize, settling, overlap mode, snapshots, undo, saved layouts.
  - `scripts/regressions/game-layout-edit-mode.browser.mjs` (Playwright fixture): edit chrome, unlock-all hint, drag anywhere, snap guides, overlap settle, collisions off, 8-way resize, options popover, undo/redo, hide/show, saved layouts, keyboard, Esc.
  - Updated: `floating-panel-layout.regression.mjs`, `game-panel-autogrow.browser.mjs`, `game-panel-bottom-lock.browser.mjs`, `game-widget-stack.browser.mjs`, `game-widget-tuck.browser.mjs` (these take an optional layout scope argument), `scripts/ui-fixtures/game-hud/run.mjs`.

### HUD panels crushed to 64px after the rebuild: fix and recovery
- Commit: 67967f940.
- Files: `lib/game-panel-layout.ts`, `components/game/FloatingGamePanel.tsx`, `components/game/DraggablePanel.tsx`.
- Symptom: at 1440x900 every HUD panel, narration included, rendered 64px tall.
- Cause: the crowded-screen reflow places panels one at a time and shrank every panel by the same step whenever any panel did not fit. One wide widget (727px) always failed to fit, so everything dropped to the 64px floor.
- Behaviour:
  - Stranded panels are retried first, then widgets are packed, before anything shrinks. Widgets shrink before reading panels do.
  - Narration, map and storyboard never go below a third of the screen height.
  - A width that cannot fit keeps its spot instead of crushing the rest.
- Recovery:
  - Stored heights below the 64px minimum are treated as unset.
  - Positions saved while panels were crushed recover to a non-overlapping layout.
  - Automatic reflow never writes sizes or positions. Only manual drag, resize and keyboard moves persist.
- Tests:
  - `scripts/regressions/game-panel-crowded-layout.regression.ts`
  - `scripts/regressions/game-panel-crowded-reflow.browser.mjs`: an 11-panel crowded HUD at 1440x900 keeps readable heights, a layout saved before the rebuild renders at its old size, crushed-era positions recover, and reflow writes nothing.

### Edit layout bug-hunt fixes
- Commit: 681fd2d1d.
- Files: `components/game/FloatingGamePanel.tsx`, `components/game/GameLayoutEditToolbar.tsx`, `components/game/GameStoryboardViewer.tsx`, `lib/game-panel-layout.ts`, `localization/locales/en.json` (`ui.game.layoutEditor.thisWidgetStack`).
- Fixes:
  - The crowded layout no longer flips between two solutions every frame. Anchors stay absolute until the screen resizes, and a height-limited storyboard uses its last unlimited height.
  - "Fixed height" captures the content's real height, and Lock keeps the saved position.
  - The 900px game toolbar is placed right after narration, alongside the map, instead of last.
  - Name tags move inside the panel's top edge when a neighbour is within 12px above.
  - Esc during a drag or resize cancels it and restores size and growth. Leaving edit mode mid-drag cancels it too.
  - Undo or a chat switch mid-drag resumes reflow and clears guides.
  - The edit session (the undo scope) ends whenever editing stops, including on a chat switch.
  - Edit mode ends below 1024px wide, and the Edit layout button is hidden there.
  - Stack siblings no longer block a resize.
  - The value-change reveal of a tucked widget gets its own timer, so changing the tuck edge cannot leave it open for good.
  - The "This widget stack" label is localized.
  - The storyboard reserves 192px for header and footer when height-limited.
- Tests:
  - `scripts/regressions/game-layout-edit-hunt.browser.mjs` (new): tags, Esc and undo mid-drag, composer undo, chat switch, tablets.
  - `game-widget-tuck.browser.mjs` uses a stateful mock and clears keys under the layout scope.

### Readable accent fills and on-screen popovers
- Commit: eff73f52b.
- Files: `components/game/GameLayoutEditToolbar.tsx`, `components/game/GameLayoutPopover.tsx`, `components/game/FloatingGamePanel.tsx`.
- Behaviour:
  - The Done button, the Save button, the hidden-count badge and the W x H badge use `--primary-foreground` on the accent fill. White on #ec4b97 was about 3.5:1.
  - Popovers that would open below the viewport flip up.
  - Menu icons are one size (12).
- Test: `scripts/regressions/game-layout-visual-polish.regression.mjs`.

### Storage failures never half-apply a layout
- Commit: 5e57cd705.
- Files: `lib/game-layout-snapshots.ts`, `lib/game-layout-editor-store.ts`, `components/game/GameLayoutEditToolbar.tsx`, `localization/locales/en.json` (`ui.game.layoutEditor.storageFull`, `ui.game.layoutEditor.importStorageFull`).
- Behaviour:
  - Apply, undo, redo, reset and import roll back when browser storage is full or blocked, and the undo history stays in step with the layout.
  - A clear storage message replaces the generic "not a Marinara layout" text.
  - Saving a layout reports a failed write.
  - Imports over 512K characters are refused before parsing.
  - Applying a layout saved in another chat rewrites the key prefixes to the current chat.
- Test: `scripts/regressions/game-layout-snapshots-hardening.regression.ts`.

### Keyboard, screen reader and rename fixes
- Commit: 06fd3ca19.
- Files: `components/game/FloatingGamePanel.tsx`, `components/game/GameLayoutEditToolbar.tsx`, `localization/locales/en.json` (`ui.game.floatingPanel.moveNamed`, `ui.game.floatingPanel.resizeNamed`).
- Behaviour:
  - Move and resize handles include the panel name in their accessible label.
  - Arrow nudges ignore Ctrl, Alt and Meta.
  - The undo and redo shortcuts ignore AltGr chords (Ctrl+Alt).
  - Esc in the layout rename field cancels without saving and returns focus to the rename button. Enter also returns focus there.
- Test: `scripts/regressions/game-layout-edit-focus.browser.mjs`.

### Tidy and Shift+click align
- Commit: 6015b7172.
- Files: `lib/game-layout-tidy.ts` (new), `lib/game-layout-arrange.ts` (new), `lib/game-layout-editor-store.ts` (selection state), `components/game/FloatingGamePanel.tsx`, `components/game/GameLayoutEditToolbar.tsx`, `localization/locales/en.json` (`ui.game.layoutEditor.tidy`, `alignLeft`, `alignRight`, `alignTop`, `matchWidth`).
- How to reach it: in Edit layout, the Tidy button is always shown. Shift+click panels to select them; Align left, Align right, Align top and Match width appear when two or more are selected. The first Esc or a click on empty surface clears the selection.
- Behaviour:
  - Tidy packs panels into non-overlapping columns, keeping each panel's left, centre or right side and its top-to-bottom order.
  - Locked and tucked panels stay put and act as obstacles. Stacks move as one block.
  - Reading panels keep at least a third of the screen height.
  - Each action is one undo step.
  - With collisions off, alignment is applied exactly.
- Tests: `scripts/regressions/game-layout-tidy.regression.ts`, `scripts/regressions/game-layout-tidy.browser.mjs`.

### Arrange widgets on phones
- Commit: 753ed582a.
- Files: `components/game/GameMobileArrange.tsx` (new), `lib/game-mobile-panel-arrangement.ts` (new), `components/game/GameWidgetPanel.tsx` (MobileWidgetPanel applies the arrangement), `components/game/GameSurface.tsx` (the Arrange button at the end of the phone widget row), `localization/locales/en.json` (`ui.game.mobilewidgetarrange.*`).
- How to reach it: in Game mode below 1024px, the Arrange button at the end of the widget row.
- Behaviour:
  - A sheet lists the left and right widgets in two groups, with up, down and hide/show buttons. Touch targets are at least 40px.
  - Both widget rails stay in sync.
  - The Arrange button stays visible even when every widget is hidden.
- Settings: per device, in localStorage `marinara-game-panel-mobile:<scopeId>:arrangement` (order, hidden, expanded). Desktop layouts are unaffected. Default: server order, nothing hidden.
- Tests: `scripts/regressions/game-mobile-panel-arrangement.regression.ts`, and `scripts/ui-fixtures/game-hud/run.mjs` at 390x844 (reorder persists, hidden stays hidden, targets at least 40px, no horizontal scroll).

### Neutral fixture names
- Commit: 0b3dea6a3.
- Campaign-specific widget ids and session references in `scripts/regressions/game-panel-layout.regression.ts`, `game-panel-crowded-layout.regression.ts` and `game-panel-crowded-reflow.browser.mjs` are replaced with invented neutral names.

### Campaign Wiki: article pages
- Commits: 05d60f159 (wiki files only), c823be962, 327a18130, acca532f3, 12331af21.
- Files: `components/game/CampaignWiki.tsx` (Detail), `CampaignWikiFacts.tsx`, `CampaignWikiInfobox.tsx`, `CampaignWikiReaderParts.tsx`, `CampaignWikiEditor.tsx` (initialFactId/initialTab props), `hooks/use-campaign-memory.ts` (useCampaignMemoryEntityFacts, useUpdateCampaignMemoryFact, fact filter params).
- Behaviour: every entity page is a wiki article. Hero with an 88px portrait, name and one meta line (aliases, kind, sessions, fact and secret counts), Edit, Open character card and a "View as" perspective select. Main column plus a 16rem infobox that switches by container query (follows the reading pane, not the window).
  - Pinned canon block at the top: facts with `manualLock === true` and `value.pinned === true`.
  - Facts are compact one-line rows grouped by session, newest session open, older sessions collapsed with counts from the server's `factSessions`; per-session paging with Load more; search box sends `factQuery` (300ms debounce); kind chips from `factKinds` (top five, rest in "More kinds"); withdrawn (retracted) facts fold into one line per session.
  - Clicking a row expands it: evidence quote with Show full message, conditions ("Only if"), co-holders ("Also known to"), status badges, and actions Pin as canon, Unpin, Correct (opens the editor on that fact), Wrong (inline confirm, then retract and lock).
  - Infobox: Right now (current state; values that are page ids resolve to page names and link), Connections (one row per person with merged labels), Open promises, and "On this page" links that open Facts, What they know, Events, Connections, Timeline, Promises and quests, Details in the main column. The old tab bar is gone.
  - Events tab leads with the text of a live fact that cites the same message and quote. An event summary made only of ids shows "Event recorded". No raw ids are shown anywhere (RAW_ID filter).
- How to reach: open a game session chat, press the Campaign Wiki button, pick a page.
- Settings and defaults: none. Writes go to the fact's origin session (`recordWriteChatId`). Pin sends `{value: {...value, pinned: true}, manualLock: true}`; Unpin restores the earlier lock (`value.lockedBeforePin`); Wrong sends `{status: "retracted", manualLock: true}`. A 409 revision conflict offers Reload.
- Tests: `scripts/ui-fixtures/campaign-wiki/run-tests.mjs` (session groups, load more, pinned canon, kind filter, search, Wrong, Pin, Unpin, Correct, older-server fallback, error and retry, 390px overflow); regression `scripts/regressions/campaign-memory-wiki-reader-ui.regression.ts`.

### Campaign Wiki: front page, grouped page list and campaign timeline
- Commits: bc4beedf7, f66d35889 (new files), 856a5fc67 (title and desc timeline).
- Files: `components/game/CampaignWikiOverview.tsx`, `CampaignWikiRail.tsx`, `CampaignWiki.tsx`, `campaign-wiki-ui.tsx` (EntityAvatar loading placeholder and error fallback), `hooks/use-campaign-memory.ts` (`sort` option, `kindTotals` type).
- Behaviour:
  - Page list with no search groups by kind: People, Player characters, Places, then Organizations, Items, Quests, Lore, Notes, each with its count. The first three start open; the rest load when opened; each section shows 8 rows, Show more, and See all (paged kind list). Pages with the same kind and name collapse into one row ("Lore, 17 pages"). Search ranks match tier first, then people and places before lore. Filter chips show counts and hide empty kinds.
  - Portraits show initials (pulsing) until the image loads, fade in, and fall back to initials on error.
  - Front page: hero with the campaign name (the chat name without a trailing "Session N" suffix) and counts, stat tiles that open each kind, a people grid (12, trimmed to 6 on phones; portraits and most sessions first), Latest in the story (5 newest events via one `order=desc&limit=10` request, with a cursor-walk fallback for older servers), Open promises, top places, recently changed, quick links; import tools behind a Tools disclosure.
  - Campaign timeline: Story events and Promises and quests tabs; events grouped by session (from `originSessionNumber`) then by day, with a session jump bar; event cards show summary, place chip, people chips with portraits and state changes.
- How to reach: Campaign Wiki window, front page (home icon in the rail) and the Timeline button.
- Settings and defaults: none. Uses the server's `kindTotals` and `sort=kind` when present, else one count request per kind.
- Tests: `run-tests.mjs` (grouping order and counts, show more, see all, search ranking, older-server fallback, portrait loading and fallback, front page sections, promises tab, timeline sessions and jump bar, phone front page and timeline without sideways scroll, duplicate-name collapsing, grouped connections).

### Campaign Wiki: review duplicates, what links here, canon page
- Commit: d02f0f881.
- Files: `components/game/CampaignWikiReview.tsx`, `CampaignWikiLinksHere.tsx`, `CampaignWikiCanon.tsx` (all new), `CampaignWiki.tsx`, `CampaignWikiOverview.tsx`, `hooks/use-campaign-memory.ts`; fixtures `scripts/ui-fixtures/campaign-wiki/run-review-canon.mjs` (new), `entry.tsx`, `run-all.mjs`.
- Behaviour:
  - Review duplicates: reads `/memory/review/duplicates` for each session chat of the campaign (the route is per session), shows each group's versions side by side (text, subject, session, date, quote count, pinned or pending chips) and the reason they were grouped; preselects a pinned version, then the most quoted, then the newest; Resolve posts to that session chat with `expectedRevisions`; Skip hides a group, Show again restores. Conflict offers Reload; cross-session refusal shows its message; a missing fact reports it. Count badge on the front page Tools summary.
  - What links here: a block at the end of each article listing pages connected through loaded connections and events, grouped by kind with portraits, plus a campaign-wide summary line from `/memory/entities/:id/references`.
  - Canon: every pinned fact across the campaign from `GET /memory/facts?pinned=true`, grouped by page, with search, Load more and Unpin (written to the fact's own session).
  - Older servers without these routes get "needs a server update" empty states.
- How to reach: wiki front page, Tools (Review) and Quick links (Canon); What links here at the end of any article.
- Settings and defaults: none.
- Tests: `run-review-canon.mjs` (38 checks at desktop and 390px: review, resolve, conflict and reload, cross-session refusal, skip, canon, unpin, older-server states, links here, no overflow).

### Campaign Wiki: write paths, cross-session references and fixes
- Commits: 856a5fc67, 12331af21, 23eb00759, 8a55809e7.
- Files: `campaign-wiki-ui.tsx` (cross-session error helpers), `CampaignWikiCommitments.tsx`, `CampaignWikiCreateRecord.tsx`, `CampaignWikiEditor.tsx`, `CampaignWikiEvidence.tsx`, `CampaignIndexDialog.tsx`, `CampaignWikiFacts.tsx`.
- Behaviour:
  - A write that references a person with no page in the write session (409 `CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE`) shows a specific message on every write path (editor preview and save, create record including knowledge, commitment transitions, Pin, Unpin, Wrong) instead of the reload banner.
  - Pin, Unpin and Wrong send partial patches.
  - The "who knows it" fact picker lists facts from the write session first and labels facts from other sessions.
  - Fixes from two review passes: paging keeps the open tab and perspective; changing tabs resets the shared page offset; the editor diffs against a snapshot taken when editing starts (a refetch can no longer hide a concurrent change from the 409 check); evidence scrolls back to the quote when reopened; a failed Resume in the campaign index job view shows its error; commitments Reload after a 409 refetches; the create form waits for the owner check of the exact id; the editor rejects condition values that don't match their type.
  - The create form uses the app safe-area inset variable (#5667).
- Tests: `run-editor.mjs`, `run-create-evidence-owner.mjs`, `run-commitment-conflict.mjs` (new), `run-pulse8-scrolled.mjs`, `run-branch-proof.mjs`, `run-knowledge-setting-proof.mjs`; regressions `campaign-memory-authoring-ui`, `campaign-memory-commitments-ui`, `campaign-index-ui`, `mobile-safe-area-inset`.

### Chat fixes (bug hunt)
- Commits: 5e0ad5c4b, 648c75a56, 42180d981.
- Files: `components/chat/ChatMessage.tsx`, `RoleplayCommandResults.tsx`, `MessageEditTextarea.tsx`, `ConversationMessageBubble.tsx`, `ConversationMessageLine.tsx`, `ConversationMessageGrouped.tsx`, `ConversationPresenceCard.tsx`, `ChatInput.tsx`, `ConversationInput.tsx`, `ChatRoleplaySurface.tsx`, `ChatMessageSearch.tsx`, `ChatBranchSelector.tsx`, `HomeBrowserHub.tsx`, `RecentChats.tsx`.
- Behaviour:
  - Touch: a tap on a hidden message action row only reveals it; it no longer presses the button underneath (Regenerate, Delete).
  - Markdown tables in roleplay no longer raise React key warnings.
  - The message editor carries `data-chat-message-editor` again, restoring mobile scroll-into-view, bottom spacing while editing and the unsaved-edit check in visual novel history; Save and Cancel scroll into view inside the chat scroller.
  - Conversation edit box uses the full message width; the unrendered EditTextarea was removed.
  - Send button labelled by its action; attachment remove buttons labelled, 38px, focus rings; conversation image attachments show a thumbnail.
  - The transcript stays pinned to the latest message as the composer grows.
  - Phones: search closes after jumping to a result; branch panel buttons 38px; missing avatars use AvatarImage everywhere.
  - Home: recent chat cards open their chat (the feed module made only buttons and links clickable, so the card-wide "Open Chats tab" button caught the clicks); mode buttons stack icon over label below 640px.
- Tests: regressions `open-issues` (editor controls assertion moved to the live editor), `assigned-issues-5474-5502`, `mari-polish`.

### Characters and personas
- Commits: db3d3ad8b, 889b5cb94, f9c274005, 00ea14412, a625e235e (restores a later accidental revert).
- Files: `components/characters/AvatarImage.tsx` (new), `CharacterEditor.tsx`, `CardLibraryPreview.tsx`, `CharacterLibraryView.tsx`, `components/personas/PersonaEditor.tsx`, `components/panels/PersonasPanel.tsx`, `components/bot-browser/BotBrowserView.tsx`, `components/modals/ImportCharacterModal.tsx`.
- Behaviour:
  - Saving with an empty character name stops with a clear message.
  - Bot browser tags on phones are an overlay drawer (backdrop and Escape close it).
  - Library header shows "100+" while more pages exist.
  - AvatarImage falls back to a placeholder when an avatar file is missing.
  - Cropped avatars render in the library; Set as avatar from the gallery clears the previous crop; depth prompt depth clamps to 0 to 100; tags that differ only in case are one tag.
  - Performance on large characters (memoized sections and greeting rows, off-screen rows skip layout, deferred library filtering): greeting typing about 127 to 50 ms per key, editor scroll 11 to 13 fps to 36 to 41 fps, library search up to 200 to about 33 ms per key (dev build).
  - Clip labels localized.
  - Personas panel shows an error with Retry when loading fails instead of "No personas yet".
  - Import: closing the "Embedded lorebook found" prompt cancels with a toast; choices read Import with lorebook, Import without, Cancel.
- Tests: regressions `assigned-issue-sweep`, `avatar-crop-contract`, `persona-client-contract`, `character-library-token-estimate`, `janny-character-import`.

### Lorebook and preset editors
- Commits: 7d8c56b2c, c176bebf6.
- Files: `components/lorebooks/LorebookEditor.tsx`, `LorebookEntryRow.tsx`, `LorebookFormFields.tsx`, `components/presets/PresetEditor.tsx`, `components/agents/AgentEditor.tsx`, `components/panels/AgentsPanel.tsx`, `components/panels/PresetsPanel.tsx`.
- Behaviour:
  - Move and Copy entries start on "Choose a lorebook" and the confirm names the target (it used to preselect the first lorebook alphabetically).
  - Entry rows: order box widens with its value and shows the saved value; aligned columns; Duplicate and Delete visible on keyboard focus; filter modes, matching sources, triggers, logic chips, vector status and empty states localized; header shows the category display name; sort options localized.
  - Phones: Duplicate and Delete move into the row menu; toolbar lays out as search plus a 2x2 grid.
  - Labels on keyword and tag remove, back and close buttons; preset overview card spacing; preset section buttons labelled with state; agents and presets folder-delete dialogs localized; agent editor save button labelled on mobile.
- Tests: regressions `lorebook-entry-status`, `prompt-token-counters`, `assigned-issue-sweep`.

### Lorebook editor performance
- Commit: e5679fc90.
- Files: `components/lorebooks/LorebookEditor.tsx`, `LorebookEntryListItem.tsx` (new); regression `scripts/regressions/lorebook-editor-memo-rows.regression.ts` (new).
- Behaviour: entry rows render through a memoized wrapper with one shared handlers object (current state read through a ref refreshed after render; drag-over and drop rules, shift-click range selection, stale-only filter and activation stats unchanged). Search filtering and the grouped or flat switch use a deferred value. 400 entries, dev build: search keystroke to paint 440 to 686 ms down to 48 to 58 ms; clear search about 1100 ms down to 33 to 129 ms; expand 480 to 700 ms down to about 120 ms. Sort change unchanged (about 1.2 s).
- Tests: regression `lorebook-editor-memo-rows`; browser checks of autosave, search, sort, drag at root and in a folder, range select with copy and move, menus on screen at 1280 and 390.

### Shell: dialogs, connections, settings, onboarding, focus
- Commits: 4e999d129, 0333d2ad0.
- Files: `components/ui/Modal.tsx`, `ContextMenu.tsx`, `HelpTooltip.tsx`, `EmojiPicker.tsx`, `GifPicker.tsx`, `StatIconPicker.tsx`, `ExpandedTextarea.tsx`, `AppDialogRenderer.tsx`, `ExportFormatDialog.tsx`, `ImageUploadDropzone.tsx`, `ColorPicker.tsx`, `AvatarCropWidget.tsx`, `DraftTextarea.tsx`, `DraftNumberInput.tsx`, `PanelStates.tsx` (new), `hooks/use-dialog-focus-scope.ts`, `components/layout/AppShell.tsx`, `RightPanel.tsx`, `ChatSidebar.tsx`, `use-panel-keyboard-focus.ts` (new), `components/connections/ConnectionEditor.tsx`, `components/panels/ConnectionsPanel.tsx`, `SettingsPanel.tsx`, `settings/*`, `components/modals/*`, `components/onboarding/OnboardingTutorial.tsx`, `App.tsx`, `styles/globals.css`.
- Behaviour:
  - Only the topmost dialog traps Tab; Escape during IME composition doesn't close a dialog; menus and pickers render above dialogs; pinned help tooltips close on scroll; the avatar preview is its own labelled overlay.
  - Connection editor keeps unsaved edits across background refetches and saves before switching; saving no longer reclaims the Agents default; image quality Extra high and Max round-trip; clearing Seed, Steps or Max tokens clears instead of saving 0; Create has no double submit; Import has no ghost rows or overlapping drops; load failures show Retry.
  - Settings: chat list background select uses real options; backup delete asks first; labels for language selects; rows stack in the narrow panel.
  - Opening a side panel moves focus into it; Escape closes it (unless a field has text or a menu or dialog is open) and returns focus to the toggle.
  - PanelStates: shared loading skeleton and error with Retry; the chat list shows its retry state after two failures.
  - Onboarding on phones: the tour card is opaque.
- Tests: regressions `setup-escape-overlay-guard`, `backup-download-handoff`, `extension-security`, `update-apply-hardening`, `frozen-server-client-timeouts`, `music-dj-and-floating-ui`, `mobile-safe-area-inset`, `avatar-crop-contract`.

### Settings localization and keyboard-reachable imports
- Commit: 68018a4df.
- Files: `components/panels/SettingsPanel.tsx`, `settings/TTSConfigCard.tsx`, `settings/PromptOverridesEditor.tsx`, `settings/SettingControls.tsx`, `settings/TrackerCardColorSettings.tsx`, `components/layout/ChatSidebar.tsx`, `components/modals/STBulkImportModal.tsx`, `components/ui/TrackerCardColorControls.tsx`, `localization/locales/en.json`.
- Behaviour: settings option lists, help, toasts, update and build labels, tracker order labels (previously passed to t() as English) and settings search text resolve through en.json; TTS config, prompt overrides (with plurals), setting controls and tracker colour settings localized. Profile import and SillyTavern import controls are real buttons that open the file picker, reachable by keyboard.
- Tests: `localization:ui-check`, `scripts/check-locales.mjs`.

### Em dash cleanup in UI copy
- Commit: 68018a4df.
- Files: `localization/locales/en.json` (115 values), plus six hard-coded em dashes in `ChatSidebar.tsx`, `STBulkImportModal.tsx`, `TrackerCardColorControls.tsx`, `TTSConfigCard.tsx`.
- Behaviour: every en.json value that contained an em dash is rewritten with commas, colons, periods, parentheses or "to"; interpolation variables kept; model suffixes read "Name (model)". No keys renamed or removed.
- Tests: `scripts/check-locales.mjs`.

### Accent animation performance
- Commit: c125258c0.
- Files: `App.tsx`.
- Behaviour: each live accent tick (every 500 ms) rewrites root CSS variables, which restyles every element. Above 6000 DOM elements the tick now holds the current accent instead of restyling. Measured before the fix: a 190-entry lorebook (about 16k elements) idled at about 1.5 frames per second; with the writes blocked, 66 frames in 2 s.
- Settings and defaults: `ACCENT_ANIMATION_MAX_ELEMENTS = 6000` (constant, not user-facing). Accent animation settings unchanged.
- Tests: manual measurement only.

Paths are relative to the repository root; `server/` means `packages/server/src/`. Every commit named here is on main. Regression files live in `scripts/regressions/` and run through `node scripts/run-regressions.mjs --filter <name>`.

### Launcher backs up untracked source files before `git clean`
- **Commit(s):** 962e36777
- **Files:** `scripts/preserve-untracked-src.mjs` (new), `start.bat`, `start.sh`, `start-termux.sh`
- **Behaviour:** all three launchers run `git clean -fd -- packages/shared/src packages/server/src packages/client/src` to remove leftovers of failed checkouts. On a development checkout that also deleted source files that had never been committed. Each launcher now runs `node scripts/preserve-untracked-src.mjs` first. The script lists untracked, non-ignored files in those three trees (`git ls-files --others --exclude-standard -z`) and copies each one to `.tmp/untracked-src-backups/<ISO timestamp>/<same relative path>`, printing `[..] Backed up N untracked source file(s) to <dir> before cleanup.` Any failure prints a `[WARN]` line and exits 0, so a backup problem never blocks startup. The clean itself is unchanged.
- **Settings / env and defaults:** none. Backups are never pruned automatically.
- **Tests:** none.

### World Maps spatial context kept out of the cached prompt prefix on non-subscription providers
- **Commit(s):** 0d9ba9004; fixture rename a478a8b5f
- **Files:** `server/services/generation/prompt-cache-layout.ts`, `scripts/regressions/prompt-cache-layout.regression.ts`
- **Behaviour:** on providers without the subscription cache layout, the location-dependent `<spatial_context>` block (and any other app-owned runtime system block) sat directly after the system prompt, so every move between locations rewrote the whole history behind it and broke prefix caching. `keepGameDialogueAdjacent` now first runs `moveLeadingRuntimeSystemContextToCurrentTurn`: leading system messages with `contextKind: "injection"` and `providerMetadata.marinaraRuntimeContext` or `marinaraDynamicLoreContext` set move to just before the current user turn, the position the subscription layout already used. User-authored prompt sections keep their place. Nothing moves when the only non-system message is the current turn. a478a8b5f replaced the regression fixture names with invented ones; no behaviour change.
- **Settings / env and defaults:** none in these commits. (On current main the reordering is gated by the later `cacheFriendlyPromptLayout` feature switch, default on.)
- **Tests:** `prompt-cache-layout.regression.ts` (extended).

### Startup inject gate
- **Commit(s):** 5209aa6d4
- **Files:** `server/app.ts`, `server/lib/fastify-inject-gate.ts` (new), `scripts/regressions/startup-inject-gate.regression.ts` (new)
- **Behaviour:** Fastify boots the whole instance on the first `app.inject()`. Capability package activation registers routes for minutes at startup, and background work started in that window (continuity workers, package timers calling internal routes) could call `inject()`, freeze registration half way and make later packages fail with "Root plugin has already booted"; the scheduler's `addHook` then threw "already listening" and killed startup. `buildApp` now wraps `app.inject` with `holdInjectUntilRegistered(app)` right after creating the instance and releases it at the end of `buildApp`. Held calls (promise or callback form) run once registration ends. A call still held after 60 s logs a warning with the caller's stack. (The logging pass later renamed these lines to `startup.inject_held` / `startup.inject_released`.)
- **Settings / env and defaults:** none (warning delay 60 000 ms, internal parameter).
- **Tests:** `startup-inject-gate.regression.ts`.

### Capability packages: host-lifecycle failures no longer roll back or persist "error"
- **Commit(s):** 2489691ae; one-time data repair `review-2026-09-22/restore-capability-packages_v1.0.mjs` (outside the repo, run in a deploy window with the engine stopped)
- **Files:** `server/services/capability-packages/capability-module-runtime.service.ts`, `scripts/regressions/startup-inject-gate.regression.ts`
- **Behaviour:** the startup race above made three healthy packages (hierarchical-maps, conversation-calls, long-term-memory) fail activation. The runtime then rolled each back one version and persisted status `error`, so every later boot skipped them. New `isHostLifecycleActivationError` recognises errors from the host's own Fastify lifecycle (codes `FST_ERR_INSTANCE_ALREADY_LISTENING`, `AVV_ERR_ROOT_PLG_BOOTED`, or the messages "Root plugin has already booted" / "Fastify instance is already listening"). For those, activation cleans up, logs a warning that the package will be retried on the next start, and leaves the installed version and status untouched: no rollback, no persisted error. The restore script repaired the registry already damaged by the race: it backs up `data/capability-packages/installed.json` to `installed.json.before-race-restore-<time>`, then puts each of the three packages back on its pre-race version (1.4.29, 1.0.17, 1.3.10) with `status: "active"`, `readiness: "pending"`, `error: null`, keeping the rolled-back version as `previousVersion`. It skips a package that is not installed or whose stored manifest does not match.
- **Settings / env and defaults:** none.
- **Tests:** `startup-inject-gate.regression.ts` (extended with the no-rollback case).

### Lorebook scan compaction
- **Commit(s):** ec5e6cd79 (server); one-time data compaction `review-2026-09-22/compact-lorebook-scans_v1.0.mjs` (outside the repo, run during deploy 5 with the engine stopped)
- **Files:** `server/services/lorebook/lorebook-scan-compaction.ts` (new), `server/services/storage/chats.storage.ts`, `server/routes/lorebooks.routes.ts`, `server/routes/generate/retry-agents-route.ts`, `scripts/regressions/lorebook-scan-compaction.regression.ts` (new)
- **Behaviour:** every generated message stored `extra.lorebookScan` with the full resolved text of every activated entry, on the message row and again on every swipe. In one long game chat that was 184 MB of a 192 MB message shard, and because loaded chats stay resident it pushed the server towards its heap limit. Only the newest generated message's scan is ever read with text (Active Context, agent retries), so:
  - Swipe writes (`updateMessageExtra`, `updateMessageExtraForSwipe`, the roleplay interruption swipe patch) store a compact scan: `activatedEntries` keep ids, names, keys, match type and scores but no `content`, and the scan gets `contentStripped: true`.
  - After a scan with text is saved on a message (`updateMessageExtra`, `updateMessageExtraForSwipe`, `commitRoleplayInterruption`), `compactStaleLorebookScans` strips the text from every other message row and every swipe in that chat. It takes one message queue at a time (never nested), pre-filters serialized extras cheaply, and only logs on failure (a scan that keeps its text is harmless and is compacted on the next generation).
  - Readers fall back to stored entry text: the Active Context route merges text from the message row's scan and treats `content` as optional; agent retries load missing entry text from the lorebooks store by id.
  - The one-time script applied the same rule to existing data (newest message row with a full scan per chat keeps it; everything else compacted), dry run by default, `--apply` refuses while port 7860 answers, backs up both tables to `data/backups/lorebook-scan-compaction-<time>/`, and rewrites each changed shard through a temp file and rename. Result: message and swipe shards 1502 MB to 213 MB; boot private memory about 4.1 GB to about 1.3 GB. The store's `.bak` copies of each shard still hold the old large content until that shard's next write refreshes them.
- **Settings / env and defaults:** none in this commit. The script reads `MARINARA_DATA_DIR` and `MARINARA_ENGINE_PORT` (default 7860) and needs `--max-old-space-size=8192`. (On current main compaction is wrapped by a later feature switch; not part of this session.)
- **Tests:** `lorebook-scan-compaction.regression.ts`.

### 2026-09-22 whole-fork bug-hunt merge (39 files)
- **Commit(s):** 660d992fa (fixes from bughunt branch 7380e6a8d that had been applied to the working tree but never committed; six further files had already landed with other commits; the deferred game.routes.ts, GameSurface.tsx, GameWidgetPanel.tsx, game-gm-prompt-runtime.ts and generation-lifecycle.regression.ts fixes were left to another session)
- **Files:** client: `components/characters/CharacterReferences.tsx`, `components/chat/ChatNotificationBubbles.tsx`, `components/game/GameCharacterSheet.tsx`, `GameCombatUI.tsx`, `GamePartyBar.tsx`, `TacticalCombatUI.tsx`, `game-asset-generation-payload.ts`, `game-inventory-identity.ts`, `components/ui/GenerationParametersEditor.tsx`, `SpriteGenerationModal.tsx`, `hooks/use-generate.ts`, `lib/game-npc-character-sync-policy.ts`, `lib/generation-token-usage.ts`. Server: `routes/generate.routes.ts`, `routes/sprites.routes.ts`, `routes/tts.routes.ts`, `services/capability-packages/automatic-legacy-game-map-migration.ts`, `services/game/game-asset-generation.ts`, `game-contact-book.ts`, `game-isolated-turn.ts`, `game-keeper-lorebook.ts`, `npc-avatar-utils.ts`, `npc-character-sync.ts`, `scene-timeline.service.ts`, `services/generation/connection-admission.ts`, `generation-jobs.ts`, `services/professor-mari/workspace-agent.service.ts`, `workspace-shell-sandbox.ts`, `services/spatial-context/narration-reconciliation.ts`, `services/storage/game-storyboards.storage.ts`, `inventory-item-identity.ts`.
- **Behaviour:**
  - Generation route: adjacent-message merging no longer merges an assistant message that carries `providerMetadata`; the cache send guard always fingerprints the narrator request (so planner turns record a baseline) and only skips the hold check once tool-planner work has begun, with the planner condition computed once (`toolPlannerWillRun`); character-tracker automatic NPC avatar generation is restored for non-game chat modes (game mode still leaves portraits to the queued `/game/generate-assets` pipeline), writing to `NPC_AVATAR_DIR/<chatId>/<slug>.png` and re-persisting through the tracker field locks.
  - Generation jobs store: bounded disk retention. A throttled prune (at most every 10 min, after finished jobs, and once at startup) keeps metadata of the newest 200 terminal jobs and result files of the newest 50, never touches running or in-memory jobs or anything updated in the last 24 h, and removes stray `.tmp` files and orphaned result files older than 10 min.
  - Media and cancellation: TTS game audio (ElevenLabs) now passes the job's abort signal to the provider request (combined with its timeout); game asset generation rethrows when its request was aborted instead of continuing; sprite routes return 504 for a job timeout that surfaces as the generation-jobs `AbortError` or `ME_TIMEOUT`, not only the legacy timeout class.
  - Connection admission: group membership only lets batch members share a connection; quarantine, foreground priority and the post-foreground cooldown now apply to every background caller.
  - Game services: legacy map migration keeps the user's `enableAgents` switch and only switches the start mode to hierarchical when agents are on; the contact book scopes library cards to the campaign (cast, party, linked NPCs) with the rest of the library only as a fallback, and memoises relationship ordering; isolated-turn quoting no longer backslash-escapes (the client only strips the outer quotes); the Keeper lorebook adopts an existing book with its deterministic id instead of inserting a duplicate key; NPC avatar ignore checks pass the known NPC names; NPC character sync treats a tracker "ID or name" only as a lookup hint and no longer truncates appearance and creative additions to 4000 characters; scene timeline throws when a review or timeline write finds no swipe or makes no progress, instead of looping; narration reconciliation only matches places inside the chosen parent path; storyboards gain `remove(id)` (deletes keyframes first); inventory identity reserves explicit item ids before name matching.
  - Professor Mari workspace: directory listing counts and truncation use only entries inside the workspace; the shell sandbox judges a dangling or looping link by its lexical path instead of throwing.
  - Client: character reference click works when the reference itself is a button; notification bubbles are real `<button>`s; the party bar portrait opens the character sheet directly (also the initial-letter fallback); tactical combat and selectable combat sprites no longer open the photo lightbox; the character sheet keeps an empty attribute list empty; NPC asset payloads fall back to name keys and honour name-keyed failure sets; inventory name matching picks the first row only when no match has an item id, and merges id-less rows into the same-name row; Generation Parameters shows the post-processing select (apply / none / single user message) and an optional custom headers editor; sprite reference images over the connection's limit stay in state (dimmed) instead of being dropped; a cache-guard resend keeps the turn's regenerate/continue/target parameters and drops only the one-shot user-turn fields; an unreachable server (status 0) counts as offline for NPC sync; token usage treats the Anthropic API provider like the Claude subscription (separate uncached input, missing cache fields count as 0).
- **Settings / env and defaults:** none. Job retention constants: 200 jobs, 50 results, 24 h minimum age, 10 min stray age, 10 min prune interval.
- **Tests:** `automatic-legacy-game-map-migration.regression.ts`, `cache-send-guard-route.regression.ts`, `game-contact-book.regression.ts`, `game-inventory-identity.regression.ts`, `generation-token-usage.regression.ts`, `inventory-item-identity.regression.ts`, `narration-location.regression.ts`, `open-issues.regression.ts` (all extended or updated).

### Server-hunt fixes (2026-09-23 review of the non-game server): overview
- **Commit(s):** be4c94289 (chunk 1: batches 0, 3, 4, 6, 7, 9, 11, 13, 14, 17, 24, 27), cc144f9c9 (chunk 2: batches 2, 5, 8, 20, 21, 22, 25, 26, 28 to 38, 41 to 43, 45 to 48, 50 to 56), 2b2ca2f29 (second-review follow-ups for batches 3, 6, 27), 3354c1c89 (the 13 parked batches 1, 10, 12, 15, 16, 18, 19, 23, 39, 40, 44, 49, 57, re-applied onto current main with every problem the first review found fixed and an adversarial re-review passed). Some chunk 2 batches had hunks in files only 3354c1c89 touched (`chats.storage.ts`, `generate.routes.ts`, `import.routes.ts`, `auto-summary.service.ts`, `sidecar-speech.service.ts`, `sidecar-download.ts`); those hunks landed with 3354c1c89 and are noted per batch.
- **Behaviour:** 58 batches, one per file group; each finding was verified by an independent reviewer before fixing, and each fix passed a second review. Batches whose findings were all skipped: none. Single skipped finding: batch 0, `.env` hot reload overriding launcher-provided variables (a product decision about launcher env versus `.env` edits, left for a maintainer).
- **Settings / env and defaults:** none unless stated per batch.
- **Tests:** one `server-hunt-b<N>.regression.ts` per batch (batch 3 is `server-hunt-b3.slow-regression.ts`).

### Server-hunt batch 0: `.env` reload reports only real changes
- **Commit(s):** be4c94289
- **Files:** `server/config/runtime-config.ts`
- **Behaviour:** saved request timeouts (`.env.timeouts.json`) made every `.env` reload report those keys as changed and raise a false restart-required warning. `reloadRuntimeEnv` now applies `.env` values, removals, `applySavedRequestTimeouts()` and TZ normalisation first, then classifies each key as added, updated or unchanged by comparing its value before the reload with its final value. Added and removed keys report as before; a launcher value that differs from `.env` still reports as updated so the LOG_LEVEL and ENABLE_EXTERNAL_EXTENSIONS handling stays in step. The skipped finding (launcher env versus `.env` on reload) is unchanged.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b0.regression.ts` (existing `env-watcher.regression.ts` still passes).

### Server-hunt batch 1: storage pre-shard restore, Windows writer lease, joined selects, backgrounds seed
- **Commit(s):** 3354c1c89
- **Files:** `server/db/file-backed-store.ts`, `server/db/seed-backgrounds.ts`, `server/lib/log-events.ts`
- **Behaviour:**
  - Pre-shard auto-restore: `migrateShardedTables` restores the `.pre-shard` backup only when the shard directory itself is missing. An empty directory is what a deliberately emptied table leaves (saveShardedTable unlinks files, never the directory), so a crash before the manifest rewrite no longer revives deleted rows; that case logs `storage.migrate` warn `reason: "shard-dir-empty"` and asks for a manual restore. The restored-profile case (#4845) still recovers.
  - Windows writer lease: Windows boot ids are LastBootUpTime timestamps that move with every clock step, so a live writer's lease could be reclaimed as "from an earlier boot". New `writerLeaseFromEarlierBoot` compares timestamp-shaped boot ids as times: the lease is from an earlier boot only when the current boot started more than 5 min after the lease's `acquiredAt`; opaque ids (Linux boot_id) still compare exactly. A shifted id falls through to the same-host PID proofs. (The first attempt, disabling the boot shortcut on win32, was rejected because it could refuse to start after a real reboot.)
  - Joined selects: `SelectQuery.run` pre-filters base rows with the top-level AND conjuncts that read only base-table columns (skipped for self-joins; full WHERE still runs) and hash-joins `eq(column, column)` joins, keeping row order and re-checking every pair. Results are identical; two 3000x3000 joins went from 14 s to about 40 ms.
  - Backgrounds seed: an unreadable or non-object `meta.json` (including JSON `null`, which used to throw) is renamed to `meta.json.corrupt-<ts>` (event `storage.json_corrupt`) and rebuilt; if the rename fails nothing is written. `meta.json` is written only when new, rebuilt or changed, atomically (temp file and rename).
- **Settings / env and defaults:** none (boot-id slack 5 min, constant).
- **Tests:** `server-hunt-b1.regression.ts`.

### Server-hunt batch 2: deleted built-in regex scripts stay deleted
- **Commit(s):** cc144f9c9
- **Files:** `server/db/seed-regex.ts`, `server/routes/admin.routes.ts`
- **Behaviour:** `seedDefaultRegexScripts` re-inserted any missing built-in regex script, enabled, on every start. It now keeps the app setting `regexDefaultsSeeded` (exported `REGEX_DEFAULTS_SEEDED_KEY`, a JSON array of default ids already seeded) and inserts a default only when it is missing from both the table and that list. Migration: when the key is absent and the table already has rows, every current default counts as seeded. A fresh install still gets the defaults. Expunge marker: the admin expunge that deletes regex scripts also deletes the `regexDefaultsSeeded` row (`regex_defaults_marker` step), so built-ins return on the next start as on a fresh install.
- **Settings / env and defaults:** new app setting key `regexDefaultsSeeded` (no UI).
- **Tests:** `server-hunt-b2.regression.ts`.

### Server-hunt batch 3: fatal errors flush the store before exiting
- **Commit(s):** be4c94289; 2b2ca2f29 (test made opt-in slow)
- **Files:** `server/index.ts`
- **Behaviour:** `uncaughtException` and `unhandledRejection` exited without flushing the file store's debounced writes. Both now go through one `fatalExit`: log, stamp the `crash` exit kind, reap the sidecar, set the shared `isShuttingDown` guard, `armShutdownDeadline(app, "crash", { exitCode: 1 })` (connections severed at 4 s, forced exit(1) at 8 s), stop the env watcher, memory monitor and freeze detector, then `app.close()` (which flushes the store) and `process.exit(1)`. A second fatal error, or one during a signal shutdown, returns instead of cutting the running close short. (The robustness pass later made sure a crash always keeps its nonzero exit code.)
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b3.slow-regression.ts` (boots the server twice, about 50 s, past the runner's 30 s limit, so it is run directly and not by the suite).

### Server-hunt batch 4: IP allowlist CIDR and IPv6, per-route rate limits
- **Commit(s):** be4c94289
- **Files:** `server/middleware/ip-allowlist.ts`, `server/middleware/rate-limit.ts`
- **Behaviour:** an IPv4 CIDR with a prefix over 32 was accepted unshifted and matched almost every client; `parseCIDR` now returns null for it (logged as invalid; the allowlist fails closed if nothing valid is left). `isLocalInferenceBaseUrl` treated every IPv6 literal as local; IPv6 hosts are now judged by `isNonRoutableNetworkIp` (::1, ULA and link-local still local). Per-route `config.rateLimit` (Beholder, sprite rename, utility sidecar) was never read; `rateLimitHook` now uses it when no `ROUTE_RULES` pattern matches, keyed `route:<method>:<url>`.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b4.regression.ts`.

### Server-hunt batch 5: admin and agent route bodies, agent image cleanup
- **Commit(s):** cc144f9c9
- **Files:** `server/routes/admin.routes.ts`, `server/routes/agents.routes.ts`
- **Behaviour:** `/expunge` and `/clear-all` with no body now return the intended 400 instead of a 500 TypeError. Agent image upload returns 400 for a missing, null or non-string image. Replacing an agent image now deletes the previous file, and deleting an agent deletes its image, through `removeAgentImageIfUnreferenced` (only `/api/agents/images/file/` paths, resolved through `getSafeAgentImagePath`, deleted only when no agent row, including soft-deleted built-ins and duplicates, still references it). Called on image upload (old image, or the new file if the update fails), `DELETE /:id` (hard removals only), `PATCH /:id` and `PATCH /type/:agentType` when `imagePath` changes.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b5.regression.ts`.

### Server-hunt batch 6: background uploads, renames and meta.json
- **Commit(s):** be4c94289; 2b2ca2f29
- **Files:** `server/routes/backgrounds.routes.ts`
- **Behaviour:** a non-ASCII filename sanitised to a hidden, unlisted file; the stem is now sanitised on its own, leading dots stripped, fallback `background`, and a rename to `...` returns 400. Parallel uploads with the same name overwrote each other; the name is chosen after the body is read and written with flag `wx`, retrying on EEXIST up to 50 times. `writeMeta` is atomic (temp file and rename). `uniqueFilename` also treats a same-stem file with another allowed extension as taken (the asset manifest tags by stem), ignoring the file being renamed. Follow-up (2b2ca2f29): a rename whose suffix search lands back on the file's own name (renaming `forest_2.jpg` to "forest" while `forest.png` exists) returns early instead of deleting the file's tags.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b6.regression.ts` (tag-survival check added in 2b2ca2f29).

### Server-hunt batch 7: compatible export names, full backup size, package uninstall
- **Commit(s):** be4c94289
- **Files:** `server/routes/backup.routes.ts`, `server/routes/capability-packages.routes.ts`
- **Behaviour:** the compatible profile export silently dropped characters, personas and lorebooks whose names collided; entry names now get ` (2)`, ` (3)` suffixes (case-insensitive). Full and automatic backups failed once the zip central directory passed 8 MiB; uncapped archives now allow 256 MiB (`FULL_BACKUP_CENTRAL_DIRECTORY_LIMIT_BYTES`) and the profile zip reader accepts the same, so such backups can be imported. Package uninstall cleaned chat metadata from a stale snapshot, overwriting concurrent agent changes; it now passes `patchMetadata` an updater that recomputes the cleanup patch from the metadata read inside the per-chat queue.
- **Settings / env and defaults:** none (central directory limits 256 MiB uncapped, 8 MiB capped).
- **Tests:** `server-hunt-b7.regression.ts`.

### Server-hunt batch 8: character routes
- **Commit(s):** cc144f9c9
- **Files:** `server/routes/characters.routes.ts`
- **Behaviour:** the fallback PNG for avatar-less card export had invalid zlib IDAT data; it now uses a valid stream. Embedded-lorebook import wrote back a stale copy of all extensions outside the per-character queue; it now runs in `enqueueUpdate`, re-reads the row and patches only `extensions.importMetadata.embeddedLorebook`. Deleting a character or persona now removes its gallery videos (`removeGalleryVideoDir`, under the manifest lock). The gallery video manifest read-modify-write is serialised (`withGalleryVideoManifestLock`) and written atomically. Gallery image uploads unlink the partial file on pipeline failure, return 413 on multipart truncation, and the character route rolls back a failed row create like the persona route. `injectTextChunk` no longer throws RangeError on trailing bytes or a truncated chunk; a failed injection re-encodes the avatar through sharp, then falls back to the minimal PNG, instead of a 500. `PATCH /groups/:id` and `/persona-groups/:id` return 404 for unknown ids instead of 200 with a null body.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b8.regression.ts`.

### Server-hunt batch 9: chat preset duplicate name validation
- **Commit(s):** be4c94289
- **Files:** `server/routes/chat-presets.routes.ts`
- **Behaviour:** the duplicate route stored an unvalidated name. The body is now parsed with `duplicateChatPresetSchema` (`name`: trimmed string, 1 to 120 characters, optional); a bad name gives 400. No body or no name keeps the `<source> Copy` fallback.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b9.regression.ts`.

### Server-hunt batch 10: chat routes (scene pointer, bodies, branches, summaries)
- **Commit(s):** 3354c1c89
- **Files:** `server/routes/chats.routes.ts`
- **Behaviour:** deleting any scene chat wiped the origin chat's active-scene pointer outside the per-chat patch queue; `DELETE /chats/:id` now uses `patchMetadata` and clears `activeSceneChatId` / `sceneBusyCharIds` only when they still name the deleted chat. Missing bodies no longer give 500 in `/:id/connect`, bulk-delete, edit message, bulk-hidden, swipes/bulk and active-swipe; `POST swipes` returns 400 when content is not a string; `PATCH /:id/metadata` returns 400 for a missing, non-object or array body. Branch creation now covers message copy, remap, metadata and folder steps with the existing cleanup, so a failure no longer leaves a half-built branch and a changed source `groupId`. A concurrent edit while combining summaries returns 409 instead of 500. Manual summary backfill passes the chat time zone.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b10.regression.ts`.

### Server-hunt batch 11: connection image cleanup
- **Commit(s):** be4c94289
- **Files:** `server/routes/connections.routes.ts`
- **Behaviour:** connection image uploads never deleted the previous image and deleting a connection left its image. New `removeConnectionImageIfUnreferenced` (safe path, skipped while any connection, including duplicates, still references the file) runs on upload (old image, or the new file if the update fails), on `DELETE /:id` and on `PATCH` when `imagePath` changes.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b11.regression.ts`.

### Server-hunt batch 12: conversation routes write only what they change
- **Commit(s):** 3354c1c89
- **Files:** `server/routes/conversation.routes.ts`, `server/routes/chats.routes.ts`
- **Behaviour:** `/schedule/generate` wrote a stale copy of the whole `extensions` object after a slow LLM call, and the status sync in `/status` and `/autonomous/check` did whole-object read-modify-write; all now patch only their own keys (`conversationStatus`, `conversationSchedule`, `conversationActivity`) and rely on the extensions merge. `/autonomous/exchange` no longer reloads the full transcript on every call (shared once-per-process `ensureAutonomousActivitySeeded`). Presence was recorded before the chat-exists check and recreated state for deleted chats; `/autonomous/check` and `/activity/presence` now 404 first, and chat deletion calls `clearChatActivity` after removal.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b12.regression.ts` (path fixed for the runner's cwd in f81aa3a07).

### Server-hunt batch 13: AVIF dimensions, emoji and sticker import, custom tool rename
- **Commit(s):** be4c94289
- **Files:** `server/utils/image-metadata.ts`, `server/routes/custom-emojis.routes.ts`, `server/routes/custom-stickers.routes.ts`, `server/services/storage/custom-tools.storage.ts`, `packages/client/src/hooks/use-custom-tools.ts`
- **Behaviour:** AVIF emojis and stickers were exported but always skipped on import; new `readAvifDimensions` walks the ISO-BMFF boxes (ftyp avif/avis, meta, iprp, ipco, ispe, largest ispe for grids). A null entry in an import list crashed with 500 after a partial import; it is now skipped. Renaming a custom tool left agents' `enabledTools` pointing at the old name; the rename now rewrites it in one transaction, and the client invalidates agent queries on update.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b13.regression.ts`.

### Server-hunt batch 14: fonts metadata lock, gallery selfie cleanup
- **Commit(s):** be4c94289
- **Files:** `server/routes/fonts.routes.ts`, `server/routes/gallery.routes.ts`
- **Behaviour:** concurrent Google font downloads dropped each other's `font-metadata.json` entries; writes are serialised (`withFontMetadataLock`) and re-read inside the lock. `POST /google/download` with no body returns the 400 "Font family name is required". The selfie job left orphaned shared gallery files and partial rows when a later save step failed; each variant's save is wrapped, an uncommitted file is removed, and the job throws only when no variant saved.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b14.regression.ts`.

### Server-hunt batch 15: generate route and agent retry
- **Commit(s):** 3354c1c89
- **Files:** `server/routes/generate.routes.ts`, `server/routes/generate/retry-agents-route.ts`, `server/services/storage/chats.storage.ts`
- **Behaviour:**
  - The eager game-state snapshot promise had no rejection handler, so a rejection on a turn that never awaited it killed the process; it is now marked handled.
  - Cross-chat awareness paired character ids with names by index; it now keys by each entry's own id.
  - Streamed textual tool-call markup (a local model's `<tool_call>{...}</tool_call>`) was saved with the reply; when a round returns tool calls with empty content after streaming, that round's text is cut and a `content_replace` is sent.
  - Content is written conventionally only when nothing streamed in that round (the `endsWith` check could drop or duplicate text).
  - A continuation that returns only commands or GM verbs anchors to the continued message instead of adding a hidden message; it keeps its prose and flags and records only the new command content (appended), scene request and encrypted reasoning.
  - NPC avatar auto-generation skips an NPC whose name slug is empty (it wrote a shared `<chatId>/.png` after a paid call).
  - Illustrator result fields are type-checked before `.trim()` (array style joined with ", "; also in the retry route); a non-string reason no longer turns success into failure.
  - New `appendSwipeAttachmentAndActiveMirror` writes a swipe attachment and, if that swipe is still active, the message mirror in one critical section, so a swipe switch cannot erase or misplace illustration or roleplay sound attachments; a message with no swipe rows still gets the mirror write.
  - The conversation summary provider now gets the connection's `claudeFastMode`, `treatAsLocalEndpoint` and `defaultParameters`.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b15.regression.ts` (import path fixed in f81aa3a07).

### Server-hunt batch 16: connected conversations, OOC influences, summary aborts
- **Commit(s):** 3354c1c89
- **Files:** `server/routes/generate/connected-conversation-injections.ts`, `server/routes/generate.routes.ts`, `server/routes/generate/conversation-connected-context.ts`, `server/routes/generate/conversation-history-runtime.ts`, `server/services/conversation/auto-summary.service.ts`, `server/lib/log-events.ts`
- **Behaviour:** OOC influences were marked consumed at prompt-build time, before the generation succeeded; the injector now returns `consumedInfluenceIds` and the route marks them only after a message for the turn (or its hidden command anchor) is saved, once, logging failures as `generation.influence_consume`. Failed or stopped turns leave them pending. Each conversation turn loaded the whole connected roleplay or game chat for its last 20 messages; it now uses `listMessagesPaginated(chatId, 20)` when available. Conversation auto-summary calls ignored the request abort; the signal is threaded through to `chatComplete`, checked before each day bucket and call, aborts are never recorded as failures or backoff, and `withTimeout` clears its timer and rejects on abort.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b16.regression.ts`.

### Server-hunt batch 17: dry-run aborts, expression agent entries
- **Commit(s):** be4c94289
- **Files:** `server/routes/generate/dry-run-route.ts`, `server/routes/generate/expression-agent-utils.ts`
- **Behaviour:** dry-run listened for `req.raw` "close", which had already fired, so a disconnect never aborted the provider call; it now listens on `reply.raw` with a completion flag. Regenerate dry-run now drops the target message in every mode. A mid-stream abort reports `aborted` (with partial content) instead of a normal result. `validateSpriteExpressionEntries` skips null or non-object entries with a warning instead of throwing.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b17.regression.ts`.

### Server-hunt batch 18: output-format injection and Lorebook Keeper merge
- **Commit(s):** 3354c1c89
- **Files:** `server/routes/generate/generate-route-utils.ts`, `server/routes/generate/lorebook-keeper-utils.ts`
- **Behaviour:** `injectIntoOutputFormatOrLastUser` used a string replacement, so `$&`, `$'`, `` $` `` and `$$` in names were expanded; it now uses a replacer function. Keeper paragraph dedupe dropped punctuation-only paragraphs (`---`, `***`); they are now kept (the #488 duplicate cleanup still works). The novel-fact check used a substring test, so a fact contained in longer existing text was discarded; it now compares against whole lines (bullets stripped) and sentences (ending punctuation may be followed by a closing quote or bracket), and a multi-sentence fact made only of known sentences counts as known. Whole lines are included so a multi-sentence bullet the Keeper appended matches itself on the next pass (the first attempt re-appended it every pass).
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b18.regression.ts`.

### Server-hunt batch 19: raw route aborts, retry map sync, backfill cursor
- **Commit(s):** 3354c1c89
- **Files:** `server/routes/generate/raw-route.ts`, `server/routes/generate/retry-agents-route.ts`, `server/routes/generate/lorebook-keeper-utils.ts`, `server/routes/chats.routes.ts`
- **Behaviour:** `/raw` never aborted on client disconnect (listener on `req.raw`); it now listens on `reply.raw` behind a completion flag. An explicit `/raw/abort` after partial output is reported as `aborted` (streaming event or `{ aborted: true, content, runId }`). The retry game-map sync wrote back the whole stale metadata blob; it is now a queued `patchMetadata` writing only `gameMap`, `gameMaps`, `activeGameMapId` (and sends `game_map_update` only on change). The custom lorebook backfill cursor never advanced when agent write approval was on; a pending `lorebook_update` proposal carries `payload.backfillCursor`, and committing it advances the cursor, only forward and only onto a message that still exists (`readCustomLorebookBackfillCursorPayload`, `shouldAdvanceCustomLorebookBackfillCursor`).
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b19.regression.ts`.

### Server-hunt batch 20: import routes
- **Commit(s):** cc144f9c9 (regression); code in 3354c1c89
- **Files:** `server/routes/import.routes.ts`
- **Behaviour:** the folder-picker timeout resolved null but left the dialog process running; the 60 s timer now kills the current child (osascript, powershell, zenity or kdialog) and the zenity fallback does not spawn kdialog after the timeout. A corrupt avatar entry in a `.marinara` package returns 400 "Could not read package avatar" instead of 500. `/marinara`, `/st-preset` and `/st-lorebook` return 400 "Expected a JSON object body" for null, primitive or array bodies (`isJsonObjectBody`).
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b20.regression.ts`.

### Server-hunt batch 21: knowledge sources and lorebook export and move
- **Commit(s):** cc144f9c9
- **Files:** `server/routes/knowledge-sources.routes.ts`, `server/routes/lorebooks.routes.ts`
- **Behaviour:** a failed or oversized knowledge-source upload left a partial file (and @fastify/multipart ends a truncated stream rather than failing, so the old route returned 200 with a cut file); failures and truncation now unlink the file, truncation returns 413, and a failed meta write removes the file. A corrupt `meta.json` was treated as empty and then overwritten; writes use a strict read that renames it to `meta.json.corrupt-<ts>` and fails. Bulk lorebook export dropped same-named books; names get ` (n)` suffixes. A failed entry move rolled back the copies after the source entries were already deleted; copies are kept once removal has started and both books' character books are resynced.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b21.regression.ts`.

### Server-hunt batch 22: personal extension storage, sidecar setup streams, Whisper delete
- **Commit(s):** cc144f9c9; `sidecar-speech.service.ts` hunk in 3354c1c89
- **Files:** `server/services/extensions/personal-extension-settings.service.ts`, `server/services/extensions/personal-extension-storage.service.ts`, `server/routes/sidecar.routes.ts`, `server/services/sidecar/sidecar-speech.service.ts`
- **Behaviour:** extension storage PATCH was an unlocked read-modify-write; `patch` and `remove` now run under a per-extension lock. A stale-hash approve returns 409 and an unknown-revision rollback 404 instead of 500. `DELETE /speech/model` now waits for an in-flight load of that same model before deleting. A disconnect on any sidecar setup SSE stream cancelled all sidecar downloads and stopped the sidecar; `handleDownloadSse` now has a single owner, a second setup stream gets 409, and the owner releases the slot on finish or close.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b22.regression.ts` (import path and fake load state fixed in f81aa3a07).

### Server-hunt batch 23: sprite uploads and cleanup
- **Commit(s):** 3354c1c89
- **Files:** `server/routes/sprites.routes.ts`
- **Behaviour:** a sprite upload with a new extension left the old file as a second sprite, and cleanup-saved then overwrote the other file with no backup. Upload now writes inside `withSpriteRenameLock` and, after the write succeeds, deletes other sprite files for the same expression. Uploads whose type is outside `SPRITE_FILE_RE` (bmp, tiff, heic and so on) return 400 before writing, so the working sprite is never deleted for an invisible file. `isSameSpriteFile` compares `ino` and `dev` as bigints (NTFS 64-bit ids lose precision as Numbers), falling back to realpath. cleanup-saved refuses ("Another file for this expression already exists") instead of overwriting a different file, and only unlinks the original when it is not the same file. Sheet background cleanup skips the per-cell pass when the whole sheet was already cleaned by the AI remover. Every sprite POST handler defaults a missing body, so validation returns 400 instead of 500.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b23.regression.ts`.

### Server-hunt batch 24: translate, utility sidecar model ids
- **Commit(s):** be4c94289
- **Files:** `server/routes/translate.routes.ts`, `server/routes/utility-sidecar.routes.ts`, `server/services/utility-sidecar/utility-sidecar.service.ts`
- **Behaviour:** Google translate put up to 5000 characters in a GET query string; `q` is now a form-encoded POST body. A non-JSON 200 from DeepLX, DeepL or Google gave an opaque 500; `parseProviderJson` throws a 502 "<provider> returned a non-JSON response". Model ids equal to `Object.prototype` member names counted as installed; `__proto__`, `constructor`, `prototype`, `.` and `..` are rejected and installed models are looked up with `Object.hasOwn`.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b24.regression.ts`.

### Server-hunt batch 25: advanced memory import and performance
- **Commit(s):** cc144f9c9
- **Files:** `server/services/advanced-memory.ts`
- **Behaviour:** `importMemory` reused the scene id for scaffold records and hit a primary-key violation, leaving a half-finished import; same-id and existing scaffold rows (including hidden summaryWork rows) now resolve to the local record. `put()` reloaded the whole chat on every record write (O(n^2) preparation); it reuses a validated snapshot per scene, cleared around paid summarize calls. The temporary-prefix search is a binary search (same result). `status()` validation uses a per-context index instead of a full-chat scan per record.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b25.regression.ts`.

### Server-hunt batch 26: agent executor
- **Commit(s):** cc144f9c9
- **Files:** `server/services/agents/agent-executor.ts`
- **Behaviour:** the custom music folder was walked recursively with sync fs on every Music DJ turn; the walk stops at depth 8 and 2000 directories and results are cached per folder for 60 s (at most 32 folders). CYOA anti-repetition and haptic device/settings blocks were injected into every agent's prompt; they now require the `cyoa` or `haptic` agent. Stored `cyoaChoices` are validated (null elements no longer throw). `extractJson` no longer cuts at a ``` inside a JSON string of an unfenced response.
- **Settings / env and defaults:** none (music cache 60 s, depth 8, 2000 dirs, 32 folders).
- **Tests:** `server-hunt-b26.regression.ts`.

### Server-hunt batch 27: Beholder state
- **Commit(s):** be4c94289; 2b2ca2f29
- **Files:** `server/services/agents/beholder-state.ts`
- **Behaviour:** a `__proto__` (or `constructor`, `prototype`) key in Beholder lane or repair deltas could pollute prototypes; unsafe keys are skipped and accumulators are read with `Object.hasOwn`. The worn-item merge appended past the 12-item cap and normalisation then dropped the new garment; bounding now keeps touched items and evicts the oldest untouched ones (the same for characters at the character cap). Follow-up (2b2ca2f29): garments coming off a slot are removed before the cap is applied, so a swap on a full slot no longer evicts another garment.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b27.regression.ts` (swap case added in 2b2ca2f29).

### Server-hunt batch 28: capability package runtime and registry
- **Commit(s):** cc144f9c9
- **Files:** `server/services/capability-packages/capability-module-runtime.service.ts`, `server/services/capability-packages/package-manager.service.ts`
- **Behaviour:** install reported "restored X" even when the rollback activation also failed; it now throws "Could not activate id@new, and rolling back to old also failed". Runtime snapshot directories were never swept after an unclean exit; `start()` removes `DATA_DIR/capability-runtime-snapshots` first. Legacy availability migration aborted permanently on an entry this Engine cannot install; it skips entries already at or above the catalog version and, with a warning, incompatible ones (network and checksum errors still retry next start). `installed.json` read-modify-write is serialised (`withRegistryLock`) and temp names use `randomUUID()`.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b28.regression.ts`.

### Server-hunt batch 29: conversation summary timeout, awareness, schedules
- **Commit(s):** cc144f9c9; `auto-summary.service.ts` hunk in 3354c1c89
- **Files:** `server/services/conversation/auto-summary.service.ts`, `awareness.service.ts`, `schedule.service.ts`, `intent.service.ts`
- **Behaviour:** the summary timeout never aborted the LLM request; `summarizeTranscript` now owns an AbortController (caller aborts forwarded) and aborts it on timeout, still reporting "Summary timeout". Cross-chat awareness loaded every sibling message and every sibling chat; messages are filtered by `createdAt >=` the earliest window start minus 60 s in the query, and siblings whose `lastMessageAt` is older than the window are skipped. `resolveIntent` tolerates stored schedule blocks without an activity. The lenient `parseScheduleResponse` normalisation from this batch was superseded by the upstream staging merge (strict schedule parsing that raises a visible "invalid schedule" error); the test was updated to match in f81aa3a07.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b29.regression.ts`.

### Server-hunt batch 30: autonomous scheduler fairness and delayed sends
- **Commit(s):** cc144f9c9
- **Files:** `server/services/conversation/server-autonomous-scheduler.service.ts`
- **Behaviour:** the concurrency cap starved every eligible chat after the first two in list order; sweeps now walk eligible chats round-robin (`orderAutonomousSweepCandidates`, persistent cursor), and busy-delay timers are tracked in `delayedChats` instead of holding a running slot. A delayed autonomous generation fired on stale state after its claim expired; at fire time the chat is re-read and the send is aborted (claim cleared) when the claim changed, a user message arrived after the claim, or the chat is gone or no longer eligible (`getDelayedAutonomousAbortReason`).
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b30.regression.ts`.

### Server-hunt batch 31: Discord webhook 429 retry
- **Commit(s):** cc144f9c9
- **Files:** `server/services/discord-webhook.ts`
- **Behaviour:** a Discord 429 dropped the message. The queued task retries up to 3 attempts (`MAX_RATE_LIMIT_ATTEMPTS`), sleeping for Retry-After (2 s when missing, zero or invalid); other failures are logged once. Order per webhook is kept.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b31.regression.ts`.

### Server-hunt batch 32: personal extension lock scope and startup rejection
- **Commit(s):** cc144f9c9
- **Files:** `server/services/extensions/personal-extension-settings.service.ts`, `server/services/extensions/personal-server-extension-runtime.ts`
- **Behaviour:** the batch 22 lock lived inside each storage wrapper, and the runtime and routes build separate wrappers, so writes were still unordered; the lock map is now module-scoped (one chain per extension id). An early child spawn error rejected `startup` before a handler was attached, triggering the process-fatal unhandledRejection exit; `startup` is marked handled at once, and the start send and timeout creation moved into the guarded block.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b32.regression.ts`.

### Server-hunt batch 33: agent fallbacks, cache guard memory, schedule and selfie commands
- **Commit(s):** cc144f9c9; `generate.routes.ts` hunk in 3354c1c89
- **Files:** `server/services/generation/agent-resolution.ts`, `cache-send-guard.ts`, `conversation-schedule-command-runtime.ts`, `conversation-selfie-command-runtime.ts`, `server/routes/generate.routes.ts`
- **Behaviour:** the built-in fallback loop re-ran agents that were deliberately skipped (unavailable local model, dead connection) on the default connection; built-ins with a config row are no longer fallen back. The cache send guard's `lastSent` map grew without bound; it is an LRU of 200 (`LAST_SENT_MAX`), evicted entries reload from `DATA_DIR/cache-guard`. `schedule_update` rewrote the whole chat metadata outside the patch queue; it now uses `patchMetadata` returning only `characterSchedules`. The selfie command now honours the generation abort signal (prompt call, image request, persistence), and the route stops the command loop after a Stop.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b33.regression.ts` (import path fixed in f81aa3a07).

### Server-hunt batch 34: memory command versions, trimming, empty wrapper pruning
- **Commit(s):** cc144f9c9
- **Files:** `server/services/generation/conversation-side-effect-command-runtime.ts`, `generation-text-utils.ts`, `runtime-agent-sections.ts`, `prompt-message-scope.ts`
- **Behaviour:** each AI `[memory]` command bumped the card version and stored a full version snapshot; it now patches only `characterMemories` with `skipVersionSnapshot`. `trimIncompleteModelEnding` deleted complete final sentences wrapped in markdown emphasis; `*`, `_`, `~` and backtick now count as closers. `pruneEmptyPromptWrappers` deleted image-only history turns and single-line headings; messages with images or files are never dropped and history messages only when truly empty; group scoping keeps attachment-only messages.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b34.regression.ts`.

### Server-hunt batch 35: video fallback permit
- **Commit(s):** cc144f9c9
- **Files:** `server/services/video/video-generation.ts`
- **Behaviour:** a nested video fallback held a shared permit while waiting on another connection's queue. The fallback hop moved out of `generateVideoUnqueued` into a catch around the queued request, so it runs after the primary releases its permit and takes its own queue turn; failures during the queue wait (timeout, abort) still skip the fallback.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b35.regression.ts`.

### Server-hunt batch 36: sharp loading, ComfyUI placeholders and cancel, ChatGPT image SSE
- **Commit(s):** cc144f9c9
- **Files:** `server/services/image/image-generation.ts`, `server/services/image/openai-chatgpt-image.ts`
- **Behaviour:** concurrent first use of `tryLoadSharp` returned null while sharp was loading; loading is one memoised promise. ComfyUI/SwarmUI placeholder substitution expanded `$` patterns and re-scanned inserted text; it is one regex pass with a function replacer. A queued ComfyUI prompt was never cancelled on abort or timeout; `cancelComfyUiPrompt` (own 5 s timeout) interrupts a running prompt or deletes a queued one. The ChatGPT image SSE reader re-split the growing multi-MB buffer on every chunk; it only joins when a separator arrives.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b36.regression.ts`.

### Server-hunt batch 37: RunPod ComfyUI cancel and prompt escaping
- **Commit(s):** cc144f9c9
- **Files:** `server/services/image/runpod-comfyui.service.ts`
- **Behaviour:** a RunPod job kept running (and billing) after abort or poll timeout; any non-terminal exit sends a best-effort, non-awaited `POST {base}/{endpoint}/cancel/{jobId}` (5 s timeout). Prompt text was used as a replacement pattern and control characters were not escaped; values are escaped with `JSON.stringify(...).slice(1, -1)` and inserted with function replacers.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b37.regression.ts`.

### Server-hunt batch 38: native character import and profile assets
- **Commit(s):** cc144f9c9
- **Files:** `server/services/import/marinara.importer.ts`, `server/services/import/profile-import-assets.ts`
- **Behaviour:** native character import threw after the row was created (so a retry duplicated it); avatar, sprite and gallery restore are each guarded and logged, and an avatar file whose attach failed is removed. Preset import crashed on a non-array `sectionOrder` or `groupOrder`; they fall back to `[]`. Case-variant asset paths destroyed the rollback backup; they are skipped with a message, and an existing rollback backup is never overwritten.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b38.regression.ts`.

### Server-hunt batch 39: SillyTavern bulk scan
- **Commit(s):** 3354c1c89
- **Files:** `server/services/import/st-bulk.importer.ts`
- **Behaviour:** the preset scan listed every preset twice on case-insensitive filesystems; preset folders are deduplicated by directory identity (bigint `dev:ino`, realpath when ino is 0) and missing folders are skipped. The chat scan read every chat JSONL in full to parse its first line; `readFirstLine` streams chunks and cuts at the first LF only (readline was rejected because it also splits at U+2028/U+2029, which JSON.stringify leaves raw), decoding once so split multibyte characters survive.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b39.regression.ts`.

### Server-hunt batch 40: SillyTavern and RisuAI card and chat import
- **Commit(s):** 3354c1c89
- **Files:** `server/services/import/st-character.importer.ts`, `server/services/import/st-chat.importer.ts`, `server/services/import/st-bulk.importer.ts`, `server/routes/import.routes.ts`
- **Behaviour:** RisuAI regex scripts were never imported (read from `raw.data.extensions`); they are read from the normalised extensions. CharX import errors (zip or JSON) returned 500; the branch now returns `{ success: false, error }` like PNG and JSON. Outlet position 7 (or "outlet") and `outletName` were lost on card re-import; both are kept. An invalid or null JSONL header threw; `importSTChat` returns `{ error: "Invalid JSONL: ..." }`, and the bulk importer now counts such results as errors instead of imported (`throwIfChatImportFailed`).
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b40.regression.ts`.

### Server-hunt batch 41: connection fallback streaming, Codex auth write
- **Commit(s):** cc144f9c9
- **Files:** `server/services/llm/connection-fallback-provider.ts`, `server/services/llm/openai-chatgpt-auth.ts`
- **Behaviour:** the `chatComplete` fallback re-streamed a second reply after the primary had already streamed partial text; once non-whitespace text reached the caller, a primary failure is rethrown instead of falling back, and an empty result after usable streamed text is returned as primary. The Codex `auth.json` was rewritten in place after a token refresh; it is written to a 0600 temp file and renamed.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b41.regression.ts`.

### Server-hunt batch 42: Anthropic top_k, Gemini parts after edits, Grok CLI
- **Commit(s):** cc144f9c9; `chats.storage.ts` hunk in 3354c1c89
- **Files:** `server/services/llm/providers/anthropic.provider.ts`, `server/services/storage/chats.storage.ts`, `server/services/llm/providers/grok-subscription.provider.ts`
- **Behaviour:** `top_k` was still sent with extended or adaptive thinking; it is deleted in all four thinking branches. Stored Gemini parts replaced edited message text on later turns; a content edit now sets `extra.geminiParts` to null on the message and the active swipe. Grok CLI output was decoded per chunk, corrupting split multibyte characters; streams use `setEncoding("utf8")`. The Grok scratch directory was cached forever; it is re-checked and recreated if the OS removed it, with a clear error when it went missing.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b42.regression.ts`.

### Server-hunt batch 43: OpenAI stream capture and Responses readers
- **Commit(s):** cc144f9c9
- **Files:** `server/services/llm/providers/openai-stream-inspection.ts`, `server/services/llm/providers/openai.provider.ts`
- **Behaviour:** stream capture re-measured the whole buffer (up to 2 MB) on every chunk; a running byte count is passed in and appends stop once truncated. Responses API streaming never cancelled or released its SSE reader on early exit or error; the finally blocks now cancel and release it, closing the upstream connection.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b43.regression.ts`.

### Server-hunt batch 44: textual tool-call parser duplicates
- **Commit(s):** 3354c1c89
- **Files:** `server/services/llm/textual-tool-call-parser.ts`
- **Behaviour:** a tool call in a ```json fence inside `<tool_call>` tags was parsed twice, so the tool ran twice. Snippets now carry their source ranges and a range is claimed only once it actually yields a call; an overlapping snippet is not parsed whole, but its recovery may still find a separate call outside the claimed span, and an unclosed tag claims only its recovered JSON. So a tag that fails to parse never hides a valid fence inside it, and later fenced calls after an unclosed tag still parse (both were regressions in the first attempt).
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b44.regression.ts`.

### Server-hunt batch 45: lorebook recursion and regex contexts
- **Commit(s):** cc144f9c9
- **Files:** `server/services/lorebook/index.ts`, `keyword-scanner.ts`, `regex-timeout.ts`
- **Behaviour:** with recursion enabled the ordinary keyword scan ran twice with separate probability rolls; the outer scan is skipped when any book is recursive. Recursion passes re-ran semantic matching; they now pass no chat embedding and an empty semantic map. `recursiveScan` re-activated inclusion-group losers; groups with a winner are excluded. A new V8 vm context was created for every regex key test; one module-level context with precompiled scripts is reused.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b45.regression.ts`.

### Server-hunt batch 46: memory recall prune
- **Commit(s):** cc144f9c9
- **Files:** `server/services/memory-recall.ts`
- **Behaviour:** the stale-chunk prune rescanned every message for every chunk on each generation (O(n^2)); it uses first and last index maps by `createdAt` (same counts, O(chunks + messages)).
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b46.regression.ts`.

### Server-hunt batch 47: prompt assembly
- **Commit(s):** cc144f9c9
- **Files:** `server/services/prompt/assembler.ts`, `macro-context.ts`, `marker-expander.ts`, `format-engine.ts`, `packages/shared/src/utils/xml-wrapper.ts`
- **Behaviour:** the final empty-content filter dropped image or file only history messages; they are kept (as are assistant messages with provider metadata). Per-character depth and post-history prompts resolved `{{charPhonetic}}` to the first character; each uses its own phonetic name. Referenced-character extraction capped at 8 ids before excluding active ones; exclusion now happens first. Wrapper tags became empty for non-ASCII names and a missing name threw; tag and heading slugs keep Unicode letters and digits and fall back to `section` / `Section`.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b47.regression.ts`.

### Server-hunt batch 48: regex application vm context
- **Commit(s):** cc144f9c9
- **Files:** `server/services/lorebook/regex-timeout.ts`
- **Behaviour:** a new vm context was created for every message and script pair on every prompt build; the shared context from batch 45 serves both `createTimeoutRegexExecutor` and `createTimeoutRegexReplaceGuard`, clearing the text global after each run so large prompts are not retained. A fresh RegExp is still built per call.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b48.regression.ts`.

### Server-hunt batch 49: local sidecar downloads, model switch, runtime fallback, Whisper loads
- **Commit(s):** 3354c1c89
- **Files:** `server/services/sidecar/sidecar-download.ts`, `sidecar-model.service.ts`, `sidecar-process.service.ts`, `sidecar-speech.service.ts`
- **Behaviour:** `downloadFileWithProgress` deleted the installed file before the new download succeeded; the verified temp file now replaces it by rename only. A model switch failed after a full download when the old model's llama-server held the file; the new config is committed first and the old file's unlink is best effort, and auto-start is skipped while a model download runs (unless forced). A working fallback runtime was killed and restarted on every sync and a failed one was never remembered; every attempt is recorded under the requested runtime's signature. Whisper: loads are serialised with a generation counter; a superseded load disposes its pipeline; delete waits only for a load of the same model; and transcription during a model download fails fast ("Local Whisper is downloading a model. Try again when the download finishes.") instead of stalling for minutes and then writing the old model back over the user's new choice.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b49.regression.ts`.

### Server-hunt batch 50: app settings upsert
- **Commit(s):** cc144f9c9
- **Files:** `server/services/storage/app-settings.storage.ts`
- **Behaviour:** `set()` did an exists-check then insert, so concurrent first writes failed with a duplicate key; it is one `insert ... onConflictDoUpdate`.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b50.regression.ts`.

### Server-hunt batch 51: chats and connections storage
- **Commit(s):** cc144f9c9 (connections and regression); `chats.storage.ts` hunks in 3354c1c89
- **Files:** `server/services/storage/chats.storage.ts`, `server/services/storage/connections.storage.ts`
- **Behaviour:** `isValidLegacySchedule` had an operator-precedence bug (a null block threw, a block without time passed); the status alternatives are grouped. `setActiveSwipe` to the already active index dropped message-only extra such as attachments; it returns early. Note pruning could delete the just-created note on a `createdAt` tie; note ids are time-sortable and the new note is always kept. A media-provider connection could keep or get `isDefault` and become the chat default; only language providers can be default, and `getDefault()` ignores media rows already flagged.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b51.regression.ts`.

### Server-hunt batch 52: lorebook embeddings, preset default, active theme
- **Commit(s):** cc144f9c9
- **Files:** `server/services/storage/lorebooks.storage.ts`, `server/services/lorebook/embeddings.ts`, `server/routes/lorebooks.routes.ts`, `server/services/storage/prompts.storage.ts`, `server/services/storage/themes.storage.ts`
- **Behaviour:** `updateEntryEmbedding` wrote a vector computed from stale text and bumped `updatedAt`; it takes an optional `expectedUpdatedAt` in the WHERE and no longer bumps `updatedAt` (both callers pass it). `setDefault` bumped `updatedAt` on every preset; it only touches the old and new default. Theme `setActive` could leave two active themes; it runs in one transaction and also repairs duplicates already on disk.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b52.regression.ts`.

### Server-hunt batch 53: Spotify playlists
- **Commit(s):** cc144f9c9
- **Files:** `server/services/tools/tool-executor.ts`
- **Behaviour:** `spotify_get_playlists` crashed on playlists without `tracks.total` (Development Mode); null items are skipped, the count falls back to `items.total` or null, and a null description is handled.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b53.regression.ts`.

### Server-hunt batch 54: utility sidecar install and start
- **Commit(s):** be4c94289 (service); `sidecar-download.ts` hunk in 3354c1c89; regression in cc144f9c9
- **Files:** `server/services/utility-sidecar/utility-sidecar.service.ts`, `server/services/sidecar/sidecar-download.ts`
- **Behaviour:** reinstalling or updating a model deleted the working copy before the download succeeded and the process could restart on it mid-install; install downloads to `<dest>.staged`, stops the process only just before the swap, rejects a concurrent install and refuses to start a model being installed. `ensureRunning` retried a failed start up to 3 times; a failed start of the same model is final for that call. A spawn error still waited the full 120 s health timeout; the error handler clears the child so the wait ends with the real error. The config write is atomic.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b54.regression.ts`.

### Server-hunt batch 55: Gemini Omni video size cap
- **Commit(s):** cc144f9c9
- **Files:** `server/services/video/video-generation.ts`
- **Behaviour:** the Gemini Omni JSON response carrying base64 video was capped at the raw video limit; the fetch cap is now `MAX_VIDEO_JSON_RESPONSE_BYTES` (room for base64 overhead) and the decoded MP4 is still checked against `MAX_VIDEO_RESPONSE_BYTES`.
- **Settings / env and defaults:** none.
- **Tests:** `server-hunt-b55.regression.ts`.

### Server-hunt batch 56: taskbar shortcut migration on non-ASCII paths
- **Commit(s):** cc144f9c9
- **Files:** `server/services/setup/taskbar-shortcut-migration.ts`
- **Behaviour:** PowerShell output was decoded as UTF-8 without asking PowerShell for UTF-8, so shortcut targets with non-ASCII paths never matched and the migration was silently skipped. Reads now set `[Console]::OutputEncoding` to UTF-8 and decode the collected buffers once.
- **Settings / env and defaults:** `MARINARA_B56_E2E=1` enables the regression's opt-in end-to-end block (test only).
- **Tests:** `server-hunt-b56.regression.ts`.

### Server-hunt batch 57: SSRF reserved addresses and redirect handling
- **Commit(s):** 3354c1c89
- **Files:** `server/utils/security.ts`
- **Behaviour:** Google and Horde keys (`x-goog-api-key`, `apikey`) were forwarded on cross-origin redirects; both are stripped. The SSRF private-range block depended on `TRUSTED_PRIVATE_NETWORKS`, so a narrowed list let 169.254/10/172.16/fd00 addresses through; `isReservedIp` now checks loopback, the built-in non-routable ranges and the operator's trusted list, so a narrowed list cannot unblock built-ins and a widened one keeps its internal hosts blocked. The redirect-limit throw left the response body and per-request dispatcher open; the body is cancelled first on every hop.
- **Settings / env and defaults:** `TRUSTED_PRIVATE_NETWORKS` (existing) no longer weakens outbound SSRF checks.
- **Tests:** `server-hunt-b57.regression.ts`.

### Server logging pass
- **Commit(s):** 750e67ff3
- **Files:** `docs/development/logging.md` (v1.0, new), `LOGGING.md`, `CHANGELOG.md`, `packages/server/scripts/build.mjs`, `write-build-meta.mjs`, new `server/lib/best-effort.ts`, `build-integrity.ts`, `child-process-diagnostics.ts`, `http-diagnostics.ts`, `log-events.ts`, `startup-timeline.ts`, `worker-gauges.ts`, plus about 90 changed server files (app, index, config, db, lib, middleware, routes, agents, capability packages, continuity, generation, image, import, llm providers, sidecar, storage, video, `utils/runtime-memory.ts`).
- **Behaviour:** implements the logging guide, whose vocabulary (`event`, `outcome`, `state`, `kind`, `errorCode`, `elapsedMs` plus the DiagnosticContext fields) is shared with the generation-jobs work.
  - Request trail: every line carries `bootId`; request ids are UUIDs, bound again at preValidation so POST routes keep them, and echoed in `x-request-id`. One `request.end` per request (debug; info on 5xx or when request logging is on), `request.slow` warn, `request.stream.end`, `request.aborted` at info, `request.error`.
  - Startup: `startup.build` first line; every `buildApp` step timed as `startup.phase` (debug, info over 1 s, warn over 5 s, error on failure); `startup.early_boot` (`ME_EARLY_BOOT`) when Fastify boots early; `startup.inject_held` / `startup.inject_released`; `startup.build_check` compares the running dist with a source inventory written at build time (`ME_BUILD_STALE`); one `startup.ready` summary with activated, failed and skipped packages, slowest phases, storage and memory, also returned by `/api/health` as `startup`. The build fails if compiled output is missing for a source module.
  - One failure, one error line: `reportDiagnosticError`, `replyWithDiagnostic`, `emitSseFailure`; no duplicate "Diagnostic failure" line; cause chains (8 deep, AggregateError members, errno/syscall/exit code) kept; cancellations at info, client errors at warn.
  - Rate limiting: `logRepeated` / `logRecovered` (15 min window, `suppressedCount` summary); `logSuppressed` / `orFallback` / `bestEffort` replace silent catches (once per minute per event, chat and stage); an empty-catch ratchet test stops the count rising.
  - Runtime: `runtime.memory` (heap, external, array buffers, event-loop p99, worker gauges, peaks) at debug every 5 min and info every 30 min; `runtime.memory_pressure` once per episode with a recovered line; shutdown times each service.
  - Privacy: prompt debug output goes only to `DATA_DIR/logs/prompt-debug/` and the console, never the main files; debug level no longer unredacts prompts; secrets, prompt text, full URLs and raw bodies stay out of lines.
- **Settings / env and defaults:** `MARINARA_SLOW_REQUEST_MS` (default 5000) for `request.slow`; `MARINARA_RSS_WARN_MIB` (default: the heap limit) for `runtime.memory_pressure` (also fires at 85% heap or p99 loop delay over 1 s); `MARINARA_CACHE_DIAGNOSTICS=1` raises the Claude and OpenAI per-item cache diagnostic lines from debug to info (default off, read per call). Fixed thresholds: `operation.slow` 10 s, `storage.flush.slow` 1 s, `storage.lazy.full_residency` 250 ms. Existing LOG_* settings unchanged.
- **Tests:** `logging-b0.regression.ts` to `logging-b14.regression.ts`, `logging-infrastructure.regression.ts`, `empty-catch-ratchet.regression.ts`.

### Server robustness pass
- **Commit(s):** f4f547396
- **Files:** `server/db/file-backed-store.ts`, `server/db/writer-host-identity.ts`, `server/db/connection.ts`, `server/index.ts`, `server/app.ts`, `scripts/run-server.mjs`, new `server/lib/shutdown-steps.ts`, `server/lib/shutdown-signals.ts`, `server/lib/runtime-diagnostics.ts`, `server/services/generation/background-call-budget.ts`, `server/routes/admin.routes.ts`, `server/services/capability-packages/capability-module-runtime.service.ts`, `server/services/game/continuity-runtime.ts`, `continuity-provider.ts`, `server/services/generation/connection-admission.ts`, `server/services/llm/rate-limit-aware-provider.ts`, `packages/shared/src/constants/generation-parameter-relevance.ts`, `packages/client/src/components/game/GameContinuityPanel.tsx`, `packages/client/src/localization/locales/en.json`, plus one-line test environment pins in about 40 regressions.
- **Behaviour:**
  - Storage writes: a flush skips any shard or `manifest.json` whose serialized content is byte-identical to this process's last durable write, while the file still has the recorded size and mtime (no tmp, fsync, rename or `.bak` refresh; `filesSkipped` on `storage.flush`). Large shards serialize row by row in slices that yield the event loop, with the fingerprint hashed incrementally (output byte-identical).
  - Windows boot id: the PowerShell LastBootUpTime probe (about 1.5 to 2 s, blocking at module load) is cached per boot in `%LOCALAPPDATA%/MarinaraEngine/writer-boot-id.json` with a boot-time estimate (now minus uptime); a later start within 10 s of the estimate reuses the exact string; any mismatch or corrupt cache probes again; a null probe is never cached.
  - Shutdown: runtime stops run as bounded, timed steps so a hung `stop()` cannot keep `closeDB()` from flushing; a timed-out step logs `outcome: "failed"`, `reason: "timeout"`, and its late error is still logged; the store close keeps a reserve. Windows console close (SIGHUP) and Ctrl+Break (SIGBREAK) now reach graceful shutdown (with a tighter budget for the console close); duplicate stop signals within the grace window are ignored; a deliberate second Ctrl+C or Ctrl+Break after it forces exit 130; repeated SIGHUP/SIGTERM are ignored; a fatal-error close keeps its nonzero exit code; the launcher also handles SIGBREAK so it keeps the server's exit status; pending saves start writing while `app.close()` waits on connections.
  - Admin runtime diagnostics: `GET /api/admin/runtime-diagnostics` (privileged access, `Cache-Control: no-store`) returns what `/api/health` does not: memory peaks, storage residency and dirty tables, last flush failure, quarantine count, whether each capability package runtime is live (`skipped` for a recorded early-boot failure, `failed`, `pending`), worker gauges and continuity queue and breaker detail. Counts and states only; each section fails independently to `{ error }`.
  - Continuity pacing: a global rolling-hour cap on automatic model calls (interactive requests never count); a refusal sends no request and pauses workers until a slot frees. Historical backfill may fill only 75% of the cap and pauses on its own (re-checked every 60 s) while live turns keep running on the rest (live before backfill). Stages whose connection is a local inference endpoint are exempt unless their fallback is remote. A rejected API key (401, or 403 and some 400 prose with credential wording; moderation 403s excluded) parks only that chat without spending attempts, with Retry in the panel and a 10 min unpark timer. A batch's own failures back off per item: 60 s then 120 s, plus or minus 20% jitter, three attempts. Connection admission books the cap only once the connection is free. The continuity panel shows "Paused: hourly call cap reached" and "Paused: API key rejected" states.
  - Provider transient retry: before any token reaches the caller, connect-phase failures, fast socket drops (ECONNRESET, EPIPE, UND_ERR_SOCKET within 1.5 s) and HTTP 502/503 are retried at most 2 times with jittered exponential backoff (1 s base, 60 s cap, Retry-After honoured). 504, header and body timeouts, body-phase "terminated" errors and user aborts are never retried; nothing is replayed after output started. Rate limits keep their own budget of 6 retries (2 s base).
  - Also: the Generation Parameters relevance table hides topK while Anthropic thinking is on; stale source-shape checks updated for the logging pass (backup failure state, fatal handlers, `startup.ready`); regressions pin `FILE_STORAGE_DIR` next to `DATA_DIR`.
- **Settings / env and defaults:** `MARINARA_BACKGROUND_CALLS_PER_HOUR`: positive integer sets the cap, `0` / `off` / `false` / `disabled` turns it off, anything else means 600; default 600. Fixed: backfill share 0.75, backfill recheck 60 s, continuity retry 60 s then 120 s with 20% jitter, unpark 10 min; transient retries 2 (1 s base), rate-limit retries 6 (2 s base), backoff cap 60 s, stale-socket window 1.5 s; runtime stop budget 2000 ms (1000 ms on a Windows console close), store close reserve 1500 ms, repeated-signal grace 1500 ms; serialize yield slice 12 ms; boot id cache tolerance 10 s. Later main-tree switches (commit 8aa93818b, Settings > Features, all default on; off restores upstream behaviour): `stableLorebookGroupPicks`, `providerRetry`, `backgroundCallCap`, `backgroundCallsPerHour` (default 600, 1 to 100000). When set, `MARINARA_BACKGROUND_CALLS_PER_HOUR`, `LOREBOOK_STABLE_GROUP_WINNERS` and `PROVIDER_RETRY_TRANSIENT_ERRORS` win over the saved switches (confirmed in `server/services/features/feature-settings.ts` and `background-call-budget.ts`).
- **Tests:** `robustness-storage-write.regression.ts`, `robustness-boot-performance.regression.ts`, `robustness-shutdown-safety.regression.ts`, `robustness-health-endpoint.regression.ts`, `robustness-continuity-backoff.regression.ts`, `robustness-provider-resilience.regression.ts`; updated `server-signal-shutdown`, `shutdown-deadline`, `termux-postmortem`, `diagnostic-foundation`, `open-issues`.

### Regression suite green: isolated storage per file, logged catches, stale tests
- **Commit(s):** f81aa3a07
- **Files:** `scripts/run-regressions.mjs`; product: `server/db/file-backed-store.ts`, `server/db/writer-host-identity.ts`, `server/lib/shutdown-steps.ts`, `server/routes/import.routes.ts`, `server/services/generation/agent-activation-questions.ts`; tests and fixtures listed below.
- **Behaviour:**
  - Runner: every regression file gets its own temp dir (`marinara-regression-*`) with `DATA_DIR=<tmp>/data`, `FILE_STORAGE_DIR=<tmp>/data/storage` and `MARINARA_ENV_FILE=<tmp>/.env` (empty), removed afterwards, so no test can open (or be blocked by the writer lease of) the live store named in the repo `.env`. This fixed the environment failures of experience-generation, experience-lore-entries, mari-workspace-context, checkpoint-retention and game-metadata-race without test changes.
  - Real fixes: the robustness pass had added 4 empty catches (ratchet 231 against 224); they now call `logSuppressed` at debug (flush fingerprint, writer boot id cache read and temp cleanup), and a late shutdown step whose logging itself throws emits a `MarinaraShutdownWarning` process warning; two more silent catches in import (picker kill, ST chat character link) and agent activation questions now log. `robustness-boot-performance` spawns PowerShell with `windowsHide: true` (windows-process-launch guard).
  - Stale tests updated (code verified correct):
    - capability-gm-verb-runtime: lookup string missed the `...emptyRef` added to the empty-response SSE error by the logging pass.
    - capability-gm-verbs: opaque metadata writer count 15 to 14 (retry map sync became a readable `patchMetadata`), and the key regex no longer counts `chat.metadata.includes(...)` as a key.
    - claude-cache-diagnostics and openai-cache-diagnostics: per-item lines now need `MARINARA_CACHE_DIAGNOSTICS=1`; OpenAI transport failures are wrapped as `LLMTransportError` with the original on `cause`.
    - experience-state and game-checkpoint-engine-state: register fixture engines through the server's own `@marinara-engine/shared` instance, not a second module copy.
    - game-background-assets: the copied GameSurface branch now needs the `resultStillCurrent` parameter.
    - game-sequential-tasks: the fake map needs one node since generated maps are validated.
    - game-journal-edit and generate-agent-abort: isolate storage in a temp `DATA_DIR`.
    - generation-job-tracking: lifecycle checks limited to tracker-built lines (`sourceKind`), since the store now logs `job.state` itself.
    - gm-skill-check-resolution: anchor on the post-processing `content_replace`, not the new tool-loop one.
    - maintenance-lifecycle: anchor changed to `let anchoredMsg = savedMsg`.
    - open-issues: automatic-backup catch now sets the stage first; notification help text moved to locale keys; folder headers render through `LibraryFolderTree.tsx`.
    - roleplay-streaming: looks for `appendSwipeAttachmentAndActiveMirror` instead of the old two-step write.
    - floating-panel-layout and scene-portrait-sheet: UI locators follow the named resize handle and the button-wrapped party portrait.
    - pnpm-runner: the fake pnpm fails at once on `install` instead of idling to a timeout.
    - server-hunt-b12: source path resolved from the test file, not cwd.
    - server-hunt-b15 and b33: import shared by relative dist path (the runner's cwd is `packages/server`).
    - server-hunt-b22: same import fix, and the fake in-flight load names the model being deleted.
    - server-hunt-b29: keeps the event loop alive during the unref'd timeout, and expects the upstream strict schedule error.
    - storyboard-source-sections.browser: esbuild shim exports `game-narration-text` and `hud-widget-extended`.
    - windows-console-shutdown.ps1 fixture: re-enables Ctrl+C before spawning the server, so a host that launched it with Ctrl+C ignored does not break the test.
- **Settings / env and defaults:** runner-only `DATA_DIR`, `FILE_STORAGE_DIR`, `MARINARA_ENV_FILE` per file.
- **Tests:** the files listed above.

### Generation job failure lines drop echoed prompt text
- **Commit(s):** 62fb57271
- **Files:** `server/services/generation/generation-jobs.ts`, `scripts/regressions/generation-job-tracking.regression.ts`
- **Behaviour:** provider errors often quote the request back, so a `job.state` failed line could carry prompt text in `err.message`. `withoutEchoedPrompt` keeps the error's name, `code`, `status`, `statusCode`, `errorCode`, `cause` and stack frames, replaces quoted spans of 12 or more characters in the message (and the stack's first line) with `[quoted text removed]`, and caps the message at 300 characters.
- **Settings / env and defaults:** none.
- **Tests:** `generation-job-tracking.regression.ts` now checks the whole line, `err` included, for the planted prompt.

### Regressions seed the server's shared agent registry
- **Commit(s):** 0623ac08e
- **Files:** `scripts/regressions/fixtures/server-shared.ts` (new), `agent-registry-hydration.regression.ts`, `assigned-chat-sweep.regression.ts`, `illustrator-disconnect.regression.ts`, `manual-agent-retry-resolution.regression.ts`, `prompt.regression.ts`, `tracker-sections.regression.ts`
- **Behaviour:** six regressions registered fixture agent manifests into the repo-relative `packages/shared/dist`, while server code resolves `@marinara-engine/shared` through `packages/server/node_modules`. In any checkout where that link points elsewhere (every worktree) those are two module instances and the server saw no fixtures, so they passed only from the main tree. The new fixture imports the server's instance. No assertions changed.
- **Settings / env and defaults:** none.
- **Tests:** the six files above.

### Peek-prompt live preview shows the next-turn layout
- **Commit(s):** bd402ac7c
- **Files:** `server/routes/chats.routes.ts`, `server/services/generation/prompt-cache-layout.ts`, `scripts/regressions/peek-prompt-next-turn-layout.regression.ts` (new)
- **Behaviour:** the live preview (and the dev MCP's `get_prompt which=next`) had no pending player message, so it showed runtime blocks such as the World Maps spatial context right after the system prompt, while a real game turn on a non-subscription provider carries them at the current turn. New `layoutAsNextTurn` adds a placeholder user turn, applies the same reordering as generation for the chat mode and provider (`normalizePromptCacheLayout` for full-lorebook-context providers, `keepGameDialogueAdjacent` for game mode), then removes it. The response carries `layout: "next-turn"` and the preview note says the next player message would follow the last line.
- **Settings / env and defaults:** none.
- **Tests:** `peek-prompt-next-turn-layout.regression.ts`.

### Stable lorebook inclusion-group winner per chat

- Commit: `ede160d9d`.
- Files: `packages/server/src/services/lorebook/keyword-scanner.ts` (`ScanOptions.groupSeed`, seeded group random), `packages/server/src/services/lorebook/index.ts`; later `group-pick-policy.ts` for the switch.
- Problem: an inclusion group re-rolled its winner with `Math.random` on every generation, so a different entry landed near the top of the prompt each turn and broke prompt caching on selective-lore connections. Found on 2026-09-22 by diffing two consecutive next-turn previews (the first lore entry flipped with no change in between) and reproduced 3 of 3 in the sandbox.
- Behaviour: the winner is seeded by chat id, group and candidate set: stable across turns, still varied across chats and when the activated candidates change. Injected random sources keep their behaviour.
- Setting: **Stable lorebook picks** (`stableLorebookGroupPicks`, default on; env `LOREBOOK_STABLE_GROUP_WINNERS` wins).
- Tests: `scripts/regressions/feature-switch-lorebook-picks.regression.ts`.

### Feature switches: mechanism

- Commit: `8aa93818b` (the job tracking switch joined on 2026-09-24 in `d91c5d395`).
- Files: `packages/server/src/services/features/feature-settings.ts` (`isFeatureEnabled`), `packages/shared/src/schemas/feature-settings.schema.ts`, `packages/client/src/components/panels/settings/FeatureSwitchesSettings.tsx`, `packages/client/src/hooks/use-feature-settings.ts`, `packages/server/src/services/game/game-feature-switches.ts`, `packages/shared/src/utils/game-feature-switches.ts`, `ChatSettingsDrawer.tsx`, `AdvancedParametersSection.tsx`, `docs/configuration/features.md`.
- Behaviour: app-wide switches in Settings > Advanced > Features are saved together in app setting `features` (JSON of booleans and numbers; missing, empty or unreadable means on with default numbers). Precedence: a set environment variable wins both ways, then the saved value, then default on. Changes apply without a restart or reload. Searching settings for `features` opens the section.
- Rule: every switch defaults on, which is this build's behaviour; off restores upstream's.
- Tests: `scripts/regressions/feature-settings.regression.ts`.

### Feature switch: ChatGPT history replay

- Setting: `chatgptHistoryReplay`, default on. Off: the prompt is rebuilt every turn and no `session-id` header or `prompt_cache_key` is sent.
- Tests: `feature-switch-chatgpt-replay`.

### Feature switch: Cache-friendly prompt layout

- Setting: `cacheFriendlyPromptLayout`, default on. Off: the prompt goes in assembly order, and chats use the keyword lore scan unless a chat explicitly turned full lore on.
- Tests: `feature-switch-cache-layout`.

### Feature switch: Stable lorebook picks

- Setting: `stableLorebookGroupPicks`, default on; env `LOREBOOK_STABLE_GROUP_WINNERS` (`true`, `1`, `yes`, `on` turn it on; anything else off). Off: the winner is re-rolled on every scan.
- Tests: `feature-switch-lorebook-picks`.

### Feature switch: Retry failed provider calls

- Setting: `providerRetry`, default on; env `PROVIDER_RETRY_TRANSIENT_ERRORS`. On: a refused connection or gateway 502 or 503 is retried up to twice before any text arrived, each time on the next DNS address. Off: only 429 and 529 are retried, on the first address.
- Tests: `feature-switch-provider-retry`.

### Feature switch: Background call cap

- Settings: `backgroundCallCap` (default on) and **Calls per hour** `backgroundCallsPerHour` (default 600); env `MARINARA_BACKGROUND_CALLS_PER_HOUR` (a positive number sets the cap; `0`, `off`, `false` or `disabled` removes it). Off: no cap.
- Tests: `feature-switch-background-cap`.

### Feature switch: Message trash

- Settings: `messageTrash` (default on) and **Days kept in Trash** `messageTrashDays` (default 30). Off: every delete is permanent, single and bulk, and the Trash view is hidden; messages already in the Trash stay until they expire.
- Tests: `feature-switch-message-trash`.

### Feature switch: Usage and activation stats

- Setting: `usageAndActivationStats`, default on. Off: no token usage or lorebook activations are recorded, including queued but unwritten activations; the Usage Dashboard and activation stats are hidden.
- Tests: `feature-switch-usage-stats`.

### Feature switch: Send client error reports

- Setting: UI preference `clientErrorReports`, default on, synced with other UI settings. Off: the browser error listeners are not installed and nothing is queued or sent.
- Tests: `feature-switch-client-error-reports`.

### Game switch: Scene timeline

- Setting: chat metadata `gameSceneTimelineEnabled`, default on, in a Game chat's settings drawer, Agents tab below Character knowledge. Off: no scene review call after GM turns, no scene index in the recap, Scenes tab hidden; presence and party replies use the tracker snapshot.
- Tests: `game-switch-scene-timeline`.

### Game switch: Extended HUD widgets

- Setting: chat metadata `gameExtendedWidgetsEnabled`, default on. Off: the GM sees upstream's widget block and types only; create and delete commands are ignored live and on branch replay; existing extended widgets are hidden, not deleted. With the switch on the GM prompt is byte for byte what it was before the switch existed; the switch changes only the late format reminder, never the cached system layers.
- Tests: `game-switch-extended-widgets`.

### Game switch: Automatic scene media

- Setting: chat metadata `gameAutoSceneMediaEnabled`, default on. Off: nothing is queued automatically after GM turns; media you ask for still works.
- Tests: `game-switch-auto-scene-media`.

### Chat switch: Warn before a low-cache send

- Setting: chat metadata `cacheSendGuard.enabled` (default on) and `cacheSendGuard.thresholdPercent` (**Warn below (%)**, 0 to 100, default 80), in Chat settings > Advanced Parameters in every chat mode. The server already read this setting; the control only surfaces it with the same defaults.
- Tests: `chat-cache-send-guard-settings`.
- Game switches are copied into new sessions with the rest of the game's settings, and a branch keeps the choice of the chat it came from.

### HUD widget landing, enum repair and interim list capacity

- `0f90ee405`: GM prompt summary line for extended widgets, the compact catalog of the 19 extra types, the setup JSON schema listing every type, and locale keys (`formatHint`, calendar day label). The widget engine and renderers had been swept into `05d60f159` from the shared index.
- `2ceb4b780`: `0f90ee405` applied zero-context hunks at shifted offsets; the 19 type names landed outside both enums in `packages/server/src/routes/game.routes.ts` and HEAD did not compile (20 server tsc errors before, 0 after, checked on a clean checkout).
- `857d874d5`: widgets created by the GM without an icon show their type's default icon in the phone tray, the tucked panel and the headers (19 identical buttons before).
- `beeafe7c7`: interim per-widget list capacity (`config.max` 1 to 30, default 5), `[widget: id, max: N]`, eviction toast and branch replay parity, with `scripts/regressions/hud-widget-list-capacity.regression.ts`. Superseded on 2026-09-24 by list widget capacity 100.

### GameSurface parse repair

- Commit: `a0e614fc5`. `3008c346d` applied a zero-context hunk one line late: `const shownChoices = activeChoices;` landed inside the `sendMessage(` call, so `GameSurface.tsx` did not parse at HEAD. The function now matches the working copy; nothing else changed.

### Search All Chats

- Commit: `786bda8dd` (feat/search); palette and shortcut in `8e4a1ccff`.
- Files: `packages/client/src/components/modals/GlobalSearchModal.tsx`, `packages/server/src/routes/chat-insights.routes.ts` (prefix `/api/chat-insights`), `packages/server/src/services/chat-insights/chat-insights.service.ts`, `packages/shared/src/utils/chat-search-query.ts`.
- Behaviour: finds messages across every chat with quoted phrases and filters for mode, character, sender and date range; results show highlighted snippets and open the chat at that message. Game results open the campaign log at that turn (since `7a7a44b11`). On phones the panel closes after the jump.
- Shortcut: Ctrl+Shift+F (Cmd+Shift+F on Mac); also the search button beside the chat list and the command palette ("typing anything also offers a search inside messages").
- Tests: `chat-global-search`.

### Story exports (Markdown and HTML)

- Commit: `786bda8dd`.
- Files: `packages/server/src/services/chat-insights/transcript-document.ts`, `transcript-avatars.ts`.
- Behaviour: Markdown and HTML exports next to JSONL and Text in the branch menu. Exports follow the active swipe and leave out hidden and system messages; the HTML story is a standalone page with light, dark and print styling and small embedded avatars; chapters become headings and the HTML story gets a contents list (since `2f9737914`). Private notes are left out unless "Include private notes in exports" is on.
- Tests: `chat-story-export`.

### Chat stats

- Commit: `786bda8dd`.
- Files: `packages/client/src/components/modals/ChatStatsModal.tsx`, `packages/shared/src/utils/chat-stats.ts`; route `GET /api/chat-insights/chats/:id/stats`.
- Behaviour: Stats in the branch menu: messages, words per speaker, average reply length, messages per day, the longest message, reported generation tokens and play time. Play time adds up sittings; a pause over 30 minutes starts a new sitting.
- Tests: `chat-stats-activity`, `chat-insights-display`.

### Activity overview

- Commit: `786bda8dd`.
- Files: `packages/client/src/components/modals/ActivityOverviewModal.tsx`; route `GET /api/chat-insights/activity`.
- Behaviour: pulse button beside your status: yearly heatmap of messages across all chats, streaks, totals, total play time and most played chats.
- Tests: `chat-stats-activity`.

### Dice log

- Commit: `36f8f452e` (feat/game); summary strip in `524d6dbca`.
- Files: `packages/client/src/components/game/GameDiceLog.tsx`, `packages/server/src/services/game/dice-roll-log.ts`, `db/schema/game-dice-rolls.ts`, `services/storage/game-dice-rolls.storage.ts`; routes `GET` and `POST /api/game-tools/dice-log`; fire-and-forget hook in `generate.routes.ts` after the GM message save.
- Behaviour: every roll from the dice tray, GM narration and skill checks is kept with dice, total and crit or fumble flags; recent rolls, average against expected, natural 20s and 1s, per-face distribution, for the current session or the whole game. A one-line summary shows the most rolled die against a fair die and nat 20 and nat 1 rates. Logging never blocks or fails a roll. Session panel, Tools tab.
- Schema: new table `game_dice_rolls`.
- Tests: `game-dice-roll-log`.

### Name generator

- Commit: `36f8f452e`.
- Files: `packages/client/src/components/tools/NameGenerator.tsx`, `modals/NameGeneratorModal.tsx`, `packages/client/src/lib/name-generator.ts`, `lib/open-name-generator.ts`.
- Behaviour: offline fantasy names in harsh northern, flowing elvish, desert and imperial styles, plus names learned from a chosen lorebook or the character library; seeded, lockable, copyable. Opens from the Game Mode Tools tab or anywhere through its own window and the command palette.
- Tests: `name-generator`.

### Campaign codex export

- Commits: `36f8f452e`; projection-based rewrite in `7a7a44b11`.
- Files: `packages/server/src/services/game/campaign-codex.ts`; route `GET /api/game-tools/codex/:chatId`.
- Behaviour: downloads a game's campaign memory as Markdown or JSON: entities grouped by kind with aliases, current state, verified facts, knowledge and relationships tagged by session, and a timeline. Since `7a7a44b11` it reads the merged campaign projection, writes each statement once with its holders (JSON format version 2: per-holder `knowledge` became `claims` and `heldBy`), cuts long values in Markdown, and keeps branch-aware session lists. Read only.
- Tests: `campaign-codex-export`, `campaign-codex-projection`, `campaign-codex-size`.

### Campaign log reader

- Commit: `7a7a44b11` (feat/game-log).
- Files: `packages/client/src/components/modals/GameLogModal.tsx`, `packages/client/src/lib/game-log.ts`, `lib/open-game-log.ts`, `packages/server/src/services/game/campaign-log.ts`; route `GET /api/game-tools/log/:chatId`.
- Behaviour: full-screen reader laying out every session of a campaign in order, with segment edits and deletions applied, campaign-wide search with highlights and next and previous, and filters by session and speaker. Opens from the Tools tab or "Open campaign log" in the palette; `/goto` and Search All Chats game results open it at that turn. Chapter list for jumping (since `2f9737914`).
- Tests: `campaign-log-reader`.

### Check lorebook

- Commit: `a837cd319` (feat/library).
- Files: `packages/client/src/components/lorebooks/LorebookLintPanel.tsx`, `packages/shared/src/utils/lorebook-lint.ts`.
- Behaviour: lists empty entries, entries without keys, duplicate keys and content, invalid or unsafe regex keys, overlong and disabled entries, and very short or common-word keys, with severity filters and a jump to each entry. Also "Check" for the open lorebook in the palette.
- Tests: `lorebook-lint`.

### Lorebook scan test

- Commit: `a837cd319`.
- Files: `LorebookScanTest.tsx`, `packages/server/src/services/lorebook/test-scan.ts`; route `POST /api/lorebooks/:id/test` (1 MB body limit).
- Behaviour: runs the real generation scanner on pasted text or the current chat, showing which entries would fire and why (matched key, constant, recursion) and which matched but were held back by secondary keys, filters, groups or conditions.
- Tests: `lorebook-test-scan`.

### Lorebook activation stats, fired-in chats and Stale filter

- Commits: `a837cd319`; backlinks and Stale in `2f9737914`.
- Files: `packages/server/src/services/lorebook/activation-stats.ts`, `activation-backlinks.ts`, `db/schema/lorebook-activation-stats.ts`, `LorebookEntryFiredIn.tsx`; batched hook in `generate.routes.ts`.
- Behaviour: each entry counts real firings (each saved reply once; swipes and regenerations count, Continue does not) with last activation, a **Fired** sort and a **Never fired** filter. Entries remember the last 20 chats they fired in; clicking the count opens them. **Stale** filter: entries that have not fired in the last 7 to 180 days while the rest of the lorebook did. Counting is batched, never interrupts a generation, and is written out on shutdown.
- Setting: **Usage and activation stats** (`usageAndActivationStats`, default on).
- Schema: new table `lorebook_entry_activation_stats`.
- Tests: `lorebook-activation-stats`, `lorebook-backlinks`.

### Character duplicates

- Commit: `a837cd319`.
- Files: `CharacterDuplicatesModal.tsx`, `packages/shared/src/utils/character-duplicates.ts`, `lib/open-character-duplicates.ts`.
- Behaviour: **Duplicates** in the character library groups likely duplicates by matching names or very similar description and personality, with side-by-side basics, a field-by-field compare and an open button. Nothing is deleted automatically. Palette: "Find duplicate characters".
- Tests: `character-duplicates`.

### Character bulk tags

- Commit: `a837cd319`.
- Files: `CharacterBulkTagsModal.tsx`, `packages/shared/src/utils/character-tag-edits.ts`.
- Behaviour: add, remove or rename tags on selected characters from the library selection bar, with a review summary; each card saves through its normal path so version history records the edit.
- Tests: `character-bulk-tags`.

### Command palette

- Commit: `4922158c0` (feat/productivity); tool commands in `8e4a1ccff`; focus fix in `52464c6a7`.
- Files: `packages/client/src/components/command-palette/CommandPalette.tsx`, `CommandPaletteHost.tsx`, `palette-navigation.ts`, `packages/client/src/lib/command-palette.ts` (`registerCommand`), `stores/command-palette.store.ts`.
- Shortcut: **Ctrl+K** (Cmd+K on Mac), or the search button in the top bar.
- Behaviour: jump to chats, characters, personas, lorebooks, presets and Settings tabs, or run actions (new chat, light or dark mode, chat guide); recent picks first. Since `8e4a1ccff` it reaches Search all chats, Activity overview, Name generator, Find duplicate characters, and where they apply stats, Markdown or story export, the dice log and campaign codex, and Check or Test for the open lorebook. Later merges add the calendar, campaign log, random tables, prep board, initiative tracker, reading mode, chapters and generation jobs. `52464c6a7`: the search box is focused as soon as the lazily mounted content exists, so the first keystrokes after Ctrl+K are no longer lost.
- Tests: `command-palette`.

### Keyboard shortcuts overlay

- Commit: `4922158c0`.
- Files: `command-palette/KeyboardShortcutsOverlay.tsx`, `packages/client/src/lib/keyboard-shortcuts.ts`.
- Shortcut: **?** while not typing, or Keyboard shortcuts in the palette.
- Behaviour: lists every shortcut the app supports, grouped by where it works.

### Text snippets

- Commit: `4922158c0`.
- Files: `settings/TextSnippetsSettings.tsx`, `chat/SnippetPicker.tsx`, `packages/client/src/lib/text-snippets.ts`, `hooks/use-text-snippets.ts`, `hooks/use-snippet-expansion.ts`, `packages/shared/src/schemas/text-snippets.schema.ts`.
- Behaviour: define triggers such as `;ooc` in Settings > General > Text Snippets; type the trigger then Space or Tab in the chat, conversation or game input to expand it. `{{cursor}}` sets the caret; macros like `{{char}}` fill in at send; Ctrl+Z undoes an expansion. Also insertable from Quick replies or the palette; syncs across devices.
- Setting: app setting `text-snippets` (empty list means off).
- Tests: `text-snippets`.

### Usage dashboard

- Commit: `4922158c0`.
- Files: `settings/UsageDashboardSettings.tsx`, `hooks/use-usage-dashboard.ts`, `packages/server/src/routes/usage.routes.ts` (prefix `/api/usage`), `services/usage/usage-aggregation.ts`, `db/schema/generation-usage.ts`, `packages/shared/src/schemas/usage-dashboard.schema.ts`.
- Behaviour: Settings > Advanced; totals provider-reported tokens per reply by connection, chat and day over a chosen range, with an optional cost estimate from prices per 1M input and output tokens. Usage is recorded from this version on.
- Setting: **Usage and activation stats** (default on). Schema: new table `generation_usage`.
- Tests: `usage-dashboard`.

### Message bookmarks

- Commit: `8391f07d1` (feat/messages).
- Files: `chat/MessageMarks.tsx`, `ChatMessageMarksPanels.tsx`, `packages/shared/src/utils/message-marks.ts`.
- Behaviour: bookmark any message with an optional short label; the Bookmarks tab of chat search lists speaker, snippet and time and jumps to the message.
- Tests: `message-marks`.

### Pin to context

- Commit: `8391f07d1`.
- Behaviour: a pinned message (up to 10 per chat) stays in the prompt when the context message limit would drop it, sent in original order and marked as an earlier pinned message (`applyContextMessageLimitWithPins`). Peek Prompt shows the same result.
- Tests: `message-marks`.

### Message Trash

- Commit: `8391f07d1`.
- Files: `packages/server/src/services/storage/message-trash.storage.ts`, Trash tab in chat search.
- Behaviour: deleted Roleplay and Conversation messages go to a per-chat Trash; Restore returns a message to its original position with its swipes, bookmarks and notes; delete forever and empty trash; automatic purge after the retention days. Game and helper chats keep permanent deletes.
- Setting: **Message trash** (`messageTrash`, default on; `messageTrashDays` 30). Schema: new table `message_trash`.
- Tests: `message-trash`.

### Private message notes

- Commit: `8391f07d1`.
- Behaviour: attach a note to any message from its bookmark action; a small note icon shows it. Notes are never sent to the model and are left out of exports unless "Include private notes in exports" is on (default off).
- Tests: `message-marks`.

### Nested library folders

- Commit: `cc3d55b6c` (feat/organize, with the character tag-filter paging fix).
- Files: `packages/client/src/components/panels/library/LibraryFolderTree.tsx`, `use-library-organizer.tsx`, `packages/client/src/stores/library-organize.store.ts`, `packages/shared/src/utils/library-folder-tree.ts`, `packages/server/src/services/storage/character-folders.ts`.
- Behaviour: lorebook and character folders nest up to six levels; drag a folder onto another or to the top level; "New subfolder" and "Move folder to..." buttons; Move in selection mode picks a folder from the tree; counts include subfolders; open folders are remembered; search opens matching folders and shows each result's path. Deleting a folder moves its subfolders up one level. Preset and agent folders gain the same nesting on the server. Existing folders keep working.
- Schema: `parentId` on `library_folders` and `character_groups` (cycle-safe).
- Tests: `library-folder-tree`, `library-organize-migration`, `library-organize-unshard`.

### Library campaign view

- Commit: `cc3d55b6c`.
- Files: `LibraryCampaignBar.tsx`, `LibraryCampaignSections.tsx`, `LibraryCampaignBadges.tsx`, `LibraryPickerModal.tsx`, `packages/client/src/lib/library-campaign-filter.ts`, `hooks/use-library-campaigns.ts`, `packages/server/src/routes/library-campaigns.routes.ts` (prefix `/api/library`), `services/storage/library-campaigns.storage.ts`, `packages/shared/src/schemas/library-campaign.schema.ts`.
- Behaviour: a campaign picker above the Characters and Lorebooks lists shows one campaign's items (or everything in no campaign); the layers button groups the list into collapsible campaign sections. Campaigns come from game sessions (party, GM and linked NPC cards, active and chat-owned lorebooks, lorebooks linked to those characters). Rows show a campaign badge that filters on click; "Campaign" in selection mode or the swords button adds or removes items by hand. Each panel remembers its last choice.
- Schema: new table `library_campaign_links`.
- Tests: `library-campaigns`.

### Random tables and yes/no oracle

- Commit: `a03fe63a5` (feat/gm-tables).
- Files: `packages/client/src/components/tools/RandomTablesTool.tsx`, `modals/RandomTablesModal.tsx`, `hooks/use-random-tables.ts`, `packages/shared/src/utils/random-tables.ts`, `packages/server/src/routes/random-tables.routes.ts` (prefix `/api/random-tables`: list, create, update, delete, `/import`, `/roll`, `/oracle`, `/lorebook-sources/:lorebookId`, `/from-lorebook`), `db/schema/random-tables.ts`.
- Behaviour: tables roll on dice (d6, d20, d100, 2d6 with ranges such as 1-3) or by weight, can roll other tables with `[[Table Name]]` up to five levels, and are edited by pasting a plain list. Global or per game; JSON import and export; built from a lorebook folder or tag. The oracle answers at five likelihoods with yes, no, yes but, no but and exceptional results. Rolls can go to the Dice Log and into the chat input as an OOC note; nothing is sent automatically. Game Mode Tools tab and palette.
- Schema: new table `random_tables`.
- Tests: `random-tables`.

### Character usage and Unused

- Commit: `a03fe63a5`.
- Files: `packages/server/src/services/characters/character-usage.ts`, `routes/character-usage.routes.ts` (prefix `/api/character-usage`), `CharacterUsageSection.tsx`, `CharacterUnusedModal.tsx`, `hooks/use-character-usage.ts`.
- Behaviour: the character editor lists every chat and game a card is in (member, party member, NPC or GM), when each was last played and, on request, message counts. **Unused** lists cards in no chat. Reads only the chat list, never messages; cached until chats change.
- Tests: `character-usage`.

### Cross-feature integration review

- Commit: `ab891fb41` (feat/integration-review).
- Behaviour: fixes where the new tools meet: search, stats and palette seams, Danger Zone clears that also expunge the new tables, and usage recounts.
- Tests: `integration-expunge`, `integration-seams`.

### GM prep board

- Commit: `2f9737914` (nine reviewed features).
- Files: `packages/client/src/components/game/GamePrepBoard.tsx`, `modals/PrepBoardModal.tsx`, `hooks/use-prep-board.ts`, `packages/shared/src/utils/prep-board.ts`, `packages/server/src/routes/game-prep-board.routes.ts` (prefix `/api/prep-board`), `db/schema/game-prep-boards.ts`.
- Behaviour: a private planning board per game (strong start, scenes, secrets and clues, open threads, NPCs, locations, treasure, notes; renamable and reorderable). Items have a used checkbox, tags and an optional link to a character card or lorebook entry. Drag within and across sections or move with arrow keys on the handle; search the board or a `#tag`; archive used items; carry unfinished items to the next session. "To input" puts an item into the chat input as an OOC note without sending. Never sent to the model, hidden from the built-in helper, survives deleting sessions, JSON import and export. Tools tab and full-screen from the palette.
- Tests: `prep-board`, `prep-board-mari-privacy`.

### Chapters

- Commit: `2f9737914`.
- Files: `chat/MessageChapters.tsx`, `packages/client/src/lib/chat-chapters-events.ts`.
- Behaviour: start a chapter at any Roleplay or Conversation message from its bookmark action, with a title and optional summary. A divider marks it; the Chapters tab in chat search lists them; "Go to chapter" in the palette jumps; story exports use them as headings. Chapters follow the message through edits, swipes, trash and branches and are never sent to the model. In Game Mode, chapters are marked from the campaign log.
- Tests: `message-chapters`.

### Random table starter packs

- Commit: `2f9737914`.
- Files: `packages/client/src/lib/random-table-packs.ts`, `lib/table-packs/taverns-and-inns.json`, `roads-and-weather.json`, `town-life.json`, `treasure.json`, `story-complications.json`.
- Behaviour: five original fantasy packs with tables that roll into each other, added from the pack button in the Tables header for all games or the current game; tables whose names already exist are skipped.
- Tests: `random-table-packs`.

### Character quick reference

- Commit: `2f9737914`.
- Files: `packages/client/src/components/characters/NpcQuickReference.tsx`, `packages/client/src/lib/npc-quick-reference.ts`.
- Behaviour: hovering or tapping a linked character name in a chat message or Game narration shows a small card (avatar, short description, tags, Open card, where used). Enter opens it, Escape closes it. Never changes message text or copies. Name linking in long messages is faster with a large library.
- Setting: Settings > Advanced > Character quick reference, default off.
- Tests: `npc-quick-reference`.

### Lorebook bulk edit

- Commit: `2f9737914`.
- Files: `LorebookBulkEditPanel.tsx`, `packages/shared/src/utils/lorebook-bulk-edit.ts`, `packages/client/src/lib/lorebook-selection.ts`.
- Behaviour: in Select mode, Shift+click selects a range and Select all takes every entry matching the search and filters. Bulk edit enables or disables entries, turns Constant on or off, moves to a folder, adds or removes primary or secondary keys, and sets probability, order or depth in one all-or-nothing step. Deleting a selection is one request.
- Tests: `lorebook-bulk-edit`.

### Lorebook Markdown and CSV import and export

- Commit: `2f9737914`.
- Files: `LorebookTextImportDialog.tsx`, `packages/server/src/routes/lorebook-text.routes.ts`, `services/lorebook/text-import.ts`, `packages/shared/src/utils/lorebook-text-format.ts`.
- Behaviour: Markdown (a `## Name` heading per entry, optional `Keys:` line, then text) and CSV (name, keys, content, optional folder, enabled, constant and probability). Import previews entries with line-numbered errors and warnings, targets the open or a new lorebook, and skips, renames or overwrites existing names. Markdown and CSV join the export dialog.
- Tests: `lorebook-text-import`.

### Reading mode

- Commit: `2f9737914`.
- Files: `packages/client/src/components/modals/ReadingModeModal.tsx`, `packages/client/src/lib/reading-mode.ts`.
- Behaviour: Read in the branch menu or the palette opens a full-screen paged reader for roleplay chats that follows the active swipe, leaves out hidden messages, lists bookmarks as chapters and remembers the page per chat. Adjustable text size, line width, spacing and serif or sans.
- Shortcuts: arrow keys, J and K, Home and End turn pages.
- Tests: `reading-mode`.

### Initiative tracker

- Commit: `2f9737914`.
- Files: `packages/client/src/components/tools/InitiativeTracker.tsx`, `modals/InitiativeTrackerModal.tsx`, `hooks/use-initiative.ts`, `lib/initiative-draft.ts`, `packages/shared/src/utils/initiative-tracker.ts`, `packages/server/src/routes/game-initiative.routes.ts` (prefix `/api/game-initiative`: list, create, update, delete, `/roll`), `db/schema/game-initiative-encounters.ts`.
- Behaviour: add combatants from cards, lorebook entries or a typed name; roll initiative (each roll lands in the Dice Log as an Initiative roll); round counter, current, next and previous turn, HP and condition notes, move up or down, delay and remove. Encounters save per game and reopen from any session. **To input** drops the current turn into the chat input as an OOC note.
- Tests: `initiative-tracker`.

### In-world calendar

- Commit: `abc4f85a1` (feat/calendar-v2).
- Files: `packages/client/src/components/tools/GameCalendarTool.tsx`, `modals/GameCalendarModal.tsx`, `hooks/use-game-calendar.ts`, `packages/shared/src/utils/game-calendar.ts`, `packages/server/src/routes/game-calendar.routes.ts` (prefix `/api/game-calendar`, through the queued metadata path), `docs/game/calendar.md`.
- Behaviour: custom months, weekdays, era, leap years and moons, a month view, dated events and deadlines with an upcoming list. The calendar stores only the date of clock Day 1 next to `gameTime`, so the Day editor, time advance and calendar move one clock. The GM sees the date and upcoming events; a GM calendar widget lists them. Tools tab > Calendar or **In-world calendar** in the palette.
- Setting: chat metadata `gameCalendar`, per game, off until created. The GM time line uses it only when enabled (byte-identical otherwise) and stays out of the stable prompt block.
- Tests: `game-calendar-math`, `game-calendar-routes` (isolated `FILE_STORAGE_DIR`), `game-calendar-gm-stable`.

### Generation jobs (E02)

- Commit: `077e055ee` (feat/generation-jobs); logging follow-ups `1094acd08`, `62fb57271`, `1d35147fc`.
- Files: `packages/server/src/services/generation/generation-job-tracker.ts`, observer seam in `generation-jobs.ts` (fires after saves, never throws), `routes/generation-job-records.routes.ts` (prefix `/api/generation-job-records`), `db/schema/generation-job-records.ts`, client `GenerationJobsModal.tsx`, `generation-jobs/GenerationJobsActivityDot.tsx`, `GenerationJobsRecoveryHost.tsx`, `TrackedJobDetails.tsx`, `docs/development/generation-jobs.md`.
- Behaviour: while tracking is on, image, sprite and video jobs keep a saved status, result link and short log; refreshing, closing the tab or losing the connection does not stop them while the server runs; results that finished while away are announced on return. The viewer shows kind, chat, age, run time, error code and log trail; the top bar shows a dot while jobs run; "Open generation jobs" is in the palette. A restart marks running jobs interrupted (not retried). Finished jobs kept 7 days, up to 300; deleting a chat deletes its jobs.
- Logging: each transition is logged once (the store's `logJobState` is canonical for accepted, running and settled); failure lines drop echoed prompt text (see "Generation job failure lines drop echoed prompt text").
- Setting: `generationJobTracking`, default off (moved into Features on 2026-09-24). Schema: new table `generation_job_records`.
- Tests: `generation-job-tracking` (checks the whole failure line, error included, for a planted prompt).

### Lorebook folder power switch and campaign roster

- Commit: `80eaf5384`.
- Files: `packages/client/src/components/panels/library/use-lorebook-folder-toggle.tsx`, `LibraryFolderTree.tsx` (`renderFolderActions`, `isFolderDimmed`), `LibraryCampaignRoster.tsx`, `packages/client/src/lib/library-campaign-roster.ts`; route `POST /api/lorebooks/bulk-enabled` (returns changed, unchanged and missing ids).
- Behaviour: a small power button enables or disables every lorebook in a folder subtree after a confirmation; the following notice has an Undo that flips back exactly the lorebooks that changed; a folder whose lorebooks are all off shows its name dimmed.
- Behaviour: library campaigns carry a roster (GM, party, NPC card ids) derived from every session's metadata; filtering Characters to one campaign shows a foldable roster of chips that open the character; long groups show eight with "+N more".

### Lorebook selection Enable and Disable, in-chat dot, debounced search

- Commit: `8614962f1`.
- Files: `LorebookSelectionEnableActions.tsx`, `LibrarySearchInput.tsx`, `character-search-index.ts`.
- Behaviour: Lorebooks selection mode gets Enable and Disable with an Undo that flips back exactly the changed lorebooks; rows feeding the open chat show a small dot; Characters and Lorebooks search commit after a pause; character search fields are normalized once per loaded list.
- Tests: `card-library-search-index` (index answers exactly like the per-keystroke matcher), `library-folder-view-perf` (2000 items in 300 nested folders against a reference and a time budget).

### Library folders beyond loaded pages and tag delete

- Commits: `97ab74c71`, `e4098e218`.
- Files: `CharactersPanel.tsx`, `LorebooksPanel.tsx`, `use-auto-load-all-pages.ts`, `packages/server/src/routes/characters.routes.ts`.
- Behaviour: `fetchAllCharacterPages` reads `/characters/catalog` rows (raw rows carry no tags, so tag delete never matched). `/characters/catalog` accepts `ids=`, so folder members beyond loaded pages are fetched. Folder counts go through the visibility check; character folders keep creation order; tag delete is one bulk-tags request; tag filters, the full tag list and folders holding unloaded lorebooks load every page; folder errors show a toast; deleting a lorebook drops it from folders; cropped avatars render in panel rows; "Load more (N loaded)" counts only paged rows.

### Selection bar labels on phones and narrow panels

- Commit: `fae3d5747`.
- Files: `packages/client/src/components/ui/selection-action-classes.ts`, `LibrarySelectionExtraActions.tsx`.
- Behaviour: Export and Delete are inline-size containers and hide their label only when too narrow to show it whole; panel extras (Tags, Move, Campaign, Enable, Disable) are icon-only on phones and in right panels under 28rem. All buttons carry `title` and `aria-label`.
- Tests: `lorebook-scan-compaction` now pins `FILE_STORAGE_DIR` to its temp directory.

### Upstream sync 1 (Pasta-Devs `1d30a562c`)

- Commits: `90fd2894e` (merge of 145 upstream commits), `acef9788e`, `1efb58035`, `7e5fdccb8`.
- Brought in from upstream: Decision connections, scene busy checks, automatic translation, advanced-memory refresh, Opus 5.5 effort, GPT-6 and Grok models, Game helper output defaults, quick reply placement, reported prompt tokens.
- Conflicts: 31 files resolved keeping both sides. The fork's apostrophe and whisper-header fixes moved into shared `game-narration-text.ts`; the "ignored" attempt outcome and background `groupId` joined the shared connection admission types; a duplicate `aria-label` was removed from the agent editor Save button.
- `acef9788e`: 11 more conflicts; the fork's translation fixes (non-JSON provider replies become a named 502, Google Translate text sent in a POST form body) ported into `services/translation.service.ts`. `1efb58035`: Keeper extraction keeps upstream's truncation check inside the fork's parse guard. `7e5fdccb8`: `server-hunt-b24` and `server-hunt-b25` point at upstream's new code locations.

### Regression suite isolation and fixture hygiene

- `18875cd1f`: the open-issues check accepts a search-filtered journal timeline list.
- `792b58081`, `367dba6a8`, `7be167a69`, `a478a8b5f`, `1610c3e17`, `f8d405382`, `20167a05b`: fixtures and comments use invented neutral names mapped one to one; assertions unchanged apart from renamed strings.
- `c664bb44d`: the game log session name and random table scope render without template strings (the localization check flags them).
- `847beb80a`: locale keys for the game journal, party bar and state patcher.
- `cba450807`: pending `CHANGELOG.md` entries from the day's sessions.

### Process note: shared working tree

- Two HEAD repairs (`2ceb4b780`, `a0e614fc5`) and two restores (`a625e235e`, `1bb910e91`) came from zero-context hunks or stale file copies in a working tree shared by several sessions. Later commits go through a private git index.

## 2026-09-22

### Campaign-wide memory across Game sessions

- New `packages/server/src/services/game/campaign-memory-campaign-scope.ts`. Each Game session is its own chat, and continuity writes each session's memory into that chat, so a new session started with an empty memory. The campaign projection merges every earlier session of the same game (session number no higher than the current one; never a later session) into a read-only view of the current chat.
  - One entity per person across sessions. Identity is the owner reference; tracked NPCs and registry names fold into the library card of the same name.
  - Earlier facts are tagged with their session. Presence comes only from the current session.
  - Records carry `originChatId`/`originSessionNumber`, so edits go to the chat that owns them.
- Chat metadata `gameCampaignMemoryScope: "session"` opts a chat out. Wiki read routes take `?scope=session`; the default is campaign.
- Caches: a generation-keyed projection cache (4 projections), earlier-session memory keyed by the memory tables' write counters (24 sessions), and a source cache keyed by chat version. There is a background warm-up 15 seconds after start. The caches are bounded, which removed a heap-limit warning.
- Commits aa13ba294, 6f72a1c8e, 9c1552c01.

### Readable, relevant GM memory block

- `campaign-memory-context.ts`: fact lines read `[fact <id> S<n>] Name, predicate: text (if ...)` with names instead of entity ids; the `continuity.` prefix is stripped. Earlier-session state reads `Name: last known prop = value (S<n>)`.
- Relevance order: characters present in the scene, then people named in the latest turns (focus), then keyword matches, then recent event participants, then the rest.
- Continuity twin facts render once. GM knowledge lines cite the rendered fact.
- `packages/server/src/services/generation/game-gm-prompt-runtime.ts`: the default budget is 10,000 characters (was 6,000), setting `gameCampaignMemoryMaxCharacters`.

### Wiki and memory maintenance fixes delegated on 2026-09-22 (server)

- Campaign indexing keeps advancing after a partial run, a cancel stays cancelled, a deleted session is skipped, and a failed segment pauses the job.
- Stale backfill batches are re-planned when retried, and a turn whose batch went stale is read again when the same text comes back.
- One damaged game no longer stops the engine from starting.
- Undo clears fields an edit added.
- A commitment retry after a lost response returns the saved change.
- Duplicate review refuses to keep a fact another tab already retired.
- Branching a game with a large memory is faster.
- Completed events are classified as events.
- Item quantities are read next to the item, not from a year in the text.
- Very large stage timeouts are capped at the Node timer maximum.
- Repair can add a record for a message the extractor left unresolved.
- Deferred bug-hunt server fixes: Keeper regenerate replaces the session's entries, the NPC backfill works without the Biographer and stays within its id limit, a storyboard with no visual beats leaves no orphan row, and asset batches survive a missing location reference.
- Commits e8e485270, 1bb910e91 (the `game.routes.ts` hunks were dropped by a later stale-copy commit and restored).

### Extended HUD widget engine (shared)

- Files: `packages/shared/src/utils/hud-widget-extended.ts` (new), `packages/shared/src/index.ts`, `packages/shared/src/types/game.ts`, `packages/shared/src/utils/hud-widget-lifecycle.ts`.
- Behaviour: one pure implementation of the 19 extended widget types, used by live playback (client store), branch restoration (server), the GM prompt summary and both manual editors, so a command means the same thing everywhere. Exports `EXTENDED_HUD_WIDGET_TYPES`, `isExtendedHudWidgetType`, `normalizeExtendedWidgetConfig`, `defaultExtendedWidgetConfig`, `createExtendedWidgetConfig`, `applyExtendedWidgetUpdate`, `describeExtendedWidgetForPrompt`, `extendedWidgetConfigToText` / `extendedWidgetConfigFromText` (editor text codec), `EXTENDED_WIDGET_TEXT_FORMAT`, `calendarUpcoming`, `scheduleDayOf`, `parseScheduleEntry`, `normalizeWidgetText`, `leadingWidgetNumber`, `coerceWidgetValue`.
- Types: `HudWidgetType` gains the 19 types. `HudWidgetConfig` gains `tasks`, `entries`, `text`, `levels`, `current`, `tags`, `transactions`, `rumors`, `meters`. `WidgetUpdate.changes` gains `check`, `uncheck`, `text`.
- Tag syntax: no new keys. Every type reuses the existing `[widget:]` keys `add`, `remove`, `check`, `uncheck`, `text`, `value`, `max`, `stat`.
- Matching rules: duplicate checks are exact after normalization (case, accents, punctuation and spacing ignored), so "Goblin" and "Goblin Archer" are different entries; symbol-only text compares raw. Target lookups (remove, check, uncheck, stat, cursor moves) use an exact match, else the single entry that starts with the target; a longer target never resolves to a shorter entry.
- Value coercion: `coerceWidgetValue` turns a wholly numeric value into a number and keeps anything else as text (names, step words such as next). Numeric widgets read a leading number from text themselves (`leadingWidgetNumber`, so "3 days" is 3). The live tag parser and branch replay both use it, so they agree.
- Tests: `scripts/regressions/hud-widget-extended.regression.ts` (every type: behaviour, idempotent normalize, prompt summary, editor text round trip, branch replay, all review scenarios).

### Widget type: checklist

- Behaviour: tasks with a done flag, up to 12. Over the cap, done tasks leave first, then the oldest. Checking a task that is not listed adds it as done.
- Commands: `[widget: id, add: "Task"]`, `[widget: id, check: "Task"]`, `[widget: id, uncheck: "Task"]`, `[widget: id, remove: "Task"]`.
- Config: `tasks: [{ text, done }]`. Editor lines: `[x] Done task` / `[ ] Open task`.
- Render: box glyphs, done tasks struck through and muted.

### Widget type: schedule

- Behaviour: dated in-game appointments kept in day order (a day number is read from "Day 21", "day 3 dusk", "D21"; undated entries go after dated ones), up to 10. Re-adding the same event updates its time. Over the cap the earliest entry leaves first, never the entry just added.
- Commands: `[widget: id, add: "Day 21, dusk | Event"]`, `[widget: id, remove: "Event"]`.
- Config: `entries: [{ when, text }]`. Editor lines: `when | what`; undated text containing `|` is written with a leading ` | ` so it reads back unchanged.
- Render: accent-coloured "when" line above the text.

### Widget type: note

- Behaviour: one short status text (up to 600 characters); each text command replaces it.
- Commands: `[widget: id, text: "Status"]`.
- Config: `text`. Editor: the whole textarea is the text.

### Widget type: clock

- Behaviour: segmented progress clock, 2 to 12 segments (default 6); value is the filled count, clamped.
- Commands: create with `max: N`; `[widget: id, value: n]` (a leading number is read from text).
- Config: `value`, `max`. Editor line: `3 / 6`; typing only a value keeps the current max.
- Render: SVG circle cut into wedges plus `value / max`.

### Widget type: pips

- Behaviour: a row of filled or empty dots, 1 to 20 (default 5), for hope, stress, ammunition and similar.
- Commands: create with `max: N`; `[widget: id, value: n]`.
- Config: `value`, `max`. Editor line: `2 / 5`.

### Widget type: countdown

- Behaviour: a number counting down with an optional caption and optional starting value; turns urgent (red) at 1 or below, or at 20% or less of max.
- Commands: `[widget: id, value: n]`, `[widget: id, text: "days until the event"]`, optional `max`.
- Config: `value`, `max?`, `text`. Editor line: `3 / 10 | caption`.

### Widget type: tug_of_war

- Behaviour: a bidirectional bar from -max to +max (max 1 to 20, default 5) for chases, contests and negotiations; positive favours the right side.
- Commands: create with `max: N`; `[widget: id, value: n]` (negative allowed); `[widget: id, text: "Left side | Right side"]`.
- Config: `value`, `max`, `text` (side names). Editor line: `-2 / 5 | Left | Right`.

### Widget type: tier_track

- Behaviour: escalating levels (for example an alert or heat level), up to 10, with a current level that can go up or down.
- Commands: `[widget: id, add: "Level"]` in order; `[widget: id, value: "Level"]`, its 1-based number, or a step word (`up`/`next`/`raise`, `down`/`back`/`previous`/`lower`); `[widget: id, remove: "Level"]` keeps the cursor on the same level. An unknown level name is appended (within the cap).
- Config: `levels`, `current` (0-based). Editor: one level per line, `> ` marks the current one.
- Render: segmented bar coloured up to the current level, current level name, next level preview.

### Widget type: stages

- Behaviour: ordered quest or journey steps, up to 10; steps before the current one show as done.
- Commands: same as tier_track (`add`, `value` by name, number or step word, `remove`).
- Config: `levels`, `current`. Editor: one stage per line, `> ` marks the current one.
- Render: vertical stepper (done, current, pending glyphs).

### Widget type: tags

- Behaviour: short state chips (conditions, statuses), up to 10, unique; over the cap the oldest leaves.
- Commands: `[widget: id, add: "Poisoned"]`, `[widget: id, remove: "Poisoned"]`.
- Config: `tags`. Editor: one tag per line.

### Widget type: ledger

- Behaviour: a balance plus the last 6 transactions. Adding a transaction changes the balance; removing one reverses it. Thousands separators are read correctly ("+1,000" is 1000; "1,5" is a decimal comma).
- Commands: `[widget: id, add: "+50 | Reason"]` or `"-20 | Reason"`; `[widget: id, value: n]` sets the balance; `[widget: id, text: "gold"]` sets the unit; `[widget: id, remove: "Reason"]`.
- Config: `value` (balance), `text` (unit), `transactions: [{ amount, text }]`. Editor: first line `120 gold`, then `+50 | Reason` lines.
- Render: large balance, gains green and losses red.

### Widget type: log

- Behaviour: newest-first event feed, 6 kept; re-adding an event moves it to the top.
- Commands: `[widget: id, add: "Event"]`, `[widget: id, remove: "Event"]`.
- Config: `items` (newest first). Editor: one event per line.

### Widget type: rumor_board

- Behaviour: rumors with a status of unverified, confirmed or false, up to 8; over the cap settled rumors leave first. Adding never overwrites a status; check and uncheck add the rumor when it is missing.
- Commands: `[widget: id, add: "Rumor"]`, `[widget: id, check: "Rumor"]` (confirmed), `[widget: id, uncheck: "Rumor"]` (proven false), `[widget: id, remove: "Rumor"]`.
- Config: `rumors: [{ text, status }]`. Editor lines: `[?] Unverified`, `[x] Confirmed`, `[-] False`.

### Widget type: obligations

- Behaviour: debts, favours and promises, using the checklist rules (check when settled); text after `|` shows as terms.
- Commands: `[widget: id, add: "Party owes the guild | 200 gold"]`, `[widget: id, check: "Party owes the guild"]`, `uncheck`, `remove`.
- Config: `tasks`. Editor lines: `[ ] Text | terms` / `[x] Settled`.

### Widget type: turn_order

- Behaviour: an ordered list of names with a current turn, up to 12; `next` wraps around. Removing an earlier name keeps the same person current.
- Commands: `[widget: id, add: "Name"]`, `[widget: id, remove: "Name"]`, `[widget: id, value: "Name"]`, its 1-based number, or `next` / `back`.
- Config: `items`, `current`. Editor: one name per line, `> ` marks the current one.

### Widget type: scoreboard

- Behaviour: named scores, up to 8, shown sorted with the leader highlighted and proportional bars.
- Commands: `[widget: id, stat: "Side", value: n]`; `[widget: id, add: "Side"]` adds a row at 0; `[widget: id, remove: "Side"]`.
- Config: `stats: [{ name, value }]`. Editor lines: `Side | 3`.

### Widget type: bars

- Behaviour: several named meters (value out of max), up to 8, each with a bar.
- Commands: `[widget: id, add: "Name | 3 / 10"]` (or `"Name | 10"`, value then 0); `[widget: id, stat: "Name", value: n]` (clamped); `stat` plus `max` changes a meter's max; `remove`.
- Config: `meters: [{ name, value, max }]`. Editor lines: `Name | 3 / 10`.

### Widget type: charges

- Behaviour: named uses such as spell slots, drawn as pips when the max is 12 or less. Adding "Name | N" starts full.
- Commands: same as bars.
- Config: `meters`. Editor lines: `Name | 2 / 4`.

### Widget type: calendar

- Behaviour: in-game date with today's day number, a label, a configurable week length (3 to 12 days, default 7), a three-week day grid with today highlighted and event days marked, and the next three events counted in days. Events use the schedule rules and cap.
- Commands: `[widget: id, value: n]` (today) or `next` / `back`; `[widget: id, text: "date label"]`; `[widget: id, max: N]` (days per week); `[widget: id, add: "Day 21 | Event"]`; `remove`.
- Config: `value`, `max`, `text`, `entries`. Editor: first line `18 / 7 | Date label`, then `Day 21 | Event` lines.
- Locale: `ui.game.extendedwidgets.dayValue`.

### GM widget create and delete commands

- Files: `packages/shared/src/utils/hud-widget-lifecycle.ts` (`applyHudWidgetLifecycle`), `packages/client/src/lib/game-tag-parser.ts`, `packages/server/src/services/game/branch-state.ts`, `packages/server/src/services/game/gm-prompts.ts`.
- Behaviour: the GM can create and delete widgets during play; create never overwrites an existing widget. Extended types get their default config plus create-time `value`, `max` and `text` (`createExtendedWidgetConfig`). Branch replay passes the same create fields (including `text`) and the same value coercion as live playback.
- Commands: `[widget: id, action: create, type: <type>, label: "Label", position: hud_left|hud_right, value, max, count, seconds, running, text, icon]`, `[widget: id, action: delete]`.
- Settings: `enableCustomWidgets`; the Extended widgets feature switch (`gameExtendedWidgetsEnabled`, added separately) swaps the GM widget block to upstream's text when OFF.
- Server validation: both widget type enums in `packages/server/src/routes/game.routes.ts` (`hudWidgetSchema` and the blueprint schema) list all 27 types.

### GM prompt widget catalog

- Files: `packages/server/src/services/game/gm-prompts.ts`.
- Behaviour: the GM instructions carry a compact catalog of the extra types with their commands, telling the model to pick one only when it shows something a list or stat_block would not. `buildWidgetSummaryLines` describes each extended widget's current state via `describeExtendedWidgetForPrompt`. The setup blueprint prompt lists each type's config shape, and its JSON template lists every type.
- Cache: these lines sit in the stable prompt section; each change rebuilds the prompt cache once per game.

### Widget editors (setup editor and in-game manual editor)

- Files: `packages/client/src/components/game/GameWidgetSetupEditor.tsx`, `packages/client/src/components/game/GameWidgetPanel.tsx`.
- Behaviour:
  - The setup editor offers all 27 types with per-type default accent and icon; extended types edit through the text codec in a field that commits on blur and then shows the text actually kept.
  - The in-game manual editor edits extended types through the same codec, shows the format hint (`ui.game.widgeteditormodal.formatHint`), and shows a live preview of the widget below the textarea (`ui.game.widgeteditormodal.preview`).
  - Both editors edit in draft mode, so labels and stat names keep typed spaces and can be cleared; they normalize strictly on save or submit.
  - The editor no longer wipes the draft when the widget refreshes during a model turn; closing is blocked while saving.
  - Text boxes use automatic text direction (right-to-left text).
- Server limit: widget accent max length 32 to 64 (the default accent `var(--marinara-chat-chrome-accent)` is 34 characters, so Relationship Meter and Timer widgets failed game creation and widget saves with 400).

### Extended widget renderers

- Files: `packages/client/src/components/game/ExtendedWidgets.tsx` (new), `packages/client/src/components/game/GameWidgetPanel.tsx`.
- Behaviour: one `ExtendedWidgetView` renders every extended type. Accent-coloured text is blended with the panel text colour for contrast on light panels; long labels, large numbers and right-to-left entries lay out without overflow. JSX output uses no template literals (the localization check flags them).
- Icons: `widgetIcon()` falls back to the type's default icon, so GM-created widgets (which carry no icon) are distinguishable in the phone tray, tucked panels and headers.
- Verified: all 19 types at 390px, 1024px and 1600px in the sandbox and on a live example campaign (no errors, no overflow).

### Memory panel and "How the GM uses memory" settings
- Commits: d33b9e631, 5c596f053, 12331af21.
- Files: `components/game/GameContinuityPanel.tsx`, `components/game/GameMemorySettings.tsx` (new), `components/game/GameSurface.tsx` (two edits); regression `scripts/regressions/game-memory-settings-ui.regression.ts` (new).
- Behaviour:
  - The continuity panel now renders in the game Session panel (GameSurface passes `chatId` and `chatMetadata` to GameSessionHistory; without them the panel never appeared).
  - The desktop Session panel is clamped on screen when the toolbar sits at the left (module-level ref, `translate`, re-clamps on resize).
  - Health headline, progress, filtered batch list, and continuity mode can be turned on from Off. With no memory connection the headline reads "Paused: no memory connection".
  - "How the GM uses memory" block: Replace the Lorebook Keeper switch, recaps of earlier sessions, memory scope, and GM memory budget. Each control saves on change.
- How to reach: game chat, Session panel, Memory settings.
- Settings and defaults (chat metadata):
  - `gameContinuity.ownership` `{lorebook: "continuity" | "keeper", fromSession}`; the switch sends `{lorebook: "continuity", fromSession: <current session>}`. No saved ownership while memory is On already means the Keeper is off (server legacy gate), so the switch shows on.
  - `gamePromptRecentSessionLimit`: All (null, default) or last 1, 2, 3, 5, 10.
  - `gameCampaignMemoryScope`: "campaign" (default) or "session".
  - `gameCampaignMemoryMaxCharacters`: empty (null) means the default 10000; clamped 1000 to 100000; half-typed input restores the saved value.
- Tests: regression `game-memory-settings-ui` (panel wiring, PATCH contracts, clamping, locale keys).

### Campaign Wiki reader redesign (client)

- Commit: `d33b9e631`.
- Files: `packages/client/src/components/game/CampaignWiki.tsx`, `CampaignWikiWindow.tsx`, new shared kit `campaign-wiki-ui.tsx` (used by the editor, create form, commitments, evidence, owner link and campaign index dialog).
- Behaviour: searchable page rail, overview with people and places, entity pages with tabs, readable fact cards, evidence per origin session, and a day-grouped timeline.
- Fixes: commitments reload after a 409 refetches; create-record waits for the owner check of the exact id; the editor rejects condition values that do not match their type instead of saving null or false.

### Dev MCP v2.0 and sandbox (outside the repo)

- Location: `D:\Marinara Engine Staging\marinara-dev-mcp-v2.0` (`server.mjs`, `lib/`, `test-client.mjs`); journal `.dev-mcp\journal.jsonl`.
- Behaviour: one MCP server for Claude Code and Codex with orientation, chat, prompt and cache, diagnostics, character, settings, development and sandbox tools (listed in the inventory). The sandbox on port 7862 runs the same build against a sanitized copy of the live store, so it can never spend model quota or post anywhere.
- Safety: shared engine lock, quiet wait of 150 s before live restarts, dist backup and rollback, backups of every edited card and chat setting, bounded output saved under `.dev-mcp\out`.
- Incident fix: the first live deploy built correctly but its `cmd /c start` launch never ran `start.bat`, leaving the live server down for about 19 minutes; the tool now starts `run-server.mjs` directly through PowerShell `Start-Process`, and the live health wait is 12 minutes.

### Work started this day and committed on 2026-09-23 (from the Dev MCP journal)

- The lore-flip cause (random inclusion-group pick) was found by diffing two next-turn previews and fixed in source; committed as `ede160d9d`.
- The World Maps spatial block was moved out of the cached prefix for non-subscription providers; committed as `0d9ba9004`.
- A whole-fork review (57 reviewers plus adversarial verification) confirmed 81 bugs: 27 memory-system bugs went to their owners, the rest were applied to the working tree and committed as `660d992fa` and the game UI commits of 2026-09-23.
- The launcher's `git clean` deleted untracked source files (including the extended widget and projection modules) during a relaunch; they were recreated, and `962e36777` prevents a repeat.
- Feature branches built this day in separate worktrees (search, game tools, library, productivity, messages, organize) were merged on 2026-09-23 and are described there.
- Validation boundary: these items come from the journal; their verification is recorded under the commits that landed them.

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

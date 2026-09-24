# Technical changelog

## Fork feature inventory (vs upstream Pasta-Devs staging)

A standing list of everything this fork carries over upstream `Pasta-Devs/Marinara-Engine` `staging`, so no feature is forgotten. Every user-visible feature, shortcut, route, setting and behaviour gets its own bullet. Update this list whenever a feature lands, changes its switch or is dropped.

- Baseline (2026-09-24): branch `memory-system-finish` at `bcb5006ea`; merge base with `upstream/staging` is `60ed7ec80` (upstream sync 2). `git log upstream/staging..HEAD` lists 159 fork commits (154 without merges). Most of the Game Mode base (storyboards, Contact Book, scene timeline, continuity, first Campaign Wiki) arrived in one large commit, `44fba2b25` (2026-09-20, 770 files).
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
- Reviewed server bug fixes from the 2026-09-22 whole-fork review and the 2026-09-23 non-game server review, each batch with a `server-hunt-b<N>` or `bughunt-*` regression: runtime-config `.env` reload diff, fatal-error flush, IP allowlist CIDR and IPv6, per-route rate limits, SSRF reserved-address checks, background uploads, export name collisions, backup central directory cap, storage pre-shard restore and writer lease, importers, providers, textual tool-call parsing, sidecar downloads, deleted built-in regex scripts staying deleted. Always on.
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

- Memory panel: health headline, progress, filtered batch list, "How the GM uses memory" (Keeper hand-off, recap limit, campaign or session scope, memory budget). Files: `GameMemorySettings.tsx`, `GameContinuityPanel.tsx`.
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

### Game Mode UI and layout (27)

Edit layout (`GameLayoutEditToolbar.tsx`, `GameLayoutPopover.tsx`, `lib/game-layout-editor-store.ts`, `game-layout-geometry.ts`, `game-layout-snapshots.ts`, `game-layout-tidy.ts`; no switch yet):

- Edit mode shows a grid, outlines and a name tag per panel; Esc leaves edit mode.
- Drag a panel from anywhere; resize from every edge and corner with a live size readout.
- Snapping to screen edges, centres and neighbours with guide lines; hold Alt to place freely.
- Collisions switch: on, a dropped panel settles into the nearest free space; off, panels overlap on purpose and a click brings one to the front.
- Undo and redo: Ctrl+Z and Ctrl+Shift+Z (AltGr chords ignored).
- Keyboard nudge: arrow keys move a focused panel (Shift+Arrow in larger steps; Ctrl, Alt and Meta ignored); move and resize handles carry the panel name for screen readers.
- Lock all and unlock all; Panels menu to hide and bring back panels.
- Saved layouts: name, apply, rename (Esc cancels), delete, share as JSON, reuse in any game; imports over 512K characters refused; storage failures roll back instead of half-applying.
- Reset all to defaults.
- Tidy: packs panels into non-overlapping columns keeping their rough side and order.
- Shift+click selection with align left, right, top and match width; each action is one undo step.
- Per-panel options menu on the name tag: lock, reset, growth, collapse to an edge, widget stacks, narration bottom pin, toolbar top-centre pin.
- Manual heights survive content growth and crowded reflow; crushed heights are never persisted; the storyboard fills its box.

Layout and phones:

- Layouts follow the campaign across sessions (edge bookmarks, collapsed state, stacks, pins). Files: `lib/game-panel-layout.ts`, `hooks/use-map-layout.ts`.
- Phone widget tray: one horizontally scrolling row of widget tabs with 44px targets, fading edge, Game status as a tray tab that opens a sheet (`GameMobileStatus.tsx`).
- Phone Arrange sheet: reorder, hide and show widgets, stored per device under its own key prefix. Files: `GameMobileArrange.tsx`, `lib/game-mobile-panel-arrangement.ts`.
- Phone presence strip: Currently Present as one row of whole-name chips with the Campaign Wiki button; joins the top row on landscape phones while the toolbar folds into the actions menu.
- Phone storyboard: a slim closed tab under narration that opens a sheet above the composer; the composer is pinned to the bottom of narration.
- Landscape phones (below 1024px wide and 32rem tall): map, party, the tab tray, a storyboard icon and the actions button share one top row; Currently Present and the image retry line become tray tabs that open sheets; the composer stays one line until focused; narration gets 65 to 69% of the height.
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

### Phones: top navigation with a More menu

- Commits: `a4049498b`, `d2a7e9094`.
- Files: `packages/client/src/components/layout/TopBar.tsx`, `PersonalExtensionContributionsMenu.tsx`, `ChatSidebar.tsx`, `RightPanel.tsx`, `packages/client/src/components/ui/Modal.tsx`, `TouchDragHandle.tsx`, `HomeBrowserHub.tsx`, `styles/globals.css`.
- Behaviour: below 640px the top nav keeps Home, Chats, Characters and Settings as 38px buttons and moves Search, Personas, Lorebooks, Presets, Connections, Agents, Generation jobs and extension buttons into a labelled More menu (44px rows, active check, jobs dot, closes on rotate). An active item from the menu shows on the bar. Landscape phones keep all buttons at 38px. Top bar height unchanged (51px); desktop unchanged.
- Keys: arrow keys, Home and End move through the More menu; Escape closes it and returns focus.
- Also: modal and side-panel close buttons, home widget drag handles and row drag handles reach 36px on touch.
- `d2a7e9094` reverts this commit's size changes to the built-in helper popup at the user's request; the home widget drag-handle fix in the same file is kept.

### Phones: landscape chat list

- Commit: `a4049498b`.
- Behaviour: on short landscape screens the chat list sidebar scrolls as one column with its header pinned, so chats are visible at 740x360.

### Touch: readable text and 36px targets in modals, tools and editors

- Commit: `ad7a61ad1`.
- Behaviour (pointer-coarse only, desktop unchanged): text at 0.5625 to 0.625rem becomes 0.6875rem; small icon buttons and h-7/h-8 buttons and inputs reach 36px, overriding `mari-chrome-control` sizes where set.
- Covered: Create and Import dialogs, character card update, Create Connection providers, possible duplicates, chat stats, docs, activity, SillyTavern import, Search All Chats, random tables, name generator (chips and surname), initiative tracker (encounter select no longer clipped), calendar, the character, persona, lorebook and preset editors, and the Campaign Wiki window (chips, See all, Retry, Tools).
- Measured at 360px: flagged small text 1547 to 511 and small targets 1021 to 342 across the compared modals; no horizontal overflow.

### Phones: music bubble, composer caps and emoji picker

- Commit: `7d83a801c`.
- Behaviour: the collapsed YouTube or local music bubble is clamped inside the screen with room kept for the composer and re-positions on rotation and when the on-screen keyboard opens (it sat on Send at 740x360 with the keyboard up).
- Behaviour: on wide-but-short screens the roleplay composer caps at 30% of screen height (max 200px) and the conversation composer at 30% (max 160px), re-sizing on keyboard or rotation, so long drafts no longer hide attach, emoji and send.
- Behaviour: the conversation emoji, GIF and sticker picker is opaque on phones; the swipe number box is 36px tall with 12px text on touch; roleplay timestamps are 11px below 768px.

### Phones: side panel touch floor and Settings in landscape

- Commit: `0b05da7f2`.
- Files: new `packages/client/src/components/panels/panel-phone-floor.ts`; panel roots for lorebooks, presets, personas, connections, characters and agents; `SettingsPanel.tsx`.
- Behaviour: shared classes give buttons, selects and inputs a 36px minimum and small text 11px on narrow and touch screens; opt out with `data-touch-compact`.
- Behaviour: list-row actions sit beside the text instead of over it and wrap to a second line when narrow, so names are no longer cut or covered.
- Behaviour: Settings on short landscape screens shows one row of six text tabs beside Quick Access and a compact search header (settings area about 35 to 170px at 740x360).
- Behaviour: the Load more bar sits at the end of the list on short screens; selection checkboxes, campaign badges and library folder header actions get 36px hit areas.

### Phones and tablets: compact editor header, touch targets, palette fit

- Commit: `e82a2d1f8`.
- Behaviour: on short landscape screens the editor header stays on one row (lorebook, preset and persona header 107 to 48px at 740x360); on portrait phones the section picker shrinks first.
- Behaviour (touch): editor actions 38px; section jumps and chat message actions 36px; textarea tool icons get an invisible 37px hit area; markdown links get an invisible vertical hit extension with no line-spacing change.
- Behaviour: the command palette (Ctrl+K) opens at the top on short screens with its list capped to fit; shortcut hints are hidden on touch; its small text is 11px.
- Behaviour: the update toast sits below chat and editor headers on touch; Refresh 38px, close 36px hit area.
- Checked at 360 to 915px phone sizes and tablets 768x1024, 820x1180, 1024x768, 1180x820, 1366x1024.

### Touch tablets: 36px chat controls and readable timestamps

- Commit: `4909d11f7`.
- Behaviour: at 768px and wider, touch tablets get the desktop chat layout with larger controls on coarse pointers only. Chat header buttons use the new `getChatTouchToolbarButtonClass` (search, active lorebook entries, notebook, roleplay surface, conversation view, roleplay HUD, branch selector, identity pill); the shared default size is untouched, so Game Mode buttons are unchanged.
- Behaviour: composer buttons, quick connection switcher, swipe arrows and chat settings profile and close buttons stay at 36px or more; top-bar music player buttons get invisible 36px hit areas; its subtitle and roleplay timestamps are 11px on touch.
- Measured: undersized controls on tablets fell from 23 to 25 to 8 to 9 (conversation) and from 20 to 22 to 2 to 3 (roleplay); no overflow at the five tablet sizes.

### Touch: persona switcher, volume sliders and branch badges

- Commit: `d9e519954`.
- Behaviour: Quick Persona Switcher is 36px or taller on touch; YouTube and custom-music volume sliders get a 36px touch height that wins over the generic range-input rule (visible track stays slim); branch count badges read 11px through a local class. The shared `mari-chrome-muted-badge` rule is untouched because the built-in helper uses it.

### Phones and tablets: connection and agent editors, switches, settings text

- Commit: `e8c42afc9`.
- Behaviour: the panel phone floor now wraps the connection editor, agent editor, regex script editor, tool editor and feature agent detail host (11 small controls and 32 small labels gone from the connection editor at 390px).
- Behaviour: toggle switches (38x21 labels around hidden checkboxes) get an invisible 38x38 hit area; the track looks the same.
- Behaviour: the Settings quick replies checkbox label reaches 36px on touch; section and switch descriptions, the sound status chip and background picker chips read 11px on narrow and touch screens (also in the chat drawer).
- Checked on phones and the five tablet sizes: no overflow, no text under 11px, desktop unchanged.

### Game Mode on phones: widget tray, status sheet and presence strip

- Commit: `eee40df22`.
- Files: `packages/client/src/components/game/GameSurface.tsx`, `GameWidgetPanel.tsx`, `GameMobileStatus.tsx`, `GameNarration.tsx`.
- Behaviour: the widget tray scrolls tab by tab without a visible scrollbar or clipped tabs, fades where more tabs wait and keeps Arrange on screen.
- Behaviour: Game status becomes a tray tab that opens a sheet instead of filling the top half.
- Behaviour: Currently Present uses an icon and whole-name chips in one row; on landscape phones it joins the top row while the toolbar folds into the actions menu, so narration keeps most of the height. Desktop unchanged.

### Game Mode on phones: storyboard sheet and pinned composer

- Commit: `f5cd40182`.
- Files: `GameStoryboardViewer.tsx`, `GameStoryboardTimings.tsx`, `GameNarration.tsx`, `GameSurface.tsx`.
- Behaviour: on phones the storyboard is a slim tab under the narration, closed by default, that opens a sheet in the free space above the composer, with a close button; Escape closes it.
- Behaviour: timings, request errors, counts and generation details fold into one Details disclosure on every screen size; a failure shows one line with Retry.
- Behaviour: the composer is pinned to the bottom of the narration on phones; the image retry banner becomes a compact line clear of narration and composer.

### Floating music widget avoids marked controls

- Commits: `854989034`, `fa8ddf74b`, `16c55356f`.
- Files: new `packages/client/src/lib/floating-widget-avoid.ts` (placement math) and `hooks/use-floating-widget-avoid.ts`; `LocalMusicPlayer.tsx`, `YouTubePlayer.tsx`, `SpotifyMiniPlayer.tsx`.
- Behaviour: the collapsed YouTube or local music bubble and the Spotify mini player avoid any element marked `data-floating-widget-avoid` (Game Mode marks the Currently Present strip with its Campaign Wiki button, the widget tray, the storyboard tab and the Game actions button). A free spot, including one the user dragged to, is only clamped; an overlapping spot moves to the nearest free spot on the right edge, else the left; with no free spot the clamped position stays. The saved position is never rewritten. The Spotify bubble gets the composer clearance too.
- Performance: measurement runs on mount, resize, rotation, keyboard, marker add and remove, and a light 1.5 s check, at most once per frame, only while a phone bubble is mounted.
- Tests: `scripts/regressions/floating-widget-avoid.regression.ts`.

### Landscape phones: one top row for Game chrome

- Commit: `5bf5ff31f`.
- Files: `packages/client/src/components/game/GameSurface.tsx`, `GameMobileStatus.tsx`, `GameMobileArrange.tsx`, `GameInput.tsx`, `GameNarration.tsx`, `GameStoryboardViewer.tsx`.
- Behaviour: below 1024px wide and 32rem tall, the map, party, the tab tray, a storyboard icon and the actions button share one top row. Currently Present and the image retry line become tray tabs that open sheets, the actions menu opens as a row, and the composer stays one line until focused. The narration column gets 65 to 69% of the height at 740x360 to 915x412. Portrait and desktop unchanged.
- Tests: new `scripts/regressions/game-mobile-landscape.live.mjs`; `game-mobile-layout.live.mjs` and `game-storyboard-phone.browser.mjs` updated.

### Tablets and landscape phones: editor targets, category bar, wiki fit

- Commit: `795b87b66`.
- Files: `packages/client/src/components/characters/CharacterEditor.tsx`, `personas/PersonaEditor.tsx`, `lorebooks/LorebookEntryRow.tsx`, `LorebookFolderRow.tsx`, `game/CampaignWikiOverview.tsx`, `CampaignWikiRail.tsx`, `CampaignWikiWindow.tsx`.
- Behaviour (touch): Generate avatar with AI gets a 36px hit area from the editors (the shared button file is unchanged); avatar tile, Upload, sprite tabs, Images tab and expression quick-add chips are 36px.
- Behaviour: the character editor Library category bar is a single slim row below 500px screen height (about 56 to 44px at 740x360).
- Behaviour (touch): lorebook entry and folder row drag and expand chevrons get 36px hit areas.
- Behaviour: Campaign Wiki Hide navigation is 36px wide; filter chips and Latest in the story entity links are at least 36px on touch; the top bar is tighter below 500px height; People cards wrap to fit instead of a fixed two columns (names were cut at 768px).
- Checked at 768x1024, 820x1180, 1024x768, 1180x820, 1366x1024 and 740x360: no overflow.
- `bcb5006ea` updates `CHANGELOG.md` for the job tracking setting's new place.

### GM prep board on phones

- Commit: `d1ec31bbc`.
- Behaviour: on touch screens every prep board control (buttons, inputs, menu items, drag handle, done box, search clear, link chips, tags) is at least 36px and small labels step up to 11px. Desktop pixel-identical.

### Edit layout fixture stabilised

- Commit: `92528c1c1`.
- Tests: applying a saved layout remounts every panel; on a loaded machine the remount could land after the Shift+Arrow press and put the panel back. The fixture now waits until the panel holds still before nudging.

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

### World Maps spatial block out of the cached prefix on all providers

- Commit: `0d9ba9004`.
- Files: `packages/server/src/services/generation/prompt-cache-layout.ts` (`keepGameDialogueAdjacent`).
- Problem: on providers without the subscription cache layout, the location-dependent `<spatial_context>` block sat right after the system prompt, so every move rewrote the whole history behind it.
- Behaviour: leading runtime and dynamic-lore system injections, including the World Maps block, move to just before the current user turn in Game Mode.
- Setting: part of **Cache-friendly prompt layout** (`cacheFriendlyPromptLayout`, default on) since `8aa93818b`.

### Stable lorebook inclusion-group winner per chat

- Commit: `ede160d9d`.
- Files: `packages/server/src/services/lorebook/keyword-scanner.ts` (`ScanOptions.groupSeed`, seeded group random), `packages/server/src/services/lorebook/index.ts`; later `group-pick-policy.ts` for the switch.
- Problem: an inclusion group re-rolled its winner with `Math.random` on every generation, so a different entry landed near the top of the prompt each turn and broke prompt caching on selective-lore connections. Found on 2026-09-22 by diffing two consecutive next-turn previews (the first lore entry flipped with no change in between) and reproduced 3 of 3 in the sandbox.
- Behaviour: the winner is seeded by chat id, group and candidate set: stable across turns, still varied across chats and when the activated candidates change. Injected random sources keep their behaviour.
- Setting: **Stable lorebook picks** (`stableLorebookGroupPicks`, default on; env `LOREBOOK_STABLE_GROUP_WINNERS` wins).
- Tests: `scripts/regressions/feature-switch-lorebook-picks.regression.ts`.

### Peek Prompt shows the layout a real turn sends

- Commit: `bd402ac7c`.
- Files: `packages/server/src/routes/chats.routes.ts`, `prompt-cache-layout.ts`.
- Problem: the live preview (and the Dev MCP `get_prompt which=next`) had no pending player message, so runtime blocks such as the World Maps context showed right after the system prompt, unlike a real game turn on a non-subscription provider.
- Behaviour: new `layoutAsNextTurn` applies the same reordering as generation around a placeholder turn, then removes it; the response is labelled `layout: "next-turn"`.
- Tests: `scripts/regressions/peek-prompt-next-turn-layout.regression.ts`.

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

### Campaign Wiki: article pages

- Commits: `05d60f159` (with `95eac9867` and `f66d35889` as checkpoints so untracked components could not be lost to the launcher's `git clean`).
- Files: `packages/client/src/components/game/CampaignWiki.tsx`, `CampaignWikiInfobox.tsx`, `CampaignWikiFacts.tsx`, `CampaignWikiReaderParts.tsx`, `campaign-wiki-ui.tsx`.
- Behaviour: hero with large portrait and one meta line; main column plus an infobox (Right now, Connections, Open promises, On this page) that follows the reading pane width through container queries.
- Behaviour: pinned canon block at the top; facts as compact rows grouped by session (server `factSessions` counts, per-session paging), search through `factQuery`, kind chips from `factKinds`, withdrawn facts folded.
- Behaviour: row actions Pin as canon (`value.pinned` plus `manualLock`), Unpin, Correct (opens the editor on that fact), Wrong (retract and lock, reload on 409). Other sections (knowledge, events, connections, timeline, promises, details) open in the main column from the infobox; no tab bar.
- Tests: fixture mock covers sessions, kinds, pinned and retracted facts, filters and an older server without `factSessions`; reader suite 49 checks.

### Campaign Wiki: front page and grouped page list

- Commit: `bc4beedf7`.
- Files: `CampaignWikiOverview.tsx`, `CampaignWikiRail.tsx`.
- Behaviour: the page list groups by kind (People, Player characters, Places, then Organizations, Items, Quests, Lore, Notes) with counts from `kindTotals` and `sort=kind`; big groups start collapsed and load on open; search ranks matches, then people and places before lore; identical names collapse into one row ("Lore, 17 pages").
- Behaviour: portraits show initials until the image loads, fade in, and fall back to initials on error.
- Behaviour: front page with hero, stat tiles, people grid, latest in the story, open promises, places, recently changed, quick links; tools behind a disclosure.
- Behaviour: infobox connections show one row per person with merged labels.

### Campaign Wiki: campaign timeline

- Commit: `bc4beedf7`; newest-first request in `856a5fc67`.
- Behaviour: Story events and Promises tabs grouped by session and day with a jump bar; event cards with place and people chips; "Latest in the story" uses one `order=desc` request.
- Tests: 144 checks across 7 runners, including an older-server fallback (155 after `856a5fc67`).

### Campaign Wiki: cross-session writes and partial patches (client)

- Commit: `856a5fc67`.
- Behaviour: a write referencing a person with no page in the write session (409 `CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE`) shows a specific message on every wiki write path instead of the reload banner. Pin, Unpin and Wrong send partial patches. The "who knows it" fact picker lists this session first and labels facts from other sessions. The front page title drops the session suffix.

### Campaign Wiki: review duplicates

- Commit: `d02f0f881`.
- Files: `CampaignWikiReview.tsx`.
- Behaviour: reads each session chat of the campaign (duplicates are per session), shows versions side by side with session, date and quote counts, preselects the pinned or best-evidenced version and resolves in that session chat with expected revisions; skip and show again; conflict, missing and cross-session errors handled; count badge on the front page Tools.

### Campaign Wiki: what links here

- Commit: `d02f0f881`.
- Files: `CampaignWikiLinksHere.tsx`.
- Behaviour: pages that mention this one, grouped by kind with portraits and a campaign-wide summary line.

### Campaign Wiki: canon page

- Commit: `d02f0f881`.
- Files: `CampaignWikiCanon.tsx`; route `GET /api/game/:chatId/memory/facts?pinned=true`.
- Behaviour: every pinned fact across the campaign grouped by page, with search, load more and unpin (written to the fact's own session). Older servers get "needs a server update" states.
- Tests: new review and canon runner; 193 checks across 8 runners.

### Campaign Wiki: create form safe area

- Commit: `8a55809e7`. The wiki create form uses the app safe-area inset variable.

### HUD widget landing, enum repair and interim list capacity

- `0f90ee405`: GM prompt summary line for extended widgets, the compact catalog of the 19 extra types, the setup JSON schema listing every type, and locale keys (`formatHint`, calendar day label). The widget engine and renderers had been swept into `05d60f159` from the shared index.
- `2ceb4b780`: `0f90ee405` applied zero-context hunks at shifted offsets; the 19 type names landed outside both enums in `packages/server/src/routes/game.routes.ts` and HEAD did not compile (20 server tsc errors before, 0 after, checked on a clean checkout).
- `857d874d5`: widgets created by the GM without an icon show their type's default icon in the phone tray, the tucked panel and the headers (19 identical buttons before).
- `beeafe7c7`: interim per-widget list capacity (`config.max` 1 to 30, default 5), `[widget: id, max: N]`, eviction toast and branch replay parity, with `scripts/regressions/hud-widget-list-capacity.regression.ts`. Superseded on 2026-09-24 by list widget capacity 100.

### Game Mode Edit layout: editor modules and rebuild

- Commits: `f72a47763` (modules), `7b19cd5d2` (wiring).
- Files: `packages/client/src/components/game/GameLayoutEditToolbar.tsx`, `GameLayoutPopover.tsx`, `FloatingGamePanel.tsx`, `packages/client/src/lib/game-layout-editor-store.ts`, `game-layout-geometry.ts`, `game-layout-snapshots.ts`.
- Behaviour: edit mode shows a grid, outlines and name tags; panels drag from anywhere, snap to edges, centres and neighbours with guides, resize from every edge and corner, and settle into free space on drop. A collisions switch lets panels phase through each other. Per-panel options move into a menu on the name tag. The Layout toolbar adds undo and redo, lock all, show and hide panels, saved layouts and reset. Manual heights survive growth and crowded reflow, and the storyboard fills the box it is given.
- Shortcuts: Ctrl+Z undo, Ctrl+Shift+Z redo, Alt to place freely, Esc leaves edit mode.
- Setting: none yet (audit tier 3); layouts are stored per campaign in browser storage.
- Tests: `scripts/regressions/game-layout-editor.regression.ts`; Edit layout browser fixture under `scripts/ui-fixtures/game-hud/`.

### Game Mode Edit layout: crushed panels and reflow

- Commits: `67967f940`, `681fd2d1d`.
- Problem: the crowded-screen reflow shrank every panel, narration included, to the 64px floor after the rebuild.
- Behaviour: reading panels keep readable heights; stored heights below the minimum count as unset; positions saved while panels were crushed recover without overlap; automatic reflow no longer persists sizes or positions.
- Behaviour (`681fd2d1d`): stable crowded reflow with no frame-to-frame flipping and the wide toolbar placed early; name tags move inside the panel when a neighbour is directly above; Esc cancels a drag or resize; undo or a chat switch mid-drag resumes reflow; the edit session ends on chat switch and below desktop width; stack siblings no longer block resize; the value-change reveal timer survives tuck edge changes.

### Game Mode Edit layout: contrast and popover placement

- Commit: `eff73f52b`.
- Behaviour: Done, Save, the hidden count and the resize badge use the primary foreground on the accent fill (white failed contrast); popovers near the bottom edge flip up to stay in the viewport; menu icons use one size.

### Game Mode Edit layout: storage failures never half-apply a layout

- Commit: `5e57cd705`.
- Behaviour: applying, undoing, resetting or importing a layout rolls back when browser storage is full or blocked, keeps the undo history in step, and shows a clear storage message. Imports over 512K characters are refused before parsing.

### Game Mode Edit layout: named handles, safer shortcuts, rename Esc

- Commit: `06fd3ca19`.
- Behaviour: move and resize handles include the panel name for screen readers; arrow nudges ignore Ctrl, Alt and Meta; undo shortcuts ignore AltGr chords; Esc in the layout rename field cancels without saving and returns focus to the rename button.

### Game Mode Edit layout: Tidy and Shift+click align

- Commit: `6015b7172`.
- Files: `packages/client/src/lib/game-layout-tidy.ts`, `GameLayoutEditToolbar.tsx`.
- Behaviour: Tidy packs panels into non-overlapping columns keeping their rough side and order. Shift+click selects panels for align left, align right, align top and match width. Each action is one undo step; locked and tucked panels stay put; stacks move as a block; reading panels keep a readable height.

### Game Mode on phones: Arrange widgets

- Commit: `753ed582a`.
- Files: `packages/client/src/components/game/GameMobileArrange.tsx`, `packages/client/src/lib/game-mobile-panel-arrangement.ts`.
- Behaviour: an Arrange button at the end of the phone widget row opens a sheet to reorder widgets and hide or show them, with 40px touch targets. The arrangement is stored per device under its own key prefix, so desktop layouts are unaffected, and both widget rails stay in sync.

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
- Logging: each transition is logged once (the store's `logJobState` is canonical for accepted, running and settled); `withoutEchoedPrompt` keeps the error's name, code, status and stack frames, replaces quoted spans with "[quoted text removed]" and caps the message at 300 characters.
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

### Lorebook Move and Copy target, localized rows, phone row menu

- Commit: `c176bebf6`.
- Behaviour: Move and Copy entries start on "Choose a lorebook" and confirm names the target (it pre-selected the first lorebook alphabetically). Entry row labels, filter modes and sort options localized. Phones: Duplicate and Delete move into the row menu; the toolbar is search plus a 2x2 button grid. Agents and Presets folder-delete dialogs localized.

### Character editor and library speed

- Commit: `f9c274005`.
- Behaviour: on a large character (60 greetings, 30k description, 200 embedded entries, 40 gallery images; dev build) typing in a greeting went from 127 to about 50 ms per key, description 112 to about 70 ms, editor scroll 11 to 13 up to 36 to 41 fps. Lorebook, sprites and gallery sections are memoized; each greeting is its own memoized row; off-screen rows skip layout and paint. Library search typing 88 to 200 down to about 33 ms per key. Clip labels localized.

### Lorebook editor memoized rows and deferred search

- Commit: `e5679fc90`.
- Files: `LorebookEntryListItem.tsx`, `LorebookEditor.tsx`.
- Behaviour: rows go through a memoized `LorebookEntryListItem` with one shared handlers object; search filtering and the grouped or flat switch use a deferred value. On 400 entries (dev build, 1280px): search keystroke to paint 440 to 686 ms down to 48 to 58 ms; typing 360 to 488 down to 40 ms; expand 480 to 700 down to 113 to 132 ms. Sort change unchanged (about 1.2 s).
- Tests: `lorebook-editor-memo-rows`; browser checks at 1280 and 390px.

### Live accent animation pauses on very large pages

- Commit: `c125258c0`.
- Files: `packages/client/src/App.tsx`.
- Problem: each accent tick rewrites root CSS variables; with a 190-entry lorebook open (about 16k elements) the idle page ran about 1.5 fps and typing took 0.5 to 6 s.
- Behaviour: above 6000 elements the tick holds the current accent instead of restyling the page.

### Character and persona fixes

- Commit `db3d3ad8b`: saving a character with an empty name stops with a clear message (also on auto-save when leaving); on phones the bot browser tag list is an overlay drawer (backdrop and Escape close it); the library header shows "100+" while more pages exist; `AvatarImage` falls back to a centred placeholder for missing avatar files.
- Commit `889b5cb94`: cropped avatars render on library cards and the detail view; Set as avatar from the gallery clears the previous crop; depth prompt depth clamped to 0 to 100; tags differing only in case are one tag; persona folder-delete dialog localized.
- Commit `00ea14412`: closing the "Embedded lorebook found" prompt during a JSON or PNG import shows "Import cancelled" with a count; choices read Import with lorebook, Import without, Cancel (36px targets).
- Commits `1023cb356` and `a625e235e`: a failed Personas load shows an error with Retry instead of "No personas yet"; the TTS speed slider's 1.0x marker sits at 1.0 on the active range. `a625e235e` re-applied both after `fae3d5747` was committed from a stale copy.

### Lorebook and preset editor layout and accessibility

- Commit: `7d8c56b2c`.
- Behaviour: the order box widens with its value and shows the saved value (12.9 displays 12); the name column keeps a fixed minimum width; the token estimate is computed once per row; Duplicate and Delete appear on keyboard focus; keyword, tag, back and close buttons are labelled; long keywords wrap; preset editor buttons report their open or enabled state.

### Selection bar labels on phones and narrow panels

- Commit: `fae3d5747`.
- Files: `packages/client/src/components/ui/selection-action-classes.ts`, `LibrarySelectionExtraActions.tsx`.
- Behaviour: Export and Delete are inline-size containers and hide their label only when too narrow to show it whole; panel extras (Tags, Move, Campaign, Enable, Disable) are icon-only on phones and in right panels under 28rem. All buttons carry `title` and `aria-label`.
- Tests: `lorebook-scan-compaction` now pins `FILE_STORAGE_DIR` to its temp directory.

### Chat touch and editor fixes

- Commit: `5e0ad5c4b`.
- Behaviour: a tap on a hidden message action row only reveals it (no accidental Regenerate or Delete); markdown tables raise no React key warnings; the message editor carries `data-chat-message-editor` again (mobile scroll-into-view, bottom spacing, unsaved-edit check); the conversation edit box uses the full width; attachment remove buttons have labels, 38px targets and focus rings; the transcript stays pinned to the latest message as the composer grows.

### Chat search jump, branch targets and avatar fallbacks

- Commit: `648c75a56`.
- Behaviour: on phones the search panel closes after jumping to a result; branch panel rename, delete and close targets are 38px on mobile; message, header and presence avatars use `AvatarImage`; Home mode buttons stack icon over label below 640px.

### Home recent chat cards

- Commit: `42180d981`.
- Behaviour: recent chat cards (role=button) open their chat again instead of the card-wide "Open Chats tab" button catching the click; card avatars use `AvatarImage`.

### Dialogs, connections and settings shell fixes

- Commit: `4e999d129`.
- Behaviour: only the topmost dialog traps Tab; Escape during IME composition does not close a dialog; menus and pickers render above dialogs; `DraftTextarea` keeps committed text after blur; `DraftNumberInput` supports empty-means-off.
- Behaviour: the connection editor keeps unsaved edits across refetches and saves before switching; image quality Extra high and Max round-trip; clearing Seed, Steps or Max tokens clears instead of saving 0; create has no double submit; import has no ghost rows.
- Behaviour: chat list backgrounds select uses real options; backup delete asks first; settings rows stack in the narrow panel through container queries; panel resize handles work with touch and pen.

### Onboarding, panel focus and shared panel states

- Commit: `0333d2ad0`.
- Files: new `packages/client/src/components/layout/use-panel-keyboard-focus.ts`, `packages/client/src/components/ui/PanelStates.tsx`.
- Behaviour: the onboarding helper renders at page level so Home widgets no longer cover Skip and Get Started on phones; opening a side panel moves focus in and Escape closes it (unless a field has text or a menu is open) and returns focus to the toggle; shared loading skeleton and error with Retry (Connections, and the chat list after two failures); 36px phone targets in Settings, Connections and the chat list; toasts sit below the chat header and above the composer.

### Settings localization, keyboard-reachable imports, no em dashes in UI copy

- Commit: `68018a4df`.
- Behaviour: settings option lists, help, toasts, update and build labels, tracker order labels and search text resolve through `en.json`; profile import and SillyTavern import are real buttons; all 115 `en.json` values with em dashes rewritten; six hard-coded em dashes in TSX removed or localized.

### Music widget docks right on phones

- Commit: `afbfb69bc`.
- Files: `LocalMusicPlayer.tsx`, `YouTubePlayer.tsx`, `SpotifyMiniPlayer.tsx`, UI store and settings sync.
- Behaviour: the YouTube or local music widget defaulted to x=16, y=144 and covered message avatars; the default now docks right, and `resolveMobileWidgetX` makes the panel and drag start use the real on-screen x. UI persist v101 to v102 moves only the untouched old default; dragged positions stay; the server-synced copy gets the same move and is written back.
- Tests: `ui-store-music-widget-migration`; browser checks at 390, 360 and 1280px.

### Startup inject gate

- Commit: `5209aa6d4`.
- Files: new `packages/server/src/lib/fastify-inject-gate.ts`, `packages/server/src/app.ts`.
- Problem: a background `app.inject()` during the minutes-long capability package activation booted Fastify early; later packages failed with "Root plugin has already booted" and the scheduler's `addHook` threw "already listening", killing startup.
- Behaviour: `buildApp` holds such calls until registration ends; the logging pass adds a `startup.inject_held` line. Regression included.

### Capability packages survive host lifecycle errors

- Commit: `2489691ae`.
- Files: `packages/server/src/services/capability-packages/capability-module-runtime.service.ts`.
- Problem: the startup race made three healthy packages fail activation; the runtime rolled each back a version and persisted status error, so every later boot skipped them.
- Behaviour: errors from the host's own Fastify lifecycle leave the installed version and status untouched so the next start retries. Regression extended.

### Launcher backup of untracked source

- Commit: `962e36777`.
- Files: new `scripts/preserve-untracked-src.mjs`; `start.bat`, `start.sh`, `start-termux.sh`.
- Problem: the launchers run `git clean -fd -- packages/*/src` on every launch (even `--skip-update`); on 2026-09-22 a relaunch deleted other sessions' untracked source files.
- Behaviour: every untracked source file is copied to `.tmp/untracked-src-backups/<timestamp>/` before the clean.

### Lorebook scan text only on the newest message row

- Commit: `ec5e6cd79`.
- Files: new `packages/server/src/services/lorebook/lorebook-scan-compaction.ts`; `services/storage/chats.storage.ts`, `routes/lorebooks.routes.ts`, `routes/generate/retry-agents-route.ts`.
- Problem: stored scans carried every activated entry's full text on every message and again in every swipe (184 MB of one 192 MB chat shard).
- Behaviour: swipes store a compact scan (ids, keys, scores); saving a new scan compacts all older ones in the chat; Active Context and agent retries fall back to the stored entry text.
- Data: the journal records the live compaction of messages and swipes JSON from 1502 MB to 213 MB, with a backup taken first.
- Tests: `lorebook-scan-compaction`.

### Whole-fork review fixes (2026-09-22 review)

- Commit: `660d992fa` (39 files).
- Behaviour: the verified fixes from the 2026-09-22 whole-fork review (branch `fix/bug-hunt-2026-09-22`) that had been applied to the working tree but not committed. Deferred `game.routes.ts`, `GameSurface.tsx`, `GameWidgetPanel.tsx`, `game-gm-prompt-runtime.ts` and `generation-lifecycle` hunks landed with the memory work; other sessions' uncommitted edits were excluded.
- Tests: the `bughunt-*` regressions.

### Server review fixes, chunk 1

- Commit: `be4c94289` (12 batches, each with a `server-hunt-b<N>` regression).
- Behaviour: runtime-config `.env` reload diff; fatal-error flush in `index.ts`; IP allowlist CIDR and IPv6 and per-route rate limits; background uploads and `meta.json`; compatible export name collisions and backup central directory cap; capability uninstall race; chat preset name validation; connection image cleanup; AVIF dimensions; custom emoji, sticker and tool handling; fonts and gallery routes; dry-run and expression agent utilities; translate and utility sidecar; Beholder state.

### Server review fixes, chunk 2 and follow-ups

- Commits: `cc144f9c9`, `2b2ca2f29`.
- Behaviour: storage and seeding; character, chat, conversation, import, knowledge source, lorebook, personal extension, sidecar and sprite routes; agents; conversation services; image and video generation; importers; LLM providers; lorebook scanning and storage; prompt assembly; regex; tools; deleted built-in regex scripts stay deleted (the reset automation clears the seed marker so built-ins return after a reset).
- Follow-ups (`2b2ca2f29`): a background rename whose suffix search lands back on its own name returns early instead of deleting the file's tags (b6); Beholder garments leave before the worn cap applies, so a swap on a full slot no longer evicts another garment (b27); the fatal-flush test that boots the server twice (about 50 s) became an opt-in `*.slow-regression.ts`.

### Server review fixes, parked batches

- Commit: `3354c1c89` (batches 1, 10, 12, 15, 16, 18, 19, 23, 39, 40, 44, 49, 57, re-applied onto current main after an adversarial re-review).
- Behaviour: storage pre-shard restore, Windows writer lease and joined selects; chats, conversation and branch routes; generate route and agent retry; Lorebook Keeper merge and backfill cursor; raw route aborts; sprites upload; SillyTavern importers; textual tool-call parsing; local sidecar runtime and downloads; SSRF reserved-address checks.

### Server logging pass

- Commit: `750e67ff3`.
- Files: `packages/server/src/lib/log-events.ts`, `http-diagnostics.ts`, `startup-timeline.ts`, `build-integrity.ts`, `runtime-diagnostics.ts`, `worker-gauges.ts`, `best-effort.ts`, `app.ts`, `index.ts`, `config/runtime-config.ts`, `config/env-watcher.ts`, `db/file-backed-store.ts`, `server/scripts/build.mjs`, `write-build-meta.mjs`; spec `docs/development/logging.md` v1.0, `LOGGING.md`.
- Behaviour: every line in a request carries `requestId` (also on POST bodies), echoed as `x-request-id`; `request.slow`, `request.aborted` and `request.error` lines; `startup.phase` timing and a `startup.ready` summary with activated, failed and skipped packages; `build.integrity` check; `startup.inject_held`; one error line per failure with cause chains; cancellations at info; repeated warnings rate-limited; runtime memory telemetry; silent catches replaced with logged best-effort helpers; secrets and prompt text kept out of lines. Shares its vocabulary (event, state, kind, errorCode, outcome, elapsedMs) with the generation jobs work.

### Server robustness pass

- Commit: `f4f547396` (each item passed an adversarial review, with a regression).
- Storage: a flush skips shards and `manifest.json` byte-identical to this process's last write (`filesSkipped` on `storage.flush`); large shards serialize in slices that yield the event loop.
- Startup: Windows caches the OS boot id per boot (about 1.5 to 2 s).
- Shutdown: bounded, per-step timed stops; a timed-out step logs `outcome failed / reason timeout` and its late error is logged; a crash keeps its nonzero exit code.
- Diagnostics: admin runtime diagnostics endpoint reusing the startup, build-integrity, memory and worker-gauge data.
- Continuity pacing: global hourly cap on automatic calls (backfill uses a share and pauses on its own, live turns keep running, local endpoints exempt), per-chat parking on rejected API keys with Retry, jittered per-item backoff.
- Providers: small jittered retry budget for transport failures and 502 or 503 before any output streams; nothing replayed after the upstream accepted.
- Also: regressions pin `FILE_STORAGE_DIR` next to `DATA_DIR`; the parameter panel hides topK while Anthropic budget thinking is on.
- Deployment (journal): live deploys at 09:38 on `7e5fdccb8` and 11:11 on `f4f547396`, each ready in about 22.5 s with 13 packages active.

### Upstream sync 1 (Pasta-Devs `1d30a562c`)

- Commits: `90fd2894e` (merge of 145 upstream commits), `acef9788e`, `1efb58035`, `7e5fdccb8`.
- Brought in from upstream: Decision connections, scene busy checks, automatic translation, advanced-memory refresh, Opus 5.5 effort, GPT-6 and Grok models, Game helper output defaults, quick reply placement, reported prompt tokens.
- Conflicts: 31 files resolved keeping both sides. The fork's apostrophe and whisper-header fixes moved into shared `game-narration-text.ts`; the "ignored" attempt outcome and background `groupId` joined the shared connection admission types; a duplicate `aria-label` was removed from the agent editor Save button.
- `acef9788e`: 11 more conflicts; the fork's translation fixes (non-JSON provider replies become a named 502, Google Translate text sent in a POST form body) ported into `services/translation.service.ts`. `1efb58035`: Keeper extraction keeps upstream's truncation check inside the fork's parse guard. `7e5fdccb8`: `server-hunt-b24` and `server-hunt-b25` point at upstream's new code locations.

### Regression suite isolation and fixture hygiene

- `f81aa3a07`: `scripts/run-regressions.mjs` gives every file its own temporary `DATA_DIR`, `FILE_STORAGE_DIR` and an empty `MARINARA_ENV_FILE`, so no regression can open (or be blocked by) the live store named in `.env`; new silent catches log (`logSuppressed`, or a process warning); `robustness-boot-performance` spawns PowerShell hidden; stale tests updated where the code was verified correct.
- `0623ac08e`: six regressions registered fixture agents into the repo-relative shared `dist` while the server resolves `@marinara-engine/shared` through its own `node_modules`; new `fixtures/server-shared.ts` imports the server's instance, so worktrees pass too.
- `18875cd1f`: the open-issues check accepts a search-filtered journal timeline list.
- `792b58081`, `367dba6a8`, `7be167a69`, `a478a8b5f`, `0b3dea6a3`, `1610c3e17`, `f8d405382`, `20167a05b`: fixtures and comments use invented neutral names mapped one to one; assertions unchanged apart from renamed strings.
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

### Campaign Wiki reader redesign (client)

- Commit: `d33b9e631`.
- Files: `packages/client/src/components/game/CampaignWiki.tsx`, `CampaignWikiWindow.tsx`, new shared kit `campaign-wiki-ui.tsx` (used by the editor, create form, commitments, evidence, owner link and campaign index dialog).
- Behaviour: searchable page rail, overview with people and places, entity pages with tabs, readable fact cards, evidence per origin session, and a day-grouped timeline.
- Fixes: commitments reload after a 409 refetches; create-record waits for the owner check of the exact id; the editor rejects condition values that do not match their type instead of saving null or false.

### Memory panel: "How the GM uses memory"

- Commits: `d33b9e631`, `5c596f053`.
- Files: `packages/client/src/components/game/GameMemorySettings.tsx`, `GameContinuityPanel.tsx`, `GameSurface.tsx`, `GameSessionHistory.tsx`.
- Behaviour: the continuity panel shows a health headline, progress and a filtered batch list, plus a "How the GM uses memory" block (Keeper hand-off, recap limit, campaign or session scope, memory budget). It shows "no memory connection" when the server reports `connectionAvailable=false`.
- Fix: the continuity panel never rendered in the game because `GameSurface` did not pass `chatId` to `GameSessionHistory`. The desktop Session panel no longer runs off the left edge when the toolbar sits on the left.
- Tests: `5c596f053` adds a regression guarding the `chatId` prop and the memory block's PATCH contracts.

### Campaign Wiki: real-data fixes

- Commits: `c823be962`, `327a18130`, `acca532f3`.
- Behaviour: kind filter chips show counts and hide kinds with no pages; overview tiles include Persona and Note so they add up to All pages; overview grids size to their container, so names are no longer cut in a narrow window.
- Behaviour: a state value that is itself a page id (for example a character's location) shows as a link with the page name, fetched when not loaded, instead of the raw id.
- Behaviour: retracted facts move into a collapsed "Withdrawn by the memory check" group at the end of the Story tab; the co-holder line reads "Also known to".
- Behaviour: an event with no summary reads "Event recorded" instead of its first transition id; the Events tab leads with the text of a live fact citing the same message and quote, with the quote underneath.

### Campaign Wiki: fixture coverage for conflicts and owner checks

- Commit: `23eb00759`.
- Tests: new `run-commitment-conflict.mjs` (a stale transition gets 409, Reload refetches, the retry sends the fresh `expectedRevision`); `run-create-evidence-owner.mjs` (preview and apply stay blocked until the owner check covers the exact owner id); `run-tests.mjs` selectors tolerate the count badge. Client: an event summary made only of ids reads "Event recorded".

### Campaign Wiki and memory panel: 14 review fixes

- Commit: `12331af21`.
- Wiki reader: paging keeps the open tab and perspective and changing tabs resets the page offset; no raw ids in the Details tab, timeline location chips, state changes or the perspective list; blank event cards read "Event recorded"; evidence without a quote keeps its source link.
- Memory panel and editors: the Keeper switch matches the server (no saved ownership with memory On already replaces the Keeper) and waits for status; a half-typed budget (`1e`, `-`) restores the saved value; mutation errors and the open batch reset on chat change; the Session panel clamp uses a stable ref and translate and re-clamps on resize; the editor diffs against a snapshot taken when editing starts, so a refetch cannot hide a concurrent change from the 409 check; evidence scrolls back to the quote when reopened; a failed Resume in the campaign index job view shows its error.
- Settings and schema impact of the wiki and panel work: none; client only.

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

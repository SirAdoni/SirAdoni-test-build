# Technical changelog

## Fork feature inventory (vs upstream Pasta-Devs staging)

A standing list of everything this fork carries over upstream `Pasta-Devs/Marinara-Engine` `staging`, so no feature is forgotten. Every user-visible feature, shortcut, route, setting and behaviour gets its own bullet. Update this list whenever a feature lands, changes its switch or is dropped.

- Baseline (2026-09-24): branch `memory-system-finish` at `490265ab7`; merge base with `upstream/staging` is `60ed7ec80` (upstream sync 2). `git log upstream/staging..HEAD` lists 164 fork commits (159 without merges). Most of the Game Mode base (storyboards, Contact Book, scene timeline, continuity, first Campaign Wiki) arrived in one large commit, `44fba2b25` (2026-09-20, 770 files).
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

### Feature switches (Settings > Advanced > Features, 13 + job tracking) (15)

- Mechanism: `server/src/services/features/feature-settings.ts` (`isFeatureEnabled`, app setting `features`, JSON of booleans and numbers), `shared/src/schemas/feature-settings.schema.ts`, `client/src/components/panels/settings/FeatureSwitchesSettings.tsx`, `hooks/use-feature-settings.ts`; game switches in `services/game/game-feature-switches.ts` and `shared/src/utils/game-feature-switches.ts`. Precedence: environment variable, then saved value, then default on. Changes apply without restart. Searching settings for `features` opens the section.
- App: **ChatGPT history replay** (`chatgptHistoryReplay`, on).
- App: **Cache-friendly prompt layout** (`cacheFriendlyPromptLayout`, on).
- App: **Stable lorebook picks** (`stableLorebookGroupPicks`, on).
- App: **Retry failed provider calls** (`providerRetry`, on).
- App: **Background call cap** (`backgroundCallCap`, on; **Calls per hour** `backgroundCallsPerHour` 600).
- App: **Message trash** (`messageTrash`, on; **Days kept in Trash** `messageTrashDays` 30).
- App: **Usage and activation stats** (`usageAndActivationStats`, on).
- App (Windows server): **Minimize the console to the system tray** (`consoleTray`, on; env `MARINARA_CONSOLE_TRAY` wins; unavailable off Windows). File: `server/src/services/console-tray/console-tray.service.ts`, helper `server/src/assets/console-tray.ps1`.
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

### Game Mode UI and layout (33)

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
- Hide the party bar and Currently Present: two toggles in the desktop game toolbar, the phone Game actions menu and the Party section of game settings; per game and per device in localStorage `marinara-game-hud:<gameId>:party-bar:hidden` and `...:scene-presence:hidden`; default shown. Files: `hooks/use-game-hud-lists.ts`, `GameHudListToggles.tsx`, `features/chat-settings/sections/GameHudListsSettings.tsx`.
- Long turns never move the layout: the composer grows upward from a fixed one-line slot (textarea capped at min(120px, 22dvh), scrolls inside) and the generating status keeps its height, so typing, pasting and sending move narration and floating panels 0px. Files: `game-composer-stability.ts`, `GameInput.tsx`, `GameNarration.tsx`.
- Tablets: panels can report a minimum height, so narration keeps its composer in view on crowded 1024px and wider screens; the tablet narration column below 1024 stops at 48rem; touch tablets (768px wide and 32rem tall and up) get 36px Game controls. Files: `lib/game-panel-layout.ts`, `styles/globals.css`.
- Tablets keep the tablet layout with the on-screen keyboard up: phone versus tablet is decided by the device screen short side (under 600px is a phone), exposed as `data-game-short-landscape` / `data-game-short-tablet` on the root and Tailwind variants of the same names. File: `lib/game-short-landscape.ts`.
- Full names: map, place, widget, presence, contact, journal, sheet, speaker, storyboard and inventory names wrap instead of truncating (no ellipsis or clamp); package-drawn map names are left for upstream.

Scene, combat and server guards:

- Storyboards: adaptive frame counts, concurrent image requests, per-stage timing, full-screen images, recoverable background work, continuity. Files: `services/game/storyboard-*.ts`, `StoryboardContinuitySettings.tsx`, `GameStoryboardTimings.tsx`.
- Automatic scene media queue after each GM turn. File: `services/game/automatic-game-media.ts`. Switch **Automatic scene media**.
- Presence and portraits: library portraits with saved crops, full-screen portrait preview, character names in narration open their profile. Files: `game-scene-presence.ts`, `game-speaker-avatar.ts`, `ui/CharacterPhoto.tsx`.
- Game server guards: bad model maps return `422 MAP_INVALID` (`services/game/game-map-validate.ts`); journal edits answer `409 JOURNAL_ENTRY_MOVED` (`journal-entry-guard.ts`); reputation applies once per source message (last 200 remembered); party removal by `characterId`; boss `hp_threshold` mechanics fire once; inventory rows matched by item id (`inventory-item-identity.ts`, `game-inventory-identity.ts`).
- Party bar HP bars inside avatars and tactical combat range preview on hover; journal search over Timeline and Library (case and accent insensitive).
- Legacy node maps convert to World Maps at startup when the package is available, originals kept. Files: `services/capability-packages/automatic-legacy-game-map-migration.ts`, `shared/src/utils/legacy-game-map.ts`.
- In-game help: chaptered features guide to layouts, widgets, maps, memory, Status and the Contact Book (`GameFeaturesGuide.tsx`).

### Game tools (Session panel Tools tab and command palette) (11)

- Session panel **Tools** tab (wrench icon) beside Session history, Scenes and Journal, holding the tools below. File: `GameToolsPanel.tsx`.
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

### Library (18)

- Nested folders up to six levels for lorebooks and characters (server support for presets and agents): drag onto a folder, New subfolder, Move folder to, remembered open state, search opens matching folders. Files: `panels/library/LibraryFolderTree.tsx`, `shared/src/utils/library-folder-tree.ts`, `services/storage/character-folders.ts`; `parentId` on `library_folders` and `character_groups`.
- Character tag filter and tag list cover the whole library: the Characters panel keeps fetching catalog pages while a tag filter is active or the tag list is open (safety cap 50 pages). File: `panels/library/use-auto-load-all-pages.ts`.
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

### Regression fixes: empty-catch ratchet and campaign log reader
- **Empty-catch ratchet (227 vs baseline 224):** the console tray commit added three empty catch blocks under `packages/server/src`. They now log through `logSuppressed` from `lib/best-effort.ts`: `console-tray.service.ts` stop path, `child.kill()` after the stop timeout (`console_tray.stop`, stage `kill`, debug) and the `stop` write to the helper's stdin (`console_tray.stop`, stage `stdin-stop`, debug); `feature-settings.ts` `notifyFeatureSettingsChange`, a throwing change listener (`feature_settings.change`, stage `listener`, warn, rate-limited). Behaviour is unchanged (still swallowed); the baseline stays at 224.
- **Campaign log reader regression:** the wiring check for `GlobalSearchModal.tsx` expected `if (result.chatMode === "game") openGameLog(...)` on one line; the phone-targets commit (ad7a61ad1) let Prettier wrap it onto two lines with no code change. The code is correct, so the test regex now allows whitespace between the condition and the call (`scripts/regressions/campaign-log-reader.regression.ts`).

### Always-reasoning models: retry once without the reasoning-off flag (Chat Completions)
- **Commit(s):** this commit
- **Files:** `packages/server/src/services/llm/providers/reasoning-disable-rejection.ts` (new), `packages/server/src/services/llm/providers/openai.provider.ts`, `scripts/regressions/glm53-nanogpt-reasoning-off.regression.ts` (new), `scripts/regressions/openai-reasoning-disable-retry.regression.ts` (new), `CHANGELOG.md`.
- **Behaviour:** a live 500 came from NanoGPT answering 400 "GLM 5.3 always thinks and does not support disabling reasoning." The request did not come from the engine: the noodle, slurp and conversation-calls capability packages bundle their own old copy of the OpenAI-compatible provider, and that copy sends thinking off to GLM 5.3. The engine's callers (agent executor, advanced memory, game routes) pass `reasoningEffort: "none"` or `enableThinking: false`, and the engine provider was already correct for them: `applyGlmThinkingParameters` in `glm-request-compat.ts` sends `enable_thinking: true` (and the thinking `type: "enabled"` on native Z.AI) for every GLM 5.3 variant. This change adds a general safety net for models the engine does not know about yet. Both Chat Completions paths (`chat()` and `chatComplete()`) now send through `fetchChatCompletionsWithReasoningFallback`. When a request that turned reasoning off (`enable_thinking: false`, `thinking: { type: "disabled" }`, `reasoning_effort: "none"`, `reasoning.enabled: false` or `reasoning.effort: "none"`) gets HTTP 400 whose body matches a conservative "cannot / does not support disabling reasoning or thinking" or "always thinks / reasons" pattern, the provider removes only those fields (reasoning stays at the provider default), sends once more, and remembers the base URL and model in a process-level set (bounded to 256 entries). Later requests to that model are sent without the disable fields, so they make one call. The retry happens before any output has streamed; other 400s, non-400 statuses and a failed retry are never retried and surface the usual typed error. The first rejection per model logs one warn `llm.retry` line (`reason: "reasoning-disable-rejected"`, host and model only) through `logRepeated`. `resetReasoningDisableRejectionsForTests()` clears the set. The capability packages still need a rebuild in Marinara-Agents against the current provider before their own calls stop failing.
- **Settings / env and defaults:** none. The set is in memory and clears on restart.
- **Tests:** `scripts/regressions/glm53-nanogpt-reasoning-off.regression.ts` (real `createLLMProvider("nanogpt")` against a local stub, four GLM 5.3 model ids, reasoning off via effort, `enableThinking` or both, `chat` and `chatComplete`, streaming and not: one request, `enable_thinking: true`, no disable field); `scripts/regressions/openai-reasoning-disable-retry.regression.ts` (field detection and stripping, first request rejected and retried once without the disable, second request one call with no disable, other models unaffected, an unrelated 400 and a matching 500 not retried and not remembered).

### Console tray icon on Windows (feature switch)

- **Files:** `packages/server/src/services/console-tray/console-tray.service.ts` (new), `packages/server/src/assets/console-tray.ps1` (new, copied to `dist/assets` by the existing `copyRuntimeAssets` in `packages/server/scripts/build.mjs`), `packages/server/src/index.ts`, `packages/server/src/services/features/feature-settings.ts`, `packages/server/src/routes/app-settings.routes.ts`, `packages/server/src/config/env-watcher.ts`, `packages/server/src/lib/log-events.ts`, `packages/shared/src/schemas/feature-settings.schema.ts`, `packages/client/src/components/panels/settings/FeatureSwitchesSettings.tsx`, `packages/client/src/localization/locales/en.json`, `docs/configuration/features.md`.
- **What it does:** on Windows, once the server listens, it spawns a hidden Windows PowerShell helper (`-NoProfile -NonInteractive -ExecutionPolicy Bypass -Sta -WindowStyle Hidden -File`, `windowsHide`, all stdio piped so it gets no console of its own). The helper attaches to the server's console for a moment to read its window handle (`AttachConsole` + `GetConsoleWindow`), shows a `NotifyIcon` (app icon `win/installer/app-icon.ico` when present, tooltip "Marinara Engine (port N)"), and every 500 ms hides the console with `ShowWindow(SW_HIDE)` while `IsIconic`. Menu: **Open Marinara** (default browser at the listen address, wildcard hosts become 127.0.0.1 as in `start.bat`), **Show console** / **Hide console**, **Quit Marinara**; double-click toggles the console. Quit shows the console, prints `quit` on stdout, and the server runs its normal graceful `shutdown("SIGINT")`, never a kill.
- **Lifecycle:** the helper stops on `stop` or stdin end (restoring a hidden console without taking focus: minimized back to the taskbar, or open) and exits by itself when the server process is gone. Node puts children in a kill-on-exit job, so for a hard kill the helper starts a small watchdog PowerShell (outside the job, via silent breakaway) that waits for the helper and shows the console again if it is still hidden. Shutdown stops the helper alongside `app.close()` and waits at most 1 s for it.
- **Console hosts:** conhost (`ConsoleWindowClass`): full behaviour. Windows Terminal or another ConPTY host (`PseudoConsoleWindow`, owner `CASCADIA_HOSTING_WINDOW_CLASS` reported as `windows-terminal`): tray icon only, never hidden, because the tab's window may hold other tabs and the pseudo window cannot be hidden usefully; double-click opens Marinara instead. No console or a hidden console: no tray, one info line.
- **How to reach it:** Settings > Advanced > Features, **Minimize the console to the system tray**; the tray icon itself. API: `GET /api/app-settings/features` and `PUT /api/app-settings/features` (the response now also carries `unavailable`, for example `{ "consoleTray": "windowsOnly" }` off Windows).
- **Settings and defaults:** switch `consoleTray`, default ON (off = upstream: no helper, console untouched). Env `MARINARA_CONSOLE_TRAY` (1/true/yes/on or anything else) wins both ways; a `.env` reload now notifies switch listeners (`notifyFeatureSettingsChange`) so the env takes effect without a restart. Saving the switch starts or stops the helper at once (`onFeatureSettingsChange`). Other platforms: no-op, the toggle is disabled with "Only available when the server runs on Windows." (`settings.features.unavailable.windowsOnly`).
- **Storage:** app_settings `features.consoleTray`. No new tables.
- **Logging:** `console_tray.start` (info, `mode` hide or tray-only, `reason`), `console_tray.stop` (info, `reason` switch-off or shutdown), `console_tray.skipped` (info, `reason` no-console or console-hidden), `console_tray.quit` (info), `console_tray.open` (debug), `console_tray.failed` (warn, rate-limited through `logRepeated` key `console-tray-failed`). Helper lines run in a root diagnostic context (`operation: console-tray`), not the request that toggled the switch.
- **Tests:** `scripts/regressions/feature-switch-console-tray.regression.ts` (default on, env both ways, non-Windows no-op with `process.platform` mocked, `unavailable` map, browser URL, spawn arguments, runtime start and stop through a fake spawner, quit callback, no retry loop after no-console or a crash, helper script present, ASCII and parseable, build copies assets); `scripts/regressions/feature-settings.regression.ts` (response carries `unavailable`).
- **Known limits:** Windows PowerShell 5.1 must be present and allowed to run a script with `-ExecutionPolicy Bypass` (a machine policy that forbids it leaves the server running with one warning). The helper costs one PowerShell process, plus the watchdog one while the console can be hidden. After a hard kill the dead icon stays in the tray until the pointer passes over it (Windows behaviour). A console that was hidden or absent at start is not retried until the switch is turned off and on. Windows Terminal never hides.

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

### Stat block widget: pair columns that fit, no squeezed labels

- Files: `packages/client/src/components/game/GameWidgetPanel.tsx` (`StatBlockWidget`, `isLongStatPair`, the stat block natural width), `packages/client/src/components/game/ExtendedWidgets.tsx` (obligations terms).
- Bug: stat block pairs sat in a fixed two-column grid with the value on one unbreakable line (`shrink-0 whitespace-nowrap`). A long value squeezed its label to one letter per line (the label had become `min-w-0 break-words` with the full-names change) and ran past the widget edge, where it was cut off. The widget's natural width also grew with the full length of the longest pairs, so a few long values made the desktop widget as wide as the screen.
- Behaviour: the grid has as many pair columns as fit, each at least 8.5rem (`repeat(auto-fill, minmax(min(8.5rem, 100%), 1fr))`). A label keeps its words whole and only wraps at spaces. The value takes the rest of the row, wraps anywhere, and drops under the label when fewer than about 3.5rem are left. A pair whose value is longer than 18 characters, or whose name and value together are longer than 28, spans the whole row. The natural width caps each pair at 220px and the widget at 448px, since values now wrap. Nothing is truncated.
- Obligations: long terms after `|` no longer squeeze the obligation text; terms take at most 45% of the row and wrap.
- Applies to the desktop HUD panel and the phone and tablet widget tray (same component). No setting.
- Tests: `scripts/regressions/game-widget-stat-grid.browser.mjs` (new; real panel and tray with long values at 390x844, 820x1180, 1024x768 and 1440x900: no label word split across lines, values inside the widget and not clipped, long pairs span the row, obligations text keeps its room); `game-hud-full-names.browser.mjs` passes.

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

### Game map popover fits the visible viewport on phones and tablets

- Commits: `b5741831d`, `1f04fede6`.
- Behaviour: below 1024px the World map popover was capped at min(68dvh, 26rem), which cut the capability map view (place details, linked places, travel buttons) in half. It now sizes from its top to the bottom of the visual viewport, following browser bars, the on-screen keyboard and the bottom safe area, with the body as the scroll container. Desktop unchanged.
- Behaviour (`1f04fede6`): the phone map popover header (title and close button) carries `data-floating-widget-avoid`, so the floating music bubble moves off it.
- Boundary: package-side layout issues in the maps capability are reported upstream, not patched.

### Hide the party bar and Currently Present

- Commit: `6fb7d8b8f`.
- Files: `packages/client/src/hooks/use-game-hud-lists.ts` (new), `packages/client/src/components/game/GameHudListToggles.tsx` (new), `packages/client/src/features/chat-settings/sections/GameHudListsSettings.tsx` (new), `packages/client/src/components/chat/ChatSettingsDrawer.tsx`, `packages/client/src/components/game/GameSurface.tsx`, `packages/client/src/components/game/GameNarration.tsx`, `packages/client/src/localization/locales/en.json` (`ui.game.hudLists.*`).
- How to reach it: desktop game toolbar (two icon toggles beside the status and contact book toggles); phones, the "..." Game actions menu; everywhere, two switches ("Party bar", "Currently present") at the top of the Party section of game settings. All three stay in sync through one store.
- Behaviour: the party portrait bar and the Currently Present strip hide independently. On portrait phones the narration top reserve (CSS variable `--game-narration-top-reserve`) drops from 8rem to 4rem when presence is hidden, or to 5.5rem when only the party bar is hidden and presence moves into the top row. On desktop the widgets reflow into the freed corner (narration already had priority). The landscape presence tray tab follows the same setting, because `hasScenePresence` includes it.
- Settings and defaults: per game and per device in localStorage `marinara-game-hud:<gameId>:party-bar:hidden` and `marinara-game-hud:<gameId>:scene-presence:hidden`, shared by every session of the game; nothing is written to the server. Default: both shown (upstream behaviour).
- Tests: `scripts/regressions/game-hud-lists.live.mjs` (47 checks at 390x844 and 1440x900: default shown, each toggle hides, stored per game, survives reload, restore clears the key, narration gains room on phones and is never squeezed on desktop).

### Long turns never move the Game layout

- Commits: `32fbf045f`, `cce862f29`.
- Files: `packages/client/src/components/game/GameInput.tsx`, `packages/client/src/components/game/GameNarration.tsx`, `packages/client/src/components/game/game-composer-stability.ts` (new), `packages/client/src/components/game/GameStoryboardViewer.tsx`.
- Cause: the composer textarea auto-grew from 36px to 120px in normal flow, so on phones and tablets the bottom-anchored narration rose 82 to 84px and on desktop the narration text scrolled 84px; on send the composer was swapped for a one-line "writing" status, collapsing the panel about 110px and reflowing every floating widget. On phones the storyboard tab also hid on every composer focus, shifting the column 53px.
- Behaviour: the input bar sits at the bottom of a slot that keeps its one-line height (set directly on the element from a resize observer, never through React state, so no re-measure loop) and grows upward over the narration; the textarea caps at min(120px, 22dvh) and scrolls inside. While a turn generates, the status line keeps the composer's last height. The storyboard phone tab steps aside only while the composer is focused and an on-screen keyboard makes the visual viewport shorter than 80% of the layout viewport.
- Measured: 0.0px movement of the narration panel, the floating panels, the first narration line and scroll position while pasting 2,000 characters, typing and sending, at 390x844, 820x1180 and 1440x900 (before: up to 84px).
- Settings: none.
- Tests: `scripts/regressions/game-composer-growth.browser.mjs` (real GameInput, FloatingGamePanel and the reserve hook, short and long narration at three sizes).

### Game Mode on tablets

- Commit: `61753173c`.
- Files: `packages/client/src/lib/game-panel-layout.ts` (panel `minHeight`), `packages/client/src/components/game/FloatingGamePanel.tsx`, `packages/client/src/components/game/GameNarration.tsx`, `packages/client/src/components/game/GameWidgetPanel.tsx`, `packages/client/src/styles/globals.css`.
- Cause: at 1024px and wider a crowded HUD shrank the floating narration to a third of the height (239px at 1024x768), scrolling the composer out of view at 1024x768, 1025x768 and 1180x820, and at 1366x1024 with the keyboard up. Just below 1024 the phone column ran 952px wide (about 110 characters a line). Most Game controls were 20 to 34px on touch tablets.
- Behaviour: panels can report a minimum height; narration asks for its composer area plus 272px, so widgets give way first, and the composer sticks to the panel bottom when the box is still short (`data-game-panel-keep`). Below 1024 the narration column stops at 48rem, centred, with the tray inside it (landscape phones excluded). On touch tablets (at least 768px wide and 32rem tall) toolbar, narration, composer, party, presence, storyboard, map, retry-line and widget header controls get a 36px minimum. Phones, landscape phones and mouse desktops are unchanged.
- Settings: none.
- Tests: `scripts/regressions/game-tablet-layout.live.mjs` (768x1024, 820x1180, 1024x768, 1180x820, 1366x1024, 1023x768, 1025x768: no horizontal overflow, composer visible and on top with and without a simulated keyboard, narration visible, no cut-off headings, 36px targets, column width below 1024); new case in `scripts/regressions/game-panel-crowded-layout.regression.ts`.
- Known limits: map place titles truncate in the 320px desktop map card (fixed in `d2f71b1cd`); the image-retry banner case is fixed in `a085f68f6`; the 1023x461 keyboard case is fixed in `ec1e99004`.

### Game retry banners above the floating HUD on desktop

- Commit: `a085f68f6`.
- Files: `packages/client/src/components/game/GameSurface.tsx`.
- Cause: the "Image generation failed" and "Scene analysis failed" retry banners render inside the Game chrome container (`absolute inset-0 z-10`), the same stacking context as the floating HUD panels (layers 30 to 49 while dragged), so at z-30 they sat behind the narration panel (z-31) at 1024px and wider.
- Behaviour: both banners use z-55 from 1024px up; still inside the Game chrome layer, so dialogs stay above them. Phones keep the in-flow compact retry line.
- Settings: none.
- Tests: verified live on the sandbox at 1440x900 with an element at the banner position inside the chrome container (z-30 hit-tested under narration, z-55 on top); `game-storyboard-phone.browser.mjs` and client tsc pass.

### Tablets with the keyboard up keep the tablet layout

- Commit: `ec1e99004`.
- Files: `packages/client/src/lib/game-short-landscape.ts` (new), `packages/client/src/styles/globals.css` (Tailwind `@custom-variant game-short-landscape` and `game-short-tablet`), `packages/client/src/components/game/GameSurface.tsx`, `GameNarration.tsx`, `GameInput.tsx`, `GameStoryboardViewer.tsx`, `GameMobileStatus.tsx`.
- Cause: the landscape-phone rules keyed on a viewport at most 32rem tall below 1024px, so a 1024x768 tablet with the on-screen keyboard up (1023x461) got the phone layout: the composer was clipped and the story location card covered narration.
- Behaviour: a short, narrow viewport is classed by the device's screen short side, which the keyboard does not change. Under 600px sets `data-game-short-landscape` on the document root (landscape phone rules, unchanged); 600px or more sets `data-game-short-tablet`; no screen size reported falls back to the phone rules. All former `max-lg:[@media(max-height:32rem)]:` classes use the `game-short-landscape:` variant, and the JS checks (`SHORT_LANDSCAPE_GAME_QUERY`, `shortLandscapeGame`, `shortGameViewport`, the GameInput location row) use the module. While the keyboard is up on a short tablet, the Currently Present strip, the storyboard tab and the image retry banner step aside and return when it closes. The 36px touch-tablet rule excludes phones by the attribute, so tablets keep 36px targets with the keyboard up.
- Settings: none.
- Tests: `scripts/regressions/game-short-landscape.regression.ts`, `scripts/regressions/game-short-landscape.browser.mjs` (390x844, 820x1180, 1024x768, 1023x461 with a 1024x768 screen, 844x390 with a phone screen, 1440x900, and a phone rotation; 14 checks); `game-tablet-layout.live.mjs` now runs the keyboard case and pins the device screen per browser context (Playwright resets `window.screen` on resize); `game-mobile-landscape.live.mjs` asserts a phone screen.

### Full names everywhere the Game HUD renders them

- Commits: `604b44ee9`, `fb35f57c5` (merged as `d2f71b1cd`).
- Files: `packages/client/src/components/game/GameMap.tsx`, `GameNodeMap.tsx`, `game-node-map-label.ts` (new), `GameWidgetPanel.tsx`, `GameSurface.tsx`, `GameContactBookWidget.tsx`, `GameJournal.tsx`, `GameCharacterSheet.tsx`, `GameStoryboardViewer.tsx`, `GameNarration.tsx`, `GameInventory.tsx`, `GameMobileArrange.tsx`, `GameLayoutEditToolbar.tsx`, `FloatingGamePanel.tsx`.
- Behaviour: names wrap onto as many lines as needed instead of truncating (no ellipsis, no line clamp, no marquee):
  - Desktop map card title (was a marquee past 18 characters, otherwise cut with an ellipsis; drops below the day and time controls when the card is narrow).
  - Phone and tablet map popover: map name, the "Story location:" breadcrumb, the current place and the selected-place footer.
  - Node map tooltip (was cut at 15 characters; now wraps, flips below a node near the top edge and stays inside the map).
  - Widget titles (floating card, phone card, phone modal, setup list) and widget stat names.
  - Storyboard turn title and viewer title; Currently Present extras; phone presence chips grow and wrap inside their sideways-scrolling row.
  - Contact book names, journal entry titles, the character sheet name, dialogue speaker names, the phone Arrange list, the Edit layout panel list and the panel options popover title.
  - Inventory tiles on tablet and desktop grow to fit long item names; phones keep the compact tile that scrolls inside, and tapping shows the full name.
- Bug fixed on the way: while maps load, a 208px placeholder card shares the map panel id; its width was saved and the loaded card stayed 208px instead of 320px, clipping the package view. Both cards now follow their set width unless resized by hand, and saved 208px widths recover.
- Not changed (drawn by the hierarchical-maps package UI; listed for upstream): breadcrumb chips (`max-w-24 truncate`), the place title (`truncate text-xs font-bold`), the in-view "Story location" line, place descriptions (`line-clamp-2`), destination names (`max-w-32 truncate`), and the "STORY LOCATION" runtime row above the composer. Also still truncated and outside Game HUD names: the app chrome chat title, storyboard status text, and the closed native map picker select (opening it shows full names).
- Settings: none.
- Tests: `scripts/regressions/game-hud-full-names.browser.mjs` (map card, popover, node tooltip, widgets, contact book, inventory, journal, character sheet and storyboard with long invented names at 390x844, 820x1180, 1024x768, 1023x461 and 1440x900: no ellipsis, no clamp, no clipping or sideways overflow, no short word split, tooltip inside its box, loaded map card full width). Live sweep of three chats at the five sizes found no truncated host names.

### Job tracking setting moved into Feature switches

- **Commit:** `d91c5d395` (2026-09-24 10:00 +0300). Follow-up to 077e055ee; the CHANGELOG.md line was corrected in bcb5006ea.
- **Files:** `packages/client/src/components/panels/SettingsPanel.tsx`, `packages/client/src/components/panels/settings/FeatureSwitchesSettings.tsx`, `packages/client/src/components/panels/settings/GenerationJobTrackingSettings.tsx`, `packages/client/src/localization/locales/en.json`, `docs/configuration/features.md`, `docs/development/generation-jobs.md`.
- **What it does:** removes the separate Settings > Advanced section **Generation job tracking** (toggle "Track generation jobs") and renders the same control as a row inside Settings > Advanced > Features (`FeatureSwitchesSettings`), relabelled **Keep generating when the tab is closed (job tracking)**, placed after the server switches and before **Send client error reports**. Adds the note "Unlike the switches above, this one starts off." before the retention line. The **Open generation jobs** button stays under the toggle.
- **How to reach it:** Settings > Advanced > Features. The former section's search aliases (`jobs`, `generation jobs`, `job tracking`, `tab closed`, `keep generating`, `background`, `recover`, `reconnect`) now point at the Features section; the old `generation-job-tracking` settings section id was removed.
- **Settings and defaults:** unchanged: app setting `generationJobTracking`, default off, still separate from the `features` JSON object. `docs/configuration/features.md` lists it in the switch table as default **Off**, scope App, no environment variable.
- **Storage:** None (no new keys; same `generationJobTracking` app setting).
- **User changelog:** the matching CHANGELOG.md Unreleased line was updated in follow-up commit bcb5006ea (2026-09-24) to name **Keep generating when the tab is closed (job tracking)** (Settings > Advanced > Features, off by default).
- **Tests:** `scripts/regressions/generation-job-tracking-settings-placement.regression.ts`.
- **Known limits:** i18n keys `settings.generationJobTracking.title` and `settings.generationJobTracking.searchDescription` were removed (`en.json` is the only locale file, so no other locale needed changes).

### Built-in helper popup left unchanged

- Commit: `d2a7e9094`.
- Behaviour: reverts the helper minimize and search size changes that `a4049498b` made, at the user's request; the helper popup, its position and behaviour stay as they were. The home widget drag-handle fix in the same file is kept.

### Validation boundary for the 2026-09-24 phone and tablet work

- All rules key off `pointer: coarse` or narrow widths; the commits record desktop with a mouse as unchanged. No settings or schema changes.
- Checks were browser viewport emulation, not a physical device or soft keyboard test.

### Setting: message actions on touch screens (inline row or menu)
- Files: `packages/client/src/components/chat/MessageActionsMenu.tsx` (new), `MessageActionButton.tsx` (renders as a menu item inside the menu; `keepMenuOpen` option), `ChatMessage.tsx` (both roleplay rows), `ConversationMessageActions.tsx` (line, bubble and grouped layouts), `MessageMarks.tsx` and `ReactionAddButton.tsx` (`keepMenuOpen`), `stores/ui.store.ts`, `hooks/use-settings-sync.ts`, `components/panels/SettingsPanel.tsx`, `localization/locales/en.json` (9 keys); regression `scripts/regressions/touch-message-actions-setting.regression.ts` (new).
- What and why: on portrait phones the roleplay action row squeezed its buttons to 32 to 36px, and wrapping it would have reserved about 41px under every message. The user asked for a choice instead. With "⋯ menu" on touch screens (pointer: coarse) each message shows one 38px ⋯ button (revealed on tap) that opens a bottom sheet on phones or a popover at 768px and wider, with 47px items (icon and label), a header with Close, arrow/Home/End keys, Escape, Tab, Close or tap outside to close, and focus returned to the ⋯ button. No layout space is reserved: roleplay messages get 38 to 39px shorter; conversation messages keep their height. The menu renders the same action children as the inline row, so the actions, order, conditions and handlers stay identical. Popovers opened from the menu (bookmark, pin, note, chapter; add reaction) open over it, and the first Escape closes only them. Tap-to-reveal stays for the inline mode. Mouse screens show the inline row in both modes.
- Setting and default: `touchMessageActionsMode` in ui.store, `"inline"` (default, today's behaviour) or `"menu"`; invalid values normalize to `"inline"`; persisted and synced like the other ui.store settings (server values normalized in settings sync); control at the top of Settings > Appearance > Conversation Display, findable in settings search ("touch screens").
- Tests: regression `touch-message-actions-setting` (default, normalization, setter, persisted and synced shape, sync normalization, migration). Playwright probe at 390x844 touch for roleplay and conversation line and bubble in both modes: inline keeps the rows; menu has no rows, zero-height anchors and no taller messages; the button is 36px or more; the sheet matches the row's action list and order; Regenerate present but not clicked; Copy, marks and Edit work; keyboard, Escape, focus return and tap outside. Also 820x1180 tablet popover inside the screen and 1280 mouse unchanged in both modes (64 of 64 checks).

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

### Search All Chats (global message search)

- **Commit:** `786bda8dd` (2026-09-23 00:34 +0300).
- **Files:** `packages/client/src/components/modals/GlobalSearchModal.tsx` (new), `packages/client/src/hooks/use-chat-insights.ts` (new, `useGlobalChatSearch`), `packages/client/src/lib/chat-insights.ts` (new, `openGlobalSearch`, `openChatAtMessage`), `packages/server/src/routes/chat-insights.routes.ts` (new), `packages/server/src/services/chat-insights/chat-insights.service.ts` (new, `searchAllChats`), `packages/shared/src/utils/chat-search-query.ts` (new: query parser, matcher, snippet builder), `packages/shared/src/types/chat-insights.ts` (new), `packages/client/src/components/layout/ChatSidebar.tsx`, `packages/client/src/components/layout/ModalRenderer.tsx` (modal id `global-chat-search`), `packages/client/src/components/chat/ChatArea.tsx`.
- **What it does:** searches message text across every chat (internal Professor Mari assistant chats excluded), newest-active chats first and newest matches first inside each chat. Every needle must match, case-insensitively; `"quoted phrases"` stay together (curly quotes accepted, an unclosed quote takes the rest of the query as a phrase), and whitespace inside a phrase matches any run of whitespace. Results show chat name, mode, speaker, message number and a highlighted snippet; clicking one (or Enter on the first result) switches to that chat and scrolls to the message via the existing goto request (closes open detail panels, closes the sidebar under 768px width).
- **What it does (filters and visibility):** filters for Mode (Conversation, Roleplay, Game), Character (chats that include the character), Sent by (You, Characters, Narrator, System) and a From/To date range (a bare `YYYY-MM-DD` To date includes the whole day). Hidden messages (`hiddenFromUser`, `commandOnly`, `roleplayPrivateOnly`) and empty messages never match. Since ab891fb41, Game Mode narration is searched with the player's segment edits and deletions applied, so replaced or removed text neither matches nor appears in snippets.
- **How to reach it:** the "Search all chats" button (text-search icon) beside the chat list search field, which pre-fills the modal with the sidebar's current search text. Later additions (8e4a1ccff): Ctrl+Shift+F (Cmd+Shift+F on Mac) when no other dialog is open, and the command palette action "Search all chats" (typing anything in the palette also offers a search inside messages). Keyboard shortcuts list entries: "Search all chats (when no other dialog is open)" and "Open the first Search all chats result".
- **API:** `GET /api/chat-insights/search?q=&mode=&characterId=&role=&from=&to=&offset=&limit=` (400 when `q` is empty; `q` truncated to 500 characters). Response carries `results`, `hasMore`, `partial`, `scannedChats`, `totalChats`.
- **Settings and defaults:** None. Client page size 30, input debounced 300 ms, results cached 30 s. Not feature-switch gated in this commit.
- **Storage:** None (read-only). Scans one chat at a time through a chatId-scoped query so the lazy file store only loads the chat unit being read.
- **Game chats:** as merged, opening a result in a Game Mode chat showed the toast `chatInsights.gotoUnavailableInGame` instead of paging the whole history, because the Game surface has no per-message anchors. 7a7a44b11 replaced this: a jump to a game message now opens the campaign log at that turn (covered in the campaign log entry).
- **Tests:** `scripts/regressions/chat-global-search.regression.ts`; `scripts/regressions/chat-insights-display.regression.ts` (display helpers). Later: `scripts/regressions/integration-seams.regression.ts` (ab891fb41) covers the segment-edit reading.
- **Known limits:** at most 12 needles of up to 200 characters each; `limit` capped at 100 per page and `offset` capped at 1,000 (later pages return empty); an 8 second scan budget per request, after which the response is marked `partial` and the modal says "Some older chats were not searched yet; narrow the search to reach them." Plain substring matching only (no fuzzy, stemming or regex). Chats whose last message predates the From date are skipped without being read.

### Markdown and HTML story exports

- **Commit:** `786bda8dd` (2026-09-23 00:34 +0300).
- **Files:** `packages/server/src/services/chat-insights/transcript-document.ts` (new: `renderTranscriptMarkdown`, `renderTranscriptHtml`, `isStoryTranscriptMessage`), `packages/server/src/services/chat-insights/transcript-avatars.ts` (new: `readSmallAvatarDataUri`), `packages/server/src/routes/chats.routes.ts` (`serializeChatTranscript`, export route), `packages/client/src/hooks/use-chats.ts` (`useExportChat`, `ChatExportFormat`), `packages/client/src/components/chat/ChatBranchSelector.tsx`.
- **What it does:** adds two export formats beside JSONL and Text. Markdown (`.md`) writes a titled transcript with speaker headings; Story (`.html`) writes a standalone page with embedded CSS: light and dark styling (`prefers-color-scheme`), a phone layout under 480px, print styles, and a round avatar per speaker. Avatars are embedded as `data:` URIs for the persona and each character when the stored file is a local png/jpeg/gif/webp/avif of at most 96 KB; otherwise a coloured initial is drawn. The title is the chat name plus the branch name when on a branch.
- **What it does (content rules):** exports follow the active swipe (per CHANGELOG), leave out hidden (`hiddenFromUser`, `commandOnly`, `roleplayPrivateOnly`), system and empty messages, and resolve prompt macros in message text. The user speaker is the persona snapshot name stored on the message, else the chat persona name, else "User"; assistant turns named "Narrator" are shown as narration. Reasoning is included only when the existing "Include reasoning in exports" setting is on (HTML puts it in a collapsible `details`, hidden in print).
- **How to reach it:** the branch menu (branch selector in the chat header) now has "Markdown" (tooltip "Export as Markdown") and "Story" (tooltip "Export as a styled HTML story you can open, share or print") buttons next to Import. Later (8e4a1ccff): command palette actions "Export this chat as Markdown" and "Export this chat as a story" for the open chat.
- **API:** `GET /api/chats/:id/export?format=markdown|md|html&includeReasoning=true&includeAvatars=false`. `includeAvatars` defaults to on; unknown formats still fall back to JSONL.
- **Settings and defaults:** "Include reasoning in exports" (Settings > Advanced > Message Tools; existing client UI setting `includeReasoningInExports`) applies to these formats too. Not feature-switch gated.
- **Storage:** None (read-only).
- **Later changes:** 2f9737914 (chapters) added a chapter table of contents to the documents (`listTranscriptChapters`, `.toc` styles).
- **Tests:** `scripts/regressions/chat-story-export.regression.ts`.
- **Known limits:** avatars over 96 KB, remote avatar URLs or unknown image types are not embedded; the HTML story has no images other than avatars. Bulk chat export is not extended by this commit (single chat only).

### Chat stats

- **Commit:** `786bda8dd` (2026-09-23 00:34 +0300).
- **Files:** `packages/client/src/components/modals/ChatStatsModal.tsx` (new, modal id `chat-stats`), `packages/shared/src/utils/chat-stats.ts` (new: `computeChatStats`, `computeChatPlayTime`, `CHAT_SITTING_GAP_MS`, day keying), `packages/server/src/services/chat-insights/chat-insights.service.ts` (`computeStoredChatStats`), `packages/server/src/routes/chat-insights.routes.ts`, `packages/client/src/hooks/use-chat-insights.ts` (`useChatStats`), `packages/client/src/lib/chat-insights-display.ts` (new, formatting helpers), `packages/client/src/components/chat/ChatBranchSelector.tsx`.
- **What it does:** a "Stats: <chat name>" modal with the date range of the chat, Messages, Words, Active days, Average reply and Your average (words), Play time with sitting count, Longest sitting, Generation tokens ("N in, N out", or "Not reported"), Words per speaker (words, messages, average), a Messages per active day bar chart with the busiest day, and the Longest message with a "Jump to message" link.
- **What it does (counting rules):** system and hidden messages are excluded. Play time adds up sittings, and a gap of more than 30 minutes between messages starts a new sitting. Tokens are summed from `generationInfo.tokensPrompt` / `tokensCompletion` stored in message `extra` (only providers that reported usage count). In Game Mode all assistant turns count as Narrator; elsewhere each character is its own speaker. The user is named from the chat's persona identity, else "You". Since ab891fb41, game narration word counts use the segment-edited text.
- **How to reach it:** "Stats" button in the branch menu (tooltip "Chat statistics"). Later (8e4a1ccff): command palette action "Stats for this chat".
- **API:** `GET /api/chat-insights/chats/:id/stats?tz=<IANA zone>&tzOffset=<minutes>` (404 for missing chats and the internal assistant chat). The browser's IANA zone wins over the fixed offset so days follow DST; offsets are clamped to plus or minus 14 hours.
- **Settings and defaults:** None. Not feature-switch gated.
- **Storage:** None (read-only).
- **Tests:** `scripts/regressions/chat-stats-activity.regression.ts`, `scripts/regressions/chat-insights-display.regression.ts`.
- **Known limits:** the per-day chart shows the last 60 active days only ("Messages per active day (last 60)"). Token totals depend on providers reporting usage; older messages without `generationInfo` add nothing. Play time is inferred from message timestamps, not measured.

### Activity overview

- **Commit:** `786bda8dd` (2026-09-23 00:34 +0300).
- **Files:** `packages/client/src/components/modals/ActivityOverviewModal.tsx` (new, modal id `activity-overview`), `packages/server/src/services/chat-insights/chat-insights.service.ts` (`buildActivityOverview`, `createActivityOverviewCache`, `createChatActivitySummaryCache`), `packages/shared/src/utils/chat-stats.ts` (`computeDayStreaks`, `createLocalDayKeyer`), `packages/client/src/lib/chat-insights-display.ts` (`buildHeatmapGrid`, `heatmapRange`), `packages/client/src/components/layout/ChatSidebar.tsx` (`UserStatusFooter`).
- **What it does:** a GitHub-style heatmap of messages per day across all chats, with a range picker for the last 12 months or any calendar year that has activity; stat cards for current streak (plus longest), total messages (plus words), active chats, active days and total play time; and "Most played chats" (top 8 by play time, then message count) that open the chat. Play time here uses one global timeline, so two chats played side by side are not counted twice.
- **How to reach it:** the pulse (Activity) button beside the custom status field in the user status footer at the bottom of the chat sidebar (label "Activity overview"). Later (8e4a1ccff): command palette action "Activity overview".
- **API:** `GET /api/chat-insights/activity?tz=&tzOffset=&refresh=true`.
- **Settings and defaults:** None. Not feature-switch gated.
- **Storage:** None persisted. Server keeps an in-memory overview cache per time zone for 60 s (at most 32 zones, one shared in-flight scan) and per-chat summaries that are reused while the chat's `updatedAt`/`lastMessageAt` are unchanged and no message write happened (or the chat unit is not resident), re-read at least hourly. The client caches for 60 s.
- **Tests:** `scripts/regressions/chat-stats-activity.regression.ts`.
- **Known limits:** internal assistant chats, system and hidden messages are excluded. First build walks every chat's messages. Heatmap on narrow screens scrolls horizontally and starts at the newest weeks.

### Game Mode Session panel: Tools tab

- **Commit:** `36f8f452e` (2026-09-23 00:45 +0300).
- **Files:** `packages/client/src/components/game/GameSurface.tsx`, `packages/client/src/components/game/GameToolsPanel.tsx` (new).
- **What it does:** adds a fourth "Tools" tab (wrench icon) to the Game Mode Session panel beside Session history, Scenes and Journal. As merged it holds the Dice log, the Name generator (with an "Open in a window" button) and the Campaign codex download. On phones the four tabs stack the icon over a label that may wrap.
- **How to reach it:** Game Mode, Session panel, Tools tab.
- **Settings and defaults:** None.
- **Storage:** None (the tab choice is component state, not persisted).
- **Later changes:** the tab gained the campaign log (7a7a44b11) and further tools from later merges (random tables and oracle in a03fe63a5; initiative tracker and others in 2f9737914).
- **Tests:** none specific to the tab.
- **Known limits:** the tab only exists on the Game Mode surface.

### Dice roll log (Game Mode)

- **Commit:** `36f8f452e` (2026-09-23 00:45 +0300).
- **Files:** `packages/server/src/db/schema/game-dice-rolls.ts` (new), `packages/server/src/db/schema/index.ts`, `packages/server/src/db/file-backed-store.ts`, `scripts/protect-launcher-data.mjs`, `packages/server/src/services/storage/game-dice-rolls.storage.ts` (new), `packages/server/src/services/game/dice-roll-log.ts` (new), `packages/server/src/routes/game-tools.routes.ts` (new), `packages/server/src/routes/generate.routes.ts`, `packages/server/src/routes/index.ts`, `packages/client/src/hooks/use-game-tools.ts` (new), `packages/client/src/hooks/use-game.ts`, `packages/client/src/components/game/GameDiceLog.tsx` (new).
- **What it does:** an append-only history of every roll for a game: dice tray rolls (`player`), GM rolls from `[dice:]` tags and the `roll_dice` tool during generation (`gm`, tied to the saved message id) and skill checks (`skill_check`, with actor and skill label). Each row keeps notation, every die, modifier, total, and crit/fumble flags. A GM roll that a skill check adopted is logged once, as the check. Logging is fire and forget: never awaited by the roll, and a failed write is only a server warning.
- **What it does (panel):** a "Show rolls from" toggle (Session or Whole game), stat cards (Rolls, Average total vs expected, Natural 20s, Natural 1s, criticals and fumbles), a per-face distribution chart per die size with a dashed fair-share line (d20 by default), and the latest rolls with source badges (Player, GM, Check), crit/fumble markers and time. The panel refreshes every 15 s while open because GM rolls land server-side. 524d6dbca added a one-line summary (most rolled die with its average vs a fair die, nat 20 / nat 1 rates for d20s) and 390px layout fixes. Later merges added `table` (random tables and oracle, a03fe63a5) and `initiative` (initiative tracker, 2f9737914) sources.
- **How to reach it:** Game Mode, Session panel, Tools tab. Later (8e4a1ccff): command palette action "Open the dice log" when a game is open.
- **API:** `GET /api/game-tools/dice-log?chatId=&scope=session|game&limit=` (default 60 recent, max 500; 404 for unknown chat) returns `total`, `stats`, `recent`. `POST /api/game-tools/dice-log` with a discriminated body (`source: "player"` with `result` and optional `context`, or `source: "skill_check"` with `result` and optional `messageId`); returns `{ recorded }`.
- **Settings and defaults:** None. Not feature-switch gated.
- **Storage:** new file-backed table `game_dice_rolls` (`id` time-sortable, `chatId`, `gameId` stamped at write time from the chat's effective game id, `messageId`, `source`, `actor`, `label`, `notation`, `rolls` JSON, `modifier`, `total`, `critical`, `fumble`, `createdAt`). Registered in `packages/server/src/db/schema/index.ts`, `BUILT_IN_FILE_BACKED_TABLES` and `SHARD_KEY_COLUMNS` (sharded by `chatId`) in `packages/server/src/db/file-backed-store.ts`, a `chats` to `game_dice_rolls` entry in `CASCADES`, and `SHARDED_TABLES` in `scripts/protect-launcher-data.mjs`.
- **Tests:** `scripts/regressions/game-dice-roll-log.regression.ts`.
- **Known limits:** it is a history, not game state: rewinds, swipes and regenerations do not remove rows; rows go away only with their chat (the storage has a `clear` helper but no route or UI uses it). Expected-average comparison is skipped for skill checks; face statistics only track dice of 2 to 100 sides. `game_dice_rolls` is not in the file store's `LAZY_UNIT_TABLES`, so it stays fully resident.

### Offline fantasy name generator

- **Commit:** `36f8f452e` (2026-09-23 00:45 +0300).
- **Files:** `packages/client/src/lib/name-generator.ts` (new), `packages/client/src/components/tools/NameGenerator.tsx` (new), `packages/client/src/components/modals/NameGeneratorModal.tsx` (new, modal id `name-generator`), `packages/client/src/lib/open-name-generator.ts` (new), `packages/client/src/components/layout/ModalRenderer.tsx`, `packages/client/src/components/game/GameToolsPanel.tsx`.
- **What it does:** generates 8 names at a time entirely in the browser. Styles: Harsh northern, Flowing elvish, Desert, Imperial (hand-tuned syllable sets), plus "Learn from a lorebook" and "Learn from characters", which train a small order-2 character Markov model on capitalised words taken from the chosen lorebook's entry names or the character library's names (stopwords removed, verbatim training names avoided). Options: Name feel (Any, Feminine, Masculine), Surname on or off, and an editable Seed; the same seed and options always give the same list.
- **What it does (controls):** each name can be locked (kept across regenerations), copied to the clipboard, and "Regenerate" draws a new seed while locked names stay. Learned styles show "Learned from N names" and ask for a source with at least three names.
- **How to reach it:** Game Mode, Session panel, Tools tab (inline, with "Open in a window" to open the modal). Later (8e4a1ccff): command palette action "Name generator", available anywhere.
- **Settings and defaults:** default style Harsh northern, Name feel Any, Surname on, random seed. None persisted. Not feature-switch gated.
- **Storage:** None (read-only; reads lorebook entries and characters through existing client queries).
- **Tests:** `scripts/regressions/name-generator.regression.ts`.
- **Known limits:** locks reset when the source or lorebook changes; no settings are remembered between openings. Training only picks capitalised words of 3 to 14 letters.

### Campaign codex export (original version, reworked as codex v2)

- **Commit:** `36f8f452e` (2026-09-23 00:45 +0300).
- **Files:** `packages/server/src/services/game/campaign-codex.ts` (new), `packages/server/src/routes/game-tools.routes.ts`, `packages/client/src/hooks/use-game-tools.ts` (`downloadCampaignCodex`), `packages/client/src/components/game/GameToolsPanel.tsx`.
- **What it does:** as merged, downloads a game's campaign memory as readable Markdown or JSON (format `marinara-campaign-codex`, version 1): entities grouped by kind with aliases, newest summary and current state, facts, knowledge and relationships tagged by the session they came from, and a timeline across all sessions. Records of the same entity across session chats were folded into one entry and ids resolved to names. It only reads memory.
- **How to reach it:** Game Mode, Session panel, Tools tab, "Campaign codex" section with Markdown and JSON buttons. Later (8e4a1ccff): command palette action "Download campaign codex (Markdown)".
- **API:** `GET /api/game-tools/codex/:chatId?format=md|json` (attachment named from the game name; 404 for unknown chat).
- **Settings and defaults:** None.
- **Storage:** None (read-only).
- **Later rework:** 7a7a44b11 rebuilt the codex on the merged campaign memory projection with a smaller output and JSON format version 2 (`knowledge` became `claims` and `heldBy`). See the codex v2 entry for current behaviour.
- **Tests:** `scripts/regressions/campaign-codex-export.regression.ts` (adjusted by 7a7a44b11).
- **Known limits:** the version 1 behaviour described here no longer ships; see codex v2.

### Check lorebook (lorebook lint)

- **Commit:** `a837cd319` (2026-09-23 00:58 +0300).
- **Files:** new `packages/shared/src/utils/lorebook-lint.ts` (pure analyzer `lintLorebookEntries`, exported from `packages/shared/src/index.ts`), new `packages/client/src/components/lorebooks/LorebookLintPanel.tsx`; changed `packages/client/src/components/lorebooks/LorebookEditor.tsx` (panel mount plus shared `jumpToEntry`), `packages/client/src/localization/locales/en.json` (`lorebook.editor.lint.*`).
- **What it does:** a collapsible panel that analyzes the entries the editor already holds (no server round trip; computed only while the panel is open). Rules and severities: `invalid_regex` (error: regex key that fails `new RegExp(source, "g")`, matched as plain text), `unsafe_regex` (warning: fails `isPatternSafe`, matched as plain text), `empty_content` (warning), `no_keys` (warning, skipped for constant or always-loaded entries), `overlong` (warning, estimated tokens above the limit), `short_key` (warning, literal key under 3 characters), `common_key` (warning, literal key on an English stop-word list), `duplicate_content` (warning, same whitespace-normalized, case-folded content), `duplicate_key` (info, same key in several entries; regex keys compared by exact source), `disabled` (info).
- **What it does (UI):** header shows per-severity counts; filter chips All / Errors / Warnings / Notes; editable **Token limit** field (default 1000) for the overlong rule; issues sorted by severity, then entry order; clicking an issue ("Go to entry") clears the entry search and the Never fired filter, expands the entry's folder chain, expands the entry and scrolls to it. Results are paged 150 at a time ("Show N more").
- **How to reach it:** Lorebooks panel > open a lorebook > entries section > **Check lorebook** (top of the section, above **Keyword test**). No API route, no palette command in this commit.
- **Settings and defaults:** Token limit 1000 (`LOREBOOK_LINT_DEFAULT_MAX_ENTRY_TOKENS`), minimum key length 3 (`LOREBOOK_LINT_DEFAULT_MIN_KEY_LENGTH`, not exposed in the UI). Token limit is component state only (resets when the editor remounts). Not feature-switch gated.
- **Storage:** None (read-only).
- **Tests:** `scripts/regressions/lorebook-lint.regression.ts`.
- **Known limits:** the common-word list is English only (other languages are only caught by the length rule, per code comment); short/common key rules skip regex keys and constant/always-loaded entries; the analyzer never modifies entries, it only reports.

### Lorebook test tool (real scanner run)

- **Commit:** `a837cd319` (2026-09-23 00:58 +0300).
- **Files:** new `packages/server/src/services/lorebook/test-scan.ts` (`runLorebookTestScan`), new `packages/client/src/components/lorebooks/LorebookScanTest.tsx`; changed `packages/server/src/routes/lorebooks.routes.ts` (test route), `packages/client/src/hooks/use-lorebooks.ts` (`runLorebookTestScan` client call), `packages/client/src/components/lorebooks/LorebookEditor.tsx`.
- **What it does:** extends the existing instant Keyword test with a **Run scanner** button that runs the real generation scanner (`scanForActivatedEntries` / `recursiveScan`) on this lorebook only, against either **Pasted text** or the **Current chat** (all its messages, the chat's character ids and their card tags, and the chat mode's generation triggers). It lists entries that would fire with the reason: Key: matched keys, Constant, Always loaded, Recursion from another entry (with the triggering entry names), plus a chance note when probability is below 100. It separately lists entries whose keys matched but were held back, with the first gate: `secondary_keys`, `filters` (character or trigger filter), `conditions` (activation condition or schedule), `group` (another entry in the group was picked), `probability` (0%), `recursion_only`, `folder_disabled`.
- **What it does (editor):** while a scanner result is shown, the entry row highlights follow it instead of the instant keyword preview; editing the text or switching source discards the result as stale. Each result row jumps to its entry.
- **How to reach it:** Lorebooks panel > open a lorebook > entries section > **Keyword test** > source toggle (**Pasted text** / **Chat: name**) > **Run scanner**. The chat source needs an open chat ("Open a chat to test against it."). API: `POST /api/lorebooks/:id/test` with body `{ text?, chatId? }`, returns `{ activated, blocked, recursive, scannedMessages }` (404 for unknown lorebook or chat).
- **Settings and defaults:** uses the lorebook's own scan depth, recursion and max recursion depth settings; entries without a scan depth use `LIMITS.LOREBOOK_DEFAULT_SCAN_DEPTH`. Not feature-switch gated.
- **Storage:** None (read-only).
- **Tests:** `scripts/regressions/lorebook-test-scan.regression.ts`.
- **Known limits:** timing state (sticky, cooldown, delay) is ignored and chance rolls always pass (stated in the UI hint); pasted text is capped at 200,000 characters and the request body at 1 MiB; only the edited lorebook is scanned, not every lorebook the chat would use; the chat-mode generation trigger `test_scan` is excluded.

### Lorebook activation stats

- **Commit:** `a837cd319` (2026-09-23 00:58 +0300).
- **Files:** new `packages/server/src/services/lorebook/activation-stats.ts`, new `packages/server/src/db/schema/lorebook-activation-stats.ts`; changed `packages/server/src/db/schema/index.ts`, `packages/server/src/db/file-backed-store.ts`, `packages/server/src/routes/generate.routes.ts` (recording), `packages/server/src/routes/lorebooks.routes.ts` (read route), `packages/server/src/app.ts` (flush on shutdown), `scripts/protect-launcher-data.mjs`, `packages/client/src/hooks/use-lorebooks.ts` (`useLorebookActivationStats`), `packages/client/src/components/lorebooks/LorebookEditor.tsx`, `packages/client/src/components/lorebooks/LorebookEntryRow.tsx`.
- **What it does:** after each saved generation the route reports the entries actually injected (`lorebookScanSnapshot.activatedEntries`); counts are queued in memory and written in one transaction about 2 seconds later (`FLUSH_DELAY_MS`), and flushed again in the app's onClose hook. Swipes and regenerations count; a Continue (`input.continueMessageId`) does not. Recording is synchronous, never throws, and failures are logged and dropped so a generation is never affected.
- **What it does (editor):** entry rows show a small `N×` badge with a tooltip "Fired in N generations, last on date"; the sort menu gains **Fired ↓** (ties by order); the totals line gains a **Never fired (N)** toggle that shows only entries with no stats row (folder grouping is paused while it is on).
- **How to reach it:** Lorebooks panel > open a lorebook > entries list (sort menu, totals line). API: `GET /api/lorebooks/:id/activation-stats` returns `{ entryId, lorebookId, count, lastActivatedAt, lastChatId }[]` (never-fired entries are absent). Client query stale time 60 s.
- **Settings and defaults:** at this commit always on. Later gated by the feature switch **Usage and activation stats** (`usageAndActivationStats`, default ON, Settings > Advanced > Features, commit 8aa93818b): off records nothing and the editor does not fetch or show stats.
- **Storage:** new file-backed table `lorebook_entry_activation_stats` (`entryId` primary key, `lorebookId`, `count`, `lastActivatedAt`, `lastChatId`), schema in `packages/server/src/db/schema/lorebook-activation-stats.ts`, registered in `BUILT_IN_FILE_BACKED_TABLES` and `SHARD_KEY_COLUMNS` (sharded by `lorebookId`) in `file-backed-store.ts`, cascade from `lorebook_entries` (by `entryId`), and in `SHARDED_TABLES` / `PRIMARY_KEY_COLUMNS` in `scripts/protect-launcher-data.mjs`.
- **Tests:** `scripts/regressions/lorebook-activation-stats.regression.ts`.
- **Known limits:** counting starts when the feature shipped (no history backfill; "Never fired" means since stats started); a hard exit can lose the last ~2 seconds of counts; a failed batch write drops those counts; entries deleted before the flush are skipped. Later commit e5679fc90 (memoized entry rows) kept the stats display.

### Duplicate character finder

- **Commit:** `a837cd319` (2026-09-23 00:58 +0300).
- **Files:** new `packages/shared/src/utils/character-duplicates.ts` (`findDuplicateCharacters`, `normalizeCharacterName`, `jaccardSimilarity`), new `packages/client/src/components/characters/CharacterDuplicatesModal.tsx`; changed `packages/server/src/routes/characters.routes.ts`, `packages/client/src/hooks/use-characters.ts` (`useCharacterDuplicates`), `packages/client/src/components/panels/CharactersPanel.tsx`.
- **What it does:** groups likely duplicate cards by two signals: an identical normalized name (accents stripped, case folded, bracketed notes and trailing copy / duplicate / imported / new / old / version / counter suffixes removed) or description plus personality overlap by 3-word-shingle Jaccard similarity of at least 0.5 (candidate pairs from an inverted shingle index; texts under 8 shingles are not compared; shingles shared by more than 40 cards are treated as boilerplate). Groups are sorted strongest first and show "Same name" or "N% similar text".
- **What it does (UI):** "Possible duplicates" dialog with side-by-side basics (avatar, name, creator, updated date, tags, description preview), a **Compare** view that loads full cards and marks each field Same / Different / Empty (Name, Description, Personality, Scenario, First message, Creator, Version, Tags), and an **Open** button that opens the card detail. Nothing is changed or deleted.
- **How to reach it:** Characters panel > **Duplicates** button (title "Find duplicate characters") in the toolbar next to New Folder. API: `GET /api/characters/duplicates` returns `{ scanned, groups[] }` with per-card previews (description 280 chars, personality 160 chars).
- **Settings and defaults:** threshold 0.5, shingle size 3, minimum 8 shingles, boilerplate cutoff 40 (code options, not exposed in the UI). Not feature-switch gated.
- **Storage:** None (read-only).
- **Tests:** `scripts/regressions/character-duplicates.regression.ts`.
- **Known limits:** detection only, deletion is manual; the built-in Professor Mari card is excluded; the whole library is parsed on each check (query stale time 0); content similarity uses only description and personality.

### Bulk tag editing for characters

- **Commit:** `a837cd319` (2026-09-23 00:58 +0300).
- **Files:** new `packages/shared/src/utils/character-tag-edits.ts` (`normalizeCharacterTagEdit`, `applyCharacterTagEdit`, `summarizeCharacterTagEdit`, `characterTagListsEqual`), new `packages/client/src/components/characters/CharacterBulkTagsModal.tsx`, new `packages/server/src/utils/settle-with-concurrency.ts`; changed `packages/server/src/routes/characters.routes.ts`, `packages/client/src/hooks/use-characters.ts` (`useBulkEditCharacterTags`), `packages/client/src/components/panels/CharactersPanel.tsx`, `packages/client/src/components/ui/SelectionActionBar.tsx` (labels truncate instead of overflowing).
- **What it does:** add tags (comma-separated), remove tags (tap existing tags to mark), and rename tags (from / to pairs) across the selected characters. Order per card: rename, then remove, then add; matching is case-insensitive, a rename keeps the tag's position, results never hold case-insensitive duplicates. A **Review changes** step shows how many of the selected cards will change and per-operation card counts, computed by the same shared functions the server applies.
- **What it does (server):** each card goes through the normal character update path in its own queued transaction with an expected-revision check (up to 3 retries), 4 cards at a time, so version history records a snapshot with source `bulk-tags` and a reason like `+tag; -tag; old > new` (300 chars max). Returns `{ updatedIds, unchangedIds, failedIds }`; the UI reports success and partial failures.
- **How to reach it:** Characters panel > selection mode > selection bar > **Tags** (title "Edit tags of the selected characters"). API: `POST /api/characters/bulk-tags` with `{ ids, add?, remove?, rename?: [{ from, to }] }` (400 for no ids, more than 5000 ids, or an empty edit).
- **Settings and defaults:** None. Not feature-switch gated.
- **Storage:** None new (writes existing character rows and character version history).
- **Tests:** `scripts/regressions/character-bulk-tags.regression.ts`.
- **Known limits:** 5000 cards per request (the client splits bigger selections into slices); the Professor Mari card is skipped; a card changed by another writer three times in a row is reported as failed. Later commit 97ab74c71 fixed the separate per-tag delete in the Characters panel reading raw rows without tags.

### Command palette (Ctrl+K)

- **Commit:** `4922158c0` (2026-09-23 01:06 +0300).
- **Files:** new `packages/client/src/lib/command-palette.ts` (public `registerCommand` registry, fuzzy ranking, recents, key helpers), `packages/client/src/components/command-palette/CommandPalette.tsx`, `packages/client/src/components/command-palette/CommandPaletteHost.tsx` (global keydown plus built-in commands), `packages/client/src/components/command-palette/palette-navigation.ts` (confirm before leaving a dirty editor), `packages/client/src/stores/command-palette.store.ts`, `packages/client/src/lib/settings-targets.ts`; changed `packages/client/src/components/layout/AppShell.tsx`, `packages/client/src/components/layout/TopBar.tsx`, `packages/client/src/components/chat/HomeNewChatLauncher.tsx` (extracted `useLaunchNewChat`).
- **What it does:** a lazy-loaded search box that jumps to chats (with mode label), characters, personas, lorebooks, presets and Settings tabs ("Settings: General / Appearance / Generations / Add-ons / Imports / Advanced", per `settings.tabs.*.label`), or runs registered actions. Ranking: exact > prefix > word start > substring > in-order subsequence, accent and case insensitive, keywords and subtitles searched at lower weight; up to 60 results. With an empty query it shows recent picks first, then actions. Arrow keys move, Enter runs, Esc closes. Navigation asks before leaving an editor with unsaved changes.
- **Built-in commands at this commit (English labels):** New conversation; New roleplay; New game; Go home; Show or hide chats; Open settings; Switch light or dark mode; Keyboard shortcuts (hint `?`); Show chat guide (only with an open chat); Insert snippet (only with an open chat and at least one snippet); Manage text snippets (opens Settings > General > Text Snippets); Open usage dashboard (opens Settings > Advanced > Usage Dashboard); Browse character cards; Open character library; Open characters; Open personas; Open lorebooks; Open presets; Open connections; Open agents.
- **How to reach it:** Ctrl+K (Cmd+K on macOS; the physical K key also works on non-Latin layouts; key repeats ignored; works while typing since nothing else binds it), or the search button in the top bar (tooltip "Search and commands (Ctrl+K)", hidden when the bar is squeezed below 21rem). Other features add commands through `registerCommand()`.
- **Settings and defaults:** None. Not feature-switch gated.
- **Storage:** localStorage `marinara-command-palette-recents` (up to 12 command ids).
- **Tests:** `scripts/regressions/command-palette.regression.ts`.
- **Known limits:** Ctrl+K toggles the palette. Later commits changed it: 8e4a1ccff added palette commands for later tools and Ctrl+Shift+F search, ab891fb41 stops Ctrl+K and `?` from opening over another open dialog and hides Show chat guide / Insert snippet while an editor is open, 52464c6a7 focuses the search box on mount.

### Keyboard shortcuts overlay (?)

- **Commit:** `4922158c0` (2026-09-23 01:06 +0300).
- **Files:** new `packages/client/src/components/command-palette/KeyboardShortcutsOverlay.tsx`, new `packages/client/src/lib/keyboard-shortcuts.ts` (grouped shortcut list, `isApplePlatform`); changed `packages/client/src/components/command-palette/CommandPaletteHost.tsx`, `packages/client/src/localization/locales/en.json` (`shortcuts.*`).
- **What it does:** a lazy-loaded dialog titled "Keyboard shortcuts" listing every app shortcut in groups: Everywhere (Ctrl/Cmd+K palette, ? this list, Esc close), Chat input (Enter send, Shift+Enter new line, Ctrl/Cmd+Enter send when Send on Enter is off, Up to edit the latest message when enabled, Up/Down and Tab/Enter for / command, @mention and :emoji: suggestions, Space or Tab to expand a snippet, Ctrl/Cmd+Z to undo an expansion), Messages (Left/Right swipes with Intuitive swipe navigation, Ctrl/Cmd+Enter save and Esc cancel an edit, Enter jump to the first search result, Left/Right in the image viewer), Game Mode (Up/Down or W/S and Enter/Space in combat, Left/Right chapters in the Game features guide), Editors and browsers (Tab/Shift+Tab indent, Ctrl/Cmd+S save in the Game Assets file editor, Ctrl/Cmd+A and Esc in the Game Assets browser, arrows/Home/End on a focused sidebar resize handle). Mod keys render as Cmd on Apple platforms.
- **How to reach it:** press `?` while not typing in a text field (Shift is allowed, Ctrl/Cmd/Alt are not), or the command palette command **Keyboard shortcuts**.
- **Settings and defaults:** None. The intro notes that setting-dependent shortcuts only work while that setting is on.
- **Storage:** None.
- **Tests:** covered by `scripts/regressions/command-palette.regression.ts` (key helpers `isShortcutsHelpKey`, `isTypingTarget`).
- **Known limits:** the list is a static table in `keyboard-shortcuts.ts`, not generated from the handlers, so new shortcuts must be added by hand; opening the overlay closes the palette and vice versa (one at a time).

### Text snippets

- **Commit:** `4922158c0` (2026-09-23 01:06 +0300).
- **Files:** new `packages/shared/src/schemas/text-snippets.schema.ts`, `packages/client/src/lib/text-snippets.ts`, `packages/client/src/hooks/use-text-snippets.ts`, `packages/client/src/hooks/use-snippet-expansion.ts`, `packages/client/src/components/chat/SnippetPicker.tsx`, `packages/client/src/components/panels/settings/TextSnippetsSettings.tsx`; changed `packages/client/src/lib/textarea-editing.ts` (`replaceTextareaRange`), `packages/client/src/components/chat/ChatInput.tsx`, `packages/client/src/components/chat/ConversationInput.tsx`, `packages/client/src/components/game/GameInput.tsx`, `packages/client/src/components/panels/SettingsPanel.tsx`, `packages/server/src/routes/app-settings.routes.ts`.
- **What it does:** user-defined trigger to text expansions (for example `;ooc`). Typing a trigger then Space expands it in place (handled on input, so mobile keyboards work), and Tab right after a trigger expands it without inserting a tab. Triggers fire only as whole words (start of text or after whitespace). `{{cursor}}` marks where the caret lands (otherwise a trailing space is kept after a Space expansion); macros like `{{char}}` and `{{user}}` stay as written and are resolved when the message is sent.
- **What it does (undo and picker):** expansions go through `execCommand("insertText")` so they land in the browser's native undo stack and Ctrl/Cmd+Z restores the typed trigger (older browsers that reject execCommand still expand but cannot undo). A searchable **Insert a snippet** picker (arrows, Enter, Esc) inserts at the caret, replacing any selection.
- **How to reach it:** manage in Settings > General > **Text Snippets** (add, edit, delete with confirm). Use in the chat input of roleplay, conversation and game chats; the picker opens from the Quick replies menu item **Snippets** (roleplay/conversation composers; Game Mode has no quick menu) or the palette command **Insert snippet**; **Manage text snippets** in the palette opens the settings section. API: `GET /api/app-settings/text-snippets`, `PUT /api/app-settings/text-snippets` with `{ version: 1, snippets: [{ id, trigger, expansion }] }`.
- **Settings and defaults:** empty list by default. Limits: 200 snippets, trigger 1 to 32 characters without spaces and unique, expansion non-blank and at most 10,000 characters. Not feature-switch gated.
- **Storage:** app_settings key `text-snippets` (server-side JSON catalog, so snippets sync across devices); client query stale time 5 minutes.
- **Tests:** `scripts/regressions/text-snippets.regression.ts`.
- **Known limits:** an invalid stored catalog is ignored and read as empty (logged); only the composer currently on screen answers the palette's picker request; triggers are case-sensitive for uniqueness.

### Usage dashboard

- **Commit:** `4922158c0` (2026-09-23 01:06 +0300).
- **Files:** new `packages/server/src/db/schema/generation-usage.ts`, `packages/server/src/services/storage/generation-usage.storage.ts`, `packages/server/src/services/usage/usage-aggregation.ts`, `packages/server/src/routes/usage.routes.ts`, `packages/shared/src/schemas/usage-dashboard.schema.ts`, `packages/client/src/hooks/use-usage-dashboard.ts`, `packages/client/src/lib/usage-dashboard.ts`, `packages/client/src/components/panels/settings/UsageDashboardSettings.tsx`; changed `packages/server/src/routes/generate.routes.ts` (recording), `packages/server/src/routes/index.ts`, `packages/server/src/db/schema/index.ts`, `packages/server/src/db/file-backed-store.ts`, `packages/server/src/routes/admin.routes.ts`, `scripts/protect-launcher-data.mjs`, `packages/client/src/components/panels/SettingsPanel.tsx`.
- **What it does:** each completed main generation records one ledger row (chat, message, connection actually used including a fallback connection, provider, model, input, output and cached input tokens as the provider reported them), off the response path; a failure is logged and never affects the reply. The dashboard shows totals (Replies, Input tokens, Output tokens, Estimated cost), a Tokens per day bar chart with hover readout, and breakdowns By connection and By chat (deleted ones shown as "Deleted connection" / "Deleted chat"), over 7, 30 or 90 days or a Custom From/To range, in the viewer's local days.
- **What it does (cost):** **Set prices** per connection (Input per 1M, Output per 1M, and a currency symbol) turns token totals into an estimated cost; with no price set it shows "No prices set".
- **How to reach it:** Settings > Advanced > **Usage Dashboard**, or palette command **Open usage dashboard**. API: `GET /api/usage/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&tzOffsetMinutes=N`, `GET /api/usage/settings`, `PUT /api/usage/settings`.
- **Settings and defaults:** range default 30 days; currency default `$`; prices empty; price per 1M 0 to 100,000; range clamped to 366 days (reversed ranges are swapped); tz offset -840 to 840 minutes. At this commit always on; later gated by the feature switch **Usage and activation stats** (`usageAndActivationStats`, default ON, Settings > Advanced > Features, commit 8aa93818b): off records nothing and the dashboard shows an off notice.
- **Storage:** new file-backed table `generation_usage` (schema `packages/server/src/db/schema/generation-usage.ts`), registered in `BUILT_IN_FILE_BACKED_TABLES` and `SHARD_KEY_COLUMNS` (sharded by UTC `day`) in `file-backed-store.ts`, and in `scripts/protect-launcher-data.mjs`; deliberately not cascaded from chats or connections; cleared with the "Chats & Messages" scope (`chats`) of the Danger Zone expunge (`POST /api/admin/expunge`). app_settings key `usage-dashboard` (version 1, currency, per-connection prices).
- **Tests:** `scripts/regressions/usage-dashboard.regression.ts`.
- **Known limits:** usage is recorded only from this version on (no backfill); only main replies are counted, agent and image calls are not; rows where the provider reported zero input and zero output tokens are skipped; for the Claude subscription provider only the fresh (uncached) prompt part is counted as input; cost is an estimate from entered prices and may differ from the provider's bill.

### Message bookmarks

- **Commit:** `8391f07d1` (2026-09-23 02:35 +0300).
- **Files:** `packages/shared/src/utils/message-marks.ts` (new: `MessageBookmark`, `readMessageBookmark`, `normalizeMessageMarkPatch`, `MESSAGE_MARK_EXTRA_KEYS`, `MAX_BOOKMARK_LABEL_LENGTH`), `packages/shared/src/types/chat.ts`, `packages/client/src/components/chat/MessageMarks.tsx` (new: `MessageMarksAction`, `MessageMarkIndicators`), `packages/client/src/components/chat/ChatMessageMarksPanels.tsx` (new: `ChatBookmarksList`), `packages/client/src/components/chat/ChatMessageSearch.tsx`, `packages/client/src/components/chat/MessageActionButton.tsx` (shared `useMessageActionMenu` moved here from `ChatMessage.tsx`), `packages/client/src/components/chat/ChatMessage.tsx`, `packages/client/src/components/chat/ConversationMessage.tsx`, `packages/client/src/components/chat/ConversationMessageActions.tsx`, `packages/client/src/components/chat/ConversationMessageGrouped.tsx`, `packages/server/src/routes/chats.routes.ts`, `packages/server/src/services/storage/chats.storage.ts`.
- **What it does:** any Roleplay or Conversation message can be bookmarked with an optional short label. A bookmark indicator ("Bookmarked" / "Bookmarked: {label}") shows on the message. Chat search gains a Bookmarks view listing every bookmark with speaker (You, character name, System), snippet and time; clicking one jumps to the message.
- **What it does (details):** marks belong to the message, not one swipe: the PATCH handler copies every `MESSAGE_MARK_EXTRA_KEYS` key into all swipes' extra. `chats.storage.ts` preserves these keys when message extra is rewritten. In Game mode the list cannot jump ("Jumping to a message is not available in Game mode. Find it in the game log.").
- **How to reach it:** the message action "Bookmark, pin or note" (bookmark icon) in the Roleplay message actions and the Conversation message actions, then "Bookmark message" / "Remove bookmark" with the "Label (optional)" field. List: chat toolbar button "Search, bookmarks and trash" (chat search panel), tab "Bookmarks" (tabs: Search, Bookmarks, Trash). API: `PATCH /api/chats/:chatId/messages/:messageId` with `bookmark` in the body (validated by `normalizeMessageMarkPatch`).
- **Settings and defaults:** None. Not behind a feature switch.
- **Storage:** message (and swipe) `extra.bookmark` (`{ label, ... }`, label capped at `MAX_BOOKMARK_LABEL_LENGTH` = 80). No new table.
- **Tests:** `scripts/regressions/message-marks.regression.ts` (new).
- **Known limits:** bookmarks are per message, no cross-chat bookmark list; jumping is unavailable in Game mode. The Bookmarks view loads the full message list of the chat (same query as chat search). A later commit (2f9737914, chapters) added `chapter` to the same `MESSAGE_MARK_EXTRA_KEYS` set.

### Pin to context

- **Commit:** `8391f07d1` (2026-09-23 02:35 +0300).
- **Files:** `packages/shared/src/utils/message-marks.ts` (`applyContextMessageLimitWithPins`, `isMessagePinnedToContext`, `MAX_PINNED_CONTEXT_MESSAGES`, `PINNED_CONTEXT_MESSAGE_MARKER`), `packages/server/src/routes/generate.routes.ts`, `packages/server/src/routes/generate/conversation-presence-runtime.ts`, `packages/server/src/routes/generate/dry-run-route.ts`, `packages/server/src/routes/chats.routes.ts`, `packages/client/src/components/chat/MessageMarks.tsx`, `scripts/regressions/prompt.regression.ts`.
- **What it does:** a message pinned to context stays in the prompt even when the chat's context message limit would drop it. When the limit cuts history, pinned messages from the dropped part (the newest 10 at most) are put back in front of the kept window in their original order, each prefixed with `[Pinned message from earlier in the chat]`. Pinned messages are added on top of the limit, so the prompt can hold up to limit + 10 messages.
- **What it does (paths):** applied in the main generate path, the Conversation presence runtime and the dry run (Peek Prompt), so Peek Prompt shows the same result. Also applied where `chats.routes.ts` trims history with the context limit.
- **How to reach it:** message action "Bookmark, pin or note" > "Pin to context" / "Unpin from context" (hint: "Always sent to the model, even past the history limit. Up to 10 per chat."). A pin indicator ("Pinned to context") shows on the message. API: `PATCH /api/chats/:chatId/messages/:messageId` with `pinnedToContext: true|false`.
- **Settings and defaults:** None. Limit `MAX_PINNED_CONTEXT_MESSAGES` = 10 per chat (hard-coded).
- **Storage:** message (and all swipes) `extra.pinnedToContext` (boolean). No new table.
- **Tests:** `scripts/regressions/message-marks.regression.ts` (Peek Prompt includes a pinned message past the history limit), `scripts/regressions/prompt.regression.ts` (changed).
- **Known limits:** pinning an 11th message returns HTTP 409 ("A chat can pin at most 10 messages. Unpin one first."). Pins only matter when a context message limit is set; with no limit (or history shorter than the limit) nothing changes.

### Message trash

- **Commit:** `8391f07d1` (2026-09-23 02:35 +0300).
- **Files:** `packages/server/src/services/storage/message-trash.storage.ts` (new: `createMessageTrashStorage`, `sweepExpiredMessageTrash`), `packages/server/src/db/schema/chats.ts` (`messageTrash`), `packages/server/src/db/file-backed-store.ts`, `packages/server/src/routes/chats.routes.ts`, `packages/client/src/components/chat/ChatMessageMarksPanels.tsx` (`ChatTrashList`), `packages/client/src/components/chat/ChatMessageSearch.tsx`, `packages/client/src/hooks/use-chats.ts` (`useMessageTrash`, `useRestoreTrashedMessages`, `useDeleteTrashedMessages`), `packages/client/src/components/chat/ChatInput.tsx`, `packages/client/src/components/chat/HomeProfessorMariChat.tsx`, `scripts/protect-launcher-data.mjs`, `packages/shared/src/utils/message-marks.ts` (`MessageTrashEntry`, `MESSAGE_TRASH_RETENTION_DAYS`).
- **What it does:** deleting Roleplay or Conversation messages (single or bulk) snapshots the exact message and swipe rows, then runs the normal delete path (so interruption undo, lore cascade and memory chunk invalidation still happen). Restore reinserts the rows under their original ids and `createdAt`, putting the message back in place with its swipes, bookmarks and notes. Entries whose message id exists again stay in the trash and are reported as conflicts. A toast says "Message moved to trash" with the hint to restore within 30 days.
- **What it does (retention):** entries older than the retention window are purged whenever a chat's trash is read or written, by a background sweep 2 minutes after startup and then every 6 hours (timers are unref'd). Game mode deletes stay permanent (game turns carry state snapshots a restore cannot bring back).
- **How to reach it:** chat search panel (toolbar button "Search, bookmarks and trash") > tab "Trash": per entry "Restore" and "Delete forever" (click again to confirm), plus "Restore all" and "Empty trash" ("Click again to empty"). API (prefix `/api/chats`): `DELETE /api/chats/:chatId/messages/:messageId` (now trashes; `?trash=false` skips the trash for rollbacks of rows that were never shown, used by failed sends and the Professor Mari chat), bulk delete also trashes, `GET /api/chats/:chatId/trash`, `POST /api/chats/:chatId/trash/restore` (`{ entryIds }`, 1 to 5000; 409 while a generation runs in that chat), `POST /api/chats/:chatId/trash/delete` (`{ entryIds }` or `{ all: true }`).
- **Settings and defaults:** 30 day retention in this commit. Later, Feature switches (commit 8aa93818b) gated it: Settings > Features "Message trash" (`messageTrash`, default ON; off makes deletes permanent and hides the Trash tab) and "Days kept in Trash" (`messageTrashDays`, default 30, range 1 to 365). No environment override for either.
- **Storage:** new file-backed table `message_trash` (`id`, `chat_id` FK to chats with cascade delete, `message_id`, `role`, `character_id`, `content`, `snapshot` JSON `{ message, swipes }`, `message_created_at`, `deleted_at`), declared in `packages/server/src/db/schema/chats.ts`, registered in `file-backed-store.ts` as a lazy per-chat unit table (shard key `chatId`) and as a child of `chats` for cascade, and added to the protected table list in `scripts/protect-launcher-data.mjs`. Client query key `chatKeys.trash(chatId)`.
- **Tests:** `scripts/regressions/message-trash.regression.ts` (new).
- **Known limits:** Game mode has no trash. Restore is refused while a generation is running in the chat. A delete addressed through a different chat id falls back to the old permanent delete. Entries are listed newest deletion first; list preview shows the active content only (swipe count shown).

### Private message notes

- **Commit:** `8391f07d1` (2026-09-23 02:35 +0300).
- **Files:** `packages/shared/src/utils/message-marks.ts` (`readMessagePrivateNote`, `stripPrivateMessageNote`, `MAX_PRIVATE_NOTE_LENGTH`), `packages/client/src/components/chat/MessageMarks.tsx`, `packages/client/src/stores/ui.store.ts`, `packages/client/src/components/panels/SettingsPanel.tsx`, `packages/server/src/routes/chats.routes.ts`, `packages/client/src/localization/locales/en.json`.
- **What it does:** attach a private note to any message; a small note icon on the message ("Show private note") reveals it. Notes are never sent to the model. Chat exports strip the note from message and swipe extra unless the export option is on; when on, text exports add a `[Private note]` block after the message.
- **How to reach it:** message action "Bookmark, pin or note" > "Private note" field ("Only you can see this. It is never sent to the model."), "Save note" / "Remove note". Export option: Settings > Advanced > Message Tools > "Include private notes in exports". API: `PATCH /api/chats/:chatId/messages/:messageId` with `privateNote`; export routes accept `includePrivateNotes` (body for the bulk export, query string for the single chat export).
- **Settings and defaults:** "Include private notes in exports" (`includePrivateNotesInExports` in the UI store), default off. Not behind a feature switch.
- **Storage:** message (and all swipes) `extra.privateNote` (string, capped at `MAX_PRIVATE_NOTE_LENGTH` = 2000). `includePrivateNotesInExports` persisted in the client UI store (localStorage persisted state).
- **Tests:** `scripts/regressions/message-marks.regression.ts` (notes never reach prompts or exports); later `scripts/regressions/integration-seams.regression.ts` (ab891fb41) checks notes never match global search.
- **Known limits:** the export switch is per device (client store), sent with each export request. Notes are plain text only.

### Nested library folders and Game Mode campaign view (Lorebooks and Characters)

- **Commit:** `cc3d55b6c` (2026-09-23 02:47 +0300). Merged from the `feat/organize` branch, built in a separate session.
- **Files:** merged from the `feat/organize` branch, which was built in a separate session and working copy. New: `packages/shared/src/utils/library-folder-tree.ts`, `packages/shared/src/schemas/library-campaign.schema.ts`, `packages/server/src/db/schema/library-campaign-links.ts`, `packages/server/src/routes/library-campaigns.routes.ts`, `packages/server/src/services/storage/library-campaigns.storage.ts`, `packages/server/src/services/storage/character-folders.ts`, `packages/client/src/hooks/use-library-campaigns.ts`, `packages/client/src/stores/library-organize.store.ts`, `packages/client/src/lib/library-campaign-filter.ts`, `packages/client/src/lib/library-folder-view.ts`, `packages/client/src/components/panels/library/` (`LibraryFolderTree.tsx`, `LibraryPickerModal.tsx`, `LibraryCampaignBar.tsx`, `LibraryCampaignSections.tsx`, `LibraryCampaignBadges.tsx`, `LibrarySelectionExtraActions.tsx`, `use-library-organizer.tsx`, `use-auto-load-all-pages.ts`). Changed: `packages/client/src/components/panels/CharactersPanel.tsx`, `packages/client/src/components/panels/LorebooksPanel.tsx`, `packages/server/src/services/storage/library-folders.storage.ts`, `packages/server/src/services/storage/characters.storage.ts`, `packages/server/src/services/storage/character-catalog.ts`, `packages/server/src/services/storage/lorebooks.storage.ts`, `packages/server/src/routes/{characters,lorebooks,library-folders,index}.routes.ts`, `packages/shared/src/schemas/{library-folder,character}.schema.ts`, `packages/shared/src/types/character.ts`, hooks `use-characters.ts`, `use-lorebooks.ts`, `use-library-folders.ts`, `en.json` (new `ui.panels.libraryorganize.*` keys).
- **What it does (folders):** lorebook and character folders can nest up to six levels (`LIBRARY_FOLDER_MAX_DEPTH = 6`, root = depth 1). Shared tree rules (`checkLibraryFolderParent`) reject missing parent, self-parenting, cycles and over-depth moves; the server returns HTTP 400 with the reason (`LibraryFolderTreeError`), and parent check plus write run in one transaction so concurrent moves cannot form a loop. Folder counts include subfolders, open folders are remembered, and a search opens folders holding a match and shows each result's folder path. Deleting a lorebook (resource) folder moves its subfolders and items up one level (or to the top level); deleting a character folder moves subfolders up but its characters simply leave the folder (not merged into the parent), because character groups double as chat setup presets. Existing flat folders load unchanged at the root. Preset and agent folders (same `library_folders` store) get server-side nesting support too.
- **What it does (campaigns):** a campaign is every Game Mode chat (`mode = "game"`) sharing a `gameId` (falling back to the chat group, then the chat itself). Membership is derived automatically: characters from chat `characterIds`, party, GM and linked NPC cards; personas from the chat and setup; lorebooks the chats activate or own, plus library lorebooks linked to those characters and personas. Manual changes are stored as `include` / `exclude` links (removing a derived item stores an exclusion). Campaign name comes from the latest session chat with the " Session N" suffix stripped; campaigns sort by last played. A campaign picker above each list filters to one campaign or "Not in any campaign" (filtering is resolved on the server); the group toggle splits the list into collapsible campaign sections; rows show a small campaign badge that filters on click.
- **How to reach it:** Characters and Lorebooks panels. Folder rows get "New subfolder", "Move folder to..." and delete buttons; drag a folder onto another folder or onto the "Drop here to move the folder to the top level" zone; double-click, double-tap or F2 renames a folder. In selection mode, "Move to folder..." (opens a folder-tree picker, "Move N lorebooks/characters") and "Campaign" (Swords icon, "Add to or remove from a campaign", tick to add, untick to remove); a Swords button on a lorebook row does the same for one lorebook. Above the list: "Campaign" select ("All campaigns", "Not in any campaign", each campaign with session count) and the Layers button "Group by campaign". API: `GET /api/library/campaigns`, `POST /api/library/campaigns/:campaignId/items`, `POST /api/library/campaigns/:campaignId/items/remove` (body `{ itemType: "character"|"persona"|"lorebook", itemIds: [1..5000] }`, 404 for unknown campaign); `campaign=<id>` or `campaign=__none__` query on `GET /api/characters/catalog` and `GET /api/lorebooks`; `parentId` on `POST /api/library-folders/:scope`, `PATCH /api/library-folders/:scope/:id`, `POST /api/characters/groups`, `PATCH /api/characters/groups/:id`.
- **Settings and defaults:** None (not feature-switch gated). Per-panel defaults: campaign filter "all", group by campaign off.
- **Storage:** new file-backed table `library_campaign_links` (`id`, `campaign_id`, `item_type`, `item_id`, `mode`, `created_at`, unique on campaign+type+item), exported from `packages/server/src/db/schema/index.ts`, added to `BUILT_IN_FILE_BACKED_TABLES` in `packages/server/src/db/file-backed-store.ts` and to `SHARDED_TABLES` in `scripts/protect-launcher-data.mjs`. New nullable `parent_id` column on `library_folders` and `character_groups` (absent on old rows = root). localStorage key `marinara-library-organize-v1` (per panel: campaign filter, group by campaign, expanded folder ids, collapsed campaign ids; at most 500 remembered ids each). A later merge (ab891fb41) clears `library_campaign_links` in the Danger Zone chats expunge (`packages/server/src/routes/admin.routes.ts`).
- **Tests:** `scripts/regressions/library-folder-tree.regression.ts`, `scripts/regressions/library-campaigns.regression.ts`, `scripts/regressions/library-organize-migration.regression.ts` (pre-feature data without `parentId` or the links table loads cleanly), `scripts/regressions/library-organize-unshard.regression.ts` (launcher unshard covers the new table and keeps `parentId`).
- **Later changes:** e4098e218 fetches character folder members beyond loaded pages by id, fixes inflated folder counts and keeps character folder order stable; 80eaf5384 adds a lorebook folder power switch and a campaign roster (GM, party, NPC chips) when the Characters panel is filtered to one campaign; 8614962f1 adds a folder-view performance regression.
- **Known limits:** six nesting levels; campaign list is cached server-side and recomputed when source tables change; grouped-by-campaign views load every page only up to a 50-page safety cap (`useAutoLoadAllPages`); manual links for deleted items linger harmlessly but are not counted; campaigns exist only for Game Mode chats.

### Character tag filter now covers the whole library, not just loaded pages

- **Commit:** `cc3d55b6c` (2026-09-23 02:47 +0300). Merged from the `feat/organize` branch, built in a separate session.
- **Files:** `packages/client/src/components/panels/CharactersPanel.tsx`, `packages/client/src/components/panels/library/use-auto-load-all-pages.ts`.
- **What it does:** character tags are matched in the browser, so previously an include/exclude tag filter (and the full tag list) only saw the catalog pages already loaded, missing matches further down. The panel now keeps fetching catalog pages while a tag filter is active or the tag list is expanded, so filtered results and the tag list reflect every character. Stops on a page fetch error.
- **How to reach it:** Characters panel, tag filter chips / expanded tag list (clicking a tag on a character row also adds it to the filter).
- **Settings and defaults:** None.
- **Storage:** None (read-only).
- **Tests:** none specific to this fix in the commit.
- **Known limits:** loading stops at 50 pages (safety cap in `useAutoLoadAllPages`). The equivalent lorebook tag-filter paging fix landed later in e4098e218.

### Command palette hub: commands for every tool

- **Commit:** `8e4a1ccff` (2026-09-23 03:14 +0300).
- **Files:** `packages/client/src/components/command-palette/CommandPaletteHost.tsx`, `packages/client/src/components/command-palette/CommandPalette.tsx`, `packages/client/src/lib/game-session-panel-events.ts` (new), `packages/client/src/lib/lorebook-editor-events.ts` (new), `packages/client/src/lib/open-character-duplicates.ts` (new), `packages/client/src/components/game/GameSurface.tsx`, `packages/client/src/components/lorebooks/LorebookEditor.tsx`, `packages/client/src/components/lorebooks/LorebookLintPanel.tsx`, `packages/client/src/components/layout/ModalRenderer.tsx`, `packages/client/src/localization/locales/en.json`.
- **What it does:** registers palette commands for the newer tools. Commands added (exact English labels):
  - "Search all chats" (shows the Ctrl/Cmd+Shift+F hint): opens the global search dialog.
  - "Activity overview": opens the activity overview.
  - "Name generator": opens the name generator.
  - "Find duplicate characters": opens the new `character-duplicates` modal from any screen; opening a character from it goes through the usual unsaved-editor prompt.
  - "Stats for this chat" (subtitle "Chat statistics"): chat stats for the open chat (any mode).
  - "Export this chat as Markdown" and "Export this chat as a story" (styled HTML): export the open chat.
  - "Open the dice log": opens the game Session panel on its Tools tab (on phones via the actions menu); only with a game chat open and no editor covering it.
  - "Download campaign codex (Markdown)": downloads the open game's codex; error toast on failure.
  - "Check this lorebook": in the open Lorebook Editor, opens and scrolls to the "Check lorebook" lint panel.
  - "Test this lorebook's keywords": in the open Lorebook Editor, opens and scrolls to the keyword test.
  - Dynamic "Search all chats for "{query}"": appended to every non-empty query so the palette never dead-ends; runs global search with that text and is not stored in recents.
- **How to reach it:** command palette (Ctrl+K, Cmd+K on macOS), type the label or a keyword (e.g. "lint", "dice", "dedupe", "heatmap").
- **Settings and defaults:** None. Context-dependent commands are hidden via `when` (active chat, game chat, open lorebook).
- **Storage:** None (read-only). Palette recents unchanged except the per-query search is excluded.
- **Tests:** `scripts/regressions/command-palette.regression.ts` (changed: each new command id registered, game tools need a game chat, lorebook tools need an open lorebook, new labels exist in `en.json` with no em dash, per-query search present).
- **Known limits:** cross-screen commands work through window events (`marinara:game-session-panel-open`, `marinara:lorebook-editor-tool`), so they only act when the game screen or Lorebook Editor is mounted.

### Ctrl+Shift+F opens Search all chats

- **Commit:** `8e4a1ccff` (2026-09-23 03:14 +0300).
- **Files:** `packages/client/src/lib/command-palette.ts` (`isGlobalSearchShortcut`, `canOpenGlobalSearchFromShortcut`), `packages/client/src/lib/modal-overlay-registry.ts` (`countModalOverlays`), `packages/client/src/components/command-palette/CommandPaletteHost.tsx`, `packages/client/src/lib/keyboard-shortcuts.ts`.
- **What it does:** Ctrl+Shift+F (Cmd+Shift+F on macOS) opens Search all chats. Matched by `code === "KeyF"` on non-Latin layouts; Alt or key repeat do not trigger it; plain Ctrl+F is left to the browser. It does not open over another dialog; if only the palette is open, the palette closes and search opens.
- **How to reach it:** the shortcut, anywhere (including while typing). Listed in the keyboard shortcuts overlay as "Search all chats (when no other dialog is open)".
- **Settings and defaults:** None.
- **Storage:** None.
- **Tests:** `scripts/regressions/command-palette.regression.ts` (shortcut matching incl. a Hebrew-layout key with `code: "KeyF"`, and the overlay-count rule).
- **Known limits:** ignored while any non-palette dialog is open.

### Palette hub consistency fixes

- **Commit:** `8e4a1ccff` (2026-09-23 03:14 +0300).
- **Files:** `packages/client/src/components/command-palette/KeyboardShortcutsOverlay.tsx`, `packages/client/src/lib/keyboard-shortcuts.ts`, `packages/client/src/components/game/GameDiceLog.tsx`, `packages/client/src/components/panels/settings/UsageDashboardSettings.tsx`, `packages/client/src/localization/locales/en.json`.
- **What it does:**
  - Keyboard shortcuts overlay opens full screen on phones (`mobileFullscreen`).
  - Shortcuts overlay lists previously undocumented keys: "Move through and run command palette results" (arrows, Enter), "Move through and insert from the snippet picker", "Open the first Search all chats result" (Enter), plus the new Ctrl/Cmd+Shift+F entry.
  - Dice log load error now uses the destructive text colour and a standard styled Retry button.
  - Usage Dashboard (Settings > Advanced) load error gains a "Retry" button that refetches the summary.
- **How to reach it:** "?" or palette "Keyboard shortcuts"; game Session panel > Tools tab (dice log); Settings > Advanced > Usage Dashboard.
- **Settings and defaults:** None.
- **Storage:** None.
- **Tests:** none specific beyond `scripts/regressions/command-palette.regression.ts`.
- **Known limits:** cosmetic only.

### Campaign log reader (Game Mode)

- **Commit:** `7a7a44b11` (2026-09-23 04:00 +0300).
- **Files:** new `packages/client/src/components/modals/GameLogModal.tsx`, `packages/client/src/lib/game-log.ts`, `packages/client/src/lib/open-game-log.ts`, `packages/server/src/services/game/campaign-log.ts`; changed `packages/server/src/routes/game-tools.routes.ts`, `packages/client/src/hooks/use-game-tools.ts` (`useCampaignLog`, `campaignLogKeys`), `packages/client/src/components/game/GameToolsPanel.tsx`, `packages/client/src/components/layout/ModalRenderer.tsx` (modal id `game-log`), `packages/client/src/components/command-palette/CommandPaletteHost.tsx`, `packages/client/src/components/chat/ChatArea.tsx`, `packages/client/src/components/modals/GlobalSearchModal.tsx`, `packages/client/src/localization/locales/en.json` (`ui.game.log.*`, `ui.game.tools.log*`, `palette.actions.openCampaignLog`; removed `chatInsights.gotoUnavailableInGame`).
- **What it does:** a full-screen reader that lays out every session of a campaign in order as one story. The server (`loadCampaignLog`) returns only readable turns (roles user, assistant, system, narrator; hidden messages and the synthetic "[start the game]" user message left out) with each turn's /goto message number (1-based position among all stored messages of that session chat), timestamp, and each session's segment edits (`segmentEdit:<messageId>:<n>`) and deletions (`segmentDelete:<messageId>:<n>`) read from chat metadata, plus the player persona name per session. The client (`buildGameLogEntries`) parses assistant turns into narration, dialogue, readable and system lines, applies the edits, drops deleted segments, strips `[To the party]` / `[To the GM]` prefixes and turns inline `[dice: ...]` tags and emphasis markers into plain text so search matches what is shown.
- **What it does (search and filters):** campaign-wide case-insensitive search (at least 2 characters, whitespace in the query matches any whitespace run) with highlighted matches, a "N of M" counter, previous/next buttons; filters by session ("All sessions" / "Session N") and by speaker ("Anyone", "Narration", the player, each named speaker). Opening at a target (message id or /goto number) scrolls to and briefly highlights that turn (about 2.6 s); a hidden target lands on the nearest readable turn with the notice "That message is not part of the readable log, so the log opened at the nearest turn."
- **How to reach it:** Game Mode Session panel > Tools tab > "Campaign log" section > "Open campaign log" button; command palette "Open campaign log" (only offered when the active chat is a game chat; keywords game log, history, reread, session, transcript). Jumping to a game message from Search All Chats or /goto now opens the log at that turn instead of the old "not available in Game mode" toast. In the search box, Enter goes to the next match and Shift+Enter to the previous. API: `GET /api/game-tools/log/:chatId` (404 `Game chat not found` for an unknown or non-game chat).
- **How it picks sessions:** shares `resolveCampaignSessionChats` (moved into `packages/server/src/services/game/campaign-codex.ts` by this commit) with the codex: game-mode chats of the same group whose `gameId` matches, following the canonical line; opened from inside a branch, the branch stands in for the chain it forked from, and canonical sessions after the fork are dropped unless they continue the branch.
- **Settings and defaults:** None. Not behind a feature switch.
- **Storage:** None (read-only). Client query key `["game-campaign-log", chatId]` with `staleTime` and `gcTime` of 30 s so a large payload is not kept after the reader closes.
- **Transport:** responses of 64 KiB or more are gzipped when the request sends `Accept-Encoding: gzip` (`sendText` in `game-tools.routes.ts`, `Vary: Accept-Encoding`).
- **Tests:** `scripts/regressions/campaign-log-reader.regression.ts` (new).
- **Later changes:** `c664bb44d` renders the session name without template strings; `2f9737914` added a chapter picker and chapter marking/editing inside the log (chapters come from message `extra`, a chapter on a hidden turn shows on the next readable one); `ad7a61ad1` enlarged text and touch targets on phones.
- **Known limits:** one response is capped at `CAMPAIGN_LOG_MAX_CHARS` = 12,000,000 characters of turn text; past that the oldest sessions (never the one the log was opened from) are emptied, marked `omitted`, and listed in a notice. The client renders a window of 60 turns (`LOG_WINDOW_SIZE`), grown with "Show earlier turns" / "Show later turns" up to 180 rendered at once (`LOG_MAX_RENDERED`), trimming the far side. Search stops at 5,000 hits (`LOG_SEARCH_MAX_HITS`, shown as "N of M+"). Read-only apart from the later chapter editing.

### Campaign codex v2: projection based, each statement written once, gzip

- **Commit:** `7a7a44b11` (2026-09-23 04:00 +0300).
- **Files:** changed `packages/server/src/services/game/campaign-codex.ts` (new `resolveCampaignSessionChats`, `codexSessionsFromProjection`, `codexExcerpt`, `CODEX_MARKDOWN_VALUE_MAX`, `CODEX_JSON_VALUE_MAX`), `packages/server/src/routes/game-tools.routes.ts`, `CHANGELOG.md`; reads `readCampaignMemoryProjection` from `packages/server/src/services/game/campaign-memory-campaign-scope.ts`.
- **What changed versus the first codex export (`36f8f452e`):** v1 read each session chat's memory separately through the campaign memory storage, merged entities by guessing from origin ids, owner records and names, and listed knowledge under every holder ("What they know", labelled Knows / Believes / Has heard, one line per holder), with no length limits. On a long campaign the same long statement was repeated under many holders, so the file grew to tens of MB. v2, on the canonical line, reads the campaign memory projection of the newest session (the same merge the game plays from), so a tracked NPC and the library character of the same name are one entry, presence comes only from the newest session, and facts re-read in later sessions appear once; `codexSessionsFromProjection` splits the projection back per session so every record keeps its session tag.
- **What it does (statements):** each verified fact and each unverified claim is keyed by subject, predicate and value and written once under its subject. Who holds it is listed under the statement as `heldBy` groups ("Known by", "Believed by", "Heard by") instead of a copy under every holder. The same statement under another subject becomes an excerpt with `sameAs` pointing at the entry that has it in full (Markdown: "(as under <name>)"). The Markdown section "What they know" is replaced by "Unverified, as held in the story".
- **Sizes:** values are cut at a word break with an ellipsis: 280 characters in the Markdown (`CODEX_MARKDOWN_VALUE_MAX`; timeline event summaries at 560), 4,000 in the JSON (`CODEX_JSON_VALUE_MAX`). The Markdown lists at most 12 holder names per state, then "and N more". The size regression builds a campaign shaped like a real 12-session one (about 1,400 entities, 14k facts with long values, 18k knowledge rows over 7.4k distinct statements, 1,500 events) and asserts the Markdown stays under 6 MiB and the JSON under 16 MiB.
- **Format:** JSON `format` stays `marinara-campaign-codex`; `version` goes from 1 to 2. Per entity, `knowledge` is removed and replaced by `claims`; statements gain optional `sameAs` and `heldBy: [{ state, names }]`.
- **Fallback:** a branch export, or a game whose sessions the projection does not cover exactly (for example a later branch of an earlier session), falls back to reading each session chat as before, keeping the branch-aware session list. Session selection now also excludes chats in the group that carry another game's id.
- **How to reach it:** Game Mode Session panel > Tools tab > "Campaign codex" section, "Markdown" and "JSON" buttons; command palette "Download campaign codex (Markdown)" (palette command added later in `8e4a1ccff`). API: `GET /api/game-tools/codex/:chatId?format=md|json` (default `md`), sent as an attachment (`<game>.md` / `.json`); bodies of 64 KiB or more are gzipped when the client accepts gzip.
- **Settings and defaults:** None. Not behind a feature switch.
- **Storage:** None (read-only).
- **Tests:** `scripts/regressions/campaign-codex-projection.regression.ts` (new), `scripts/regressions/campaign-codex-size.regression.ts` (new), `scripts/regressions/campaign-codex-export.regression.ts` (updated for `claims` / `heldBy`).
- **Known limits:** long values are truncated in both formats (the JSON keeps up to 4,000 characters); holder lists in the Markdown are capped at 12 names per state.

### Random tables and yes/no oracle (Game Mode tools)

- **Commit:** `a03fe63a5` (2026-09-23 04:39 +0300).
- **Files:** new `packages/client/src/components/tools/RandomTablesTool.tsx`, `packages/client/src/components/modals/RandomTablesModal.tsx`, `packages/client/src/hooks/use-random-tables.ts`, `packages/client/src/lib/open-random-tables.ts`, `packages/client/src/lib/chat-input-insert.ts`, `packages/shared/src/utils/random-tables.ts`, `packages/server/src/routes/random-tables.routes.ts`, `packages/server/src/services/storage/random-tables.storage.ts`, `packages/server/src/db/schema/random-tables.ts`; changed `packages/client/src/components/game/GameToolsPanel.tsx`, `packages/client/src/components/game/GameInput.tsx`, `packages/client/src/components/game/GameDiceLog.tsx`, `packages/client/src/hooks/use-game-tools.ts`, `packages/server/src/services/game/dice-roll-log.ts`, `packages/server/src/routes/index.ts`, `packages/client/src/components/command-palette/CommandPaletteHost.tsx`, `packages/client/src/components/layout/ModalRenderer.tsx` (modal id `random-tables`).
- **What it does (tables):** GM roll tables rolled on dice (plain NdM, no modifier, up to 10 dice of up to 1000 faces, e.g. d6, d20, d100, 2d6 with row ranges such as 1-3) or by weight. Tables are edited by pasting a plain list, one row per line: a leading total or range ("1-3: Bandits", "4. Wolves", "05-10 Rain") makes a dice table (dice inferred from the covered span, e.g. 1-20 is d20, 2-12 is 2d6), a trailing "(x3)" weights a row, unranged or mixed lists roll by weight. `[[Table Name]]` in a row rolls another visible table, up to 5 levels deep (100 expansions total, cycles stopped). Tables can be global ("All games") or belong to one game ("This game"); a game table shadows a global one of the same name for references. Import and export as JSON, and "Build a table from a lorebook folder or tag" (rows are entry names, optional subfolders and disabled entries).
- **What it does (oracle):** "Oracle" asks an optional yes/no question at five likelihoods (certain 90, likely 75, even 50, unlikely 25, impossible 10 percent yes on d100, a simplified Mythic fate chart). Outcomes: Yes, and / Yes / Yes, but / No, but / No / No, and; rolls within 5 of the line get the "but" twist, the outer fifth of each side is exceptional.
- **What it does (output):** rolls happen on the server. "Log rolls to the dice log" records table and oracle rolls in the game's Dice Log with source "Table" (only for a Game Mode chat). "To input" drops the result line into the open chat input as `(OOC: ...)` via the card-asset insert event that ChatInput and GameInput listen to; nothing is sent automatically.
- **How to reach it:** Game Mode Session panel > Tools tab > "Random tables" section (embedded tool, with "Open in a window"); command palette "Random tables and oracle" (available in any chat; keywords oracle, roll, table, random, yes no, dice, gm). Tables and the oracle are one tool in one window, not separately reachable. API under `/api/random-tables`: `GET /?chatId=` (game's plus global tables), `POST /`, `PUT /:id` (optionally moves scope), `DELETE /:id`, `POST /import` (`skipExisting` option), `POST /roll` (`tableId`, `chatId`, `log`), `POST /oracle` (`likelihood`, `question`, `chatId`, `log`), `GET /lorebook-sources/:lorebookId`, `POST /from-lorebook`.
- **Settings and defaults:** not behind a feature switch. Scope defaults to "This game" in a Game Mode chat, otherwise "All games" (game scope needs a Game Mode chat, else 400). Logging to the dice log is off until toggled.
- **Storage:** new table `random_tables` (`id`, `name`, `game_id` ("" for global), `dice`, `description`, `rows` JSON, `created_at`, `updated_at`), schema `packages/server/src/db/schema/random-tables.ts` exported from `packages/server/src/db/schema/index.ts`, registered in `BUILT_IN_FILE_BACKED_TABLES` (`packages/server/src/db/file-backed-store.ts`) and `SHARDED_TABLES` (`scripts/protect-launcher-data.mjs`). No foreign key to chats: a game table outlives any one session. Later (`ab891fb41`) the Danger Zone clear that deletes chats also deletes game-scoped random tables and keeps global ones (`packages/server/src/routes/admin.routes.ts`). localStorage key `marinara-random-tables-log` (log toggle). Dice log `source` gains `"table"`.
- **Tests:** `scripts/regressions/random-tables.regression.ts` (new).
- **Later changes:** `2f9737914` added table starter packs (`packages/client/src/lib/random-table-packs.ts`, added with `skipExisting` so a pack added twice adds nothing); `c664bb44d` scope rendering fix; `ad7a61ad1` phone sizing.
- **Known limits:** at most 2,000 tables per scope (`MAX_RANDOM_TABLES`, 409 "Too many tables"), 1,000 rows per table, 2,000 characters per row, 120 characters per name, 2,000 tables per import; request bodies capped at 4 MB per table and 16 MB per import; nested rolls stop at depth 5.

### Character usage lookup ("Used in" and Unused characters)

- **Commit:** `a03fe63a5` (2026-09-23 04:39 +0300).
- **Files:** new `packages/server/src/services/characters/character-usage.ts`, `packages/server/src/routes/character-usage.routes.ts`, `packages/client/src/hooks/use-character-usage.ts`, `packages/client/src/components/characters/CharacterUsageSection.tsx`, `packages/client/src/components/characters/CharacterUnusedModal.tsx`; changed `packages/client/src/components/characters/CharacterEditor.tsx`, `packages/client/src/components/panels/CharactersPanel.tsx`, `packages/server/src/routes/index.ts`, `packages/client/src/localization/locales/en.json` (`characters.usage.*`, `characters.unused.*`).
- **What it does:** the character editor shows "Used in": every chat and game the card is in with its role (In chat, Persona, Party, NPC, GM), game sessions grouped per game, when each was last played, links to open the chat or the latest session, and, on request ("Count messages"), message counts per chat. "Unused characters" lists library cards that no chat uses as a member or persona and no game uses as a party member, NPC or GM, filterable by All / Characters / NPCs and by name, with "Open character"; nothing is deleted.
- **How it works:** built from chat rows only (`characterIds`, `personaCharacterId`, Game Mode metadata `gamePartyCharacterIds`, `gameNpcs[].characterId`, `gameGmCharacterId` when `gameGmMode` is `character`), never messages. Each chat's contribution is cached in process against the row fields it came from and rebuilt only when a row changes, so edits, new sessions and deleted chats show up on the next request. Internal assistant chats, `npc:` ids and the built-in assistant character are ignored.
- **How to reach it:** Character editor > Metadata section ("Used in"); Characters panel toolbar button "Unused" (title "Find cards that are not in any chat or game"). API under `/api/character-usage`: `GET /summary` (chat and game counts per character id), `GET /unused`, `GET /:characterId` (`?counts=1` or `true` adds `messageCounts`, 404 for an unknown character).
- **Settings and defaults:** None. Not behind a feature switch. Message counts are opt-in per request.
- **Storage:** None (read-only). In-memory index in the server process only.
- **Tests:** `scripts/regressions/character-usage.regression.ts` (new).
- **Later changes:** `ab891fb41` made cached message counts recount when the messages table write generation changes (deleting, trashing or restoring an earlier message does not touch the chat row).
- **Known limits:** message counts cover at most the 50 most recent chats (`MESSAGE_COUNT_LIMIT`, shown as "Counted the 50 most recent"); client caches detail for 30 s and the unused list for 10 s.

### Game log and random table labels without template strings

- **Commit:** `c664bb44d` (2026-09-23 05:20 +0300).
- **Files:** `packages/client/src/components/modals/GameLogModal.tsx`, `packages/client/src/components/tools/RandomTablesTool.tsx`.
- **What it does:** the Campaign log header's session name (" · {session}") and the random table "(All games)" scope suffix are now rendered as separate JSX text nodes instead of JS template strings, so the translated label is not glued into a hard-coded string. No visible change in English.
- **How to reach it:** palette "Open campaign log"; Random tables tool list.
- **Settings and defaults:** None.
- **Storage:** None.
- **Tests:** none added.
- **Known limits:** the separators (" · ", parentheses) remain literal punctuation.

### Integration review: cross-feature fixes

- **Commit:** `ab891fb41` (2026-09-23 07:57 +0300).
- **Files:** `packages/client/src/components/command-palette/CommandPaletteHost.tsx`, `packages/client/src/lib/keyboard-shortcuts.ts`, `packages/server/src/services/chat-insights/chat-insights.service.ts`, `packages/server/src/services/game/segment-edits.ts` (exports `collectSegmentOverlays`), `packages/server/src/services/characters/character-usage.ts`, `packages/server/src/routes/admin.routes.ts`, `packages/client/src/components/panels/CharactersPanel.tsx`, `packages/client/src/components/panels/library/LibrarySelectionExtraActions.tsx`, `packages/client/src/localization/locales/en.json`.
- **Search:** Search all chats in Game mode now matches the text the player sees: narration segment edits and deletions are applied before matching and snippets quote the edited text (new `createVisibleContentReader`). Trashed messages are not hits, restored ones are again, private notes never match.
- **Stats:** Chat statistics read the same visible content, so longest-message previews and counts reflect Game mode segment edits; trashing or restoring a message moves the totals.
- **Palette:** the palette shortcut no longer opens over another dialog (same rule as Ctrl+Shift+F), "?" (keyboard shortcuts) is ignored while any dialog is open, and "Show chat guide" and "Insert snippet" are hidden while an editor covers the chat screen.
- **Danger Zone clears:** Settings > Danger Zone clearing "Chats & Messages" (`POST /api/admin/expunge` with the `chats` scope, and `POST /api/admin/clear-all`) now also deletes game-scoped random tables (`random_tables` where `gameId` is set; global tables stay) and all `library_campaign_links`. Message trash, dice log rows and lorebook activation stats are verified to go with their parents.
- **Usage recounts:** character usage message counts were cached by chat row key only, so deleting, trashing or restoring an earlier message left a stale count. The cache now also stores the `messages` table write generation and recounts when it changes (unless the chat's unit is not resident).
- **Narrow panels:** bulk action buttons in the Characters panel selection bar and the library selection bar (tag, move, campaign) collapse to icons when the panel is under 28rem wide (container query), not only under a 400px viewport.
- **Locale cleanup:** removed seven unused keys from `en.json` (`ui.game.gamejournal.*` search and close strings, `ui.game.gamepartybar.value1HpValue2OfValue3`).
- **How to reach it:** no new entry points; the fixes apply to Search all chats (Ctrl+Shift+F), Stats for this chat (branch menu), the command palette (Ctrl+K) and "?" overlay, Settings > Danger Zone, the Characters panel and library selection bars.
- **Tests:** `scripts/regressions/integration-seams.regression.ts` (new: trash, bookmarks, pins, notes vs global search, chat stats and character usage; segment edits in search; chat delete clearing trash and dice rows), `scripts/regressions/integration-expunge.regression.ts` (new: Danger Zone clears), `scripts/regressions/command-palette.regression.ts` (changed: dialog guards, detail-open guards).
- **Settings and defaults:** None.
- **Storage:** no new storage; Danger Zone clear list gains `random_tables` (game-scoped) and `library_campaign_links`.
- **Known limits:** the usage recount relies on the file-backed store exposing `getTableWriteGeneration`; without it (`-1`) the cache is bypassed.

### Persistent, recoverable generation jobs (job tracking, E02)

- **Commit:** `077e055ee` (2026-09-23 08:27 +0300). Follow-ups 1094acd08 (2026-09-23 13:40, one log line per job transition) and d91c5d395 (2026-09-24 10:00, moved into Feature switches) are folded in; this entry describes the current state.
- **Files:** new `packages/server/src/services/generation/generation-job-tracker.ts`, `packages/server/src/db/schema/generation-job-records.ts`, `packages/server/src/services/storage/generation-job-records.storage.ts`, `packages/server/src/routes/generation-job-records.routes.ts`, `packages/client/src/components/generation-jobs/GenerationJobsRecoveryHost.tsx`, `packages/client/src/components/generation-jobs/GenerationJobsActivityDot.tsx`, `packages/client/src/components/generation-jobs/TrackedJobDetails.tsx`, `packages/client/src/components/panels/settings/GenerationJobTrackingSettings.tsx`, `packages/client/src/hooks/use-generation-job-tracking.ts`, `packages/client/src/lib/generation-job-tracking.ts`, `docs/development/generation-jobs.md`; changed `packages/server/src/services/generation/generation-jobs.ts` (observer seam `setObserver`/`notify`, plus the store's own `job.state` lines), `packages/server/src/routes/index.ts`, `packages/server/src/db/schema/index.ts`, `packages/server/src/db/file-backed-store.ts`, `packages/server/src/routes/admin.routes.ts`, `packages/client/src/components/modals/GenerationJobsModal.tsx`, `packages/client/src/components/layout/TopBar.tsx`, `packages/client/src/components/layout/AppShell.tsx`, `packages/client/src/components/panels/settings/FeatureSwitchesSettings.tsx`, `scripts/protect-launcher-data.mjs`.
- **What it does:** when on, every media job that runs through the existing job store (`generationJobs.run`) gets a persisted record: gallery image and selfie, scene background, character avatar and sheet drafts (kind `image`), sprite sheet and animated expressions (kind `sprite`), gallery scene video (kind `video`). The record holds status, timestamps, `elapsedMs`, `errorCode`, `errorId`, `resultRef` (first same-origin asset path, else `/api/generation-jobs/:id/result`; never data or remote URLs), `seenAt` and a log trail. A job keeps running on the server after a refresh, a closed tab or a dropped connection.
- **What it does (states and recovery):** statuses are `accepted`, `running`, `completed`, `failed` (includes timeout `ME_TIMEOUT`), `cancelled` (`ME_CANCELLED`) and `interrupted` (`ME_INTERRUPTED`). On reconnect, after a reload, or when a hidden or offline tab comes back, the client re-reads the records and shows a toast ("N generation jobs finished while you were away", with a count of those that did not complete) with a **View** button that opens the Generation jobs viewer; each job is announced once (`partitionFinishedJobs`), jobs that finished while watched are stamped silently. On server restart nothing is resumed or retried: a clean shutdown marks running jobs `interrupted`, and after a crash the tracker reconciles leftover `accepted`/`running` records at startup from the store metadata, else marks them `interrupted`. The Generation jobs viewer gains per-job kind, chat, age, run time, error code and a **Log trail** section; the top bar shows a small activity dot while tracked jobs run.
- **What it does (logging):** structured `job.state` events (`state`: accepted, running, completed, failed, cancelled, recovered, expired) and throttled `job.progress` heartbeats every 30 s, with `operation: "generation.job"`, `jobId`, `chatId`, `kind`, `sourceKind`, `stage`, `elapsedMs`, `outcome` (`ok`/`failed`/`cancelled`/`skipped`) and `ME_*` `errorCode`. Since 1094acd08 each transition is logged exactly once: the store writes the accepted, running and settled lines whether or not tracking is on, and the tracker only adds them to the trail, logging its own lines just for progress, `recovered` (`stage: "server-restart"` or `"client-reattach"`) and `expired`. Events are built from an allow-list (`buildJobLogEvent`): no prompts, message text, provider error text or keys; non-`ME_*` codes become `ME_INTERNAL`. The store's failure line strips quoted spans of 12+ characters from the error message and caps it at 300 characters (`withoutEchoedPrompt`).
- **How to reach it:** Settings > Advanced > Features, row **Keep generating when the tab is closed (job tracking)**, with an **Open generation jobs** button under it (searching settings for `jobs`, `job tracking`, `keep generating`, `tab closed`, `recover` or `reconnect` lands on the Features section). Command palette action **Open generation jobs** (registered only while tracking is on). Top bar activity dot. API (registered with prefix `/api/generation-job-records`): `GET /api/generation-job-records/settings`, `PUT /api/generation-job-records/settings` (`{ enabled: boolean }`), `GET /api/generation-job-records?chatId=&limit=` (newest first, no trails), `GET /api/generation-job-records/:id`, `GET /api/generation-job-records/:id/trail`, `POST /api/generation-job-records/seen` (`{ ids, recovered? }`). Cancel and full result still use `/api/generation-jobs/:id/cancel` and `/api/generation-jobs/:id/result`.
- **Settings and defaults:** app setting `generationJobTracking` (`"true"`/`"false"`), default **off**; it is the only Features row that starts off and it is not part of the `features` JSON switch object. While off: the observer returns immediately, `/api/generation-jobs` is byte-identical, every `/api/generation-job-records` route except `/settings` returns the normal 404, no rows, files, log lines or timers, and the client makes one cached setting read (5 min) and renders nothing new. No environment variables.
- **Storage:** new `generation_job_records` table (`DATA_DIR/storage/tables/generation_job_records/`, one file per job), registered in `packages/server/src/db/schema/index.ts`, `FILE_BACKED_TABLES` in `packages/server/src/db/file-backed-store.ts` (primary-key shards, always resident), the `chats` delete cascade, `scripts/protect-launcher-data.mjs` and the admin "clear chats" expunge in `packages/server/src/routes/admin.routes.ts`. App setting key `generationJobTracking`. Existing `DATA_DIR/generation-jobs/` files unchanged.
- **Tests:** `scripts/regressions/generation-job-tracking.regression.ts` (added in 077e055ee, extended in 1094acd08 to assert one log line per job and transition): table wiring, helpers, byte-identical setting-off responses, persistence and progress, completion without a client, client reattach, restart reconcile, cancel racing settle, chat deleted mid-job, log redaction, retention and failure safety, throwing observer. `scripts/regressions/generation-jobs-ui.browser.regression.mjs` (viewer unchanged while off). `scripts/regressions/generation-job-tracking-settings-placement.regression.ts` (added in d91c5d395).
- **Known limits:** not covered: TTS (synchronous routes), Illustrator agent images during a chat turn, Game Mode asset generation, and the text jobs `game-party-turn`, `game-npc-backfill`, `game-character-sheet-draft`. Nothing is resumed after a restart (providers are not idempotent, inputs are not persisted). The dialog that started a job does not re-attach; results come back through the viewer. Retention: finished records removed 7 days after last update, newest 300 kept per pass (startup, on enable, then hourly on an unref'd timer); unfinished records never expire. A record can outlive the store's own result file (store keeps 200 metadata / 50 result files). List route returns at most 200 (client asks for 100), `/seen` takes at most 100 ids, trail keeps 40 events. Client polls every 3 s while a tracked job runs, 30 s otherwise, paused while hidden. Turning it off keeps existing records until retention or chat deletion.

### GM prep board

- **Commit:** `2f9737914` (2026-09-23 09:06 +0300). One of nine features merged together in this commit.
- **Files:** new `packages/shared/src/utils/prep-board.ts` (pure board logic, exported via `packages/shared/src/index.ts`), `packages/server/src/db/schema/game-prep-boards.ts`, `packages/server/src/services/storage/game-prep-boards.storage.ts`, `packages/server/src/routes/game-prep-board.routes.ts`, `packages/client/src/components/game/GamePrepBoard.tsx`, `packages/client/src/components/modals/PrepBoardModal.tsx`, `packages/client/src/hooks/use-prep-board.ts`, `packages/client/src/lib/open-prep-board.ts`; changed `packages/client/src/components/game/GameToolsPanel.tsx`, `packages/client/src/components/layout/ModalRenderer.tsx` (modal id `prep-board`), `packages/client/src/components/command-palette/CommandPaletteHost.tsx`, `packages/server/src/routes/index.ts`, `packages/server/src/services/mari-db/mari-db.service.ts`, `packages/server/src/services/professor-mari/workspace-change-review.service.ts`.
- **What it does:** a private planning board per game (Lazy DM style). Default sections: Strong start, Scenes, Secrets and clues, Open threads, NPCs to feature, Locations, Treasure and rewards, Notes (`PREP_BOARD_DEFAULT_SECTIONS`); sections can be added, renamed (blank name restores the preset name), reordered and removed (their items move to another section; the last section cannot be removed). Items have text, a used checkbox (records the session it was used in), tags, an optional link to a character card or lorebook entry (opens it), and remember the session they were added in and how often they were carried over.
- **What it does (cont.):** drag and drop within and across sections (dnd-kit), or ArrowUp/ArrowDown on an item's handle to step it (crossing into the neighbouring section, with a screen reader announcement). Search matches every word against item text, tags, link name and section name. "Archive used items", show/hide archived, and "Carry over" (moves unfinished items to the next session and archives used ones, after a confirm). "To input (OOC note)" inserts the item into the chat input via `formatOocNote` without sending. Export as JSON (`prep-board-<name>.json`, format `marinara-prep-board`, schema version 1) and Import JSON with Merge (sections match by id or name, items get fresh ids) or Replace. "Delete board" removes it on purpose.
- **How to reach it:** the game Session panel > Tools tab > "GM prep board" section (inline), with an "Open the prep board full-screen" button; command palette "GM prep board" (only when the active chat is Game Mode; palette opens with Mod+K). In the item editor Ctrl/Cmd+Enter saves and Escape cancels; Escape closes menus and the link picker. API (prefix registered in `routes/index.ts`): `GET /api/prep-board?chatId=`, `PUT /api/prep-board` (body `{ chatId, revision, board }`, 16 MB body limit, 409 with the stored board on a stale revision), `DELETE /api/prep-board?chatId=`. All return 400 for a chat that is not Game Mode.
- **Settings and defaults:** None. Not behind a feature switch.
- **Storage:** new file-backed table `game_prep_boards` (id, game_id, board JSON, revision, created_at, updated_at), keyed by effective game id (`resolveEffectiveGameId`: metadata.gameId, else chat group, else chat), with no foreign key or cascade so it survives deleting every session. Registered in `packages/server/src/db/schema/index.ts`, `BUILT_IN_FILE_BACKED_TABLES` in `packages/server/src/db/file-backed-store.ts`, `SHARDED_TABLES` in `scripts/protect-launcher-data.mjs`, and cleared by the `chats` scope of `POST /api/admin/expunge` in `packages/server/src/routes/admin.routes.ts`. Excluded from Professor Mari: `MARI_PRIVATE_TABLES` in `mari-db.service.ts` (generic DB commands never list, count, read, search, validate or write it) and `isProfessorMariPrivateDataPath` covers its storage files. localStorage key `marinara-prep-board-collapsed` (collapsed section ids, last 200). Cleared by Settings > Danger Zone "Chats & Messages" (`POST /api/admin/expunge` scope `chats`) and by `POST /api/admin/clear-all` (`packages/server/src/routes/admin.routes.ts`).
- **Saving model:** edits apply to the React Query cache through the pure helpers and save in the background, one save at a time per chat, each with the revision it started from; a 409 replaces the local board with the stored one and toasts "The prep board changed in another window. Showing the saved version."; sibling session chats of the same game pick up the saved board.
- **Tests:** `scripts/regressions/prep-board.regression.ts` (pure module, table registrations, routes, shared board across sessions, revision conflicts, survival after the last session is deleted, prompt assembly never includes the board), `scripts/regressions/prep-board-mari-privacy.regression.ts`.
- **Known limits:** sanitizer caps (`PREP_BOARD_LIMITS`): 40 sections, 2000 items, item text 4000 chars, section title 120, 20 tags of 60 chars, link label 200; client import rejects files over 16 MB. Game Mode chats only. Never sent to a model (nothing in prompt assembly reads the table). Later commits `d1ec31bbc` (36px touch targets and readable text on phones) and `ad7a61ad1` adjusted the phone layout; `abc4f85a1` added the calendar to the same Tools tab.

### Chapters and scene markers

- **Commit:** `2f9737914` (2026-09-23 09:06 +0300). One of nine features merged together in this commit.
- **Files:** new `packages/client/src/components/chat/MessageChapters.tsx` (`ChapterFields`, `ChapterMenuSection`, `ChapterDivider`, `ChapterHeading`, `ChatChaptersList`), `packages/client/src/lib/chat-chapters-events.ts`; changed `packages/shared/src/utils/message-marks.ts`, `packages/shared/src/types/chat.ts`, `packages/server/src/routes/chats.routes.ts`, `packages/server/src/services/chat-insights/transcript-document.ts`, `packages/server/src/services/game/campaign-log.ts`, `packages/client/src/lib/game-log.ts`, `packages/client/src/lib/open-game-log.ts`, `packages/client/src/components/modals/GameLogModal.tsx`, `packages/client/src/components/chat/MessageMarks.tsx`, `packages/client/src/components/chat/ChatMessageSearch.tsx`, `packages/client/src/components/chat/ChatToolbarControls.tsx`, `packages/client/src/components/chat/ChatArea.tsx`, `packages/client/src/components/chat/ChatRoleplaySurface.tsx`, `packages/client/src/components/chat/ConversationView.tsx`, `packages/client/src/components/command-palette/CommandPaletteHost.tsx`, `packages/client/src/hooks/use-chats.ts`.
- **What it does:** any Roleplay or Conversation message can be marked as a chapter start with a user-written title and optional summary (never generated). A divider ("Chapter: <title>") renders above the message, and message grouping breaks there. A new Chapters tab in the chat search panel lists chapters in reading order with message numbers and jumps to them (`requestGotoMessage`).
- **What it does (cont.):** Markdown and HTML story exports render chapters as `##` headings (summary in italics); the HTML story also gets a "Contents" table of contents with `#chapter-N` anchors, and a chapter marked on a turn the export skips moves to the next kept turn. In Game Mode, chapters are marked per turn in the campaign log ("Start a chapter at this turn", edit or remove), which also gains a "Chapters" jump select; a chapter stored on a hidden turn shows on the next readable one.
- **How to reach it:** message bookmark action menu (title "Bookmark, pin, note or chapter") > "Start a chapter here" (Enter saves, Escape cancels); chat toolbar search button ("Search, bookmarks, chapters and trash") > Chapters tab; command palette "Go to chapter…" (any chat; in Game Mode it opens the Campaign log with the chapter list focused, elsewhere it opens the Chapters tab, opening the phone overflow menu first when needed) plus one "Go to chapter N: <title>" command per chapter of the active chat while the palette is open. Game: Campaign log (from the Session panel > Tools tab). API: `GET /api/chats/:chatId/chapters` (returns `{ messageId, messageNumber, title, summary }[]`); marks are saved through the existing `PATCH /api/chats/:chatId/messages/:messageId/extra` with `{ chapter: {...} | null }`; exports via `GET /api/chats/:id/export?format=markdown|html`.
- **Settings and defaults:** None. Not behind a feature switch.
- **Storage:** message `extra.chapter` = `{ title, summary, createdAt }`; `chapter` added to `MESSAGE_MARK_EXTRA_KEYS`, so it is message-level and mirrored to every swipe. Validated in `normalizeMessageMarkPatch` (title required, whitespace collapsed). No new tables. Client query key `chatKeys.chapters(chatId)`, invalidated on mark save, delete and trash changes.
- **Tests:** `scripts/regressions/message-chapters.regression.ts`.
- **Known limits:** title max 120 chars (`MAX_CHAPTER_TITLE_LENGTH`, truncated), summary max 600 (`MAX_CHAPTER_SUMMARY_LENGTH`, rejected when longer). Never sent to the model. Game Mode has no per-message anchors on the main screen, so game chapters are only marked and read in the campaign log. Reading mode (separate feature) uses bookmarks, not these chapters, as its page breaks.

### Random table starter packs

- **Commit:** `2f9737914` (2026-09-23 09:06 +0300). One of nine features merged together in this commit.
- **Files:** new `packages/client/src/lib/random-table-packs.ts` and five JSON packs under `packages/client/src/lib/table-packs/` (`taverns-and-inns.json`, `roads-and-weather.json`, `town-life.json`, `treasure.json`, `story-complications.json`); changed `packages/client/src/components/tools/RandomTablesTool.tsx`, `packages/client/src/hooks/use-random-tables.ts`, `packages/server/src/routes/random-tables.routes.ts`.
- **What it does:** a "Starter packs" panel in the random tables tool offers five original generic fantasy packs, each self-contained (every `[[reference]]` points inside the pack): Taverns and inns (8 tables: names, menu, drinks, keeper), Roads and weather (6: weather, strange sky, roadside encounters, travellers, beasts, finds), Town life (6: rumours, districts, NPC quirks), Treasure (6: trinkets, gemstones, minor enchantments, minor/moderate/major loot), Story complications (3: complication, twist action, twist subject). Rows shown with a table count; a pack whose tables are all already present shows as added and is disabled.
- **What it does (cont.):** adding a pack imports through the normal import route with `skipExisting`, so tables whose normalized names already exist in the visible scope are left out and adding a pack twice changes nothing. Toasts report created tables, tables kept because they existed, and tables dropped by the per-scope cap.
- **How to reach it:** the "Add a starter pack" button in the random tables tool header (also shown in the empty state). The tool is in the game Session panel > Tools tab > Random tables section and in the "Random tables and oracle" command palette window. In a game, a scope select chooses "This game" or "All games"; outside a game packs go to the global scope. API: `POST /api/random-tables/import` gained optional `skipExisting: boolean` (default false) and returns `existing` (count skipped as already present) alongside `created` and `skipped`.
- **Settings and defaults:** None. Not behind a feature switch.
- **Storage:** None new: packs are static JSON bundled in the client; imported tables become ordinary rows in the existing `random_tables` table.
- **Tests:** `scripts/regressions/random-table-packs.regression.ts` (every pack parses through the import sanitiser unchanged, 12 to 100 rows per table, dice tables without gaps, references stay in the pack, no em or en dashes, many clean rolls, route import with `skipExisting` is a no-op the second time).
- **Known limits:** the per-scope table cap (`MAX_RANDOM_TABLES` = 2000) still applies. Pack names and descriptions are localized via `RANDOM_TABLE_PACK_KEYS`, but table names and rows are English only. For a game-scope add, name matching covers the game's tables and the global ones, so a pack whose tables exist globally adds nothing to the game.

### NPC quick reference

- **Commit:** `2f9737914` (2026-09-23 09:06 +0300). One of nine features merged together in this commit.
- **Files:** new `packages/client/src/components/characters/NpcQuickReference.tsx` (popover), `packages/client/src/lib/npc-quick-reference.ts` (summary and placement helpers); changed `packages/client/src/components/characters/CharacterReferences.tsx` (`useNpcPeek` hover, tap and keyboard handling), `packages/client/src/lib/character-references.ts`, `packages/client/src/stores/ui.store.ts`, `packages/client/src/components/panels/SettingsPanel.tsx`.
- **What it does:** when on, hovering (mouse, after 400 ms), clicking/tapping or pressing Enter on a linked character name in Roleplay, Conversation or Game narration shows a small card: avatar, name, a description shortened to about 300 chars at a word boundary, up to 8 tags, "Open card", and "Usage" (chat and game counts plus up to 5 recent chats that open on click, from the existing character usage endpoint). Placed below the name, or above when there is no room, clamped to the viewport.
- **What it does (cont.):** only one popover is open at a time. A hover preview closes 250 ms after the pointer leaves; a click pins it and a second click on the same name closes it; Escape, a pointer down elsewhere, scrolling or resizing close it (focus returns to the name only when it was on the popover or name). Keyboard activation focuses the popover's first button. Game-local NPCs (not library cards) only show what the game provides and cannot load full details or usage. With the setting off, a name click opens the card editor as before.
- **What it does (perf):** name linking in `createCharacterMatcher` now scans with a precomputed name set (by first character and name lengths) instead of one large alternation regex, linear in message length; the old regex remains as a fallback when lower-casing changes string length.
- **How to reach it:** Settings > Advanced > Message Tools > "Character quick reference" (searchable in settings by npc, hover, popover, names, peek). API used (existing): `GET /api/character-usage/:characterId`.
- **Settings and defaults:** UI store `npcQuickReference`, default `false`; included in `pickSyncedSettings` and `pickPersistedUIState`. Not behind a feature switch.
- **Storage:** only the `npcQuickReference` UI setting (persisted and synced with the other UI settings). No tables or metadata keys.
- **Tests:** `scripts/regressions/npc-quick-reference.regression.ts` (name matching: whole names, first names, titles, aliases, casing, word boundaries, longest match wins, ambiguous shared first names left unlinked, astral characters next to names).
- **Known limits:** hover opening is mouse only (`pointerType === "mouse"`); touch uses tap. Description limit 300 (`NPC_PEEK_DESCRIPTION_LIMIT`), tags 8 (`NPC_PEEK_TAG_LIMIT`), usage list 5 rows. Per CHANGELOG, it never changes message text or what gets copied.

### Initiative tracker

- **Commit:** `2f9737914` (2026-09-23 09:06 +0300). One of nine features merged together in this commit.
- **Files:** new `packages/shared/src/utils/initiative-tracker.ts` (pure turn-order module, exported via `packages/shared/src/index.ts`), `packages/server/src/db/schema/game-initiative-encounters.ts`, `packages/server/src/services/storage/game-initiative-encounters.storage.ts`, `packages/server/src/routes/game-initiative.routes.ts`, `packages/client/src/components/tools/InitiativeTracker.tsx`, `packages/client/src/components/modals/InitiativeTrackerModal.tsx`, `packages/client/src/hooks/use-initiative.ts`, `packages/client/src/lib/initiative-draft.ts`, `packages/client/src/lib/open-initiative-tracker.ts`; changed `packages/server/src/services/game/dice-roll-log.ts`, `packages/client/src/hooks/use-game-tools.ts`, `packages/client/src/components/game/GameDiceLog.tsx`, `packages/client/src/components/game/GameToolsPanel.tsx`, `packages/client/src/components/layout/ModalRenderer.tsx` (modal id `initiative-tracker`), `packages/client/src/components/command-palette/CommandPaletteHost.tsx`, `packages/server/src/routes/index.ts`.
- **What it does:** add combatants from a character card, a lorebook entry (pick a lorebook, then search) or a typed name (duplicate names become "Goblin 2"); each has initiative dice (blank means d20, a bare number is a d20 modifier, otherwise NdM notation), initiative, free-text HP and conditions/notes. "Roll initiative" rolls everyone on the server, sorts (highest first, ties to the higher dice modifier, then existing order, unset last) and restarts at round 1; a single combatant can be rolled mid-fight without moving the current turn. Next/previous turn with a round counter, move up/down, delay (act after the next combatant), remove.
- **What it does (cont.):** every initiative roll is written to the game's dice log with source `initiative` (shown as "Initiative" in the Dice Log, with crit/fumble flags on a single d20). "To input" inserts a one-line turn summary (for example "Round 2: <name>'s turn (HP 12/20; poisoned). Next: <name>.") into the chat input as an OOC note; nothing is sent automatically. Encounters can be saved per game ("Save encounter"), reopened from any session of the game ("Saved encounters"), and deleted; replacing an unsaved fight asks first ("Discard unsaved fight?").
- **How to reach it:** the game Session panel > Tools tab > "Initiative tracker" section, with "Open in a window" (modal); command palette "Initiative tracker" (only when the active chat is Game Mode). Enter in an inline field commits it. API (prefix `/api/game-initiative`): `GET /api/game-initiative?chatId=`, `POST /api/game-initiative` (`{ chatId, name, state }`, 409 "Too many encounters" at the cap), `PUT /api/game-initiative/:id`, `DELETE /api/game-initiative/:id`, `POST /api/game-initiative/roll` (`{ chatId, combatants: [{ id, name, dice }] }`, returns `results`, `totals`, `logged`); 1 MB body limit on encounter writes.
- **Settings and defaults:** None. Not behind a feature switch.
- **Storage:** new file-backed table `game_initiative_encounters` (id, game_id, name, state JSON, created_at, updated_at), keyed by effective game id with no foreign key or cascade. Registered in `packages/server/src/db/schema/index.ts`, `BUILT_IN_FILE_BACKED_TABLES` in `packages/server/src/db/file-backed-store.ts`, `SHARDED_TABLES` in `scripts/protect-launcher-data.mjs`, and cleared by the `chats` scope of `POST /api/admin/expunge`. The working (unsaved) encounter is kept per chat in localStorage under `marinara-initiative-draft:<chatId>` so the Tools tab and the window show the same fight and a reload keeps it. Dice log rows go to the existing `game_dice_rolls` table. Cleared by Settings > Danger Zone "Chats & Messages" (`POST /api/admin/expunge` scope `chats`) and by `POST /api/admin/clear-all`.
- **Tests:** `scripts/regressions/initiative-tracker.regression.ts` (pure turn-order rules, table registrations, CRUD per game, the roll route and its `initiative` dice-log rows, client wiring).
- **Known limits:** 100 combatants per encounter (`MAX_INITIATIVE_COMBATANTS`), combatant name 120 chars, HP/notes 500 chars, 500 saved encounters per game (`MAX_INITIATIVE_ENCOUNTERS`). Dice are clamped to the shared dice limits. Delay on the last combatant in the order does nothing that round. Rolls are logged only for Game Mode chats. Nothing here writes to a chat. Phone layout adjusted later in `ad7a61ad1`.

### Lorebook backlinks ("Fired in chats") and the Stale entries filter

- **Commit:** `2f9737914` (2026-09-23 09:06 +0300). One of nine features merged together in this commit.
- **Files:** new `packages/server/src/services/lorebook/activation-backlinks.ts` (pure `parseRecentChats`, `mergeRecentChats`, `findStaleEntries`, `clampStaleDays`), new `packages/client/src/components/lorebooks/LorebookEntryFiredIn.tsx` (badge plus popover); changed `packages/server/src/services/lorebook/activation-stats.ts`, `packages/server/src/db/schema/lorebook-activation-stats.ts`, `packages/server/src/routes/lorebooks.routes.ts`, `packages/client/src/hooks/use-lorebooks.ts` (`LorebookEntryRecentChat`, `LorebookStaleEntries`, `useLorebookStaleEntries`), `packages/client/src/components/lorebooks/LorebookEntryRow.tsx`, `packages/client/src/components/lorebooks/LorebookEditor.tsx`.
- **What it does (backlinks):** each lorebook entry now keeps a bounded list of the chats it fired in (`{ chatId, count, lastActivatedAt }`, newest first, capped at `MAX_RECENT_CHATS_PER_ENTRY = 20`; the least recently fired chat drops off first). Per-chat counts accumulate in the existing in-memory pending batch and merge into the stored list in the same batched write as the global count. The entry row's fired count (`N×`) is now a button; clicking it opens a "Fired in chats" popover listing each chat by name with its per-chat count and a "Last fired {date}" tooltip, and clicking a chat opens it via `openChatAtMessage`. Deleted chats show as "Deleted chat" (not clickable). Escape or an outside click closes the popover. When 20 chats are listed a "Showing the 20 most recent chats." footer appears.
- **What it does (stale):** `findStaleEntries` returns entries that did not fire in the last N days while the lorebook itself fired in that window (if no entry of the lorebook fired in the window, `lorebookActive` is false and nothing is called stale). Disabled entries, entries in effectively disabled folders (a disabled parent gates its enabled subfolders, via `collectEffectivelyDisabledFolderIds`) and entries created inside the window are left out. Results sort longest silent first, never-fired entries first. The editor adds a **Stale (N)** toggle next to "Never fired (N)" (the two are mutually exclusive) and, while it is on, a "Stale after" select with 7, 14, 30, 90 or 180 days (default 30). Folder grouping is turned off while the filter is on; jumping to an entry clears it.
- **How to reach it:** lorebook editor > Entries list: click an entry's `N×` fired badge for backlinks; the "Stale (N)" toggle in the stats line above the list (shown only when stats exist and the lorebook is active in the window, or the filter is already on). API: `GET /api/lorebooks/:id/activation-stats` (now returns `recentChats` per entry, each enriched with `chatName` and `chatMode`, both null for deleted chats), new `GET /api/lorebooks/:id/stale-entries?days=N` (returns `{ days, cutoff, lorebookLastActivatedAt, lorebookActive, entries: [{ entryId, lastActivatedAt }] }`).
- **Settings and defaults:** stale window default 30 days; server clamps `days` to 1..3650 (`DEFAULT_STALE_DAYS`, `MAX_STALE_DAYS`), falling back to 30 on bad input. Gated by the later feature switch **Usage and activation stats** (`usageAndActivationStats`, default On, Settings > Advanced > Features; commit 8aa93818b): Off records nothing (`recordLorebookActivations` and the flush return early) and the editor does not load activation stats, so neither the badge nor the Stale toggle appears (the stale query is only enabled once stats have loaded). The `/stale-entries` route itself is not gated on the server.
- **Storage:** new nullable column `recent_chats` (JSON text) on the existing file-backed table `lorebook_entry_activation_stats` (`packages/server/src/db/schema/lorebook-activation-stats.ts`). Rows written before the column existed fall back to the old `last_chat_id` as a single entry with count 0 (per-chat count shown only when above 0). No new table, no localStorage.
- **Tests:** `scripts/regressions/lorebook-backlinks.regression.ts` (bounded per-entry chat list including legacy rows, and the stale-entries finder).
- **Known limits:** only the 20 most recent chats per entry are kept; history before this commit only knows the last chat. Per-chat counts start at this commit. Stale detection relies entirely on activation stats, so it is empty for a lorebook that never fired in the window. The popover `MAX_RECENT_CHATS` constant (20) is duplicated on the client.

### Lorebook bulk editor

- **Commit:** `2f9737914` (2026-09-23 09:06 +0300). One of nine features merged together in this commit.
- **Files:** new `packages/shared/src/utils/lorebook-bulk-edit.ts` (exported from `packages/shared/src/index.ts`), new `packages/client/src/components/lorebooks/LorebookBulkEditPanel.tsx`; changed `packages/server/src/services/storage/lorebooks.storage.ts` (`bulkEditEntries`, `bulkRemoveEntries`), `packages/server/src/routes/lorebooks.routes.ts`, `packages/client/src/hooks/use-lorebooks.ts` (`useBulkEditLorebookEntries`, `useBulkDeleteLorebookEntries`), `packages/client/src/components/lorebooks/LorebookEditor.tsx`, `packages/client/src/components/lorebooks/LorebookEntryRow.tsx`.
- **What it does:** in the editor's selection mode a collapsible "Bulk edit N entries" panel applies one change to the whole selection per click: Enable / Disable, Constant on / Constant off, move to a folder (full folder path labels, or "No folder (top level)"), Add or Remove keys on either the primary or secondary key list (comma or newline separated, trimmed, deduped case-insensitively), set Probability (0 to 100, blank = always, i.e. null), Set order (integer) and Set depth (integer >= 0). Each request runs in one transaction, so a failure leaves every selected entry unchanged. Key removal matches case-insensitively ignoring surrounding whitespace; only rows whose key list actually changes are written, and a key change clears the stored embedding (`embedding`, `embeddingSpaceId` set to null). A toast reports "Updated N entries" (count of rows that actually changed).
- **What it does (selection and delete):** Shift+click on an entry row header or its checkbox selects or deselects the whole range between the last plainly clicked entry and the clicked one, in on-screen order (folders first, collapsed folders skipped; `selectLorebookEntryRange`); text highlighting on Shift+click is suppressed. "Select all" now has a tooltip explaining it takes every entry matching the current search and filters. Deleting a selection is now one request (`bulkRemoveEntries`, chat metadata pruned once) instead of one request per entry.
- **How to reach it:** lorebook editor > Entries > **Select** button (tooltip "Select entries for batch editing, copying, moving, or deletion") > the "Bulk edit N entries" panel under the selection toolbar. API: `POST /api/lorebooks/:id/entries/bulk-edit` (body `{ entryIds, set?: { enabled, constant, probability, order, depth, folderId, tag }, keyField?: "keys" | "secondaryKeys", addKeys?, removeKeys? }`, returns `{ matched, updated }`), `POST /api/lorebooks/:id/entries/bulk-delete` (body `{ entryIds }`, returns `{ deleted }`). Both sync the linked character book when anything changed.
- **Settings and defaults:** None. Panel is collapsed by default; key list defaults to primary keys.
- **Storage:** None new (writes existing `lorebook_entries` rows).
- **Tests:** `scripts/regressions/lorebook-bulk-edit.regression.ts`.
- **Known limits:** max 5000 entries per request (`LOREBOOK_BULK_MAX_ENTRIES`) and 200 keys per add/remove list (`LOREBOOK_BULK_MAX_KEYS`, each key up to 500 chars). Bulk edit rejects the whole request (400) if any selected id is not in the lorebook or the folder belongs to another lorebook; bulk delete silently ignores unknown ids. A request with no change is rejected ("Choose at least one change to apply"). The schema accepts a `tag` field, but the panel exposes no control for it. Only one kind of change is sent per click (no combined multi-field form).

### Lorebook Markdown and CSV import and export

- **Commit:** `2f9737914` (2026-09-23 09:06 +0300). One of nine features merged together in this commit.
- **Files:** new `packages/shared/src/utils/lorebook-text-format.ts` (parser, exporter, duplicate planner; shared so the client preview matches the server import), new `packages/server/src/services/lorebook/text-import.ts`, new `packages/server/src/routes/lorebook-text.routes.ts` (registered inside `lorebooksRoutes`), new `packages/client/src/components/lorebooks/LorebookTextImportDialog.tsx`; changed `packages/client/src/components/ui/ExportFormatDialog.tsx` (new `extraOptions` / `onSelectExtra` props), `packages/client/src/components/lorebooks/LorebookEditor.tsx`, `packages/server/src/routes/lorebooks.routes.ts`.
- **What it does (formats):** Markdown: optional `# Lorebook name` preamble, one `## Entry name` heading per entry, then optional metadata lines `Keys:` (or `Keywords:`), `Folder: A / B`, `Enabled:`, `Constant:`, `Probability:`, then the body. Content lines starting with `#` are escaped with a backslash on export and unescaped on import. CSV: header row with `name`, `keys`, `content` required and optional `folder`, `enabled`, `constant`, `probability`; quoted cells, doubled quotes, multiline cells, a UTF-8 BOM and CRLF are accepted. Booleans accept true/yes/y/1/on and false/no/n/0/off. Folder paths use " / " and missing folders are created under each parent (matched by name case-insensitively).
- **What it does (import dialog):** choose a file (`.md`, `.markdown`, `.txt`, `.csv`) or paste text; the format is auto-detected from the file name or first line and can be switched. A preview lists up to 200 entries and 200 issues with line numbers (errors such as missing name, empty content, name over 200 chars, unterminated quote, missing columns; warnings such as unknown column or a name repeated in the file). Target: "This lorebook" or "New lorebook" (with a name, default "Imported lorebook"). "When an entry name already exists": Skip (default), Import as a renamed copy (`Name (2)`, `Name (3)`...), or Overwrite the existing entry (a later duplicate in the same file wins; an overwritten entry without a folder in the file keeps its folder). Result toast: "Imported: N added, N overwritten, N skipped."
- **What it does (export):** the lorebook export dialog gains **Markdown** and **CSV** choices next to the existing formats. CSV is sent with a UTF-8 BOM and CRLF so spreadsheet apps read non-English text; Markdown only writes `Enabled`, `Constant` and `Probability` lines when they differ from defaults.
- **How to reach it:** lorebook editor header: the file-upload icon button ("Import entries from Markdown or CSV") opens the "Import entries" dialog; the "Export lorebook" button opens the export dialog with the new Markdown and CSV cards. API: `POST /api/lorebooks/:id/import-text` (body `{ format: "markdown" | "csv", text, duplicateMode: "skip" | "rename" | "overwrite" }`), `POST /api/lorebooks/import-text` (same plus `name`, creates a new lorebook and deletes it again if the import fails), `GET /api/lorebooks/:id/export-text?format=markdown|csv` (attachment `<name>.md` or `<name>.csv`). Import returns `{ lorebookId, created, renamed, overwritten, skipped, invalid, foldersCreated, issues }`.
- **Settings and defaults:** None. Duplicate mode defaults to skip; format defaults to Markdown unless detected as CSV.
- **Storage:** None new (creates rows in existing `lorebook_entries` and `lorebook_folders`, and a `lorebooks` row for the new-lorebook target).
- **Tests:** `scripts/regressions/lorebook-text-import.regression.ts`.
- **Known limits:** server caps text at 20 MiB (`LOREBOOK_TEXT_IMPORT_MAX_CHARS`) and 20,000 valid entries (`LOREBOOK_TEXT_IMPORT_MAX_ENTRIES`); names are capped at 200 chars. Only name, keys, content, folder, enabled, constant and probability round-trip; secondary keys, order, depth and other entry settings are not in either format. Commas and newlines inside a key are replaced with spaces on export, and a `/` in a folder name becomes `-`. File-level errors abort the import; invalid individual entries are skipped and counted as `invalid`. Entries are written one by one (not in a single transaction) into an existing lorebook, so a mid-import failure can leave a partial import (evident from `text-import.ts`). New entries get order values 10 apart after the current maximum.

### Reading mode

- **Commit:** `2f9737914` (2026-09-23 09:06 +0300). One of nine features merged together in this commit.
- **Files:** new `packages/client/src/components/modals/ReadingModeModal.tsx`, new `packages/client/src/lib/reading-mode.ts` (pure entry building, pagination, saved position, typography settings, key map); changed `packages/client/src/lib/chat-insights.ts` (`openReadingMode`), `packages/client/src/components/chat/ChatBranchSelector.tsx` (`showReadingMode` prop), `packages/client/src/components/chat/ChatRoleplaySurface.tsx`, `packages/client/src/components/layout/ModalRenderer.tsx` (modal id `reading-mode`, lazy loaded), `packages/client/src/components/command-palette/CommandPaletteHost.tsx`.
- **What it does:** a full-screen, distraction-free paged reader for a roleplay chat. It loads the chat's messages (each message's active swipe), drops system messages, empty messages, messages hidden from the user, command-only and roleplay-private messages, and (by default) messages hidden from the AI. Message text is reduced to plain reading text (HTML tags, style/script blocks and `<think>`/`<thinking>`/`<reasoning>` blocks removed, entities decoded) with `**bold**`, `*italic*` and `_italic_` kept. Each entry shows the speaker (persona snapshot name or "You" for user turns, character name, else "Narrator").
- **What it does (pages and bookmarks):** pages are greedy runs of whole messages up to about 6000 characters at default settings (each message adds 80 chars of overhead; a message longer than a page gets its own page and is never split); the budget scales with text size and line width (clamped 1500 to 16000). A labelled message bookmark starts a new page and is shown as a chapter heading; a Bookmarks panel lists bookmarked messages and jumps to them with a brief highlight. The reader reopens on the page holding the first message of the last page read, or the nearest later readable message if that one was deleted or hidden.
- **How to reach it:** roleplay chat toolbar > branch menu ("Switch branch") > **Read** button (tooltip "Open this chat in a distraction-free reader"), shown in the full and compact toolbars; command palette "Read this chat" (only when the active chat is roleplay). Keys (ignored while typing in a field or with Ctrl/Meta/Alt): Right Arrow, PageDown, J or N next page; Left Arrow, PageUp, K or P previous page; Home first page; End last page; B bookmarks panel; T text settings panel; + or = bigger text; - smaller text. All four arrow keys are kept from reaching the chat underneath (so they cannot swipe, regenerate or edit the last message). Uses existing `GET /api/chats/:id/messages`; no new route.
- **Settings and defaults:** reader typography: text size 18 px (13 to 30, step 1), line width 68 ch (40 to 100, step 4), line spacing 1.7 (1.3 to 2.2, step 0.1), font Serif (or Sans). No feature switch.
- **Storage:** localStorage only: `marinara:reading-mode:settings` (typography, shared across chats) and `marinara:reading-mode:position:<chatId>` (`{ messageId, number }` per chat). Storage failures (private windows, full storage) are swallowed.
- **Tests:** `scripts/regressions/reading-mode.regression.ts`.
- **Known limits:** roleplay chats only (the button and palette command are not offered for conversation or game chats). Read-only view: no editing, swipe switching or generation from the reader. Only the active swipe is shown. Markdown support is limited to bold and italic; other markup is shown as plain text. Saved position is per browser (localStorage), not synced. Later commit ad7a61ad1 adjusted phone text size and touch targets in modals and editors, touching these files.

### In-world calendar for Game Mode, anchored to the game clock

- **Commit:** `abc4f85a1` (2026-09-23 10:30 +0300).
- **Files:** new `packages/shared/src/utils/game-calendar.ts` (exported from `packages/shared/src/index.ts`), `packages/server/src/routes/game-calendar.routes.ts`, `packages/client/src/components/tools/GameCalendarTool.tsx`, `packages/client/src/components/modals/GameCalendarModal.tsx`, `packages/client/src/hooks/use-game-calendar.ts`, `packages/client/src/lib/open-game-calendar.ts`, `docs/game/calendar.md`; changed `packages/client/src/components/game/GameToolsPanel.tsx`, `packages/client/src/components/layout/ModalRenderer.tsx` (modal `game-calendar`), `packages/client/src/components/command-palette/CommandPaletteHost.tsx`, `packages/server/src/routes/index.ts`, `packages/server/src/routes/docs.routes.ts`.
- **What it does:** a per-game calendar with named months of any length, custom weekday names, an era suffix, an optional leap rule (every N / except every / unless every, extra days at the end of a chosen month) and moons (`name | cycle days | days since new moon today`, phase shown for today). It keeps no date of its own: it stores which calendar date is clock **Day 1** (`config.startDate`) and maps the Game Mode clock day (`gameTime.day`) to a date, so the Day editor, the automatic clock and time skips move the calendar too. Setup starts from a twelve-month template; "Today (clock Day N) is" renames the current day without skipping time.
- **What it does (moving the date):** **-1d**, **+1d**, **+7d** buttons, a days field (negative goes back) with **Advance**, and **Make this today** on a picked day of the month view. Advancing changes the clock day only (time of day kept), never below Day 1; picking a date before Day 1 moves the calendar's Day 1 instead. Clock moves are mirrored into the latest game-state snapshot's time, honouring tracker field locks, as `/game/time/advance` does.
- **How to reach it:** game Session panel > Tools tab > **Calendar** section (**Set up calendar**, later **Edit calendar**; a maximize button "Open calendar in a window" opens the `game-calendar` modal). Command palette action **In-world calendar** (only when the active chat is a Game Mode chat). API (prefix `/api/game-calendar`): `GET /api/game-calendar/:chatId` (calendar, clock, formatted time; a default switched-off calendar when none exists), `PUT /api/game-calendar/:chatId` (`{ calendar }`, clock untouched, 1 MB body limit), `POST /api/game-calendar/:chatId/advance` (`{ days }`, non-zero integer within +-100000), `POST /api/game-calendar/:chatId/date` (`{ date: { year, month, day } }`). All return 404 for non-game chats.
- **Settings and defaults:** per-game toggle **Use this calendar in this game** (`enabled`, default off; a game without a calendar behaves as before). Not gated by a Feature switch.
- **Storage:** chat metadata key `gameCalendar` (`{ enabled, config, events }`) on the game's session chat, beside `gameTime`; all writes go through the queued `patchMetadata` path. No new tables. Carried into a new session: the session-start `carryMeta` rest spread in `packages/server/src/routes/game.routes.ts` copies every previous-session metadata key it does not explicitly exclude, and neither `gameCalendar` nor `gameTime` is excluded.
- **Tests:** `scripts/regressions/game-calendar-math.regression.ts`, `scripts/regressions/game-calendar-routes.regression.ts`, `scripts/regressions/game-calendar-gm-stable.regression.ts`.
- **Known limits:** caps from `GAME_CALENDAR_LIMITS`: 60 months, 30 weekdays, 8 moons, 1000 days per month, 500 events, names 80 chars, era 40, event title 200, notes 2000, year clamped to +-1000000. The clock cannot go below Day 1.

### Calendar events and deadlines

- **Commit:** `abc4f85a1` (2026-09-23 10:30 +0300).
- **Files:** `packages/client/src/components/tools/GameCalendarTool.tsx`, `packages/shared/src/utils/game-calendar.ts` (`upcomingCalendarEvents`, `eventsOnDate`).
- **What it does:** add dated **Event** or **Deadline** entries on a picked day ("New event on ..."), optionally **Yearly** (a yearly event on a leap day falls on the month's last day in other years). **Upcoming** lists overdue deadlines first, then what is coming, soonest first; a past deadline shows as overdue until ticked done; finished deadlines and past one-off events drop out. Days with events get a dot in the month view. Events can be removed.
- **How to reach it:** game Session panel > Tools tab > Calendar (or the **In-world calendar** window), after picking a day in the month view. Saved through `PUT /api/game-calendar/:chatId`.
- **Settings and defaults:** None beyond the calendar's own **Use this calendar in this game** toggle.
- **Storage:** `events` array inside chat metadata `gameCalendar`.
- **Tests:** `scripts/regressions/game-calendar-math.regression.ts`, `scripts/regressions/game-calendar-routes.regression.ts`.
- **Known limits:** at most 500 events per game; title 200 chars, notes 2000 chars.

### Calendar date and upcoming events in the GM prompt

- **Commit:** `abc4f85a1` (2026-09-23 10:30 +0300).
- **Files:** `packages/server/src/services/generation/game-gm-prompt-runtime.ts`, `packages/shared/src/utils/game-calendar.ts` (`composeGameTimeLine`, `describeCalendarForPrompt`).
- **What it does:** when a game's calendar is switched on, the GM prompt's time line uses the calendar date (weekday, day, month, year, era) instead of the tracker's free-text date, followed by up to 4 events or deadlines within the next 14 days (for example "(upcoming: X tomorrow; deadline Y in 4 days)", overdue deadlines as "overdue by N days"), then the snapshot time. Without a calendar, or with it off, the line is byte-identical to before; an unreadable calendar falls back to the plain line.
- **How to reach it:** automatic on every GM turn in a Game Mode chat with an enabled calendar.
- **Settings and defaults:** follows the per-game **Use this calendar in this game** toggle (default off).
- **Storage:** None (reads `gameCalendar` and `gameTime` chat metadata).
- **Tests:** `scripts/regressions/game-calendar-gm-stable.regression.ts`.
- **Known limits:** 14-day horizon and 4 items in the prompt line.

### Calendar HUD widget lists the game's calendar events

- **Commit:** `abc4f85a1` (2026-09-23 10:30 +0300).
- **Files:** `packages/client/src/components/game/ExtendedWidgets.tsx`, `packages/client/src/hooks/use-game-calendar.ts` (`useGameCalendarWidgetEntries`), `packages/shared/src/utils/game-calendar.ts` (`calendarWidgetEntries`).
- **What it does:** a GM-made **calendar** HUD widget (which counts in clock day numbers, "Day 21") also shows the game calendar's upcoming events next to its own entries, deduplicated by day and title (case-insensitive), sorted soonest first. Events are merged at render time and never written into the widget, so edits do not fight the GM's widget updates.
- **How to reach it:** any calendar HUD widget in a Game Mode chat whose calendar is on.
- **Settings and defaults:** follows the per-game calendar toggle; the widget itself belongs to Extended HUD widgets (Feature switch, Chat settings > Agents, Game mode).
- **Storage:** None.
- **Tests:** `scripts/regressions/game-calendar-math.regression.ts` (the "HUD widget bridge" block covers `calendarWidgetEntries` and its merge with `calendarUpcoming`); the client render path itself has no fixture.
- **Known limits:** 60-day horizon, at most 8 merged entries, overdue deadlines excluded; the widget still shows its top 3 upcoming.

### Feature switches

- **Commit:** `8aa93818b` (2026-09-23 19:14 +0300).
- **Files:** `packages/shared/src/schemas/feature-settings.schema.ts` (new), `packages/shared/src/utils/game-feature-switches.ts` (new), `packages/server/src/services/features/feature-settings.ts` (new), `packages/server/src/services/game/game-feature-switches.ts` (new), `packages/server/src/services/lorebook/group-pick-policy.ts` (new), `packages/client/src/hooks/use-feature-settings.ts` (new), `packages/client/src/components/panels/settings/FeatureSwitchesSettings.tsx` (new), `packages/server/src/routes/app-settings.routes.ts`, `packages/server/src/services/storage/app-settings.storage.ts`, `packages/server/src/services/mari-db/mari-db.service.ts`, `packages/server/src/config/runtime-config.ts`, `packages/client/src/components/panels/SettingsPanel.tsx`, `packages/client/src/components/chat/ChatSettingsDrawer.tsx`, `packages/client/src/features/chat-settings/sections/AdvancedParametersSection.tsx`, `packages/shared/src/types/chat.ts`, `packages/server/src/routes/docs.routes.ts`, `docs/configuration/features.md` (new).
- **What it does:** every addition this build makes over upstream Marinara Engine gets an on/off switch. Switched on (the default) keeps current behaviour; switched off restores the upstream behaviour. Commit 8aa93818b added 12 switches: 8 app-wide (7 server switches in the `features` app setting plus the browser-side client error reports preference), 3 per-game switches in chat metadata, and 1 per-chat cache warning (`cacheSendGuard`). Changes apply immediately, no restart or reload.
- **What it does (server mechanism):** `feature-settings.ts` keeps one in-memory copy of the `features` app setting. `isFeatureEnabled(name)` and `getFeatureNumber(name)` are synchronous and allocation free so hot paths (every provider call, every lorebook scan) can call them. The cache is primed by `loadFeatureSettings` when `appSettingsRoutes` registers, replaced by `applyFeatureSettingsValue` on every `app-settings.storage.ts` write or removal of the `features` key, and reloaded by `reloadFeatureSettingsIfTouched` after Professor Mari's generic database commands (and their restore) touch the `app_settings` row `features`. Bad JSON or malformed values fall back to defaults via `normalizeFeatureSettings` (only well-formed known keys survive).
- **What it does (precedence):** 1) environment variable, when set and non-blank, wins in both directions (`readEnvFlagOverride` in `runtime-config.ts`: `1`/`true`/`yes`/`on` = on, anything else = off, blank = unset); 2) the saved value; 3) the default (on, with default numbers). Env-controlled: `stableLorebookGroupPicks` by `LOREBOOK_STABLE_GROUP_WINNERS`, `providerRetry` by `PROVIDER_RETRY_TRANSIENT_ERRORS` (both listed in `FEATURE_ENV_FLAG_OVERRIDES`), and `backgroundCallCap` plus `backgroundCallsPerHour` by `MARINARA_BACKGROUND_CALLS_PER_HOUR` (parsed in `background-call-budget.ts`; `BACKGROUND_CALLS_PER_HOUR_ENV` is listed only so the UI can show the lock). The first two keep upstream names but invert the unset default (upstream: off unless set; here: on unless set).
- **What it does (client):** `use-feature-settings.ts` exports `useFeatureSettings` (React Query, key `["features"]`, 5 minute staleTime), `useFeatureEnabled(name)` and `useFeatureNumber(name)` (both report ON/default until the server answers, so nothing hides before load), and `useSaveFeatureSettings` (PUT of the whole object, writes the response into the query cache). `FeatureSwitchesSettings.tsx` stores only non-default values (a `true` switch or a default number is deleted from the saved object, so future default changes still reach the install). A switch pinned by env is shown disabled with its in-effect value and the note "Set on the server by {{name}}." (`settings.features.envLocked`); its number input is hidden. Load and save errors show "Could not load the feature switches." / "Could not save the feature switches.".
- **How to reach it:** Settings > Advanced > Features (section "Features", description "Everything this build adds starts on. Switch an item off to get the original Marinara behaviour."); settings search aliases include `features`, `switches`, `upstream`, `trash`, `retry`, `cache`, `usage`, `error reports`, `lorebook groups`. Per-game switches: the chat settings drawer of a Game chat, Agents tab (below Character knowledge per the docs page). Per-chat cache warning: chat settings drawer > Advanced Parameters, every chat mode. API: `GET /api/app-settings/features` returns `{ settings, envOverrides, effective }` (`FeatureSettingsResponse`); `PUT /api/app-settings/features` validates the body with the strict `featureSettingsSchema` and replaces the whole object (omitted keys return to default). Docs page `docs/configuration/features.md`, registered in the in-app docs under a new `configuration` directory (`docs.routes.ts`).
- **Settings and defaults:** current schema (`feature-settings.schema.ts`): `FEATURE_SETTINGS_KEY = "features"`; `FEATURE_SWITCH_NAMES` = `chatgptHistoryReplay`, `cacheFriendlyPromptLayout`, `stableLorebookGroupPicks`, `providerRetry`, `backgroundCallCap`, `messageTrash`, `usageAndActivationStats` (all optional booleans, absent = on via `resolveFeatureEnabled`, which treats only `false` as off); `FEATURE_NUMBER_SETTINGS` = `backgroundCallsPerHour` (default 600, int 1 to 100000) and `messageTrashDays` (default `MESSAGE_TRASH_RETENTION_DAYS` = 30, int 1 to 365). The schema is unchanged since 8aa93818b. Client error reports, the 3 game switches and `cacheSendGuard` live outside this schema.
- **Settings and defaults (13th switch):** commit d91c5d395 later moved generation job tracking into this panel as "Keep generating when the tab is closed" (rendered by `GenerationJobTrackingSettings` inside `FeatureSwitchesSettings.tsx`). It is the one switch that starts OFF and keeps its own app setting `generationJobTracking`, not the `features` object. Covered in its own entry.
- **Storage:** app_settings key `features` (JSON object of booleans and numbers); UI setting `clientErrorReports` (synced UI store); chat metadata keys `gameSceneTimelineEnabled`, `gameExtendedWidgetsEnabled`, `gameAutoSceneMediaEnabled` (typed in `ChatMetadata`, `packages/shared/src/types/chat.ts`) and object `cacheSendGuard` `{ enabled?, thresholdPercent?, ttlMinutes? }`. Game switches are on every session chat of a game; per the docs a new session copies them with the rest of the game's settings and a branch keeps the source chat's choice.
- **Tests:** `scripts/regressions/feature-settings.regression.ts` (normalization, routes, cached helper refreshed on storage write, env precedence), plus one regression per switch listed in each entry below. `scripts/regressions/tsconfig.client-lanes.json` changed to include a client lane.
- **Known limits:** any new code path that writes `app_settings` rows directly (bypassing app-settings storage and Mari's reload) must call the reload, or a switch change is ignored until restart. Game and chat switches have no env variable and are independent of the app-wide ones. `send client error reports` is per browser profile (UI settings sync), not a server setting.

### Feature switch: ChatGPT history replay

- **Commit:** `8aa93818b` (2026-09-23 19:14 +0300).
- **Files:** `packages/server/src/routes/generate.routes.ts` (`isPromptHistoryReplayEligible`), `packages/server/src/services/llm/providers/openai-chatgpt-cache.ts`, `packages/server/src/services/llm/providers/openai.provider.ts`.
- **What it does:** ON: Game turns on the ChatGPT subscription reuse the previous prompt (history replay), and full-lore requests send a `session-id` header and `prompt_cache_key` (`me-lore-<identity>`) to keep the cache warm. OFF (upstream): `isPromptHistoryReplayEligible` returns false so the prompt is rebuilt every turn; `resolveOpenAIChatGPTCacheIdentity` returns undefined so no session header and no `prompt_cache_key` are sent.
- **How to reach it:** Settings > Advanced > Features > "ChatGPT history replay" (help: "Game turns on ChatGPT reuse the previous prompt and send a cache session id. Off rebuilds the prompt every turn.").
- **Settings and defaults:** default ON. Key `chatgptHistoryReplay` in the `features` app setting. No env variable.
- **Storage:** app_settings `features.chatgptHistoryReplay`.
- **Tests:** `scripts/regressions/feature-switch-chatgpt-replay.regression.ts`.
- **Known limits:** only affects the OpenAI ChatGPT subscription provider path.

### Feature switch: Cache-friendly prompt layout

- **Commit:** `8aa93818b` (2026-09-23 19:14 +0300).
- **Files:** `packages/server/src/services/generation/prompt-cache-layout.ts`, `packages/server/src/routes/generate.routes.ts`, `packages/server/src/routes/generate/dry-run-route.ts`.
- **What it does:** ON: World Maps and other changing runtime blocks are moved next to the current turn, the full-lore prefix leads the prompt, and subscription providers use the full-lore layout by default. OFF (upstream): the layout functions return the messages in assembled order (`input.slice()` / shallow copies), and `shouldUseFullLorebookContext` only uses full lore when the chat explicitly set `fullLorebookContext: true` (new third argument `explicitlyEnabled`), so other chats get the keyword lore scan.
- **How to reach it:** Settings > Advanced > Features > "Cache-friendly prompt layout" (help: "Moves World Maps and other changing blocks next to the current turn, and uses full lore on subscriptions. Off keeps the original order.").
- **Settings and defaults:** default ON. Key `cacheFriendlyPromptLayout`. No env variable. Per-chat `fullLorebookContext` metadata still overrides in either direction (explicit false disables, explicit true enables even when the switch is off).
- **Storage:** app_settings `features.cacheFriendlyPromptLayout`.
- **Tests:** `scripts/regressions/feature-switch-cache-layout.regression.ts`.
- **Known limits:** dry-run (prompt preview) follows the same rule, so previews match live requests.

### Feature switch: Stable lorebook picks

- **Commit:** `8aa93818b` (2026-09-23 19:14 +0300).
- **Files:** `packages/server/src/services/lorebook/group-pick-policy.ts` (new, `lorebookGroupPickRandom`), callers in `packages/server/src/routes/chats.routes.ts`, `game.routes.ts`, `generate.routes.ts`, `generate/dry-run-route.ts`, `services/prompt/macro-context.ts`, `services/prompt/marker-expander.ts`.
- **What it does:** ON: `lorebookGroupPickRandom()` returns undefined, so the scan seeds inclusion-group winners by chat id and a group keeps the same winner in a chat while its candidates stay the same. OFF (upstream): returns `Math.random`; a supplied random source disables the seed, so the winner is re-rolled on every scan. Probability gates default to `Math.random` either way and are unchanged.
- **How to reach it:** Settings > Advanced > Features > "Stable lorebook picks" (help: "An inclusion group keeps the same winner in a chat while its candidates stay the same. Off re-rolls every turn.").
- **Settings and defaults:** default ON. Key `stableLorebookGroupPicks`. Env `LOREBOOK_STABLE_GROUP_WINNERS` wins when set (`true`/`1`/`yes`/`on` = on, anything else = off); the toggle is then locked and shows the variable.
- **Storage:** app_settings `features.stableLorebookGroupPicks`.
- **Tests:** `scripts/regressions/feature-switch-lorebook-picks.regression.ts`.
- **Known limits:** upstream's same-named variable defaults off when unset; here unset means on.

### Feature switch: Retry failed provider calls

- **Commit:** `8aa93818b` (2026-09-23 19:14 +0300).
- **Files:** `packages/server/src/services/llm/rate-limit-aware-provider.ts`.
- **What it does:** ON: a refused connection or a gateway 502/503 (`isTransientProviderError`) is classified `"transient"` and retried up to twice before any text reached the user, each attempt on the next resolved DNS address (`resolvedAddressOffsetForAttempt(attempt)` = attempt). OFF (upstream): only rate limits (429 and 529) retry, and every attempt uses the first address (offset 0). Applies to streaming, `chatComplete` and `embed`.
- **How to reach it:** Settings > Advanced > Features > "Retry failed provider calls" (help: "Retries refused connections and gateway 502 or 503 errors twice, trying the next address. Off retries only rate limits.").
- **Settings and defaults:** default ON. Key `providerRetry`. Env `PROVIDER_RETRY_TRANSIENT_ERRORS` wins when set (same truthy set as above).
- **Storage:** app_settings `features.providerRetry`.
- **Tests:** `scripts/regressions/feature-switch-provider-retry.regression.ts`.
- **Known limits:** rate-limit retry precedence is unchanged; transient retry only happens before any streamed text arrived.

### Feature switch: Background call cap

- **Commit:** `8aa93818b` (2026-09-23 19:14 +0300).
- **Files:** `packages/server/src/services/generation/background-call-budget.ts`.
- **What it does:** ON: automatic (background) model calls are limited per rolling hour to `backgroundCallsPerHour`. OFF (upstream): no cap (limit 0). When `MARINARA_BACKGROUND_CALLS_PER_HOUR` is unset the budget now reads `isFeatureEnabled("backgroundCallCap") ? getFeatureNumber("backgroundCallsPerHour") : 0` instead of the fixed default.
- **How to reach it:** Settings > Advanced > Features > "Background call cap" (help: "Limits automatic model calls per hour so background work cannot run up a bill. Off removes the cap."), with a "Calls per hour" number input shown below it while on.
- **Settings and defaults:** default ON, `backgroundCallsPerHour` default 600 (1 to 100000). Env `MARINARA_BACKGROUND_CALLS_PER_HOUR` wins over both the switch and the number: a positive number sets the cap, `0`/`off`/`false`/`disabled` removes it; both controls then show as env-locked.
- **Storage:** app_settings `features.backgroundCallCap`, `features.backgroundCallsPerHour`.
- **Tests:** `scripts/regressions/feature-switch-background-cap.regression.ts`.
- **Known limits:** the cap counts only automatic calls, not user-initiated generations (per the switch help; exact classification not re-verified here).

### Feature switch: Message trash

- **Commit:** `8aa93818b` (2026-09-23 19:14 +0300).
- **Files:** `packages/server/src/routes/chats.routes.ts` (`chatUsesMessageTrash`), `packages/server/src/services/storage/message-trash.storage.ts`, `packages/client/src/hooks/use-chats.ts`, `packages/client/src/components/chat/ChatMessageSearch.tsx`, `packages/client/src/components/chat/ChatMessageMarksPanels.tsx`.
- **What it does:** ON: deleted messages go to the chat's Trash, restorable, kept for `messageTrashDays` (retention, `expiresAt` and the expiry sweep now read `getFeatureNumber("messageTrashDays")` instead of the constant). OFF (upstream): every delete, single and bulk, is permanent on the server; the client skips the "moved to Trash" toast path and hides the Trash tab in the chat search panel. Messages already in Trash stay until they expire. Game chats and Professor Mari chats keep permanent deletes either way.
- **How to reach it:** Settings > Advanced > Features > "Message trash" (help: "Deleted messages go to the chat Trash so you can restore them. Off deletes them permanently."), with "Days kept in Trash" below it while on. The Trash view is a tab of the chat search panel.
- **Settings and defaults:** default ON, `messageTrashDays` default 30 (1 to 365). No env variable.
- **Storage:** app_settings `features.messageTrash`, `features.messageTrashDays`.
- **Tests:** `scripts/regressions/feature-switch-message-trash.regression.ts`.
- **Known limits:** changing the days value retroactively changes expiry of entries already in Trash (retention is computed from `deletedAt` at read/sweep time).

### Feature switch: Usage and activation stats

- **Commit:** `8aa93818b` (2026-09-23 19:14 +0300).
- **Files:** `packages/server/src/services/storage/generation-usage.storage.ts`, `packages/server/src/services/lorebook/activation-stats.ts`, `packages/client/src/components/panels/settings/UsageDashboardSettings.tsx`, `packages/client/src/components/lorebooks/LorebookEditor.tsx`.
- **What it does:** ON: every generation records token usage and lorebook activations. OFF (upstream): the usage ledger write returns null, activation recording returns early, and activations already queued but not yet flushed are dropped at flush time. The Usage Dashboard is replaced by the notice "Usage recording is off. Turn on Usage and activation stats in Features to see this dashboard." and the lorebook editor stops fetching activation stats.
- **How to reach it:** Settings > Advanced > Features > "Usage and activation stats" (help: "Records token usage and lorebook activations after each generation. Off records nothing and hides the dashboard and stats.").
- **Settings and defaults:** default ON. Key `usageAndActivationStats`. No env variable.
- **Storage:** app_settings `features.usageAndActivationStats`. Existing recorded data is not deleted.
- **Tests:** `scripts/regressions/feature-switch-usage-stats.regression.ts`.
- **Known limits:** generations made while off are never back-filled.

### Feature switch: Send client error reports

- **Commit:** `8aa93818b` (2026-09-23 19:14 +0300).
- **Files:** `packages/client/src/lib/client-diagnostics.ts` (`setClientDiagnosticsEnabled`, `applyClientErrorReportsSetting`), `packages/client/src/main.tsx`, `packages/client/src/stores/ui.store.ts`, `packages/client/src/hooks/use-settings-sync.ts`.
- **What it does:** ON: browser errors (error, unhandledrejection, React recovery, network) are sent to the server log via `POST /api/diagnostics/client`. OFF (upstream): the error listeners are never installed, `reportClientDiagnostic` and `flushQueue` return immediately, so nothing is queued or sent. The saved value is applied at startup before the sender can flush a queue left from an earlier visit, and re-applied on store change.
- **How to reach it:** Settings > Advanced > Features > "Send client error reports" (help: "Sends browser errors to the server log to help with bug reports. Off sends nothing.").
- **Settings and defaults:** default ON (`clientErrorReports: true` in the UI store; sync treats only explicit `false` as off). No env variable. Not part of `featureSettingsSchema`.
- **Storage:** UI setting `clientErrorReports` (persisted UI state and synced settings).
- **Tests:** `scripts/regressions/feature-switch-client-error-reports.regression.ts`.
- **Known limits:** turning it off after listeners were installed in the same page stops sending but does not uninstall the listeners until reload (they drop reports while disabled).

### Feature switch: Scene timeline (game)

- **Commit:** `8aa93818b` (2026-09-23 19:14 +0300).
- **Files:** `packages/shared/src/utils/game-feature-switches.ts` (`isGameSceneTimelineEnabled`), `packages/server/src/services/game/game-feature-switches.ts` (`snapshotPresenceTimeline`), `packages/server/src/routes/game.routes.ts`, `packages/server/src/routes/generate.routes.ts`, `packages/client/src/components/game/GameSurface.tsx`.
- **What it does:** ON: after each GM turn a background call reviews the scene; scene presence, the Scenes tab and the scene index in the session recap come from it. OFF (upstream): the post-turn review is skipped, the timeline queue endpoint returns `{ queued: false }`, the recap gets no scene index, the Session panel shows only History, Journal and Tools (no Scenes tab), and presence/party replies use the latest tracker snapshot's present characters; a snapshot naming no party member lets every party member reply.
- **How to reach it:** chat settings drawer of a Game chat, Agents tab > "Scene timeline" (help: "Review scenes after each GM turn for presence and the session recap. Off uses tracker presence instead.").
- **Settings and defaults:** default ON (absent = on). Metadata key `gameSceneTimelineEnabled`. No env variable.
- **Storage:** chat metadata `gameSceneTimelineEnabled` on each session chat.
- **Tests:** `scripts/regressions/game-switch-scene-timeline.regression.ts`.
- **Known limits:** existing timeline data is not deleted; it just stops being read or updated while off.

### Feature switch: Extended HUD widgets (game)

- **Commit:** `8aa93818b` (2026-09-23 19:14 +0300).
- **Files:** `packages/shared/src/utils/game-feature-switches.ts` (`isGameExtendedWidgetsEnabled`, `upstreamHudWidgets`), `packages/server/src/services/game/gm-prompts.ts` (`buildUpstreamWidgetLines`, `enableExtendedWidgets`), `packages/server/src/services/generation/game-gm-prompt-runtime.ts`, `packages/server/src/services/game/branch-state.ts`, `packages/client/src/components/game/GameSurface.tsx`.
- **What it does:** ON: the GM sees the extra widget types (checklist, schedule, clock, ledger and others) and may create and delete widgets. OFF (upstream): the late format reminder carries upstream's widget block with upstream widget types only; GM widget create/delete commands are ignored live (`GameSurface`) and on branch replay (`restoreBranchHudLists`). Extended widgets are hidden, not deleted, and return with saved values when switched back on; value changes to upstream widgets still apply.
- **How to reach it:** chat settings drawer of a Game chat, Agents tab > "Extended HUD widgets" (help: "Extra widget types and GM widget create and delete. Off hides extended widgets without deleting them.").
- **Settings and defaults:** default ON. Metadata key `gameExtendedWidgetsEnabled`. No env variable.
- **Storage:** chat metadata `gameExtendedWidgetsEnabled`.
- **Tests:** `scripts/regressions/game-switch-extended-widgets.regression.ts`.
- **Known limits:** only the late format reminder changes; with the switch on the GM prompt is byte-for-byte unchanged and cached system prompt layers are never affected.

### Feature switch: Automatic scene media (game)

- **Commit:** `8aa93818b` (2026-09-23 19:14 +0300).
- **Files:** `packages/shared/src/utils/game-feature-switches.ts` (`isGameAutoSceneMediaEnabled`), `packages/server/src/routes/generate.routes.ts`.
- **What it does:** ON: after each GM turn `queueAutomaticGameMedia` may generate scene images and media. OFF (upstream): the automatic post-turn queue is skipped. Media the user explicitly requests still works.
- **How to reach it:** chat settings drawer of a Game chat, Agents tab > "Automatic scene media" (help: "Queue scene images and media after each GM turn without being asked.").
- **Settings and defaults:** default ON. Metadata key `gameAutoSceneMediaEnabled`. No env variable.
- **Storage:** chat metadata `gameAutoSceneMediaEnabled`.
- **Tests:** `scripts/regressions/game-switch-auto-scene-media.regression.ts`.
- **Known limits:** gates only the automatic queue call site in the generate route.

### Feature switch: Warn before a low-cache send (chat)

- **Commit:** `8aa93818b` (2026-09-23 19:14 +0300).
- **Files:** `packages/client/src/features/chat-settings/sections/AdvancedParametersSection.tsx`, `packages/client/src/components/chat/ChatSettingsDrawer.tsx` (`onCacheSendGuardChange`), `packages/shared/src/types/chat.ts`.
- **What it does:** on providers with prompt caching, a send is held with a question first when the predicted cache hit is below the threshold. The server already read `cacheSendGuard` (`readCacheGuardSettings`); this commit only surfaces it as a control with the same defaults. OFF: sends are never held for low predicted cache hit.
- **How to reach it:** chat settings drawer > Advanced Parameters > "Warn before a low-cache send" (help: "Hold a send and ask first when the predicted prompt cache hit falls below the threshold. Applies to providers with prompt caching."), with "Warn below (%)" number input (0 to 100, rounded) while on. Every chat mode.
- **Settings and defaults:** `cacheSendGuard.enabled` default ON (absent = on), `cacheSendGuard.thresholdPercent` default 80. No env variable.
- **Storage:** chat metadata object `cacheSendGuard` `{ enabled?, thresholdPercent?, ttlMinutes? }` (edits preserve other fields).
- **Tests:** `scripts/regressions/chat-cache-send-guard-settings.regression.ts`.
- **Known limits:** unlike the other switches this does not restore an upstream behaviour removal; it exposes an existing server setting.

### Stable lorebook inclusion-group winner per chat

- Commit: `ede160d9d`.
- Files: `packages/server/src/services/lorebook/keyword-scanner.ts` (`ScanOptions.groupSeed`, seeded group random), `packages/server/src/services/lorebook/index.ts`; later `group-pick-policy.ts` for the switch.
- Problem: an inclusion group re-rolled its winner with `Math.random` on every generation, so a different entry landed near the top of the prompt each turn and broke prompt caching on selective-lore connections. Found on 2026-09-22 by diffing two consecutive next-turn previews (the first lore entry flipped with no change in between) and reproduced 3 of 3 in the sandbox.
- Behaviour: the winner is seeded by chat id, group and candidate set: stable across turns, still varied across chats and when the activated candidates change. Injected random sources keep their behaviour.
- Setting: **Stable lorebook picks** (`stableLorebookGroupPicks`, default on; env `LOREBOOK_STABLE_GROUP_WINNERS` wins).
- Tests: `scripts/regressions/feature-switch-lorebook-picks.regression.ts`.

### HUD widget landing, enum repair and interim list capacity

- `0f90ee405`: GM prompt summary line for extended widgets, the compact catalog of the 19 extra types, the setup JSON schema listing every type, and locale keys (`formatHint`, calendar day label). The widget engine and renderers had been swept into `05d60f159` from the shared index.
- `2ceb4b780`: `0f90ee405` applied zero-context hunks at shifted offsets; the 19 type names landed outside both enums in `packages/server/src/routes/game.routes.ts` and HEAD did not compile (20 server tsc errors before, 0 after, checked on a clean checkout).
- `857d874d5`: widgets created by the GM without an icon show their type's default icon in the phone tray, the tucked panel and the headers (19 identical buttons before).
- `beeafe7c7`: interim per-widget list capacity (`config.max` 1 to 30, default 5), `[widget: id, max: N]`, eviction toast and branch replay parity, with `scripts/regressions/hud-widget-list-capacity.regression.ts`. Superseded on 2026-09-24 by list widget capacity 100.

### GameSurface parse repair

- Commit: `a0e614fc5`. `3008c346d` applied a zero-context hunk one line late: `const shownChoices = activeChoices;` landed inside the `sendMessage(` call, so `GameSurface.tsx` did not parse at HEAD. The function now matches the working copy; nothing else changed.

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

# Feature Switches

This build adds a number of features on top of the original Marinara Engine. Every one of them can be switched off. Switched on (the default), you get today's behaviour. The one exception is **Keep generating when the tab is closed**, which starts off. Switched off, you get the original upstream behaviour, as if the addition was never there.

Changes apply straight away. You do not need to restart the server or reload the page.

## Overview

| Switch                                      | Default      | Scope         | Where to find it                    | Environment variable                 |
| ------------------------------------------- | ------------ | ------------- | ----------------------------------- | ------------------------------------ |
| **ChatGPT history replay**                  | On           | App           | Settings > Advanced > Features      |                                      |
| **Cache-friendly prompt layout**            | On           | App           | Settings > Advanced > Features      |                                      |
| **Stable lorebook picks**                   | On           | App           | Settings > Advanced > Features      | `LOREBOOK_STABLE_GROUP_WINNERS`      |
| **Stable lore order**                       | On, 2 turns  | App           | Settings > Advanced > Features      |                                      |
| **Retry failed provider calls**             | On           | App           | Settings > Advanced > Features      | `PROVIDER_RETRY_TRANSIENT_ERRORS`    |
| **Background call cap**                     | On, 600/h    | App           | Settings > Advanced > Features      | `MARINARA_BACKGROUND_CALLS_PER_HOUR` |
| **Message trash**                           | On, 30 days  | App           | Settings > Advanced > Features      |                                      |
| **Usage and activation stats**              | On           | App           | Settings > Advanced > Features      |                                      |
| **Minimize the console to the system tray** | On (Windows) | App (server)  | Settings > Advanced > Features      | `MARINARA_CONSOLE_TRAY`              |
| **Send client error reports**               | On           | App (browser) | Settings > Advanced > Features      |                                      |
| **Keep generating when the tab is closed**  | **Off**      | App           | Settings > Advanced > Features      |                                      |
| **Scene timeline**                          | On           | Game          | Chat settings > Agents (Game mode)  |                                      |
| **Extended HUD widgets**                    | On           | Game          | Chat settings > Agents (Game mode)  |                                      |
| **Automatic scene media**                   | On           | Game          | Chat settings > Agents (Game mode)  |                                      |
| **Warn before a low-cache send**            | On, 80%      | Chat          | Chat settings > Advanced Parameters |                                      |

Searching settings for `features` also takes you to the app-wide section.

## Where the settings are stored

- The app-wide server switches are saved together in the `features` app setting, a JSON object of booleans and numbers. A missing key, an empty object or an unreadable value all mean on, with the default numbers.
- **Keep generating when the tab is closed** (generation job tracking) keeps its own app setting, `generationJobTracking` (`"true"` or `"false"`). It starts off. When on, image, sprite and video jobs keep running after the tab closes, their status and a short log are saved, and finished results wait in **Generation jobs** (the button under the switch, or the command palette). See [Generation jobs](../development/generation-jobs.md).
- **Send client error reports** is a browser preference (`clientErrorReports`) that syncs with your other UI settings.
- The game switches are chat metadata keys on every session chat of the game. Starting a new session copies them along with the rest of the game's settings, and a branch keeps the choice of the chat it came from.
- The cache warning is the chat metadata object `cacheSendGuard`.

## App-wide switches

### ChatGPT history replay

Setting key: `chatgptHistoryReplay`.

On: Game turns on the ChatGPT subscription reuse the previous prompt, and full-lore requests send a `session-id` header and a `prompt_cache_key` so the cache stays warm.

Off: the prompt is rebuilt every turn. No session header and no cache key are sent.

### Cache-friendly prompt layout

Setting key: `cacheFriendlyPromptLayout`.

On: World Maps and other changing runtime blocks move next to the current turn, the full-lore prefix leads the prompt, and subscription providers use the full-lore layout by default. The order of the lorebook entries the keyword or semantic scan picks has its own switch, **Stable lore order**.

Off: the prompt is sent in the order it was assembled. Chats use the keyword lore scan unless a chat explicitly turned full lore on.

Game chats on a subscription provider can also opt in to **stable final checks** with the chat metadata key `gameCacheStableFinalChecks` set to `true` (no settings control yet; default off). The player-canon and prose checks that close every Game prompt never change within a chat, but anything after the last finished exchange is written to the prompt cache again on the next turn. With the opt-in, their full text (about 5,100 characters) moves into the cached part of the prompt, just before the history, and a short `<final_checks>` reminder (about 230 characters) stays at the end. Each Game turn then writes about 4,900 fewer characters to the cache. The trade-off is that the full checks are no longer the last thing the model reads; the reminder names them and keeps the rule that the current player input has the highest authority. The opt-in only works while this switch is on. Turning it on or off in a running chat rewrites the cached history once.

### Stable lorebook picks

Setting key: `stableLorebookGroupPicks`.

On: a lorebook inclusion group keeps the same winner in a chat while its candidates stay the same.

Off: the winner is re-rolled on every scan.

### Stable lore order

Setting keys: `stableLoreOrder` and `stableLoreLingerTurns` (**Linger turns**, default 2, 0 to 8).

Full lore on a subscription provider already sends every entry in one fixed `<lore>` prefix. Everything else still picks entries per turn: the keyword and semantic scan on other providers, subscription chats with full lore turned off, depth entries and Outlets. Those entries used to be sorted by entry order, so a keyword that appeared or disappeared could change the middle of the lore block and make the provider re-read everything after it.

On:

- **First order.** Lorebook id, then entry order, then position, then entry id. Activation score and scan order never decide it.
- **Append only.** Each turn keeps the entries it sent last turn in the same order. Entries that are no longer active are removed. New ones go at the end, sorted the same way. The block before the first new entry stays the same as last turn.
- **Linger.** An entry that a keyword, semantic or recursive match brought in and that stops matching can stay for a few more turns, so a keyword that flickers in and out does not rewrite the block every turn. Each turn it lingers, it must still pass every check the scan runs apart from the keyword itself: enabled, character, tag and trigger filters, game-state activation conditions and the schedule (time, date and location), all against this turn's game state. So an entry scheduled for night, or for one location, or with a condition such as `location equals ...`, leaves as soon as the game state stops matching it. It also needs room in the chat and lorebook token budgets and entry limits, and nothing lingers on a turn where the budget already turned a new match away. Entries the current location brought in never linger (after travel they leave at once), and neither do constant, always-loaded, decision, probability, inclusion-group, cooldown, delay, macro or limited-use (ephemeral) entries. A limited-use entry is only sent on turns that count toward its limit. Lingering entries show as sticky in the activation list and do not start timers. **Linger turns** under the switch (setting key `stableLoreLingerTurns`) sets the number of turns: default 2, `0` turns linger off, the maximum is 8. A chat can override it with the chat metadata key `stableLoreLingerTurns` (a number from 0 to 8; larger numbers count as 8). The chat's own value wins over **Linger turns**; a chat without one, or with a value that is not a number of 0 or more, uses **Linger turns**. There is no chat settings control for the override yet.
- **Held until the block changes.** When an entry's linger turns run out, taking it out of a block that is otherwise the same as last turn would make the provider read everything after it again, the whole history included. So it is held, and removed on the next turn whose lore changes anyway (a new entry, or another entry leaving). It is held for at most 4 turns, and only while it still passes the same checks and budgets. Once the 4 turns are up it is removed even from an unchanged block, and that one turn rewrites the history as before.
- **Depth and position.** An entry's position and explicit depth always decide where it goes (before or after the character, a given depth, or an Outlet). The stable order only decides the order inside one place. Entries at the same depth follow it instead of entry order.
- **Where the block sits.** A keyword lore block that is its own system message sits before the history, as before. In the subscription Game layout with full lore off, keyword lore travels with the per-turn blocks next to the current turn, and it now goes first there, before weather, map and turn state. Moving those blocks is the job of **Cache-friendly prompt layout**, so this part needs both switches on.
- **Cache marker.** On the Anthropic API, a stable lore block that is its own system message gets one more cache marker on the system block just before it. When new entries are added, the system prompt and character text before the block are still read from the cache. That is the third of Anthropic's four markers; the other two are the end of the system prompt and one history message. The Claude subscription gets no extra marker, because the Agent SDK already uses all four. OpenAI-style providers cache prefixes on their own and get none either.
- **State.** Each chat stores the order it sent in the chat metadata key `stableLoreOrder`: entry ids plus linger counters, one entry per character scope, at most 8 scopes. The state is tied to the newest message before the reply, so a regenerate or swipe of the same turn starts from the same order and sends the same block. A branch starts without it. Prompt previews read it but never write it.

Off: scanned entries are sorted by entry order with scan order breaking ties, exactly as upstream: the lore blocks, depth entries and Outlets are byte for byte what they were before the stable order existed. Nothing is lingered or held, the `stableLoreOrder` chat metadata is neither read nor written (an order a chat stored earlier is left alone and used again if the switch comes back on), and no extra Anthropic cache marker is set. **Linger turns** and the chat override have no effect while the switch is off.

The switch is independent of **Cache-friendly prompt layout**: either can be on without the other.

Measured on a fixture chat whose keywords flicker (12 turns, 7 keyword entries of about 700 characters in 2 lorebooks, one depth entry, 1,500-character replies), counting the characters of each prompt after the part it shares with the previous one:

|                                  | Rewritten characters (11 turns) | Worst single turn | Prompt characters sent | Turns with the whole lore block unchanged |
| -------------------------------- | ------------------------------- | ----------------- | ---------------------- | ----------------------------------------- |
| Switch off                       | 97,185                          | 15,913            | 160,060                | 1                                         |
| Stable order, linger 0           | 95,091 (2.2% fewer)             | 15,913            | 160,060                | 1                                         |
| Stable order, linger 2 (default) | 47,548 (51.1% fewer)            | 14,397            | 176,206 (10.1% more)   | 6                                         |

The costs of linger, stated plainly:

- **More lore in each prompt.** Lingering and held entries are sent on turns where the scan did not pick them, so each prompt is larger (10.1% more characters on the fixture). On a provider that caches by prefix, most of that is read from the cache. On a provider or local model without a prefix cache, linger only adds tokens and saves nothing; set **Linger turns** to `0`, or set the chat metadata key `stableLoreLingerTurns` to `0` for just those chats.
- **Lore about things no longer mentioned.** With the default of 2, an entry can stay up to 2 turns after its keyword was last seen, plus up to 4 held turns, as long as it still passes its game-state checks. It is lore the scan picked a few turns ago, not lore that contradicts the current state.
- **Some turns can be a little worse.** When the block changes and held entries leave at the same time, the part of the block from the first entry that left is rewritten. On the fixture one turn rewrote 702 more characters than with the switch off (one entry). An entry that reaches the end of its 4 held turns on an otherwise unchanged turn rewrites the history once, as the switch off would.

The fixture numbers repeat from run to run: the first order sorts by lorebook id, and the regression gives the lower id the same role every time.

### Retry failed provider calls

Setting key: `providerRetry`.

On: a refused connection or a gateway 502 or 503 is retried up to twice before any text reached you, each time on the next DNS address.

Off: only rate limits (429 and 529) are retried, always on the first address.

### Background call cap

Setting keys: `backgroundCallCap` and `backgroundCallsPerHour` (**Calls per hour**, default 600).

On: automatic model calls are limited per rolling hour.

Off: no cap.

### Message trash

Setting keys: `messageTrash` and `messageTrashDays` (**Days kept in Trash**, default 30).

On: deleted messages go to the chat's Trash, where you can restore them. Game chats and Professor Mari chats keep permanent deletes either way.

Off: every delete is permanent, single and bulk, and the Trash view is hidden. Messages already in the Trash stay there until they expire.

### Usage and activation stats

Setting key: `usageAndActivationStats`.

On: every generation records token usage and lorebook activations.

Off: nothing is recorded, including activations that were queued but not yet written when you turned it off. The Usage Dashboard and the lorebook activation stats are hidden.

### Minimize the console to the system tray

Setting key: `consoleTray`. Windows only.

On: while the server runs in a console window, a Marinara icon sits in the Windows system tray (its tooltip shows the port), and minimizing the console hides it from the taskbar. The icon's menu has **Open Marinara** (opens the app in your default browser at the address and port the server listens on), **Show console** or **Hide console**, and **Quit Marinara**, which stops the server gracefully, the same way Ctrl+C does. Double-clicking the icon shows or hides the console.

Off: no tray icon, and the console is left alone, as in upstream Marinara. Turning it off while the console is hidden brings the console back. Turning it on or off applies at once.

Good to know:

- It works however the server was started: `start.bat`, `start-local.bat`, the Windows launcher or `pnpm start`.
- In Windows Terminal (the Windows 11 default) the console is a tab that may share its window with other tabs, so the console is never hidden there. You still get the tray icon, and double-clicking it opens Marinara. The server log says why.
- With no visible console (a service, or a console started hidden) there is no tray icon. The server log says so once.
- When the server stops for any reason, including a crash, a hidden console is shown again and the icon goes away.
- On Linux, macOS, Android and Docker the switch has no effect and is shown as unavailable.
- It uses a small hidden Windows PowerShell helper (`packages/server/src/assets/console-tray.ps1`). If PowerShell is missing or blocked, the server logs one warning and keeps working normally.

### Send client error reports

UI setting: `clientErrorReports`.

On: browser errors are sent to the server log to help with bug reports.

Off: the error listeners are not installed and nothing is queued or sent.

## Game switches

These are in the chat settings drawer of a Game chat, on the **Agents** tab below Character knowledge.

### Scene timeline

Metadata key: `gameSceneTimelineEnabled`.

On: after each GM turn a background call reviews the scene. Scene presence, the Scenes tab and the scene index in the session recap come from it.

Off: no scene review call and no scene index in the recap. The Scenes tab is hidden. Scene presence and party replies use the tracker snapshot's present characters; when the snapshot names no party member, every party member may reply.

### Extended HUD widgets

Metadata key: `gameExtendedWidgetsEnabled`.

On: the GM sees the extra widget types (checklist, schedule, clock, ledger and the rest) and may create and delete widgets.

Off: the GM sees upstream's widget block with the upstream widget types only, and create and delete commands are ignored, live and on branch replay. Existing extended widgets are **hidden, not deleted**. They keep their saved values and come back when the switch is turned on again. Values the GM changes for upstream widgets while it is off are kept as usual.

With the switch on, the GM prompt is byte for byte what it was before the switch existed. The switch only changes the late format reminder, never the cached system prompt layers.

### Automatic scene media

Metadata key: `gameAutoSceneMediaEnabled`.

On: after each GM turn the automatic scene media queue may generate scene images and media.

Off: nothing is queued automatically. Media you ask for still works.

### Auto expand widgets

Metadata key: `gameWidgetAutoExpand`.

On: HUD widgets show all their content instead of scrolling inside it. A long list widget shows every entry, and a widget opened from the phone or tablet tray can grow up to the screen height. Widgets shrink back when their content shrinks.

Off: widgets keep the fixed size limits: a list longer than about 16 lines scrolls inside the widget, and the tray sheet stops at the smaller of 60% of the screen and 28rem.

Each widget can override the game in its edit dialog under **Size**: **Auto** follows this switch, **Always expand** expands even when the switch is off, and **Fixed size** keeps the limits even when it is on. The per-widget choice is stored in the widget's config as `autoExpand` (`expand` or `fixed`; Auto stores nothing).

A height you set by hand (resizing the panel in Edit layout) wins over growing for Auto and Fixed size widgets. Always expand grows past it; the hand-set height is kept and applies again if you change the choice. With Collisions on, other movable panels make room for a grown widget.

### GM reasoning effort (a setting, not a switch)

Metadata key: `gameGmReasoningEffort`. In the chat settings drawer of a Game chat, **GM Reasoning Effort** (just below the connection), or from the command palette (Ctrl+K, **Set GM reasoning effort**).

This is a per-game setting, not a feature switch. Its **Default** equals upstream: the GM narration turn uses the effort the connection, chat parameters and built-in defaults resolve to, and the provider request is byte for byte what it was before the setting existed. No switch is needed to get upstream behaviour.

The other choices (None, Low, Medium, High, Extra high, Max; only those the selected model supports are listed) override the resolved effort for the GM narration turn, including regenerate and continue of that turn. A level the model cannot use is sent as the nearest level it supports (Opus 5.5 cannot turn thinking off, so None is sent as low). Side calls that set their own effort, such as scene analysis, planners, continuity and agents, are not affected. New sessions of the same game keep the choice. The token usage line under a GM turn shows the effort the turn used.

## Chat switch

### Warn before a low-cache send

Metadata keys: `cacheSendGuard.enabled` (default on) and `cacheSendGuard.thresholdPercent` (**Warn below (%)**, 0 to 100, default 80). It is in Chat settings > Advanced Parameters, in every chat mode.

On providers with prompt caching, a send is held with a question first when the predicted cache hit is below the threshold. The server already read this setting; the control only surfaces it, with the same defaults.

## Precedence

1. **Environment variable.** When one of the variables below is set, it wins over the saved switch, both on and off, and the switch shows which variable controls it. A blank variable counts as unset.
2. **Saved switch.** The value saved in Settings or in the chat's metadata.
3. **Default.** Anything never saved is on, with the default numbers.

| Variable                             | Controls                                | Values                                                                             |
| ------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------- |
| `LOREBOOK_STABLE_GROUP_WINNERS`      | Stable lorebook picks                   | `true`, `1`, `yes` or `on` turn it on. Any other value turns it off.               |
| `PROVIDER_RETRY_TRANSIENT_ERRORS`    | Retry failed provider calls             | `true`, `1`, `yes` or `on` turn it on. Any other value turns it off.               |
| `MARINARA_BACKGROUND_CALLS_PER_HOUR` | Background call cap and Calls per hour  | A positive number sets the cap. `0`, `off`, `false` or `disabled` removes it.      |
| `MARINARA_CONSOLE_TRAY`              | Minimize the console to the system tray | `true`, `1`, `yes` or `on` turn it on. Any other value, such as `0`, turns it off. |

The first two use the same names as upstream Marinara Engine, where they are off unless set. Here they are on unless set, so an unset variable keeps this build's behaviour.

The game switches and the chat switch have no environment variable. Each game or chat keeps its own choice, independent of the app-wide switches.

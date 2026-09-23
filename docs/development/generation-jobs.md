# Generation Jobs and Job Tracking

This guide covers how Marinara Engine runs long media generations as jobs, and the optional **Track generation jobs** setting. That setting saves each job's status and results, keeps a log trail per job, and lets the client pick jobs back up after a refresh or a lost connection.

For the shared structured logging vocabulary (`event`, `state`, `elapsedMs`, `errorCode`, `outcome` and the diagnostic context fields), see [Logging (Developers)](logging.md).

## Summary

- Jobs you have already started keep running when you close the browser, as long as the server keeps running.
- With the setting on, their status, a result link and a short structured log are saved on the server. After a refresh or a reconnect, the client lists them again and tells you which results finished while you were away.
- A server restart stops any job that was still running. Nothing is retried automatically. The job is marked **interrupted** so that you know to start it again.
- The setting is **off by default**. While it is off, the Engine behaves exactly as it did without this feature: the same routes and responses, and no new writes.

## Architecture

```text
media route (gallery, sprites, characters, backgrounds)
      │  generationJobs.run({ kind, label, chatId, timeoutMs }, work)
      ▼
GenerationJobsStore            services/generation/generation-jobs.ts
  ├── DATA_DIR/generation-jobs/<id>.json          metadata (always, existing behavior)
  ├── DATA_DIR/generation-jobs/<id>.result.json   result payload (always, existing behavior)
  └── observer seam: accepted → running → settled
      │  (sync, guarded by try/catch; inert when no observer is installed)
      ▼
GenerationJobTracker           services/generation/generation-job-tracker.ts
  ├── returns immediately while the setting is off
  ├── generation_job_records table (one row per tracked job)
  └── logger: "job.state" / "job.progress" events
      ▼
/api/generation-job-records    routes/generation-job-records.routes.ts
      ▼
Client: GenerationJobsRecoveryHost (reattach, palette command),
        GenerationJobsActivityDot (top bar), TrackedJobDetails (viewer)
```

**The existing store (unchanged behavior).** Media routes wrap provider work in `generationJobs.run(...)`. The store gives the work an `AbortSignal` and a timeout. It writes metadata and the JSON result to `DATA_DIR/generation-jobs`, and exposes `/api/generation-jobs` (list, get, result, cancel). Closing the HTTP response does **not** abort the work. The existing `generation-jobs` regression covers this.

**The observer seam.** `GenerationJobsStore.setObserver(fn)` installs one lifecycle observer. `notify()` calls it synchronously in a `try/catch`. A throwing observer is logged as a warning and never fails or delays the generation. There is no `await` on the request path. Each event fires after the store has saved the matching status: `accepted` and `running` after the job's metadata file is written, and `settled` after the final status is written. When a cancel or a shutdown aborts the job, `settled` waits for that status write to finish, so it never reports an outcome that is not on disk yet. `settled` fires once per job.

**The tracker.** On startup it reads the setting (a read only) and installs the observer. When tracking is on, it also reconciles stale records and runs a retention pass. It keeps a serialized, failure-safe write queue, so a storage error is logged and never reaches the generation.

**The setting.** It is stored in `app_settings` under the key `generationJobTracking` (`"true"` or `"false"`). The UI is in **Settings > Advanced > Generation job tracking**. `GET /api/generation-job-records/settings` and `PUT /api/generation-job-records/settings` with `{ "enabled": boolean }` read and change it.

### Setting off

With tracking off:

- the observer returns before doing anything;
- `/api/generation-jobs` answers exactly as before;
- every `/api/generation-job-records` route except `/settings` falls through to the normal 404 handler, exactly as if it were not registered;
- no table rows, files or log lines are written;
- the tracker starts no timers (the retention timer and the per-job heartbeats run only while tracking is on);
- the client makes one extra read (the setting, cached for 5 minutes), does not poll, and renders nothing new.

The `generation-job-tracking` regression compares every response byte for byte (masking only timestamps and random diagnostic ids) against a server without the feature, and checks that the table shards on disk are unchanged.

## Job kinds covered

Tracking covers the media jobs that already run through the store:

| Store kind                                        | Tracked kind | Started from                |
| ------------------------------------------------- | ------------ | --------------------------- |
| `gallery-image`                                   | image        | Gallery image generation    |
| `gallery-selfie`                                  | image        | Gallery selfie              |
| `scene-background`                                | image        | Scene background generation |
| `character-avatar-draft`, `character-sheet-draft` | image        | Character editor art drafts |
| `sprite-sheet`                                    | sprite       | Sprite sheet generation     |
| `sprite-animated-expressions`                     | sprite       | Animated expressions        |
| `gallery-scene-video`                             | video        | Gallery scene video         |

**Not covered**, because they do not run through the job store today:

- TTS: the TTS routes answer synchronously.
- Illustrator agent images made during a chat turn.
- Game Mode asset generation (backgrounds, portraits and illustrations started from the game routes).

Text jobs that do use the store (`game-party-turn`, `game-npc-backfill`, `game-character-sheet-draft`) are deliberately not tracked, because they are not media.

## States and transitions

A record's `status` is one of:

```text
accepted ──► running ──► completed
                    ├──► failed
                    ├──► cancelled
                    └──► interrupted   (server shutdown or restart)
```

| Status        | Meaning                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| `accepted`    | The store persisted the job. This store has no queue, so `running` follows almost at once.  |
| `running`     | Provider work started. A `job.progress` heartbeat is logged every 30 s.                     |
| `completed`   | The result was saved. `resultRef` points to it.                                             |
| `failed`      | The provider or the job failed, or the job timed out (`ME_TIMEOUT`).                        |
| `cancelled`   | Stopped through `POST /api/generation-jobs/:id/cancel` (`ME_CANCELLED`).                    |
| `interrupted` | The server shut down or restarted while the job ran (`ME_INTERRUPTED`). It is never re-run. |

### Log events

Every transition is logged, and also appended to the record's `trail`, as one structured event:

```json
{
  "event": "job.state",
  "state": "completed",
  "at": "2026-09-23T10:00:00.000Z",
  "operation": "generation.job",
  "operationId": "<job id>",
  "jobId": "<job id>",
  "chatId": "<chat id or null>",
  "kind": "image",
  "sourceKind": "gallery-image",
  "stage": "settle",
  "elapsedMs": 8421,
  "outcome": "ok"
}
```

`state` takes one of these values:

- `accepted`
- `running`
- `progress` (event `job.progress`)
- `completed`
- `failed`, which covers both failed and interrupted
- `cancelled`
- `recovered`, which covers a server-restart reconcile and a client reattach, told apart by `stage`
- `expired`, logged when retention removes a record

`outcome` is `ok`, `failed`, `cancelled` or `skipped`, and appears on terminal states only. `errorCode` is a stable `ME_*` code, and `errorId` links to the diagnostic reference when one exists.

**Redaction.** Events are built by `buildJobLogEvent` from an allow-list of ids, codes and timings. Prompts, message text, provider error messages, API keys and connection details are never copied into them. A string that does not look like an `ME_*` code is replaced with `ME_INTERNAL`. The regression plants an API key and a prompt in a failing job, then scans every lifecycle log line, the stored records and the route responses for them.

The trail keeps at most 40 events. The first event is always kept, and consecutive progress ticks collapse into one. You can read it in the jobs viewer: open a job, then open **Log trail**. It is also available through `GET /api/generation-job-records/:id/trail`.

## Recovery semantics

| Situation          | What happens                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Page refresh**   | The request that started the job is gone, but the job keeps running on the server. On load, the client reads `/api/generation-job-records`. The top bar dot shows that jobs are running, and the viewer lists them with their elapsed time. When they finish, the result shows up in the viewer. The dialog that started the job does not re-attach; the viewer is where you get results back.    |
| **Browser closed** | Same as a refresh: the job finishes and its result is saved. On the next visit, a toast reports results that finished while you were away, with a **View** button that opens the viewer.                                                                                                                                                                                                          |
| **Network drop**   | The job keeps running. While the client is offline or the tab is hidden, it records that you are away. When you are back, it re-reads the records and announces anything that finished in the meantime.                                                                                                                                                                                           |
| **Server restart** | In-flight jobs are lost. On a clean shutdown, the store marks them `interrupted`. After a crash, the tracker reconciles on the next start: any record still `accepted` or `running` takes its outcome from the store's metadata. If the store never finished the job, the record becomes `interrupted` with `ME_INTERRUPTED`. Both paths log `state: "recovered"` with `stage: "server-restart"`. |

**Why nothing is resumed.** Safe resumption is not possible for any covered kind today:

- the provider calls are not idempotent, and each one costs money;
- the job's inputs (prompt, references, connection) are deliberately not persisted;
- the providers offer no resumable job handles.

Re-running a job silently could double-charge you or produce a different image. So an interrupted job is reported, and you decide whether to run it again.

**Announcing results.** A finished job that nobody has seen yet is announced if it finished before the page loaded, or while the tab was hidden or offline. The client then posts `/seen` with `recovered: true`, which logs `recovered` (`stage: "client-reattach"`). A job that finished while you were watching is stamped silently (`recovered: false`), so it is never announced later. Each job is announced once. The rules are in `packages/client/src/lib/generation-job-tracking.ts` (`partitionFinishedJobs`).

## What is persisted, and where

| Data                                                                                              | Where                                                                                                | Written when               |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------- |
| Job metadata and result JSON                                                                      | `DATA_DIR/generation-jobs/`                                                                          | Always (existing behavior) |
| Job record: status, timestamps, `elapsedMs`, `errorCode`, `errorId`, `resultRef`, `seenAt`, trail | `generation_job_records` table (`DATA_DIR/storage/tables/generation_job_records/`, one file per job) | Only while tracking is on  |
| The setting                                                                                       | `app_settings`, key `generationJobTracking`                                                          | When you change it         |

`resultRef` is the first same-origin asset path in the result, such as `/api/gallery/...`. Otherwise it points to the store's `/api/generation-jobs/:id/result` route. Data URLs and remote URLs are never stored.

The table is registered in:

- `db/schema/index.ts`;
- `FILE_BACKED_TABLES`, with primary-key shards (always resident, because `chatId` can be null);
- the `chats` cascade;
- `scripts/protect-launcher-data.mjs`;
- the admin "clear chats" expunge.

## Retention, cleanup and limits

- Finished records are removed 7 days after their last update. Each retention pass keeps only the newest 300 finished records, so between passes there can briefly be more.
- Unfinished records are never expired. Stale ones are reconciled first.
- The retention pass runs at startup, when tracking is turned on, and every hour on an unref'd timer. The timer exists only while tracking is on. The pass never throws. Each removal logs `state: "expired"`.
- Deleting a chat deletes its records through the cascade. If a job of that chat is still running, its later updates do not bring the record back. Records without a chat (character drafts and sprites) go through retention.
- The store's own retention is separate and unchanged: 200 metadata files, 50 result files, and nothing younger than 24 h is pruned. A record can therefore outlive its result file. In that case the viewer has no result to show.
- Turning tracking off stops new records and retention. Existing records stay until tracking is turned back on and retention removes them, or until their chat is deleted. Jobs already being tracked when you turn it off still finish their records.
- Other limits:
  - the list route returns at most 200 records (the client asks for 100);
  - `/seen` accepts at most 100 ids;
  - the trail holds 40 events;
  - progress heartbeats come every 30 s.
- Client polling, only while tracking is on: the top bar dot, the recovery host and the viewer share one list query. It refetches every 3 s while a tracked job runs and every 30 s otherwise, pauses while the tab is hidden, and refetches when the window regains focus or the connection comes back.

## Routes

All routes are under `/api/generation-job-records`. While tracking is off, every one except `/settings` returns the standard 404.

| Method and path        | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `GET /settings`        | `{ enabled, retentionDays, maxRecords }`                            |
| `PUT /settings`        | `{ enabled: boolean }`                                              |
| `GET /?chatId=&limit=` | `{ records }`, newest first, without trails                         |
| `GET /:id`             | One record, with its `trail`                                        |
| `GET /:id/trail`       | `{ jobId, trail }`, for support lookups                             |
| `POST /seen`           | `{ ids, recovered? }`: stamps finished jobs that a client has shown |

Cancelling a job and fetching its full result still use `/api/generation-jobs/:id/cancel` and `/api/generation-jobs/:id/result`.

## Tests

`scripts/regressions/generation-job-tracking.regression.ts` covers:

- table wiring;
- the pure helpers;
- setting off (byte-identical responses, no table writes, no lifecycle log lines, no retention timer);
- persistence and progress;
- completion with no client connected;
- client reattach;
- server-restart reconcile;
- cancel, including a cancel racing the settle (one `settled` event, after the cancelled status is saved);
- a chat deleted while its job still runs;
- log redaction;
- retention with an unref'd timer, and failure safety;
- a throwing observer.

`scripts/regressions/generation-jobs-ui.browser.regression.mjs` checks that the viewer is unchanged while tracking is off.

## Related guides

- [Logging (Developers)](logging.md)
- [File-Native Storage (Developers)](file-storage.md)
- [Architecture Map](architecture-map.md)

# Design Decisions

Trade-offs made while building this system, written down so a reviewer doesn't have to reverse-engineer _why_ from the code alone.

## ORM: TypeORM over Prisma

TypeORM's `EntityManager`/`QueryRunner` and `.setLock('pessimistic_write')` map directly onto the row-locking that inventory consumption and work-order completion need, with first-class NestJS support (`@nestjs/typeorm`). Migrations are CLI-driven and `synchronize: false` from the first migration. The schema's source of truth is the migration history in `backend/src/database/migrations/`, never runtime entity reflection.

**In practice:** the completion transaction and the inventory-locking transaction both use `this.dataSource.transaction(async (manager) => { ... })` rather than manually instantiating a `QueryRunner`. `DataSource.transaction()` manages a `QueryRunner` internally and hands you its `EntityManager`: same atomicity and locking guarantee, less boilerplate to get wrong. The pessimistic lock itself is explicit: `manager.createQueryBuilder(SparePart, 'part').setLock('pessimistic_write').where(...)`.

## Pessimistic row locking over optimistic/version-column concurrency

Every write to `spare_parts.quantity_on_hand` (consume, restock, or adjust) locks that row with `SELECT ... FOR UPDATE` before reading or writing the quantity. This serializes all writes to a given part at the database level, regardless of which code path triggered them. That's what actually prevents a double-spend, not an `if (stock > 0)` check in application code, which is itself a race under concurrency.

Optimistic (version-column) concurrency was the alternative. Pessimistic locking was chosen because it's simpler to reason about and simpler to prove correct with a deterministic test for the canonical race (stock = 1, two concurrent consumers). Optimistic concurrency would require a retry loop on version conflict, which adds a second thing to get right and test.

## The audit module was built before the modules that depend on it

The brief's own suggested order places a general audit ledger after maintenance and inventory. This build built it first instead, because work-order completion needs to write an audit entry _inside its own transaction_ as one of several atomic side effects. Building the ledger after the modules that call it would have meant retrofitting every write path once it existed. The ledger is append-only, protected by both a `REVOKE UPDATE, DELETE` grant and a `BEFORE UPDATE OR DELETE` trigger on `audit_logs`, so no later code path, however it's written, can mutate history.

## `maintenance_history` is a derived query, not a stored table

A completed work order already _is_ a maintenance history record. A separate `maintenance_history` table would duplicate the same facts and create a second source of truth that could drift from the first. Instead, `GET /work-orders?assetId=&status=COMPLETED` (filters already present on the work-orders list endpoint) _is_ the maintenance history for an asset. This is a deliberate scope decision, documented here rather than left implicit.

## Duplicate auto-generated work orders are prevented at the database level

The condition-monitoring rule checks for an existing open `AUTO` work order before creating a new one, but a check-then-insert is itself a race under real concurrency: two worker jobs evaluating the same asset at nearly the same instant could both pass the check before either inserts. The actual safety net is a Postgres partial unique index:

```sql
CREATE UNIQUE INDEX "IDX_work_orders_one_open_auto_per_asset"
ON "work_orders" ("asset_id")
WHERE "status" IN ('OPEN','ASSIGNED','IN_PROGRESS','BLOCKED')
  AND "source" = 'AUTO'
```

Two open auto-generated work orders for the same asset are structurally impossible, not just unlikely.

## Telemetry is inserted directly; only a failed insert goes through a queue

A valid telemetry reading does three things on ingest: persist a row in `telemetry_readings`, write the "latest" value to Redis, and enqueue a `telemetry-processing` job for the condition-monitoring worker. The insert is a direct call inside the MQTT handler, not a queue hop: it's just an insert, not an analysis step, and queueing every reading a second time would be complexity without a benefit at this scale. The composite index `telemetry_readings(asset_id, recorded_at DESC)` keeps the realistic "recent readings for this asset" query fast without it.

**Why a failed insert cannot just be logged and dropped (BJM-2).** MQTT.js acknowledges a QoS 1 message (PUBACK) right after emitting it, without waiting for the async Nest handler. By the time the insert runs the broker already considers the message delivered and will never redeliver it, so the handler is the reading's only chance. Logging a Postgres failure and returning (the original behaviour) turned any connection reset, failover, pool exhaustion or restart into permanent data loss: about 60 readings per asset per minute at 1 Hz, and condition monitoring (which reads only `telemetry_readings`) blind for the whole window.

**What happens now.** Insert errors are classified (`telemetry-persist-error.ts`):

| Error                                                                                  | Treatment                                                                 |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| FK violation `23503` (unknown asset)                                                   | Dropped with a warning: retrying can never help.                          |
| Other data / integrity errors (SQLSTATE class `22`, `23`)                              | Dropped with an error that includes the payload: the row can never fit.   |
| Unique violation `23505` on the reading id                                             | Treated as success: an earlier attempt already stored this exact reading. |
| Everything else (connection errors, `08*`, `53*`, `57P0x`, `25006`, timeouts, unknown) | Transient: handed to the durable `telemetry-persistence` queue.           |

The default for an unrecognised error is "transient": retrying a reading too often costs a little, losing one costs data.

A transient failure moves the reading straight into the `telemetry-persistence` BullMQ queue (Redis), so it survives a restart of the backend. `TelemetryPersistenceProcessor` re-inserts it with capped exponential backoff (1 s doubling to 30 s, +/-20% jitter, 1000 attempts, roughly 8 hours) and only then does what a live reading does after its insert: updates the "latest" cache (never overwriting a newer reading with a replayed older one) and enqueues the condition-monitoring job. A reading that Postgres rejects for good fails without retries; one that exhausts its retries stays in the failed set for 7 days (up to 100 000 jobs) and is logged with its full payload.

**Idempotency.** The reading's primary key is generated once at ingest and carried in the job, and the queue job id is that same id. A retry after an ambiguous failure (the commit succeeded, the connection died before the acknowledgement) therefore hits the primary key instead of storing a duplicate, and a retried hand-off cannot enqueue the same reading twice. No migration is needed.

**Remaining limits, stated plainly.** The reading is only lost if Postgres _and_ Redis are unreachable at the same moment: the hand-off to Redis is retried and time-boxed, then fails loudly (`TelemetryNotPersistedError`, logged with the full payload). The process crashing in the few milliseconds between PUBACK and the hand-off is the one window a PUBACK deferred until the reading is stored would close; that is still not done. The persistent session (BJM-3, below) covers a different gap: readings published while the backend is not connected at all. Redis runs with `noeviction`, so an outage of many hours at fleet scale is bounded by Redis memory, not by the retry window.

`backend/test/telemetry-persistence-recovery.e2e-spec.ts` runs against a real Redis and BullMQ (Postgres is a controllable fake) and covers an outage that outlasts several retries, a process restart mid-outage, an ambiguous commit, and an unknown asset.

**What would change at real production scale:** monthly partitioning of `telemetry_readings`, explicitly out of scope here but called out rather than silently ignored.

## The backend's MQTT session is persistent (BJM-3)

**The problem.** The subscription asked for QoS 1, but the connection used MQTT.js's defaults: a random client id and `clean: true`. The broker therefore created a fresh session on every connect and discarded it on disconnect, so QoS 1 had nothing to attach to. Every reading published while the backend was restarting, crashing or cut off from the broker was dropped by the broker: 10-60+ readings per asset per deploy, and condition monitoring blind for that period.

**The fix.** The backend connects with a fixed client id (`maintelic-backend`, overridable with `MQTT_BACKEND_CLIENT_ID`) and `clean: false` (`mqtt-connection-options.ts`). The broker keeps the subscription and queues QoS 1 messages for that id while the backend is away, and delivers them when it reconnects. MQTT.js refuses `clean: false` without a client id, and a blank override falls back to the default so the id can never end up empty. If the broker ever loses the session, MQTT.js re-subscribes on reconnect (it sees `sessionPresent=false`), so the backend does not end up connected but deaf.

**Three changes that make the persistent session actually deliver.** The client options alone were not enough:

| Change                                                                                                                   | Why                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker/mosquitto.conf`: `max_queued_messages 100000`                                                                    | The default is 1000 per offline client, under 4 minutes of telemetry at 5 readings/s, and Mosquitto drops the _newest_ messages beyond it. 100000 is about 5.5 hours at that rate; raise it with the fleet. |
| `docker/mosquitto.conf`: `autosave_interval 30`, `persistent_client_expiration 1d`                                       | Queued state is written to disk every 30 s instead of every 30 minutes, and a session nobody returns to is forgotten after a day.                                                                           |
| `recordedAt` window is asymmetric: 5 minutes ahead (`RECORDED_AT_FUTURE_TOLERANCE_MS`), 24 hours behind (`..._PAST_...`) | The controller used to reject anything more than 5 minutes off the clock, which would have discarded the replayed backlog after any outage longer than that. A forged _future_ timestamp is still rejected. |

**Replay is concurrent, so the "latest" cache write is ordered.** The backlog, the live readings that follow it and the persistence worker's replays all run at once. The cache write now never replaces a newer reading with an older one, and writes for one asset are chained so two of them cannot interleave (read "empty", read "empty", write new, write old). Condition monitoring is unaffected: it reads the newest rows from Postgres, not the cache or the arrival order.

**Tests.** `mqtt-persistent-session.e2e-spec.ts` runs Nest's real MQTT server with the production options against the broker: backlog delivered in order after a restart, repeated outages, a backlog larger than 1000, and a clean-session control that shows the loss this fixes. `telemetry-offline-replay.e2e-spec.ts` runs the whole app: stop it, publish (including readings older than the old 5-minute window), restart it, and expect every row in Postgres and the newest as "latest". Other e2e suites use a unique client id and a clean session per app (`test/utils/mqtt.ts`) so they do not inherit each other's queues.

**Remaining limits, stated plainly.**

- **One backend instance per client id.** Two connections with the same id make the broker disconnect the older one, and they then keep taking the connection from each other. A rolling deploy with overlapping instances would flap. Running several instances needs a distinct `MQTT_BACKEND_CLIENT_ID` each (and then each receives every reading), or shared subscriptions, which are not used.
- **A broker crash loses at most the last 30 seconds of queued state** (the autosave interval). A clean broker restart, or a crash after an autosave, loses nothing; both were tested.
- **Outage bounds.** Readings are kept for at most one day (`persistent_client_expiration`, matching the 24 h `recordedAt` window) and at most 100000 queued messages; beyond that the broker drops the newest.
- The PUBACK is still sent before the handler finishes (see BJM-2), so a backend crash mid-handler can still lose the message it was handling.

## NestJS pinned to the 11.x line

NestJS shipped a new major version as pure ESM (`"type": "module"`) partway through this build. `ts-jest`/Jest (CommonJS) can't load it: `npm test` failed outright with `Must use import to load ES Module`, confirmed directly by running the as-committed test suite against the newer version. Migrating to ESM + Vitest mid-build was rejected as an unplanned stack change with no functional benefit to this project; pinning `@nestjs/*` packages to their last CommonJS-compatible release (the `11.x` line) kept every already-working tooling decision (Jest, `ts-jest`, `oxlint`) valid. The one real casualty of the downgrade was `RedisHealthIndicator`, which used a builder API (`.attempt()/.withTimeout()`) only present on the newer line. It was rewritten against the stable `HealthIndicatorSession` API (`.up()`/`.down()`) with a small hand-rolled `Promise.race` standing in for `.withTimeout()`.

**For the record:** NestJS's own newer scaffolding now defaults _new_ projects to ESM + Vitest for exactly this reason; a rebuild of this project from scratch today might reasonably start there instead of pinning back.

## Repository layout: one repo, three top-level folders

`backend/` (NestJS), `simulator/` (Node.js/TypeScript), `docs/`, rather than separate repositories. Easier for a reviewer to clone once and understand the whole system as one piece, and there's no independent deployment or versioning need that would justify splitting them.

## Simulator: Node.js/TypeScript, not C++

MQTT is what does the architectural work here: decoupled pub/sub, a realistic industrial protocol, an independent process publishing readings. The publisher's implementation language doesn't change any of that. A Node.js/TypeScript simulator matches the rest of the repo's tooling (npm, `tsc`, one Docker base-image family instead of two) and needs no separate build-stage ceremony. The genuine reasons to reach for C++ (real-time constraints, direct hardware access, tight memory limits) don't apply to a simulator publishing synthetic readings from inside a dev container, so this trade cost nothing architecturally while saving real setup time.

## AI diagnostic notes: isolated from everything that's tested for correctness

The AI-generated diagnostic note attached to auto-created work orders and notifications uses Groq's free, OpenAI-compatible `chat/completions` endpoint. Several choices keep this free, rate-limited, third-party dependency from ever being able to affect correctness:

- The call happens **before** the enclosing database transaction opens, using data already fetched for the rule check: an LLM round-trip can take seconds, and holding a Postgres transaction open for that long for a non-critical enrichment would be a bad trade.
- The result is wrapped in a hard timeout (`Promise.race` against a timer) with **one attempt and a silent `null` fallback** on any failure: timeout, non-200, malformed response. No retry queue, no BullMQ job for this; that would be real complexity for a feature explicitly allowed to fail.
- The note is stored in a **new, separate nullable column** (`ai_note`) on both `work_orders` and `notifications`, never appended to the existing `description`/`message` text those tables already write and already have tests asserting on.

* It's **off by default** (`AI_INSIGHTS_ENABLED=false`), so cloning the repo, running the suite, or working on any unrelated part of the system never requires a Groq key.
* The model is configurable via `GROQ_MODEL`. The current configuration uses `openai/gpt-oss-20b`; if `GROQ_MODEL` is unset, the code falls back to `llama-3.1-8b-instant`.

The deterministic rule in condition monitoring always decides whether an alert fires and what status it sets; the AI only ever attaches commentary after that decision is already made.

## Finished queue jobs are bounded (BJM-1)

Every accepted telemetry reading enqueues a `telemetry-processing` job. BullMQ keeps a finished job (hash plus an entry in the `completed`/`failed` sorted set) indefinitely unless told otherwise, so at the simulator's rate (about 432k readings a day) Redis grew without limit until it ran out of memory, at which point `redis.set`/`queue.add` in `ingest()` failed silently and condition monitoring stopped.

Retention is now configured in one place, `backend/src/common/queue/job-retention.ts`:

- **Completed jobs:** kept at most 1 hour and at most 100 jobs. They carry no value once processed.
- **Failed jobs:** kept at most 7 days and at most 1000 jobs, so failures stay diagnosable but a failure storm cannot fill Redis.

It is applied three ways: as the root `defaultJobOptions` in `BullModule.forRoot` (so any future queue is bounded by default), as the `telemetry-processing` queue's own `defaultJobOptions` (shared by both modules that register it, via `telemetry-queue.config.ts`), and explicitly on the producer call in `TelemetryService.ingest`.

`TelemetryQueueMaintenanceService` clears the backlog that already exists in Redis from before this fix: once at startup (in the background) and then hourly, it removes finished jobs older than the retention age and the oldest jobs beyond the retention count.

`docker-compose.yml` now starts Redis with `--maxmemory` (default `512mb`, override with `REDIS_MAXMEMORY`) and `--maxmemory-policy noeviction`. `noeviction` is what BullMQ requires: evicting keys would corrupt queue state, so Redis rejects writes instead of dropping data.

`backend/test/telemetry-queue-retention.e2e-spec.ts` runs against a real Redis and checks that completed and failed jobs (and their Redis hashes) stay within the caps, and that a legacy unbounded backlog is cleaned up.

## What would genuinely be done differently with more time

- **TimescaleDB** for `telemetry_readings` if this needed to scale past a portfolio-sized demo: hypertables and native time-series compression would matter once reading volume is large and sustained; out of scope here per the brief.
- **Branch protection** on `main` requiring the CI checks to pass before merge; straightforward to turn on, just not automated as part of this build.
- Partitioning strategy for `telemetry_readings` and `audit_logs` once either grows past a single-node Postgres instance's comfortable working set.

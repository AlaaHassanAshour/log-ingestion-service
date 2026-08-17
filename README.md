# Log Ingestion and Query Service

Fastify + TypeScript + PostgreSQL service for ingesting structured logs, querying them with combinable filters, and aggregating counts into time buckets.

## Setup and Usage

Start the complete system:

```bash
docker compose up --build
```

The API listens on `http://localhost:8080`.

Local development:

```bash
npm install
npm run build
npm test
```

`npm test` requires PostgreSQL to be reachable through `DATABASE_URL`. The default local value is:

```text
postgres://loguser:logpass@localhost:5432/logdb
```

## Required API

### `GET /health`

Returns `200` after the application has connected to PostgreSQL and applied schema setup.

### `POST /logs`

Accepts a batch object. A single log is still sent inside the `logs` array.

```json
{
  "logs": [
    {
      "timestamp": "2026-07-20T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": {
        "user_id": "42",
        "region": "eu-west",
        "retries": 3
      }
    }
  ]
}
```

Response when at least one entry is accepted:

```json
{
  "accepted": 1,
  "rejected": []
}
```

Invalid entries are rejected per entry and do not reject the whole batch. If all entries are rejected, the endpoint returns `400`.

Validation rules:

- `timestamp` is required, must parse as ISO 8601, and cannot be more than five minutes in the future.
- `level` must be `debug`, `info`, `warn`, or `error`.
- `service` and `message` must be non-empty strings.
- `attributes` is optional, must be flat, and values may only be strings, numbers, or booleans.

### `GET /logs`

All filters are optional and freely combinable:

- `service=checkout`
- `level=error`
- `since=2026-07-20T14:00:00Z`
- `until=2026-07-20T15:00:00Z`
- `attr.user_id=42`
- `q=declined`
- `limit=500`
- `cursor=<opaque cursor>`

Results are sorted by `timestamp DESC, id DESC`. The `id` tie-breaker keeps ordering deterministic when multiple logs have the same timestamp.

Response:

```json
{
  "logs": [
    {
      "id": "0e0b8972-bad4-42d6-89e2-49f9167d6f4f",
      "timestamp": "2026-07-20T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": {
        "user_id": "42"
      }
    }
  ],
  "next_cursor": null
}
```

Invalid query parameters return:

```json
{
  "error": "description"
}
```

### `GET /logs/aggregate`

Returns time-bucketed counts. Supports the same filters as `GET /logs`, except `since`, `until`, and `bucket` are required.

Aggregation parameters:

- `since`: inclusive range start
- `until`: exclusive range end
- `bucket`: `1m`, `5m`, `1h`, or `1d`
- `group_by`: optional, `service` or `level`

Example:

```bash
curl "http://localhost:8080/logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z&bucket=1m&group_by=service"
```

Response:

```json
{
  "buckets": [
    {
      "start": "2026-07-20T14:32:00.000Z",
      "group": "checkout",
      "count": 118
    }
  ]
}
```

## Schema and Index Design

The source of truth is PostgreSQL. Logs are stored in a range-partitioned table:

```sql
CREATE TABLE logs (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL,
  level VARCHAR(10) NOT NULL,
  service VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  attributes JSONB,
  PRIMARY KEY (timestamp, id)
) PARTITION BY RANGE (timestamp);
```

Daily partitions are created for the current day and the next two days at startup. A default partition catches data outside those ranges, which keeps ingestion reliable even if a timestamp lands outside the prepared partitions.

Indexes:

- `(service, timestamp DESC)` for service-filtered recent-log queries.
- `(level, timestamp DESC)` for level-filtered recent-log queries.
- `GIN (attributes jsonb_path_ops)` for JSONB attribute storage.
- `GIN (message gin_trgm_ops)` for case-insensitive substring search with `ILIKE`.
- `log_rollups_minute` and `log_rollups_hour` store pre-aggregated counts by bucket, service, and level for the required aggregation endpoint.

## Attribute Storage Strategy

Attributes are stored as `JSONB` because each service can send different keys. The API enforces a flat object with primitive values only. Query filters use `attributes ->> key = value`, so comparisons follow the project requirement: attribute equality is compared as strings.

This keeps ingestion simple and flexible while preserving the option to add expression indexes later for hot attributes such as `user_id`, `request_id`, or `region`.

## Retention Strategy

`RETENTION_DAYS` controls how long partitioned log data is kept. The default is `30`.

The app defines `drop_old_log_partitions(retention_days)` in PostgreSQL and runs a daily in-process retention job. Dropping old daily partitions is preferred over deleting rows one by one because it avoids long delete scans and reduces table bloat.

## Optional Features

Swagger UI is available at:

```text
http://localhost:8080/swagger
```

Authentication, tenancy, and rate limiting are not implemented. With plain `docker compose up`, all required endpoints are unauthenticated and available to the load generator.

Pre-aggregated rollups are enabled by default. They are additive: raw logs remain the source of truth, and aggregation falls back to raw logs when filters require message or attribute-level detail.

## CI

GitHub Actions runs:

- `npm ci`
- `npm run build`
- `npm test`

The test suite exercises the required API contract in the default unauthenticated configuration.

## Performance Testing

Run the included load test against a running service:

```bash
docker compose up --build
npm run load:test
```

Useful knobs:

```bash
LOAD_TEST_TOTAL=1000000
LOAD_TEST_BATCH_SIZE=1000
LOAD_TEST_CONCURRENCY=20
LOAD_TEST_BASE_URL=http://localhost:8080
LOAD_TEST_OUTPUT=load-results.json
```

The script ingests logs through `POST /logs`, sends one aggregation request per second during ingestion, and writes measured ingestion throughput plus aggregation p50/p95/p99 to `load-results.json`.

Measured local run:

- Test date: 2026-08-17
- Environment: Windows x64 host, Docker Compose app + PostgreSQL, Node.js v24.13.0 for the load generator
- Dataset: 1,000,000 generated logs spanning 30 days
- Batch size: 1,000 logs
- Concurrency: 20 ingestion workers
- Aggregation query rate: 1 request per second during ingestion
- Aggregation query: `bucket=1h&group_by=service` over the full 30-day range
- Accepted logs: 1,000,000
- Dropped/failed ingestion batches: 0
- Ingestion duration: 199.75 seconds
- Ingestion rate: 5,006.37 logs/sec
- Batch latency: p50 3,806.11 ms, p95 5,998.59 ms, p99 7,718.99 ms, max 10,376.81 ms
- Aggregation samples: 53 successful, 0 failed
- Aggregation latency: p50 1,210.20 ms, p95 11,694.08 ms, p99 15,177.81 ms, max 15,177.81 ms

Bottlenecks and optimizations:

- Initial raw-table aggregation over 1,000,000 rows measured p95 3,096.08 ms, which missed the 1 second target.
- Adding minute rollups reduced aggregation p95 to 1,045.57 ms.
- Adding hour rollups reduced aggregation p95 to 784.97 ms for the primary 1-hour aggregation query.
- Ingestion throughput is below the 15,000 logs/sec target in this local environment. The main write-side cost is maintaining raw-log indexes plus minute/hour rollup upserts on every batch.

## Known Limitations

- Daily partitions are prepared for the previous 30 days through the next two days; far-future accepted timestamps go to the default partition.
- Rollups accelerate service/level time-bucket aggregations, but queries with `q` or `attr.<key>` fall back to raw logs for correctness.
- No authentication optional mode is implemented.
- Local ingestion throughput did not reach the 15,000 logs/sec target. Next improvements would be COPY-based ingestion, fewer write-time indexes, asynchronous rollup workers, or partition-local tuning.

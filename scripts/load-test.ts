import process from 'process';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LoadConfig = {
  baseUrl: string;
  totalLogs: number;
  batchSize: number;
  concurrency: number;
  aggregateIntervalMs: number;
  outputPath: string;
  apiKey?: string;
};

type AggregateSample = {
  status: number;
  latencyMs: number;
  bucketCount?: number;
  error?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const services = ['checkout', 'auth', 'payments', 'search', 'orders'];
const regions = ['us-east', 'eu-west', 'ap-south'];

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function config(): LoadConfig {
  return {
    baseUrl: process.env.LOAD_TEST_BASE_URL ?? 'http://localhost:8080',
    totalLogs: numberEnv('LOAD_TEST_TOTAL', 1_000_000),
    batchSize: numberEnv('LOAD_TEST_BATCH_SIZE', 1000),
    concurrency: numberEnv('LOAD_TEST_CONCURRENCY', 20),
    aggregateIntervalMs: numberEnv('LOAD_TEST_AGGREGATE_INTERVAL_MS', 1000),
    outputPath: process.env.LOAD_TEST_OUTPUT ?? 'load-results.json',
    apiKey: process.env.LOAD_TEST_API_KEY ?? process.env.LOADGEN_API_KEY,
  };
}

function percentile(values: number[], p: number) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[index].toFixed(2));
}

function headers(cfg: LoadConfig) {
  const result: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (cfg.apiKey) {
    result.authorization = `Bearer ${cfg.apiKey}`;
  }

  return result;
}

function makeLog(index: number, startMs: number, spanMs: number) {
  const timestamp = new Date(startMs + (index % spanMs)).toISOString();
  const service = services[index % services.length];
  const level = levels[index % levels.length];
  const userId = String(index % 100_000);
  const requestId = `req-${index}`;
  const region = regions[index % regions.length];

  return {
    timestamp,
    level,
    service,
    message: `${service} ${level} load test event ${index}`,
    attributes: {
      user_id: userId,
      request_id: requestId,
      region,
      shard: index % 32,
      sampled: index % 10 === 0,
    },
  };
}

async function waitForHealth(baseUrl: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the service is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`service did not become healthy at ${baseUrl}/health`);
}

async function postBatch(cfg: LoadConfig, startIndex: number, count: number, startMs: number, spanMs: number) {
  const logs = Array.from({ length: count }, (_, offset) => makeLog(startIndex + offset, startMs, spanMs));
  const started = performance.now();
  const response = await fetch(`${cfg.baseUrl}/logs`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify({ logs }),
  });
  const latencyMs = performance.now() - started;
  const body = await response.json().catch(() => ({}));

  if (!response.ok || body.accepted !== count) {
    throw new Error(`batch failed status=${response.status} accepted=${body.accepted ?? 'unknown'} body=${JSON.stringify(body)}`);
  }

  return latencyMs;
}

async function sampleAggregate(cfg: LoadConfig, since: string, until: string): Promise<AggregateSample> {
  const url = new URL('/logs/aggregate', cfg.baseUrl);
  url.searchParams.set('since', since);
  url.searchParams.set('until', until);
  url.searchParams.set('bucket', '1h');
  url.searchParams.set('group_by', 'service');

  const started = performance.now();
  const response = await fetch(url, { headers: headers(cfg) });
  const latencyMs = performance.now() - started;
  const body = await response.json().catch(() => ({}));

  return {
    status: response.status,
    latencyMs,
    bucketCount: Array.isArray(body.buckets) ? body.buckets.length : undefined,
    error: response.ok ? undefined : JSON.stringify(body),
  };
}

async function runIngestion(cfg: LoadConfig, startMs: number, spanMs: number) {
  let nextIndex = 0;
  let accepted = 0;
  const batchLatencies: number[] = [];

  async function worker() {
    while (nextIndex < cfg.totalLogs) {
      const startIndex = nextIndex;
      const count = Math.min(cfg.batchSize, cfg.totalLogs - startIndex);
      nextIndex += count;
      const latency = await postBatch(cfg, startIndex, count, startMs, spanMs);
      batchLatencies.push(latency);
      accepted += count;
    }
  }

  const started = performance.now();
  await Promise.all(Array.from({ length: cfg.concurrency }, () => worker()));
  const durationSeconds = (performance.now() - started) / 1000;

  return {
    accepted,
    durationSeconds: Number(durationSeconds.toFixed(2)),
    ingestionRateLogsPerSecond: Number((accepted / durationSeconds).toFixed(2)),
    batchLatencyMs: {
      p50: percentile(batchLatencies, 50),
      p95: percentile(batchLatencies, 95),
      p99: percentile(batchLatencies, 99),
      max: batchLatencies.length ? Number(Math.max(...batchLatencies).toFixed(2)) : null,
    },
  };
}

async function main() {
  const cfg = config();
  const untilDate = new Date();
  const sinceDate = new Date(untilDate.getTime() - 30 * DAY_MS);
  const since = sinceDate.toISOString();
  const until = untilDate.toISOString();
  const spanMs = untilDate.getTime() - sinceDate.getTime();

  console.log(`Load test target: ${cfg.baseUrl}`);
  console.log(`Total logs=${cfg.totalLogs}, batch=${cfg.batchSize}, concurrency=${cfg.concurrency}`);

  await waitForHealth(cfg.baseUrl);

  const aggregateSamples: AggregateSample[] = [];
  let aggregating = true;
  const aggregateLoop = (async () => {
    while (aggregating) {
      aggregateSamples.push(await sampleAggregate(cfg, since, until));
      await new Promise((resolve) => setTimeout(resolve, cfg.aggregateIntervalMs));
    }
  })();

  const ingestion = await runIngestion(cfg, sinceDate.getTime(), spanMs);
  aggregating = false;
  await aggregateLoop;

  const finalAggregate = await sampleAggregate(cfg, since, until);
  aggregateSamples.push(finalAggregate);

  const aggregateLatencies = aggregateSamples.filter((sample) => sample.status === 200).map((sample) => sample.latencyMs);
  const failedAggregates = aggregateSamples.filter((sample) => sample.status !== 200);

  const result = {
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      baseUrl: cfg.baseUrl,
    },
    config: {
      totalLogs: cfg.totalLogs,
      batchSize: cfg.batchSize,
      concurrency: cfg.concurrency,
      aggregateIntervalMs: cfg.aggregateIntervalMs,
      authHeaderSent: Boolean(cfg.apiKey),
      since,
      until,
    },
    ingestion,
    aggregation: {
      samples: aggregateSamples.length,
      successfulSamples: aggregateLatencies.length,
      failedSamples: failedAggregates.length,
      p50Ms: percentile(aggregateLatencies, 50),
      p95Ms: percentile(aggregateLatencies, 95),
      p99Ms: percentile(aggregateLatencies, 99),
      maxMs: aggregateLatencies.length ? Number(Math.max(...aggregateLatencies).toFixed(2)) : null,
      finalBucketCount: finalAggregate.bucketCount,
      failures: failedAggregates.slice(0, 5),
    },
  };

  await import('fs/promises').then((fs) => fs.writeFile(cfg.outputPath, `${JSON.stringify(result, null, 2)}\n`));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

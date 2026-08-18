import { Readable } from 'stream';
import { finished } from 'stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { writePool } from './index.js';

type AttributeValue = string | number | boolean;

export type LogCommand = {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  service: string;
  message: string;
  attributes: Record<string, AttributeValue>;
};

const COPY_BATCH_THRESHOLD = Number(process.env.COPY_BATCH_THRESHOLD ?? 100);

function copyValue(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function copyLine(log: LogCommand) {
  return [
    copyValue(log.timestamp),
    copyValue(log.level),
    copyValue(log.service),
    copyValue(log.message),
    copyValue(JSON.stringify(log.attributes)),
    'false',
  ].join('\t');
}

function* copyLines(logs: LogCommand[]) {
  for (const log of logs) {
    yield `${copyLine(log)}\n`;
  }
}

export async function ingestLogsWithCopy(logs: LogCommand[]) {
  if (logs.length === 0) {
    return;
  }

  if (logs.length < COPY_BATCH_THRESHOLD) {
    await ingestSmallBatch(logs);
    return;
  }

  const client = await writePool.connect();
  try {
    const copyStream = client.query(
      copyFrom(
        `COPY logs (timestamp, level, service, message, attributes, rollup_processed)
         FROM STDIN WITH (FORMAT text)`,
      ),
    );
    const input = Readable.from(copyLines(logs));
    input.pipe(copyStream);
    await finished(copyStream);
  } finally {
    client.release();
  }
}

async function ingestSmallBatch(logs: LogCommand[]) {
  const values: unknown[] = [];
  const tuples = logs.map((log, index) => {
    const offset = index * 5;
    values.push(log.timestamp, log.level, log.service, log.message, JSON.stringify(log.attributes));
    return `($${offset + 1}::timestamptz, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}::jsonb, false)`;
  });

  const client = await writePool.connect();
  try {
    await client.query(
      `INSERT INTO logs (timestamp, level, service, message, attributes, rollup_processed)
       VALUES ${tuples.join(', ')}`,
      values,
    );
  } finally {
    client.release();
  }
}

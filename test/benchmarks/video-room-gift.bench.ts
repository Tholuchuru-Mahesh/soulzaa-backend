/**
 * VR-10 gift engine performance validation.
 *
 * Run MANUALLY against a real stack — real PostgreSQL, real Redis, real BullMQ:
 *
 *   npx ts-node -r tsconfig-paths/register test/benchmarks/video-room-gift.bench.ts
 *
 * This is deliberately NOT a Jest spec. The integration suite mocks Prisma,
 * Redis and BullMQ, so an `expect(elapsed).toBeLessThan(100)` there would
 * measure mock-call overhead — it would pass at ~1 ms whether or not the real
 * system meets the target, and go flaky on loaded CI. Latency targets are only
 * meaningful against real I/O.
 *
 * Exits non-zero if any starred target in the design spec (§13) is missed, so
 * it can gate a release pipeline.
 *
 * PREREQUISITES
 *   - DATABASE_URL / REDIS_URL point at a disposable environment
 *   - A seeded gift catalog, a LIVE video room, and a funded sender wallet
 *   - Set the ids below via env, or edit SCENARIO
 */

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { VideoRoomGiftTarget } from '../../src/modules/video-rooms/dto/send-video-room-gift.dto';
import { VideoRoomGiftService } from '../../src/modules/video-rooms/services/video-room-gift.service';

/** Targets from the design spec §13. A miss exits non-zero. */
const TARGETS = {
  singleReceiverP95Ms: 100,
  multiReceiverP95Ms: 300,
  queueDeliveryP95Ms: 1_000,
  replaySuccessRate: 0.999,
};

const SCENARIO = {
  roomId: process.env.BENCH_ROOM_ID ?? '',
  senderId: process.env.BENCH_SENDER_ID ?? '',
  giftId: process.env.BENCH_GIFT_ID ?? '',
  receiverId: process.env.BENCH_RECEIVER_ID ?? '',
  warmupSends: Number(process.env.BENCH_WARMUP ?? 200),
  singleSends: Number(process.env.BENCH_SINGLE ?? 1_000),
  batchSends: Number(process.env.BENCH_BATCH ?? 500),
};

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

interface Row {
  label: string;
  p50: number;
  p95: number;
  p99: number;
  target: number | null;
  pass: boolean;
}

function summarise(label: string, samples: number[], target: number | null): Row {
  const p95 = percentile(samples, 95);
  return {
    label,
    p50: percentile(samples, 50),
    p95,
    p99: percentile(samples, 99),
    target,
    pass: target === null || p95 <= target,
  };
}

/** Time one call, returning milliseconds. */
async function timed(fn: () => Promise<unknown>): Promise<number> {
  const startedAt = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

async function measureSends(
  gifts: VideoRoomGiftService,
  count: number,
  target: VideoRoomGiftTarget,
  receiverId?: string,
): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < count; i += 1) {
    samples.push(
      await timed(() =>
        gifts.send({ id: SCENARIO.senderId, roles: ['USER'] } as never, SCENARIO.roomId, {
          giftId: SCENARIO.giftId,
          target,
          receiverId,
          quantity: 1,
          // A distinct key per iteration; a shared key would measure the
          // idempotent-replay path instead of a real send.
          idempotencyKey: `bench:${target}:${i}:${process.pid}`,
        } as never),
      ),
    );
  }
  return samples;
}

function render(rows: Row[]): void {
  const pad = (value: string, width: number) => value.padEnd(width);
  console.log('');
  console.log(
    `${pad('metric', 38)}${pad('p50', 10)}${pad('p95', 10)}${pad('p99', 10)}${pad('target', 10)}result`,
  );
  console.log('-'.repeat(90));
  for (const row of rows) {
    console.log(
      pad(row.label, 38) +
        pad(`${row.p50.toFixed(1)}ms`, 10) +
        pad(`${row.p95.toFixed(1)}ms`, 10) +
        pad(`${row.p99.toFixed(1)}ms`, 10) +
        pad(row.target === null ? '—' : `${row.target}ms`, 10) +
        (row.pass ? 'PASS' : 'FAIL'),
    );
  }
  console.log('');
}

async function main(): Promise<void> {
  const missing = Object.entries(SCENARIO)
    .filter(([key, value]) => typeof value === 'string' && !value && key !== 'receiverId')
    .map(([key]) => key);
  if (missing.length > 0) {
    console.error(
      `Missing scenario ids: ${missing.join(', ')}. ` +
        'Set BENCH_ROOM_ID, BENCH_SENDER_ID, BENCH_GIFT_ID (and BENCH_RECEIVER_ID).',
    );
    process.exit(2);
  }

  let app: INestApplicationContext | undefined;
  try {
    app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    const gifts = app.get(VideoRoomGiftService);

    console.log(`warming up (${SCENARIO.warmupSends} sends)…`);
    await measureSends(
      gifts,
      SCENARIO.warmupSends,
      VideoRoomGiftTarget.SINGLE,
      SCENARIO.receiverId,
    );

    console.log(`measuring single-receiver (${SCENARIO.singleSends} sends)…`);
    const single = await measureSends(
      gifts,
      SCENARIO.singleSends,
      VideoRoomGiftTarget.SINGLE,
      SCENARIO.receiverId,
    );

    console.log(`measuring SEAT_ALL (${SCENARIO.batchSends} sends)…`);
    const batch = await measureSends(gifts, SCENARIO.batchSends, VideoRoomGiftTarget.SEAT_ALL);

    const rows = [
      summarise('POST /send (single receiver)', single, TARGETS.singleReceiverP95Ms),
      summarise('POST /send (SEAT_ALL, max)', batch, TARGETS.multiReceiverP95Ms),
    ];
    render(rows);

    console.log(
      'NOT YET MEASURED — these need a socket subscriber and a seeded DLQ, and are the\n' +
        'next thing to add here:\n' +
        `  • commit -> giftAnimation broadcast (target p95 < ${TARGETS.queueDeliveryP95Ms}ms)\n` +
        `  • DLQ replay success rate (target > ${TARGETS.replaySuccessRate * 100}%)\n`,
    );

    const failed = rows.filter((row) => !row.pass);
    if (failed.length > 0) {
      console.error(`FAILED targets: ${failed.map((row) => row.label).join(', ')}`);
      console.error(
        'Legitimate levers: pipeline the pre-flight Redis calls, reduce lock round-trips.\n' +
          'NOT a lever: moving work into or out of the transaction to shave milliseconds —\n' +
          'that trades the ACID guarantee this design is built on for a latency number.',
      );
      process.exit(1);
    }
    console.log('All measured targets met.');
  } finally {
    await app?.close();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

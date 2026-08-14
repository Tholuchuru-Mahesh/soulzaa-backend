"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const app_module_1 = require("../../src/app.module");
const send_video_room_gift_dto_1 = require("../../src/modules/video-rooms/dto/send-video-room-gift.dto");
const video_room_gift_service_1 = require("../../src/modules/video-rooms/services/video-room-gift.service");
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
function percentile(samples, p) {
    if (samples.length === 0)
        return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[index];
}
function summarise(label, samples, target) {
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
async function timed(fn) {
    const startedAt = process.hrtime.bigint();
    await fn();
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}
async function measureSends(gifts, count, target, receiverId) {
    const samples = [];
    for (let i = 0; i < count; i += 1) {
        samples.push(await timed(() => gifts.send({ id: SCENARIO.senderId, roles: ['USER'] }, SCENARIO.roomId, {
            giftId: SCENARIO.giftId,
            target,
            receiverId,
            quantity: 1,
            idempotencyKey: `bench:${target}:${i}:${process.pid}`,
        })));
    }
    return samples;
}
function render(rows) {
    const pad = (value, width) => value.padEnd(width);
    console.log('');
    console.log(`${pad('metric', 38)}${pad('p50', 10)}${pad('p95', 10)}${pad('p99', 10)}${pad('target', 10)}result`);
    console.log('-'.repeat(90));
    for (const row of rows) {
        console.log(pad(row.label, 38) +
            pad(`${row.p50.toFixed(1)}ms`, 10) +
            pad(`${row.p95.toFixed(1)}ms`, 10) +
            pad(`${row.p99.toFixed(1)}ms`, 10) +
            pad(row.target === null ? '—' : `${row.target}ms`, 10) +
            (row.pass ? 'PASS' : 'FAIL'));
    }
    console.log('');
}
async function main() {
    const missing = Object.entries(SCENARIO)
        .filter(([key, value]) => typeof value === 'string' && !value && key !== 'receiverId')
        .map(([key]) => key);
    if (missing.length > 0) {
        console.error(`Missing scenario ids: ${missing.join(', ')}. ` +
            'Set BENCH_ROOM_ID, BENCH_SENDER_ID, BENCH_GIFT_ID (and BENCH_RECEIVER_ID).');
        process.exit(2);
    }
    let app;
    try {
        app = await core_1.NestFactory.createApplicationContext(app_module_1.AppModule, { logger: ['error'] });
        const gifts = app.get(video_room_gift_service_1.VideoRoomGiftService);
        console.log(`warming up (${SCENARIO.warmupSends} sends)…`);
        await measureSends(gifts, SCENARIO.warmupSends, send_video_room_gift_dto_1.VideoRoomGiftTarget.SINGLE, SCENARIO.receiverId);
        console.log(`measuring single-receiver (${SCENARIO.singleSends} sends)…`);
        const single = await measureSends(gifts, SCENARIO.singleSends, send_video_room_gift_dto_1.VideoRoomGiftTarget.SINGLE, SCENARIO.receiverId);
        console.log(`measuring SEAT_ALL (${SCENARIO.batchSends} sends)…`);
        const batch = await measureSends(gifts, SCENARIO.batchSends, send_video_room_gift_dto_1.VideoRoomGiftTarget.SEAT_ALL);
        const rows = [
            summarise('POST /send (single receiver)', single, TARGETS.singleReceiverP95Ms),
            summarise('POST /send (SEAT_ALL, max)', batch, TARGETS.multiReceiverP95Ms),
        ];
        render(rows);
        console.log('NOT YET MEASURED — these need a socket subscriber and a seeded DLQ, and are the\n' +
            'next thing to add here:\n' +
            `  • commit -> giftAnimation broadcast (target p95 < ${TARGETS.queueDeliveryP95Ms}ms)\n` +
            `  • DLQ replay success rate (target > ${TARGETS.replaySuccessRate * 100}%)\n`);
        const failed = rows.filter((row) => !row.pass);
        if (failed.length > 0) {
            console.error(`FAILED targets: ${failed.map((row) => row.label).join(', ')}`);
            console.error('Legitimate levers: pipeline the pre-flight Redis calls, reduce lock round-trips.\n' +
                'NOT a lever: moving work into or out of the transaction to shave milliseconds —\n' +
                'that trades the ACID guarantee this design is built on for a latency number.');
            process.exit(1);
        }
        console.log('All measured targets met.');
    }
    finally {
        await app?.close();
    }
}
void main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=video-room-gift.bench.js.map
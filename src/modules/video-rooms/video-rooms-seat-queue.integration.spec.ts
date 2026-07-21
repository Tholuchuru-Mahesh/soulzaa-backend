import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  VideoRoomSeatRequestStatus,
  VideoRoomSeatStatus,
  VideoRoomSeatType,
  VideoRoomStatus,
} from '@prisma/client';
import { InMemoryEventBus } from 'src/common/events';
import { CacheService } from 'src/infra/redis/cache.service';
import { LockService } from 'src/infra/redis/lock.service';
import type { RedisClient } from 'src/infra/redis/redis.constants';
import type { IVipService } from 'src/modules/vip/interfaces/vip.service.interface';
import { VIDEO_ROOM_SYSTEM_ACTOR_ID } from './constants/video-room.constants';
import { SeatRequestResolvedEvent, VIDEO_ROOM_SEAT_EVENTS } from './events/video-room-seat.events';
import { VideoRoomSeatQueueListener } from './listeners/video-room-seat-queue.listener';
import type { VideoRoomEventsRepository } from './repositories/video-room-events.repository';
import type { VideoRoomSeatsRepository } from './repositories/video-room-seats.repository';
import type { VideoRoomsRepository } from './repositories/video-rooms.repository';
import type { VideoRoomPermissionService } from './services/video-room-permission.service';
import type { VideoRoomSeatRequestService } from './services/video-room-seat-request.service';
import { VideoRoomSeatQueueService } from './services/video-room-seat-queue.service';
import { VideoRoomSeatStateService } from './services/video-room-seat-state.service';
import { VideoRoomSeatService } from './services/video-room-seat.service';

/**
 * VR-8 seat queue — a composition test.
 *
 * ~1600 unit tests mock the repository and the Redis client, so none of them
 * can see two properties that only exist in how the REAL classes are wired
 * together:
 *
 *  1. `VideoRoomSeatService.applyVacate` publishes `SeatLeftEvent` from
 *     *inside* `mutateStage`'s `withLock(videoRoomSeatLockKey)` block, and
 *     `InMemoryEventBus.publish` (`emitAsync`) awaits listeners on the
 *     publisher's own stack. `VideoRoomSeatQueueListener` defers its reaction
 *     with `setImmediate` specifically so a nested `queue.advance` (which
 *     reseats via `seatUser` → `mutateStage`) doesn't try to re-acquire that
 *     same, still-held, non-re-entrant (`SET NX`) lock. Only a real
 *     `LockService` backed by a real single-connection-shaped Redis double can
 *     demonstrate the retry storm this would cause if that deferral regressed.
 *
 *  2. `VIDEO_ROOM_SYSTEM_ACTOR_ID` (the actor recorded for auto-advance) MUST
 *     be a UUID: `resolvedBy`/`updatedBy`/`VideoRoomEvent.actorId` are all
 *     `@db.Uuid`. A non-UUID sentinel throws at the query layer — silently,
 *     because every call site here swallows and logs. Only a persistence fake
 *     that actually validates the shape of what it's handed can catch that.
 *
 * So this test composes the real `VideoRoomSeatService`, `VideoRoomSeatQueueService`,
 * `VideoRoomSeatQueueListener`, `LockService`, `CacheService`, and `InMemoryEventBus`,
 * and fakes only the two true edges: the Redis client (an in-memory double with
 * real NX/PX + Lua-release semantics) and the Prisma-backed repositories
 * (in-memory stores that assert every `@db.Uuid` write is actually a UUID).
 */

// ---------------------------------------------------------------------------
// Fake Redis client — real NX/PX lock semantics, real sorted-set ordering,
// FIFO-synchronous (each command resolves immediately, no artificial delay),
// matching a real single connection's command ordering guarantees.
// ---------------------------------------------------------------------------

interface StringEntry {
  value: string;
  expireAtMs: number | null;
}

class FakeRedisClient {
  private readonly strings = new Map<string, StringEntry>();
  private readonly zsets = new Map<string, Map<string, number>>();

  async get(key: string): Promise<string | null> {
    return this.liveString(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    let ttlMs: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      const token = args[i];
      if (token === 'EX') ttlMs = Number(args[++i]) * 1000;
      else if (token === 'PX') ttlMs = Number(args[++i]);
      else if (token === 'NX') nx = true;
    }
    if (nx && this.liveString(key)) return null;
    this.strings.set(key, { value, expireAtMs: ttlMs !== null ? Date.now() + ttlMs : null });
    return 'OK';
  }

  async exists(key: string): Promise<number> {
    if (this.liveString(key)) return 1;
    return (this.zsets.get(key)?.size ?? 0) > 0 ? 1 : 0;
  }

  async expire(_key: string, _ttlSeconds: number): Promise<number> {
    // TTL bookkeeping doesn't affect correctness for the scenarios this file pins.
    return 1;
  }

  async del(key: string): Promise<number> {
    const hadString = this.strings.delete(key);
    const hadZset = this.zsets.delete(key);
    return hadString || hadZset ? 1 : 0;
  }

  /**
   * Compare-and-delete / compare-and-extend — the two Lua scripts LockService
   * ships. NOT JavaScript's global `eval`: this is a same-named method that
   * mimics ioredis's `RedisClient#eval` (an EVAL command dispatch to a Redis
   * server), matched here by inspecting which static script string LockService
   * passed in — no code is ever parsed or executed by this method.
   */
  async eval(script: string, _numKeys: number, ...rest: Array<string | number>): Promise<number> {
    const key = String(rest[0]);
    const token = String(rest[1]);
    const entry = this.liveString(key);
    if (!entry || entry.value !== token) return 0;
    if (script.includes('pexpire')) {
      entry.expireAtMs = Date.now() + Number(rest[2]);
      return 1;
    }
    this.strings.delete(key);
    return 1;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const z = this.zsetFor(key);
    const isNew = !z.has(member);
    z.set(member, score);
    return isNew ? 1 : 0;
  }

  async zincrby(key: string, delta: number, member: string): Promise<string> {
    const z = this.zsetFor(key);
    const next = (z.get(member) ?? 0) + delta;
    z.set(member, next);
    return String(next);
  }

  async zscore(key: string, member: string): Promise<string | null> {
    const score = this.zsets.get(key)?.get(member);
    return score === undefined ? null : String(score);
  }

  async zrank(key: string, member: string): Promise<number | null> {
    const idx = this.ascending(key).findIndex(([m]) => m === member);
    return idx === -1 ? null : idx;
  }

  async zcard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const z = this.zsets.get(key);
    if (!z) return 0;
    let removed = 0;
    for (const m of members) if (z.delete(m)) removed++;
    return removed;
  }

  async zrange(key: string, start: number, stop: number, withScores?: string): Promise<string[]> {
    const slice = this.sliceInclusive(this.ascending(key), start, stop);
    return withScores === 'WITHSCORES'
      ? slice.flatMap(([member, score]) => [member, String(score)])
      : slice.map(([member]) => member);
  }

  private liveString(key: string): StringEntry | null {
    const entry = this.strings.get(key);
    if (!entry) return null;
    if (entry.expireAtMs !== null && entry.expireAtMs <= Date.now()) {
      this.strings.delete(key);
      return null;
    }
    return entry;
  }

  private zsetFor(key: string): Map<string, number> {
    let z = this.zsets.get(key);
    if (!z) {
      z = new Map();
      this.zsets.set(key, z);
    }
    return z;
  }

  private ascending(key: string): Array<[string, number]> {
    const z = this.zsets.get(key);
    if (!z) return [];
    return [...z.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  private sliceInclusive<T>(arr: T[], start: number, stop: number): T[] {
    const len = arr.length;
    const normalize = (i: number) => (i < 0 ? Math.max(len + i, 0) : Math.min(i, len));
    const from = normalize(start);
    const to = Math.min(stop < 0 ? len + stop : stop, len - 1);
    return to < from || len === 0 ? [] : arr.slice(from, to + 1);
  }
}

// ---------------------------------------------------------------------------
// UUID guard — the exact mechanism that turns defect #2 (a non-UUID system
// actor sentinel silently failing at the Prisma layer) into a loud test
// failure instead of a swallowed log line.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidColumn(value: string | null | undefined, column: string): void {
  if (value == null) return; // nullable @db.Uuid columns tolerate null
  if (!UUID_RE.test(value)) {
    throw new Error(
      `Fake repository refused a non-UUID value for @db.Uuid column "${column}": "${value}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// In-memory Prisma-repository fakes (the other true edge). Shapes mirror the
// real `video_room_seats` / `video_room_seat_requests` / `video_room_events`
// rows closely enough for the mapper + services to operate on them unchanged.
// ---------------------------------------------------------------------------

interface FakeSeatRow {
  roomId: string;
  seatIndex: number;
  seatType: VideoRoomSeatType;
  seatStatus: VideoRoomSeatStatus;
  occupantUserId: string | null;
  reservedForUserId: string | null;
  isLocked: boolean;
  isMuted: boolean;
  isVideoOn: boolean;
  metadata: null;
  createdBy: string | null;
  updatedBy: string | null;
}

interface FakeSeatRequestRow {
  id: string;
  roomId: string;
  userId: string;
  seatIndex: number | null;
  status: VideoRoomSeatRequestStatus;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  attemptCount: number;
  lastError: string | null;
  updatedBy: string | null;
}

const seatKey = (roomId: string, seatIndex: number): string => `${roomId}:${seatIndex}`;

class FakeVideoRoomSeatsRepository {
  readonly seats = new Map<string, FakeSeatRow>();
  readonly requests = new Map<string, FakeSeatRequestRow>();
  layout = { hostSeatCount: 1, guestSeatCount: 0 };

  async getSeatLayout(_roomId: string): Promise<{ hostSeatCount: number; guestSeatCount: number }> {
    return this.layout;
  }

  async listSeats(roomId: string): Promise<FakeSeatRow[]> {
    return [...this.seats.values()]
      .filter((s) => s.roomId === roomId)
      .sort((a, b) => a.seatIndex - b.seatIndex);
  }

  async updateSeat(
    roomId: string,
    seatIndex: number,
    data: Partial<FakeSeatRow>,
    actorId: string,
  ): Promise<FakeSeatRow> {
    assertUuidColumn(actorId, 'updatedBy');
    if (typeof data.occupantUserId === 'string') {
      assertUuidColumn(data.occupantUserId, 'occupantUserId');
    }
    const key = seatKey(roomId, seatIndex);
    const existing = this.seats.get(key);
    if (!existing) throw new Error(`fake seats repo: no seat ${key}`);
    const updated: FakeSeatRow = { ...existing, ...data, updatedBy: actorId };
    this.seats.set(key, updated);
    return updated;
  }

  async listPendingRequests(roomId: string): Promise<FakeSeatRequestRow[]> {
    return [...this.requests.values()]
      .filter((r) => r.roomId === roomId && r.status === VideoRoomSeatRequestStatus.PENDING)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async findPendingRequest(roomId: string, userId: string): Promise<FakeSeatRequestRow | null> {
    return (
      [...this.requests.values()].find(
        (r) =>
          r.roomId === roomId &&
          r.userId === userId &&
          r.status === VideoRoomSeatRequestStatus.PENDING,
      ) ?? null
    );
  }

  async setRequestStatus(
    id: string,
    status: VideoRoomSeatRequestStatus,
    actorId: string,
    resolvedBy?: string | null,
    opts?: { lastError?: string | null; bumpAttempt?: boolean },
  ): Promise<FakeSeatRequestRow> {
    assertUuidColumn(actorId, 'updatedBy');
    assertUuidColumn(resolvedBy ?? null, 'resolvedBy');
    const existing = this.requests.get(id);
    if (!existing) throw new Error(`fake seats repo: no request ${id}`);
    const updated: FakeSeatRequestRow = {
      ...existing,
      status,
      resolvedBy: resolvedBy ?? null,
      resolvedAt: new Date(),
      updatedBy: actorId,
      ...(opts?.lastError !== undefined ? { lastError: opts.lastError } : {}),
      ...(opts?.bumpAttempt ? { attemptCount: existing.attemptCount + 1 } : {}),
    };
    this.requests.set(id, updated);
    return updated;
  }

  async listPendingInvitationsForRoom(_roomId: string): Promise<never[]> {
    return [];
  }

  /** Mirrors the real bulk-resolve used by the FIX I3 listener paths. */
  async resolveAllPendingRequestsForUser(
    roomId: string,
    userId: string,
    status: VideoRoomSeatRequestStatus,
    actorId: string,
  ): Promise<void> {
    assertUuidColumn(actorId, 'resolvedBy/updatedBy');
    for (const [id, req] of this.requests) {
      if (
        req.roomId === roomId &&
        req.userId === userId &&
        req.status === VideoRoomSeatRequestStatus.PENDING
      ) {
        this.requests.set(id, {
          ...req,
          status,
          resolvedBy: actorId,
          resolvedAt: new Date(),
          updatedBy: actorId,
        });
      }
    }
  }
}

class FakeVideoRoomsRepository {
  readonly rooms = new Map<string, { id: string; ownerId: string; status: VideoRoomStatus }>();
  readonly members = new Map<string, { isActive: boolean }>();
  readonly settings = new Map<string, { seatApprovalRequired: boolean } | undefined>();

  async findById(
    id: string,
  ): Promise<{ id: string; ownerId: string; status: VideoRoomStatus } | null> {
    return this.rooms.get(id) ?? null;
  }

  async getMember(roomId: string, userId: string): Promise<{ isActive: boolean } | null> {
    return this.members.get(`${roomId}:${userId}`) ?? null;
  }

  async getSettings(roomId: string): Promise<{ seatApprovalRequired: boolean } | null> {
    return this.settings.get(roomId) ?? null;
  }
}

interface FakeAppendedEvent {
  roomId: string;
  actorId: string | null | undefined;
  eventType: string;
}

class FakeVideoRoomEventsRepository {
  readonly events: FakeAppendedEvent[] = [];

  async appendEvent(input: {
    roomId: string;
    actorId?: string | null;
    eventType: string;
  }): Promise<void> {
    assertUuidColumn(input.actorId ?? null, 'VideoRoomEvent.actorId');
    this.events.push({ roomId: input.roomId, actorId: input.actorId, eventType: input.eventType });
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Let the `setImmediate`-deferred queue-advance work run before asserting. */
function flushImmediates(times = 2): Promise<void> {
  return [...Array(times)].reduce<Promise<void>>(
    (p) => p.then(() => new Promise<void>((resolve) => setImmediate(resolve))),
    Promise.resolve(),
  );
}

/** Bounded poll: cheap in the happy path (resolves after the first tick), safe under load. */
async function waitUntil(
  predicate: () => boolean,
  { timeoutMs = 900, stepMs = 5 } = {},
): Promise<void> {
  await flushImmediates(2);
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs));
  }
}

function makeSeatRow(
  roomId: string,
  seatIndex: number,
  seatType: VideoRoomSeatType,
  occupantUserId: string | null,
): FakeSeatRow {
  return {
    roomId,
    seatIndex,
    seatType,
    seatStatus: occupantUserId ? VideoRoomSeatStatus.OCCUPIED : VideoRoomSeatStatus.EMPTY,
    occupantUserId,
    reservedForUserId: null,
    isLocked: false,
    isMuted: false,
    isVideoOn: false,
    metadata: null,
    createdBy: occupantUserId,
    updatedBy: occupantUserId,
  };
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

describe('VR-8 seat queue — real service composition over a faked Redis + Prisma edge', () => {
  const roomId = randomUUID();
  const ownerId = randomUUID();
  const occupantId = randomUUID();
  const queuedUserId = randomUUID();
  const hostSeatIndex = 1;
  const requestedAt = new Date('2026-07-20T10:00:00.000Z');

  let seatsRepo: FakeVideoRoomSeatsRepository;
  let roomsRepo: FakeVideoRoomsRepository;
  let eventsRepo: FakeVideoRoomEventsRepository;
  let bus: InMemoryEventBus;
  let seatService: VideoRoomSeatService;
  let queueService: VideoRoomSeatQueueService;
  let requestId: string;
  let resolvedEvents: SeatRequestResolvedEvent[];

  /** Wires every real class fresh, with the given room settings. */
  async function setUp(settings: { seatApprovalRequired: boolean } | null): Promise<void> {
    const redis = new FakeRedisClient();
    const cache = new CacheService(redis as unknown as RedisClient);
    const locks = new LockService(redis as unknown as RedisClient);
    bus = new InMemoryEventBus(new EventEmitter2({ wildcard: true, delimiter: '.' }));

    roomsRepo = new FakeVideoRoomsRepository();
    roomsRepo.rooms.set(roomId, { id: roomId, ownerId, status: VideoRoomStatus.LIVE });
    roomsRepo.members.set(`${roomId}:${occupantId}`, { isActive: true });
    roomsRepo.members.set(`${roomId}:${queuedUserId}`, { isActive: true });
    if (settings) roomsRepo.settings.set(roomId, settings);

    seatsRepo = new FakeVideoRoomSeatsRepository();
    seatsRepo.seats.set(
      seatKey(roomId, 0),
      makeSeatRow(roomId, 0, VideoRoomSeatType.OWNER, ownerId),
    );
    seatsRepo.seats.set(
      seatKey(roomId, hostSeatIndex),
      makeSeatRow(roomId, hostSeatIndex, VideoRoomSeatType.HOST, occupantId),
    );
    requestId = randomUUID();
    seatsRepo.requests.set(requestId, {
      id: requestId,
      roomId,
      userId: queuedUserId,
      seatIndex: null,
      status: VideoRoomSeatRequestStatus.PENDING,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: requestedAt,
      attemptCount: 0,
      lastError: null,
      updatedBy: queuedUserId,
    });

    eventsRepo = new FakeVideoRoomEventsRepository();

    const vip = { getLevelOrdinal: async () => 0 } as unknown as IVipService;
    // `permissions` is genuinely unused by vacateUser/seatUser — both are
    // called directly here, bypassing the MANAGE_*-gated public verbs that
    // consult it. Any accidental use surfaces immediately as a thrown error.
    const permissions = new Proxy(
      {},
      {
        get(_t, prop) {
          throw new Error(`unexpected VideoRoomPermissionService.${String(prop)} call`);
        },
      },
    ) as unknown as VideoRoomPermissionService;
    const requests = { restore: async () => undefined } as unknown as VideoRoomSeatRequestService;
    const config = { get: () => ({ stateTtlSeconds: 300 }) } as unknown as ConfigService;

    const seatState = new VideoRoomSeatStateService(
      cache,
      seatsRepo as unknown as VideoRoomSeatsRepository,
      config,
    );
    seatService = new VideoRoomSeatService(
      locks,
      seatState,
      seatsRepo as unknown as VideoRoomSeatsRepository,
      roomsRepo as unknown as VideoRoomsRepository,
      permissions,
      eventsRepo as unknown as VideoRoomEventsRepository,
      bus,
    );
    queueService = new VideoRoomSeatQueueService(
      cache,
      seatsRepo as unknown as VideoRoomSeatsRepository,
      vip,
      bus,
      seatService,
      locks,
      eventsRepo as unknown as VideoRoomEventsRepository,
    );
    const listener = new VideoRoomSeatQueueListener(
      bus,
      queueService,
      requests,
      roomsRepo as unknown as VideoRoomsRepository,
      seatsRepo as unknown as VideoRoomSeatsRepository,
    );
    listener.onModuleInit();

    // Seed the Redis queue projection the way `VideoRoomSeatRequestService.request`
    // would have: the PENDING request row already exists (above); this projects it.
    await queueService.enqueue(roomId, queuedUserId, requestedAt);

    resolvedEvents = [];
    bus.subscribe<SeatRequestResolvedEvent>(VIDEO_ROOM_SEAT_EVENTS.REQUEST_RESOLVED, (e) => {
      resolvedEvents.push(e);
    });
  }

  // ---- Scenario A — auto-advance end to end -------------------------------

  it('auto-promotes the queued user onto a freed seat, fast, when approval is not required', async () => {
    await setUp({ seatApprovalRequired: false });

    const start = Date.now();
    await seatService.vacateUser(roomId, occupantId, occupantId, 'seat.left');
    await waitUntil(
      () => seatsRepo.seats.get(seatKey(roomId, hostSeatIndex))?.occupantUserId === queuedUserId,
    );
    const elapsedMs = Date.now() - start;

    // The deadlock guard: reverting the `setImmediate` deferral makes the
    // nested lock re-acquisition retry for ~2.1s before giving up, so this
    // bound fails loudly (and for the right reason) if that regresses.
    expect(elapsedMs).toBeLessThan(1000);

    const seatRow = seatsRepo.seats.get(seatKey(roomId, hostSeatIndex));
    expect(seatRow?.occupantUserId).toBe(queuedUserId);
    expect(seatRow?.seatStatus).toBe(VideoRoomSeatStatus.OCCUPIED);

    const requestRow = seatsRepo.requests.get(requestId);
    expect(requestRow?.status).toBe(VideoRoomSeatRequestStatus.PROMOTED);

    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0].payload).toMatchObject({
      roomId,
      requestId,
      userId: queuedUserId,
      status: 'PROMOTED',
      seatIndex: hostSeatIndex,
    });
  }, 10_000);

  // ---- Scenario B — approval-required rooms do NOT auto-seat -------------

  it('does NOT auto-seat the queued user when the room requires seat approval', async () => {
    await setUp({ seatApprovalRequired: true });

    await seatService.vacateUser(roomId, occupantId, occupantId, 'seat.left');
    await flushImmediates(3);

    const seatRow = seatsRepo.seats.get(seatKey(roomId, hostSeatIndex));
    expect(seatRow?.occupantUserId).toBeNull();
    expect(seatRow?.seatStatus).toBe(VideoRoomSeatStatus.EMPTY);

    const requestRow = seatsRepo.requests.get(requestId);
    expect(requestRow?.status).toBe(VideoRoomSeatRequestStatus.PENDING);
    expect(resolvedEvents).toHaveLength(0);
  });

  it('defaults to approval-required (no auto-seat) when a room has no settings row at all', async () => {
    await setUp(null);

    await seatService.vacateUser(roomId, occupantId, occupantId, 'seat.left');
    await flushImmediates(3);

    const seatRow = seatsRepo.seats.get(seatKey(roomId, hostSeatIndex));
    expect(seatRow?.occupantUserId).toBeNull();

    const requestRow = seatsRepo.requests.get(requestId);
    expect(requestRow?.status).toBe(VideoRoomSeatRequestStatus.PENDING);
    expect(resolvedEvents).toHaveLength(0);
  });

  // ---- Scenario C — the UUID contract, made explicit ----------------------

  it('records a UUID-shaped actor id on the auto-advance write path, not the literal string "system"', async () => {
    await setUp({ seatApprovalRequired: false });

    await seatService.vacateUser(roomId, occupantId, occupantId, 'seat.left');
    await waitUntil(
      () => seatsRepo.seats.get(seatKey(roomId, hostSeatIndex))?.occupantUserId === queuedUserId,
    );

    const requestRow = seatsRepo.requests.get(requestId);
    expect(requestRow?.resolvedBy).toMatch(UUID_RE);
    expect(requestRow?.updatedBy).toMatch(UUID_RE);
    expect(requestRow?.resolvedBy).toBe(VIDEO_ROOM_SYSTEM_ACTOR_ID);

    const advanceAuditEvent = eventsRepo.events.find((e) => e.eventType === 'seat.queue_advanced');
    expect(advanceAuditEvent?.actorId).toMatch(UUID_RE);
  });
});

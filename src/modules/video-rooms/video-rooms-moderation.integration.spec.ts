import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { PlatformRole, VideoRoomModerationMuteType } from '@prisma/client';
import { Registry } from 'prom-client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS } from 'src/common/events';
import { MetricsService } from 'src/infra/observability/metrics.service';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import { REDIS_CLIENT } from 'src/infra/redis/redis.constants';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { VideoRoomsModerationController } from './controllers/video-rooms-moderation.controller';
import { VIDEO_ROOM_NAMESPACE } from './constants/video-room.constants';
import { VIDEO_ROOM_MODERATION_QUEUES } from './constants/video-room-moderation.constants';
import { VideoRoomPermission } from './constants/video-room-permissions';
import { DuplicateDetector } from './services/detectors/duplicate.detector';
import { ExcessiveReportsDetector } from './services/detectors/excessive-reports.detector';
import { FloodDetector } from './services/detectors/flood.detector';
import { RapidJoinLeaveDetector } from './services/detectors/rapid-join-leave.detector';
import { SpamDetector } from './services/detectors/spam.detector';
import {
  UserBlacklistedEvent,
  UserKickedEvent,
  UserMutedEvent,
} from './events/video-room-moderation.events';
import type { RoomActor } from './interfaces/room-actor.interface';
import { VideoRoomModerationSocketListener } from './listeners/video-room-moderation-socket.listener';
import { VideoRoomAutoModerationListener } from './listeners/video-room-auto-moderation.listener';
import { VideoRoomModerationMetrics } from './metrics/video-room-moderation.metrics';
import { VideoRoomModerationRepository } from './repositories/video-room-moderation.repository';
import { VideoRoomReportRepository } from './repositories/video-room-report.repository';
import { VideoRoomRolesRepository } from './repositories/video-room-roles.repository';
import { VideoRoomWarningRepository } from './repositories/video-room-warning.repository';
import { VideoRoomsRepository } from './repositories/video-rooms.repository';
import { VideoRoomModerationExpiryMonitor } from './scheduler/video-room-moderation-expiry.monitor';
import { VideoRoomAutoModerationService } from './services/video-room-auto-moderation.service';
import { VideoRoomMediaService } from './services/video-room-media.service';
import { ModeratorPerformanceService } from 'src/modules/moderator-performance/services/moderator-performance.service';
import { InvestigationRecordingService } from 'src/modules/investigation-recording/services/investigation-recording.service';
import { AuditLogService } from 'src/modules/authorization/services/audit-log.service';
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';
import { ModeratorShiftService } from 'src/modules/moderator-shift/services/moderator-shift.service';
import { ModeratorWarningService } from 'src/modules/moderator-warning/services/moderator-warning.service';
import type { JoinContext } from './services/video-room-member.service';
import { VideoRoomMemberService } from './services/video-room-member.service';
import { VideoRoomModerationQueryService } from './services/video-room-moderation-query.service';
import { VideoRoomModerationService } from './services/video-room-moderation.service';
import { VideoRoomPermissionService } from './services/video-room-permission.service';
import { VideoRoomReportService } from './services/video-room-report.service';
import { VideoRoomSessionService } from './services/video-room-session.service';

/**
 * VR-16 Task 24 end-to-end. Two independent proofs, mirroring the convention
 * `video-rooms-ranking.integration.spec.ts` (VR-13) established for this
 * module:
 *
 * 1. "moderation engine (behavior)" — the REAL `VideoRoomModerationService`
 *    and REAL `VideoRoomMemberService` wired to a SHARED REAL
 *    `VideoRoomModerationRepository` (over an in-memory Prisma + Redis
 *    double), with only the outermost edges (permissions, sockets, locks,
 *    session, event bus, metrics, queue) faked. This proves the write side
 *    a human moderator action takes (kick / blacklist / mute) and the
 *    existing join-gate `VideoRoomMemberService.join` reads actually agree —
 *    something no per-class unit spec can prove on its own.
 *
 * 2. "DI graph" — every Phase-16 provider `video-rooms.module.ts` registers
 *    (both repos, all 4 services, the 5 detectors, both listeners, the
 *    monitor, the metrics, and the controller), constructed through a REAL
 *    Nest `TestingModule` exactly as the module wires them. This is the
 *    check that catches a DI wiring mistake no unit test can: a missing
 *    provider here reproduces Nest's real "Nest can't resolve dependencies
 *    of X (?, ...)" failure at test time instead of only at server boot.
 */

const ROOM = 'room-1';
const OWNER = 'owner-1';

/** A room shape satisfying both `VideoRoomModerationService.requireRoom` (id/ownerId) and `VideoRoomMemberService.join` (status/isLocked/passwordHash/maxViewers). */
function liveRoom(over: Record<string, unknown> = {}) {
  return {
    id: ROOM,
    ownerId: OWNER,
    status: 'LIVE',
    isLocked: false,
    passwordHash: null,
    maxViewers: 500,
    ...over,
  };
}

const actor = (id: string, roles: PlatformRole[] = []): RoomActor => ({ id, roles });

/** Minimal in-memory SET + string store covering the mirror commands the repo issues. */
class FakeRedis {
  private sets = new Map<string, Set<string>>();
  private strings = new Map<string, string>();

  private set_(key: string): Set<string> {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    return this.sets.get(key) as Set<string>;
  }

  async sadd(key: string, member: string): Promise<number> {
    const had = this.set_(key).has(member);
    this.set_(key).add(member);
    return had ? 0 : 1;
  }

  async srem(key: string, member: string): Promise<number> {
    return this.set_(key).delete(member) ? 1 : 0;
  }

  async sismember(key: string, member: string): Promise<number> {
    return this.set_(key).has(member) ? 1 : 0;
  }

  async set(key: string, value: string, ..._rest: unknown[]): Promise<string | null> {
    this.strings.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.strings.delete(key) ? 1 : 0;
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
}

describe('VR-16 moderation engine (behavior)', () => {
  let blocks: Record<string, unknown>[];
  let mutes: Record<string, unknown>[];
  let actions: Record<string, unknown>[];
  let published: unknown[];
  let redis: FakeRedis;
  let moderationRepo: VideoRoomModerationRepository;
  let rooms: Record<string, jest.Mock>;
  let permissions: Record<string, jest.Mock>;
  let session: Record<string, jest.Mock>;
  let sockets: Record<string, jest.Mock>;
  let locks: Record<string, jest.Mock>;
  let metrics: Record<string, jest.Mock>;
  let queue: Record<string, jest.Mock>;
  let bus: Record<string, jest.Mock>;
  let config: Record<string, jest.Mock>;
  let moderationService: VideoRoomModerationService;
  let memberService: VideoRoomMemberService;

  const ctx: JoinContext = { socketId: 's1', deviceId: 'd1', platform: 'IOS', ip: '1.2.3.4' };

  beforeEach(() => {
    blocks = [];
    mutes = [];
    actions = [];
    published = [];

    const prisma = {
      videoRoomBlock: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `block-${blocks.length + 1}`, status: 'ACTIVE', ...data };
          blocks.push(row);
          return row;
        }),
        findFirst: jest.fn(
          async ({ where }: { where: Record<string, unknown> }) =>
            blocks.find(
              (b) =>
                b.roomId === where.roomId && b.userId === where.userId && b.status === where.status,
            ) ?? null,
        ),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: unknown }) => {
          const row = blocks.find((b) => b.id === where.id) as Record<string, unknown>;
          Object.assign(row, data as Record<string, unknown>);
          return row;
        }),
      },
      videoRoomMute: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `mute-${mutes.length + 1}`, status: 'ACTIVE', ...data };
          mutes.push(row);
          return row;
        }),
        findFirst: jest.fn(
          async ({ where }: { where: Record<string, unknown> }) =>
            mutes.find(
              (m) =>
                m.roomId === where.roomId && m.userId === where.userId && m.status === where.status,
            ) ?? null,
        ),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: unknown }) => {
          const row = mutes.find((m) => m.id === where.id) as Record<string, unknown>;
          Object.assign(row, data as Record<string, unknown>);
          return row;
        }),
      },
      videoRoomModerationAction: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `act-${actions.length + 1}`, createdAt: new Date(), ...data };
          actions.push(row);
          return row;
        }),
      },
    };

    redis = new FakeRedis();
    moderationRepo = new VideoRoomModerationRepository(prisma as never, redis as never);

    rooms = {
      findById: jest.fn().mockResolvedValue(liveRoom()),
      getMember: jest.fn().mockResolvedValue(null),
      deactivateMember: jest.fn().mockResolvedValue(undefined),
      upsertActiveMember: jest.fn().mockResolvedValue({ id: 'm1' }),
      bumpStatsOnJoin: jest.fn().mockResolvedValue(undefined),
      appendLog: jest.fn().mockResolvedValue(undefined),
      listActiveMembers: jest.fn().mockResolvedValue([]),
      countActiveMembers: jest.fn().mockResolvedValue(1),
      bumpStatsOnLeave: jest.fn().mockResolvedValue(undefined),
    };
    permissions = {
      assertPermission: jest.fn().mockResolvedValue(undefined),
      assertOutranks: jest.fn().mockResolvedValue(undefined),
      hasAnyPermission: jest.fn().mockResolvedValue(true),
      resolveEffectiveRole: jest.fn().mockResolvedValue(null),
    };
    session = { endUserRoomSessions: jest.fn().mockResolvedValue(undefined) };
    sockets = { disconnectUserInNamespace: jest.fn() };
    locks = {
      withLock: jest.fn((_key: string, fn: () => Promise<unknown>) => fn()),
    };
    metrics = {
      incKick: jest.fn(),
      incBlacklist: jest.fn(),
      incMute: jest.fn(),
      incWarning: jest.fn(),
      incAutoAction: jest.fn(),
      incReport: jest.fn(),
      incAction: jest.fn(),
      observeResponse: jest.fn(),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    bus = {
      publish: jest.fn(async (e: unknown) => {
        published.push(e);
      }),
      subscribe: jest.fn(),
    };
    config = {
      get: jest.fn().mockReturnValue({
        sessionTtlSeconds: 90,
        heartbeatIntervalSeconds: 25,
        reconnectTimeoutSeconds: 120,
        idleTimeoutSeconds: 300,
        moderation: { autoMuteMinutes: 5, expiryMonitorIntervalMs: 60_000 },
      }),
    };

    moderationService = new VideoRoomModerationService(
      rooms as never,
      moderationRepo,
      permissions as never,
      session as never,
      sockets as never,
      locks as never,
      metrics as never,
      queue as never,
      bus as never,
      { forceMute: jest.fn(), getMediaState: jest.fn() } as never,
      { create: jest.fn() } as never,
      { createSystemReport: jest.fn() } as never,
      config as never,
    );

    memberService = new VideoRoomMemberService(
      rooms as never,
      moderationRepo,
      { verify: jest.fn().mockResolvedValue(false) } as never,
      {
        applyUpdate: jest.fn().mockResolvedValue(undefined),
        getSnapshot: jest.fn().mockResolvedValue({
          version: 1,
          viewerCount: 0,
          onlineCount: 0,
          reconnectingCount: 0,
          idleCount: 0,
          participantCount: 0,
        }),
      } as never,
      {
        register: jest.fn().mockResolvedValue({ duplicateOf: null }),
        endUserRoomSessions: jest.fn().mockResolvedValue([]),
        roomSessionCount: jest.fn().mockResolvedValue(1),
      } as never,
      {
        addViewer: jest.fn().mockResolvedValue(undefined),
        removeViewer: jest.fn().mockResolvedValue(undefined),
        viewerCount: jest.fn().mockResolvedValue(0),
      } as never,
      {
        emitUserJoined: jest.fn().mockResolvedValue(undefined),
        emitSessionCreated: jest.fn().mockResolvedValue(undefined),
      } as never,
      {
        appendEvent: jest.fn().mockResolvedValue(undefined),
        listAnnouncements: jest.fn().mockResolvedValue([]),
      } as never,
      { getDetail: jest.fn().mockResolvedValue({ id: ROOM }) } as never,
      { incJoin: jest.fn(), setViewers: jest.fn() } as never,
      locks as never,
      config as never,
      { hasActiveRoomInvitation: jest.fn().mockResolvedValue(false) } as never,
      { resolve: jest.fn().mockResolvedValue(new Map()) } as never,
    );
  });

  it('kick: permission → deactivate → hard-disconnect → audit → event published', async () => {
    const target = 'target-1';
    rooms.getMember.mockResolvedValue({ isActive: true });

    await moderationService.kick(actor('mod-1'), ROOM, target, 'spamming');

    expect(permissions.assertPermission).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'mod-1' }),
      expect.objectContaining({ id: ROOM, ownerId: OWNER }),
      VideoRoomPermission.KICK_USERS,
    );
    expect(rooms.deactivateMember).toHaveBeenCalledWith(ROOM, target, 'mod-1');
    // The hard-disconnect spy (room-scoped: the video-room namespace only).
    expect(sockets.disconnectUserInNamespace).toHaveBeenCalledWith(VIDEO_ROOM_NAMESPACE, target);
    expect(session.endUserRoomSessions).toHaveBeenCalledWith(ROOM, target);
    // The immutable audit row.
    expect(actions).toEqual([
      expect.objectContaining({ roomId: ROOM, targetUserId: target, action: 'KICK' }),
    ]);
    // The published domain event.
    expect(published).toEqual([expect.any(UserKickedEvent)]);
    expect(metrics.incKick).toHaveBeenCalled();
  });

  it('kickMany skips a target it cannot kick without aborting the rest', async () => {
    rooms.getMember.mockImplementation((_room: string, userId: string) =>
      Promise.resolve(userId === 'ok-user' ? { isActive: true } : null),
    );

    const result = await moderationService.kickMany(actor('mod-1'), ROOM, [
      'ok-user',
      'not-a-member',
    ]);

    expect(result.kicked).toEqual(['ok-user']);
    expect(result.skipped).toEqual([expect.objectContaining({ userId: 'not-a-member' })]);
  });

  it('blacklist populates the Redis block mirror, then the join-gate rejects the same user', async () => {
    const target = 'target-2';
    rooms.getMember.mockResolvedValue(null); // not currently in the room

    await moderationService.blacklist(actor('mod-1'), ROOM, target, 'abuse');

    // The durable row + the audit trail.
    expect(blocks).toEqual([
      expect.objectContaining({ roomId: ROOM, userId: target, status: 'ACTIVE' }),
    ]);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ roomId: ROOM, targetUserId: target, action: 'BLOCK' }),
      ]),
    );
    // The Redis enforcement mirror the join-gate reads.
    await expect(moderationRepo.isBlockedMirror(ROOM, target)).resolves.toBe(true);
    expect(published).toEqual([expect.any(UserBlacklistedEvent)]);
    expect(metrics.incBlacklist).toHaveBeenCalled();

    // Same real repository instance: VideoRoomMemberService.join's existing
    // block gate must now see the row VideoRoomModerationService just wrote.
    await expect(memberService.join(actor(target), ROOM, {}, ctx)).rejects.toBeInstanceOf(
      BusinessException,
    );
    await memberService.join(actor(target), ROOM, {}, ctx).catch((err) => {
      expect((err as BusinessException).errorCode).toBe(ERROR_CODES.VIDEO_ROOM_BLOCKED);
    });
  });

  it('an un-blacklisted user still joins normally through the same shared repository', async () => {
    await expect(memberService.join(actor('clean-user'), ROOM, {}, ctx)).resolves.toBeDefined();
  });

  it('mute populates the Redis mute mirror and publishes UserMutedEvent', async () => {
    const target = 'target-3';

    await moderationService.mute(actor('mod-1'), ROOM, {
      userId: target,
      type: VideoRoomModerationMuteType.TEMPORARY,
      durationMinutes: 10,
      channels: ['chat'],
    });

    expect(mutes).toEqual([
      expect.objectContaining({ roomId: ROOM, userId: target, status: 'ACTIVE' }),
    ]);
    await expect(moderationRepo.isMutedMirror(ROOM, target)).resolves.toBe(true);
    expect(published).toEqual([expect.any(UserMutedEvent)]);
    expect(metrics.incMute).toHaveBeenCalledWith('chat');
  });

  it('unmute clears the Redis mute mirror', async () => {
    const target = 'target-4';
    await moderationService.mute(actor('mod-1'), ROOM, {
      userId: target,
      type: VideoRoomModerationMuteType.PERMANENT,
      channels: ['chat'],
    });
    await expect(moderationRepo.isMutedMirror(ROOM, target)).resolves.toBe(true);

    await moderationService.unmute(actor('mod-1'), ROOM, target, ['chat']);

    await expect(moderationRepo.isMutedMirror(ROOM, target)).resolves.toBe(false);
  });
});

describe('VR-16 moderation engine — DI graph (video-rooms.module.ts provider wiring)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      controllers: [VideoRoomsModerationController],
      providers: [
        // ---- Every Phase-16 provider `video-rooms.module.ts` registers. ----
        VideoRoomModerationRepository,
        VideoRoomReportRepository,
        VideoRoomWarningRepository,
        VideoRoomModerationMetrics,
        SpamDetector,
        FloodDetector,
        DuplicateDetector,
        RapidJoinLeaveDetector,
        ExcessiveReportsDetector,
        VideoRoomReportService,
        VideoRoomModerationService,
        VideoRoomModerationQueryService,
        VideoRoomAutoModerationService,
        VideoRoomModerationSocketListener,
        VideoRoomAutoModerationListener,
        VideoRoomModerationExpiryMonitor,
        // ---- Everything OUTSIDE the Phase-16 set that these constructors
        // need, stood in with a minimal double keyed to the real
        // token/class — the same technique
        // `video-rooms-ranking.integration.spec.ts` (VR-13) uses to compile a
        // real DI subgraph without pulling in live Prisma/Redis/BullMQ
        // connections. ----
        { provide: ConfigService, useValue: { get: jest.fn(() => ({})) } },
        { provide: PrismaService, useValue: {} },
        { provide: REDIS_CLIENT, useValue: {} },
        { provide: LockService, useValue: {} },
        { provide: SocketManager, useValue: {} },
        { provide: EVENT_BUS, useValue: { publish: jest.fn(), subscribe: jest.fn() } },
        { provide: MetricsService, useValue: { registry: new Registry() } },
        { provide: VideoRoomsRepository, useValue: {} },
        { provide: VideoRoomRolesRepository, useValue: {} },
        { provide: VideoRoomPermissionService, useValue: {} },
        { provide: VideoRoomSessionService, useValue: {} },
        { provide: VideoRoomMediaService, useValue: {} },
        // VideoRoomReportService now records moderator KPIs. This suite asserts
        // the DI graph resolves, not what the KPIs contain, so a stub suffices.
        { provide: ModeratorPerformanceService, useValue: {} },
        { provide: InvestigationRecordingService, useValue: {} },
        { provide: AuditLogService, useValue: {} },
        { provide: WorkforceScopeService, useValue: {} },
        // Controllers in this graph are now guarded by ShiftActiveGuard, which
        // takes the shift service.
        { provide: ModeratorShiftService, useValue: {} },
        { provide: ModeratorWarningService, useValue: {} },
        {
          provide: getQueueToken(VIDEO_ROOM_MODERATION_QUEUES.PROCESSING),
          useValue: { add: jest.fn() },
        },
        {
          provide: getQueueToken(VIDEO_ROOM_MODERATION_QUEUES.REPORT),
          useValue: { add: jest.fn() },
        },
      ],
    }).compile();
  });

  afterAll(async () => {
    // No .init() was called, so no listener's/monitor's onModuleInit ever
    // subscribed to the (stubbed) bus or started a (stubbed) timer — close()
    // still tears the container down cleanly.
    await moduleRef.close();
  });

  it.each([
    ['VideoRoomModerationRepository', VideoRoomModerationRepository],
    ['VideoRoomReportRepository', VideoRoomReportRepository],
    ['VideoRoomWarningRepository', VideoRoomWarningRepository],
    ['VideoRoomModerationMetrics', VideoRoomModerationMetrics],
    ['SpamDetector', SpamDetector],
    ['FloodDetector', FloodDetector],
    ['DuplicateDetector', DuplicateDetector],
    ['RapidJoinLeaveDetector', RapidJoinLeaveDetector],
    ['ExcessiveReportsDetector', ExcessiveReportsDetector],
    ['VideoRoomReportService', VideoRoomReportService],
    ['VideoRoomModerationService', VideoRoomModerationService],
    ['VideoRoomModerationQueryService', VideoRoomModerationQueryService],
    ['VideoRoomAutoModerationService', VideoRoomAutoModerationService],
    ['VideoRoomModerationSocketListener', VideoRoomModerationSocketListener],
    ['VideoRoomAutoModerationListener', VideoRoomAutoModerationListener],
    ['VideoRoomModerationExpiryMonitor', VideoRoomModerationExpiryMonitor],
    ['VideoRoomsModerationController', VideoRoomsModerationController],
  ])('resolves %s with no DI error', (_name, token) => {
    expect(moduleRef.get(token as never)).toBeInstanceOf(token as never);
  });

  it('gives the auto-moderation engine all 5 detectors', () => {
    const engine = moduleRef.get(VideoRoomAutoModerationService) as unknown as {
      detectors: unknown[];
    };
    expect(engine.detectors).toHaveLength(5);
  });

  it('wires VideoRoomModerationService and VideoRoomReportService without a cycle', () => {
    // VideoRoomModerationService injects VideoRoomReportService (autoFlag's
    // system-report path); VideoRoomReportService must NOT inject
    // VideoRoomModerationService back, or Nest's DI graph could not have
    // compiled at all above. Constructing both here is itself the proof.
    expect(moduleRef.get(VideoRoomModerationService)).toBeDefined();
    expect(moduleRef.get(VideoRoomReportService)).toBeDefined();
  });
});

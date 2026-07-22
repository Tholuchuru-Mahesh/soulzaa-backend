import { NOT_GUEST_KEY } from 'src/common/constants';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import {
  AcceptPKInvitationDto,
  CreatePKInvitationDto,
  EndPKDto,
  PausePKDto,
  RejectPKInvitationDto,
  ResumePKDto,
  StartPKDto,
} from '../dto/video-room-pk.dto';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { VideoRoomsPkController } from './video-rooms-pk.controller';

const USER = { id: 'u1', roles: ['USER'] } as never;
const ACTOR = { id: 'u1', roles: ['USER'] };

// Reads Nest's route metadata off each handler. Declared inline (not imported)
// so this spec has no helper to keep in sync with the controller.
const routesOf = (ctrl: object): string[] =>
  Object.getOwnPropertyNames(ctrl.constructor.prototype)
    .filter((m) => m !== 'constructor')
    .map((m) => {
      const handler = (ctrl.constructor.prototype as Record<string, object>)[m];
      const path = Reflect.getMetadata('path', handler) as string | undefined;
      const method = Reflect.getMetadata('method', handler) as number | undefined;
      return path === undefined ? null : `${RequestMethod[method ?? 0]} ${path}`;
    })
    .filter((r): r is string => r !== null);

/** The mutating (POST) handler names — every one of these must carry `@NotGuest()`. */
const MUTATING_METHODS = [
  'invite',
  'accept',
  'reject',
  'cancel',
  'start',
  'pause',
  'resume',
  'end',
] as const;

describe('VideoRoomsPkController', () => {
  let lifecycle: Record<string, jest.Mock>;
  let query: Record<string, jest.Mock>;
  let controller: VideoRoomsPkController;

  beforeEach(() => {
    lifecycle = {
      invite: jest.fn().mockResolvedValue({ active: true, id: 'b1' }),
      accept: jest.fn().mockResolvedValue({ active: true, id: 'b1' }),
      reject: jest.fn().mockResolvedValue({ active: true, id: 'b1' }),
      cancel: jest.fn().mockResolvedValue({ active: true, id: 'b1' }),
      start: jest.fn().mockResolvedValue({ active: true, id: 'b1' }),
      pause: jest.fn().mockResolvedValue({ active: true, id: 'b1' }),
      resume: jest.fn().mockResolvedValue({ active: true, id: 'b1' }),
      end: jest.fn().mockResolvedValue({ active: true, id: 'b1' }),
    };
    query = {
      getCurrent: jest.fn().mockResolvedValue({ active: false }),
      history: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
      statistics: jest.fn().mockResolvedValue({
        totalBattles: 0,
        totalWins: 0,
        totalDraws: 0,
        totalContributed: 0,
        totalGiftCount: 0,
      }),
    };
    controller = new VideoRoomsPkController(lifecycle as never, query as never);
  });

  it('delegates invite to the lifecycle service with a RoomActor', async () => {
    const dto: CreatePKInvitationDto = {
      mode: 'ONE_VS_ONE' as never,
      durationSeconds: 300,
      red: ['r1'],
      blue: ['b1'],
    };
    await controller.invite(USER, 'room-1', dto, 'req-1');
    expect(lifecycle.invite).toHaveBeenCalledWith(ACTOR, 'room-1', dto, 'req-1');
  });

  it('exposes all 11 routes', () => {
    expect(routesOf(controller)).toEqual(
      expect.arrayContaining([
        'POST :id/pk/invite',
        'POST :id/pk/accept',
        'POST :id/pk/reject',
        'POST :id/pk/cancel',
        'POST :id/pk/start',
        'POST :id/pk/pause',
        'POST :id/pk/resume',
        'POST :id/pk/end',
        'GET :id/pk',
        'GET :id/pk/history',
        'GET :id/pk/statistics',
      ]),
    );
  });

  // Authorization belongs in the services, never inline in the controller —
  // the VR-10/VR-11 convention. This test is what stops it drifting back.
  it('performs no authorization inline', () => {
    const src = readFileSync(
      'src/modules/video-rooms/controllers/video-rooms-pk.controller.ts',
      'utf8',
    );
    expect(src).not.toMatch(/assertPermission|hasPermission|VideoRoomPermission\./);
  });

  it('parses the room id as a uuid on every route', () => {
    const allMethods = [...MUTATING_METHODS, 'getCurrent', 'history', 'statistics'];
    for (const method of allMethods) {
      const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, VideoRoomsPkController, method) as
        Record<string, { pipes: unknown[] }> | undefined;
      expect(args).toBeDefined();
      // PARAM = 5 in Nest's RouteParamtypes enum; the roomId param is always index 0-ish
      // but we don't rely on the index, only that SOME param entry carries ParseUuidPipe.
      const paramEntries = Object.entries(args ?? {}).filter(([key]) => key.startsWith('5:'));
      const hasUuidPipe = paramEntries.some(([, v]) => v.pipes.includes(ParseUuidPipe));
      expect(hasUuidPipe).toBe(true);
    }
  });

  it('delegates the read endpoints to the query service', async () => {
    await controller.getCurrent('room-1');
    expect(query.getCurrent).toHaveBeenCalledWith('room-1');

    const historyQuery = { page: 2, limit: 10 } as never;
    await controller.history(USER, 'room-1', historyQuery);
    expect(query.history).toHaveBeenCalledWith(ACTOR, 'room-1', historyQuery);

    await controller.statistics(USER, 'room-1');
    expect(query.statistics).toHaveBeenCalledWith(ACTOR, 'room-1');
  });

  // TDD extra: every mutating command carries @NotGuest() — guests must not
  // invite/accept/reject/cancel/start/pause/resume/end a PK battle.
  it.each(MUTATING_METHODS)('carries @NotGuest() on %s', (method) => {
    const proto = controller.constructor.prototype as Record<string, object>;
    expect(Reflect.getMetadata(NOT_GUEST_KEY, proto[method])).toBe(true);
  });

  // TDD extra: a dropped requestId silently breaks audit correlation (a
  // stated phase requirement) — every mutating handler must forward it.
  it('forwards requestId through invite/accept/reject/start/pause/resume/end', async () => {
    const acceptDto: AcceptPKInvitationDto = { battleId: 'b1' };
    const rejectDto: RejectPKInvitationDto = { battleId: 'b1' };
    const startDto: StartPKDto = {};
    const pauseDto: PausePKDto = {};
    const resumeDto: ResumePKDto = {};
    const endDto: EndPKDto = {};

    await controller.accept(USER, 'room-1', acceptDto, 'req-accept');
    expect(lifecycle.accept).toHaveBeenCalledWith(ACTOR, 'room-1', acceptDto, 'req-accept');

    await controller.reject(USER, 'room-1', rejectDto, 'req-reject');
    expect(lifecycle.reject).toHaveBeenCalledWith(ACTOR, 'room-1', rejectDto, 'req-reject');

    await controller.cancel(USER, 'room-1', 'req-cancel');
    expect(lifecycle.cancel).toHaveBeenCalledWith(ACTOR, 'room-1', 'req-cancel');

    await controller.start(USER, 'room-1', startDto, 'req-start');
    expect(lifecycle.start).toHaveBeenCalledWith(ACTOR, 'room-1', startDto, 'req-start');

    await controller.pause(USER, 'room-1', pauseDto, 'req-pause');
    expect(lifecycle.pause).toHaveBeenCalledWith(ACTOR, 'room-1', pauseDto, 'req-pause');

    await controller.resume(USER, 'room-1', resumeDto, 'req-resume');
    expect(lifecycle.resume).toHaveBeenCalledWith(ACTOR, 'room-1', resumeDto, 'req-resume');

    await controller.end(USER, 'room-1', endDto, 'req-end');
    expect(lifecycle.end).toHaveBeenCalledWith(ACTOR, 'room-1', endDto, 'req-end');
  });
});

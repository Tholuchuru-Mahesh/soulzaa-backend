import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateTreasureBoxDto, TreasureHistoryQueryDto } from '../dto/video-room-treasure.dto';
import { VideoRoomsTreasureController } from './video-rooms-treasure.controller';

const USER = { id: 'u1', roles: ['USER'] } as never;
const ACTOR = { id: 'u1', roles: ['USER'] };

const errorsFor = <T extends object>(Cls: new () => T, raw: unknown) =>
  validateSync(plainToInstance(Cls, raw) as object).flatMap((e) =>
    Object.keys(e.constraints ?? {}),
  );

describe('CreateTreasureBoxDto', () => {
  it('accepts an empty body — the ladder comes from configured levels', () => {
    expect(errorsFor(CreateTreasureBoxDto, {})).toEqual([]);
  });

  it('accepts a positive integer pool override', () => {
    expect(errorsFor(CreateTreasureBoxDto, { poolOverride: 2500 })).toEqual([]);
  });

  it('rejects a negative pool override', () => {
    expect(errorsFor(CreateTreasureBoxDto, { poolOverride: -1 })).toContain('min');
  });

  it('rejects a fractional pool override — coins are integers', () => {
    expect(errorsFor(CreateTreasureBoxDto, { poolOverride: 12.5 })).toContain('isInt');
  });

  it('bounds the override so a typo cannot mint a fortune', () => {
    expect(errorsFor(CreateTreasureBoxDto, { poolOverride: 999_999_999 })).toContain('max');
  });
});

describe('TreasureHistoryQueryDto', () => {
  it('defaults to page 1 with a bounded limit', () => {
    const dto = plainToInstance(TreasureHistoryQueryDto, {});
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
  });

  it('coerces numeric query strings', () => {
    const dto = plainToInstance(TreasureHistoryQueryDto, { page: '3', limit: '50' });
    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(50);
  });

  it('rejects a limit above the cap so a client cannot page the whole table', () => {
    expect(errorsFor(TreasureHistoryQueryDto, { limit: 5000 })).toContain('max');
  });
});

describe('VideoRoomsTreasureController', () => {
  let lifecycle: Record<string, jest.Mock>;
  let query: Record<string, jest.Mock>;
  let controller: VideoRoomsTreasureController;

  beforeEach(() => {
    lifecycle = {
      create: jest.fn().mockResolvedValue({ id: 's1' }),
      start: jest.fn().mockResolvedValue({ id: 's1' }),
      pause: jest.fn().mockResolvedValue({ id: 's1' }),
      resume: jest.fn().mockResolvedValue({ id: 's1' }),
      close: jest.fn().mockResolvedValue({ id: 's1' }),
      archive: jest.fn().mockResolvedValue({ id: 's1' }),
    };
    query = {
      status: jest.fn().mockResolvedValue({ active: false }),
      history: jest.fn().mockResolvedValue({ items: [] }),
      winners: jest.fn().mockResolvedValue({ items: [] }),
      statistics: jest.fn().mockResolvedValue({ totalPools: 0 }),
    };
    controller = new VideoRoomsTreasureController(lifecycle as never, query as never);
  });

  it.each(['start', 'pause', 'resume', 'close', 'archive'] as const)(
    'passes the resolved actor and room id through to %s',
    async (method) => {
      await controller[method](USER, 'r1', 'req-1');
      expect(lifecycle[method]).toHaveBeenCalledWith(ACTOR, 'r1', 'req-1');
    },
  );

  it('forwards the create body and the request id', async () => {
    await controller.create(USER, 'r1', { poolOverride: 2500 }, 'req-1');
    expect(lifecycle.create).toHaveBeenCalledWith(ACTOR, 'r1', { poolOverride: 2500 }, 'req-1');
  });

  it('translates page/limit into skip for history', async () => {
    await controller.history('r1', { page: 3, limit: 20 } as never);
    expect(query.history).toHaveBeenCalledWith('r1', { skip: 40, limit: 20, page: 3 });
  });

  it('translates page/limit into skip for winners', async () => {
    await controller.winners('r1', { page: 1, limit: 50 } as never);
    expect(query.winners).toHaveBeenCalledWith('r1', { skip: 0, limit: 50, page: 1 });
  });

  it('passes the actor to statistics so the permission check can run', async () => {
    await controller.statistics(USER, 'r1');
    expect(query.statistics).toHaveBeenCalledWith(ACTOR, 'r1');
  });

  it('exposes status without an actor — any room member may read it', async () => {
    await controller.status('r1');
    expect(query.status).toHaveBeenCalledWith('r1');
  });

  // There is deliberately no endpoint that opens a box or mints a pool:
  // unlocks are driven by gift progress, never by a client request.
  it('exposes no unlock or payout endpoint', () => {
    const methods = Object.getOwnPropertyNames(VideoRoomsTreasureController.prototype);
    expect(methods).not.toContain('unlock');
    expect(methods).not.toContain('distribute');
  });
});

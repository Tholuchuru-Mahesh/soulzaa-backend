import {
  ForbiddenException,
  ConflictException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BackpackItemSource, Prisma, WalletCurrency, WalletTxnReason } from '@prisma/client';
import { ATTENDANCE_CONFIG_KEYS, ATTENDANCE_DEFAULTS } from '../constants/attendance.constants';
import { AttendanceDayService } from './attendance-day.service';
import { AttendanceService } from './attendance.service';
import { AttendanceStreakService } from './attendance-streak.service';

describe('AttendanceService.claim', () => {
  let repo: Record<string, jest.Mock>;
  let wallet: Record<string, jest.Mock>;
  let exp: Record<string, jest.Mock>;
  let cosmetics: Record<string, jest.Mock>;
  let users: Record<string, jest.Mock>;
  let config: { get: jest.Mock };
  let prisma: Record<string, jest.Mock>;
  let locks: Record<string, jest.Mock>;
  let service: AttendanceService;

  const NOW = new Date('2026-07-28T06:00:00Z'); // 11:30 in Kolkata

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    repo = {
      getState: jest.fn().mockResolvedValue({
        userId: 'u1',
        currentDay: 3,
        cycleCount: 0,
        lastClaimDayKey: '2026-07-27',
        lastClaimAt: new Date('2026-07-27T06:00:00Z'),
        lastClaimTimezone: 'Asia/Kolkata',
      }),
      getRung: jest.fn().mockResolvedValue({
        day: 4,
        coins: 250,
        currency: WalletCurrency.FREE,
        expAmount: null,
        cosmeticId: null,
      }),
      getLadder: jest.fn().mockResolvedValue([]),
      recordClaim: jest.fn().mockResolvedValue({ id: 'claim-1' }),
    };
    wallet = { credit: jest.fn().mockResolvedValue({ transactionId: 'w1', duplicate: false }) };
    // ExpAwardResult is { totalExp, level, leveledUp } — one L.
    exp = { award: jest.fn().mockResolvedValue({ totalExp: 0, level: 1, leveledUp: false }) };
    cosmetics = { grantToUser: jest.fn().mockResolvedValue(null) };
    users = { findById: jest.fn().mockResolvedValue({ id: 'u1', country: 'IN' }) };
    config = { get: jest.fn().mockResolvedValue(null) };
    prisma = { $transaction: jest.fn().mockImplementation((cb) => cb(prisma)) };
    locks = { withLock: jest.fn().mockImplementation((_k, cb) => cb()) };

    service = new AttendanceService(
      repo as never,
      new AttendanceDayService(),
      new AttendanceStreakService(new AttendanceDayService()),
      wallet as never,
      exp as never,
      cosmetics as never,
      users as never,
      config as never,
      prisma as never,
      locks as never,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('credits FREE coins for the resolved rung', async () => {
    const res = await service.claim('u1');

    expect(res).toMatchObject({ claimed: true, day: 4, coins: 250 });
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        currency: WalletCurrency.FREE,
        amount: 250,
        idempotencyKey: 'attendance:u1:2026-07-28:coins',
      }),
      expect.anything(),
    );
    // The default fixture continues a day-3 streak, so day 4 is the rung that
    // must be looked up and recorded — not currentDay (3) or some other value.
    expect(repo.getRung).toHaveBeenCalledWith(4);
    expect(repo.recordClaim).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ day: 4 }),
    );
  });

  it('pins the exact wallet.credit payload — no stray UUID-typed field, dayKey lives in metadata', async () => {
    // objectContaining above cannot see an extra/wrong field such as a
    // referenceId that Postgres would reject (WalletTransaction.referenceId
    // is `String? @db.Uuid`, and a day key like "2026-07-28" is not a UUID).
    // Pin the whole payload so any future change to it must be deliberate.
    await service.claim('u1');

    expect(wallet.credit).toHaveBeenCalledWith(
      {
        userId: 'u1',
        currency: WalletCurrency.FREE,
        amount: 250,
        reason: WalletTxnReason.ATTENDANCE_REWARD,
        idempotencyKey: 'attendance:u1:2026-07-28:coins',
        referenceType: 'attendance_claim',
        metadata: { day: 4, cycle: 0, dayKey: '2026-07-28' },
      },
      expect.anything(),
    );
  });

  it('never pays GOLD', async () => {
    await service.claim('u1');
    expect(wallet.credit).not.toHaveBeenCalledWith(
      expect.objectContaining({ currency: WalletCurrency.GOLD }),
      expect.anything(),
    );
  });

  it('awards EXP only when the rung carries it', async () => {
    await service.claim('u1');
    expect(exp.award).not.toHaveBeenCalled();

    repo.getRung.mockResolvedValue({
      day: 7,
      coins: 500,
      currency: WalletCurrency.FREE,
      expAmount: 100,
      cosmeticId: null,
    });
    await service.claim('u1');
    expect(exp.award).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        amount: 100,
        idempotencyKey: 'attendance:u1:2026-07-28:exp',
      }),
    );
  });

  it('returns claimed:false without paying when today is already claimed', async () => {
    repo.getState.mockResolvedValue({
      userId: 'u1',
      currentDay: 4,
      cycleCount: 0,
      lastClaimDayKey: '2026-07-28',
      lastClaimAt: NOW,
      lastClaimTimezone: 'Asia/Kolkata',
    });

    const res = await service.claim('u1');

    expect(res.claimed).toBe(false);
    expect(wallet.credit).not.toHaveBeenCalled();
    expect(repo.recordClaim).not.toHaveBeenCalled();
  });

  it('accepts a claim 1.5 hours after the last one when the zone is unchanged', async () => {
    // 23:00 then 00:30 local is a new day and must not trip the interval guard.
    repo.getState.mockResolvedValue({
      userId: 'u1',
      currentDay: 3,
      cycleCount: 0,
      lastClaimDayKey: '2026-07-27',
      lastClaimAt: new Date(NOW.getTime() - 90 * 60 * 1000),
      lastClaimTimezone: 'Asia/Kolkata',
    });

    await expect(service.claim('u1')).resolves.toMatchObject({ claimed: true });
  });

  it('rejects a claim inside the interval when the country changed', async () => {
    repo.getState.mockResolvedValue({
      userId: 'u1',
      currentDay: 3,
      cycleCount: 0,
      lastClaimDayKey: '2026-07-27',
      lastClaimAt: new Date(NOW.getTime() - 90 * 60 * 1000),
      lastClaimTimezone: 'Pacific/Auckland',
    });

    await expect(service.claim('u1')).rejects.toBeInstanceOf(ConflictException);
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it('allows a country change once the interval has passed', async () => {
    repo.getState.mockResolvedValue({
      userId: 'u1',
      currentDay: 3,
      cycleCount: 0,
      lastClaimDayKey: '2026-07-27',
      lastClaimAt: new Date(NOW.getTime() - 21 * 60 * 60 * 1000),
      lastClaimTimezone: 'Pacific/Auckland',
    });

    await expect(service.claim('u1')).resolves.toMatchObject({ claimed: true });
  });

  it('still pays coins when the milestone cosmetic is missing', async () => {
    repo.getRung.mockResolvedValue({
      day: 15,
      coins: 1000,
      currency: WalletCurrency.FREE,
      expAmount: 250,
      cosmeticId: null,
    });

    const res = await service.claim('u1');

    expect(res.coins).toBe(1000);
    expect(cosmetics.grantToUser).not.toHaveBeenCalled();
  });

  it('grants the milestone cosmetic and carries its id through', async () => {
    repo.getRung.mockResolvedValue({
      day: 15,
      coins: 1000,
      currency: WalletCurrency.FREE,
      expAmount: 250,
      cosmeticId: 'cos-1',
    });
    cosmetics.grantToUser.mockResolvedValue({
      cosmeticId: 'cos-1',
      backpackItemId: 'bp-1',
      duplicate: false,
    });

    const res = await service.claim('u1');

    expect(cosmetics.grantToUser).toHaveBeenCalledWith({
      userId: 'u1',
      cosmeticId: 'cos-1',
      source: BackpackItemSource.ATTENDANCE,
      grantKey: 'attendance:u1:2026-07-28:cosmetic',
    });
    expect(res.cosmeticId).toBe('cos-1');
  });

  it('refuses to pay when the feature flag is off', async () => {
    config.get.mockImplementation(async (key: string) =>
      key === 'feature.attendance.enabled' ? false : null,
    );

    await expect(service.claim('u1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it('still claims successfully when the config service throws NotFoundException for an absent key', async () => {
    // ConfigurationEngineService.get THROWS NotFoundException when a key is
    // absent and no default was passed — it never resolves to undefined.
    // Model that contract precisely: reject only when no default is
    // supplied, so this test fails again if the fix regresses and a call
    // site stops passing ATTENDANCE_DEFAULTS.
    config.get.mockImplementation((key: string, defaultValue?: unknown) => {
      if (defaultValue === undefined) {
        return Promise.reject(
          new NotFoundException(`Platform configuration key '${key}' not found`),
        );
      }
      return Promise.resolve(defaultValue);
    });

    await expect(service.claim('u1')).resolves.toMatchObject({ claimed: true });
    expect(config.get).toHaveBeenCalledWith(
      ATTENDANCE_CONFIG_KEYS.ENABLED,
      ATTENDANCE_DEFAULTS.ENABLED,
    );
  });

  it('still resolves the country-change interval when the config service throws NotFoundException for the min-hours key', async () => {
    repo.getState.mockResolvedValue({
      userId: 'u1',
      currentDay: 3,
      cycleCount: 0,
      lastClaimDayKey: '2026-07-27',
      lastClaimAt: new Date(NOW.getTime() - 21 * 60 * 60 * 1000),
      lastClaimTimezone: 'Pacific/Auckland',
    });
    config.get.mockImplementation((key: string, defaultValue?: unknown) => {
      if (defaultValue === undefined) {
        return Promise.reject(
          new NotFoundException(`Platform configuration key '${key}' not found`),
        );
      }
      return Promise.resolve(defaultValue);
    });

    await expect(service.claim('u1')).resolves.toMatchObject({ claimed: true });
    expect(config.get).toHaveBeenCalledWith(
      ATTENDANCE_CONFIG_KEYS.MIN_HOURS,
      ATTENDANCE_DEFAULTS.MIN_HOURS,
    );
  });

  it('takes the user lock so two concurrent claims cannot both advance', async () => {
    await service.claim('u1');
    expect(locks.withLock).toHaveBeenCalledWith('attendance:u1', expect.any(Function));
  });

  it('advances nothing when the wallet credit fails', async () => {
    // Use a rung with BOTH an expAmount and a cosmeticId: with the default
    // rung (both null) these "not called" assertions would hold regardless
    // of whether the code actually suppressed the post-commit payouts.
    repo.getRung.mockResolvedValue({
      day: 15,
      coins: 1000,
      currency: WalletCurrency.FREE,
      expAmount: 250,
      cosmeticId: 'cos-1',
    });
    // The claim row and the streak must not survive a failed payout, or the
    // user loses a day and is never paid for it.
    wallet.credit.mockRejectedValue(new Error('wallet down'));
    // Model the real transaction: a throw inside the callback aborts it.
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));

    await expect(service.claim('u1')).rejects.toThrow('wallet down');
    expect(repo.recordClaim).not.toHaveBeenCalled();
    expect(exp.award).not.toHaveBeenCalled();
    expect(cosmetics.grantToUser).not.toHaveBeenCalled();
  });

  it('rejects with a 500 and never touches the wallet when the ladder is missing a rung', async () => {
    // The spec's error table treats a gap in the seeded 30-row ladder as a
    // defect, not a user condition: 500, and the claim must never reach the
    // wallet.
    repo.getRung.mockResolvedValue(null);

    await expect(service.claim('u1')).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(wallet.credit).not.toHaveBeenCalled();
    expect(repo.recordClaim).not.toHaveBeenCalled();
  });

  it('treats a P2002 unique-constraint race as an already-claimed response, not a raw 500', async () => {
    // The Redis lock's TTL can expire while the transaction plus two network
    // calls run, so two claims can race past it; @@unique([userId, dayKey])
    // is the last backstop. That must surface exactly like ALREADY_CLAIMED.
    const raceError = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`userId`,`dayKey`)',
      { code: 'P2002', clientVersion: 'test' },
    );
    prisma.$transaction.mockRejectedValue(raceError);

    const res = await service.claim('u1');

    expect(res).toMatchObject({
      claimed: false,
      coins: 0,
      expAwarded: null,
      cosmeticId: null,
      streakReset: false,
    });
    expect(exp.award).not.toHaveBeenCalled();
    expect(cosmetics.grantToUser).not.toHaveBeenCalled();
  });

  it('re-throws a Prisma error that is not the P2002 race', async () => {
    const otherError = new Prisma.PrismaClientKnownRequestError('not found', {
      code: 'P2025',
      clientVersion: 'test',
    });
    prisma.$transaction.mockRejectedValue(otherError);

    await expect(service.claim('u1')).rejects.toBe(otherError);
  });

  it('still returns a successful claim when the EXP award throws after coins are committed', async () => {
    // Coins are already paid and the streak already advanced by the time EXP
    // is awarded; the next claim resolves to ALREADY_CLAIMED, so a thrown
    // error here must be swallowed (and logged) rather than surfaced as a
    // failed claim the user can never retry.
    // Make the streak state actually land on day 7 (not just the rung's
    // `day` field, which the log does not read): currentDay 6, continued.
    repo.getState.mockResolvedValue({
      userId: 'u1',
      currentDay: 6,
      cycleCount: 0,
      lastClaimDayKey: '2026-07-27',
      lastClaimAt: new Date('2026-07-27T06:00:00Z'),
      lastClaimTimezone: 'Asia/Kolkata',
    });
    repo.getRung.mockResolvedValue({
      day: 7,
      coins: 500,
      currency: WalletCurrency.FREE,
      expAmount: 100,
      cosmeticId: null,
    });
    exp.award.mockRejectedValue(new Error('exp service down'));
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const res = await service.claim('u1');

    expect(res).toMatchObject({ claimed: true, coins: 500, expAwarded: null });
    // Loud and reconstructable: userId, dayKey, day number, which step, the
    // lost amount, and the underlying error message, all in one line.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /step=exp.*userId=u1.*dayKey=2026-07-28.*day=7.*amount=100.*exp service down/,
      ),
    );
    errorSpy.mockRestore();
  });

  it('still returns a successful claim when the cosmetic grant throws after coins are committed', async () => {
    // Make the streak state actually land on day 15, matching the rung.
    repo.getState.mockResolvedValue({
      userId: 'u1',
      currentDay: 14,
      cycleCount: 0,
      lastClaimDayKey: '2026-07-27',
      lastClaimAt: new Date('2026-07-27T06:00:00Z'),
      lastClaimTimezone: 'Asia/Kolkata',
    });
    repo.getRung.mockResolvedValue({
      day: 15,
      coins: 1000,
      currency: WalletCurrency.FREE,
      expAmount: 250,
      cosmeticId: 'cos-1',
    });
    cosmetics.grantToUser.mockRejectedValue(new Error('cosmetics service down'));
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const res = await service.claim('u1');

    expect(res).toMatchObject({ claimed: true, coins: 1000, cosmeticId: null });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /step=cosmetic.*userId=u1.*dayKey=2026-07-28.*day=15.*cosmeticId=cos-1.*cosmetics service down/,
      ),
    );
    errorSpy.mockRestore();
  });

  it('warns once with the userId and raw country when the profile country is set but unmapped', async () => {
    // "India" instead of "IN" resolves to UTC in resolveTimezone with no
    // signal at all; an entire market could be on the wrong day boundary
    // silently. This must be logged at the call site.
    users.findById.mockResolvedValue({ id: 'u1', country: 'India' });
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await service.claim('u1');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('India'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('u1'));
    warnSpy.mockRestore();
  });

  it('does not warn when the profile has no country — that is a legitimate UTC case', async () => {
    users.findById.mockResolvedValue({ id: 'u1', country: null });
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await service.claim('u1');

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not warn when the profile country is an empty string — also legitimate UTC', async () => {
    users.findById.mockResolvedValue({ id: 'u1', country: '' });
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await service.claim('u1');

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not warn when the profile country maps to a known zone', async () => {
    // users.findById already returns country: 'IN' in the default fixture;
    // this pins that the happy path stays silent.
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await service.claim('u1');

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { BackpackItemSource, Prisma, WalletTxnReason } from '@prisma/client';
import { ExpSource } from 'src/common/enums/exp-source.enum';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LockService } from 'src/infra/redis/lock.service';
import {
  COSMETICS_SERVICE,
  type ICosmeticsService,
} from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import { EXP_SERVICE, type IExpService } from 'src/modules/exp/interfaces/exp.service.interface';
import {
  PLATFORM_CONFIG,
  type IPlatformConfiguration,
} from 'src/modules/platform-configuration/interfaces/platform-configuration.interface';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import {
  ATTENDANCE_CONFIG_KEYS,
  ATTENDANCE_DEFAULTS,
  attendanceIdempotencyKey,
} from '../constants/attendance.constants';
import { resolveTimezone } from '../constants/country-timezone.map';
import { AttendanceRepository } from '../repositories/attendance.repository';
import { AttendanceDayService } from './attendance-day.service';
import { AttendanceStreakService } from './attendance-streak.service';

export interface ClaimResult {
  claimed: boolean;
  day: number;
  cycle: number;
  coins: number;
  expAwarded: number | null;
  cosmeticId: string | null;
  streakReset: boolean;
  nextClaimAt: Date;
}

/**
 * Daily-login streak. The claim is explicit: logging in advances nothing, the
 * user asks for the reward. Runs under a per-user lock inside one transaction,
 * so a failed payout leaves the streak untouched.
 */
@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly repo: AttendanceRepository,
    private readonly days: AttendanceDayService,
    private readonly streak: AttendanceStreakService,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
    @Inject(EXP_SERVICE) private readonly exp: IExpService,
    @Inject(COSMETICS_SERVICE) private readonly cosmetics: ICosmeticsService,
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
    @Inject(PLATFORM_CONFIG) private readonly config: IPlatformConfiguration,
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
  ) {}

  async getStatus(userId: string) {
    const timezone = await this.timezoneFor(userId);
    const now = new Date();
    const todayKey = this.days.dayKey(now, timezone);
    const [state, ladder] = await Promise.all([this.repo.getState(userId), this.repo.getLadder()]);

    const outcome = this.streak.resolve({
      todayKey,
      lastClaimDayKey: state?.lastClaimDayKey ?? null,
      currentDay: state?.currentDay ?? 0,
      cycleCount: state?.cycleCount ?? 0,
    });

    return {
      currentDay: state?.currentDay ?? 0,
      cycleCount: state?.cycleCount ?? 0,
      claimableToday: outcome.kind === 'CLAIMABLE',
      nextDay: outcome.kind === 'CLAIMABLE' ? outcome.day : null,
      timezone,
      nextClaimAt: this.days.nextBoundary(now, timezone),
      ladder,
    };
  }

  async claim(userId: string): Promise<ClaimResult> {
    const enabled = await this.config.get<boolean>(
      ATTENDANCE_CONFIG_KEYS.ENABLED,
      ATTENDANCE_DEFAULTS.ENABLED,
    );
    if ((enabled ?? ATTENDANCE_DEFAULTS.ENABLED) === false) {
      throw new ForbiddenException('Attendance rewards are currently disabled.');
    }

    const timezone = await this.timezoneFor(userId);

    return this.locks.withLock(`attendance:${userId}`, async () => {
      const now = new Date();
      const todayKey = this.days.dayKey(now, timezone);
      const state = await this.repo.getState(userId);

      const outcome = this.streak.resolve({
        todayKey,
        lastClaimDayKey: state?.lastClaimDayKey ?? null,
        currentDay: state?.currentDay ?? 0,
        cycleCount: state?.cycleCount ?? 0,
      });

      if (outcome.kind === 'ALREADY_CLAIMED') {
        return {
          claimed: false,
          day: state?.currentDay ?? 0,
          cycle: state?.cycleCount ?? 0,
          coins: 0,
          expAwarded: null,
          cosmeticId: null,
          streakReset: false,
          nextClaimAt: this.days.nextBoundary(now, timezone),
        };
      }

      await this.assertIntervalElapsed(state, timezone, now);

      const rung = await this.repo.getRung(outcome.day);
      if (!rung) {
        // A gap in a seeded 30-row ladder is a defect, not a user condition.
        throw new InternalServerErrorException(`Attendance ladder is missing day ${outcome.day}.`);
      }

      let cosmeticGranted: string | null = null;

      try {
        await this.prisma.$transaction(async (tx) => {
          // referenceId must stay a real UUID or absent: WalletTransaction /
          // LedgerEntry.referenceId is `String? @db.Uuid`, and todayKey (e.g.
          // "2026-07-28") is not a UUID — Postgres would reject it with
          // 22P02 on every single claim. The day key still needs to be
          // traceable on the ledger, so it travels in metadata instead.
          await this.wallet.credit(
            {
              userId,
              currency: rung.currency,
              amount: rung.coins,
              reason: WalletTxnReason.ATTENDANCE_REWARD,
              idempotencyKey: attendanceIdempotencyKey(userId, todayKey, 'coins'),
              referenceType: 'attendance_claim',
              metadata: { day: outcome.day, cycle: outcome.cycle, dayKey: todayKey },
            },
            tx,
          );

          await this.repo.recordClaim(tx, {
            userId,
            day: outcome.day,
            cycle: outcome.cycle,
            dayKey: todayKey,
            coins: rung.coins,
            currency: rung.currency,
            expAmount: rung.expAmount,
            cosmeticId: rung.cosmeticId,
            timezone,
            claimedAt: now,
          });
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          // Two claims raced past the Redis lock (its TTL can expire while the
          // transaction plus two network calls run) and both reached
          // `recordClaim`; the unique (userId, dayKey) constraint is the last
          // backstop. Report it the same way ALREADY_CLAIMED does rather than
          // leaking a raw 500 for what is, from the user's perspective, a
          // successful claim that already happened.
          return {
            claimed: false,
            day: state?.currentDay ?? 0,
            cycle: state?.cycleCount ?? 0,
            coins: 0,
            expAwarded: null,
            cosmeticId: null,
            streakReset: false,
            nextClaimAt: this.days.nextBoundary(now, timezone),
          };
        }
        throw err;
      }

      // Outside the transaction: EXP and cosmetics own their own idempotency and
      // must not roll back a paid claim if they fail. The coins are already
      // committed and the streak already advanced by this point, so a thrown
      // error here must be swallowed (and logged for ops) rather than
      // propagated — the next call resolves to ALREADY_CLAIMED, so a failure
      // that escaped this function would report a failed claim for a day the
      // user was, in fact, already paid for, with no way to retry.
      let expAwarded: number | null = null;

      if (rung.expAmount && rung.expAmount > 0) {
        try {
          await this.exp.award({
            userId,
            amount: rung.expAmount,
            source: ExpSource.DAILY_LOGIN,
            idempotencyKey: attendanceIdempotencyKey(userId, todayKey, 'exp'),
            referenceType: 'attendance_claim',
            referenceId: todayKey,
          });
          expAwarded = rung.expAmount;
        } catch (err) {
          // Coins are already committed; this EXP grant is now permanently
          // lost unless someone replays it by hand — log everything needed
          // to do that without opening the code.
          this.logger.error(
            `Attendance grant lost: step=exp userId=${userId} dayKey=${todayKey} day=${outcome.day} amount=${rung.expAmount} error=${(err as Error).message}`,
          );
        }
      }

      if (rung.cosmeticId) {
        try {
          const granted = await this.cosmetics.grantToUser({
            userId,
            cosmeticId: rung.cosmeticId,
            source: BackpackItemSource.ATTENDANCE,
            grantKey: attendanceIdempotencyKey(userId, todayKey, 'cosmetic'),
          });
          cosmeticGranted = granted?.cosmeticId ?? null;
        } catch (err) {
          // Same as the EXP branch above: coins are already committed, so a
          // failure here permanently loses the cosmetic unless someone
          // replays it by hand from this log line.
          this.logger.error(
            `Attendance grant lost: step=cosmetic userId=${userId} dayKey=${todayKey} day=${outcome.day} cosmeticId=${rung.cosmeticId} error=${(err as Error).message}`,
          );
        }
      }

      return {
        claimed: true,
        day: outcome.day,
        cycle: outcome.cycle,
        coins: rung.coins,
        expAwarded,
        cosmeticId: cosmeticGranted,
        streakReset: outcome.reset,
        nextClaimAt: this.days.nextBoundary(now, timezone),
      };
    });
  }

  /**
   * Local midnight makes a country change exploitable: switch to a zone already
   * on tomorrow and claim twice within hours. Requiring a minimum interval
   * closes it — but only when the zone actually changed, because an
   * unconditional check would reject an honest 23:00-then-00:30 pair.
   */
  private async assertIntervalElapsed(
    state: { lastClaimAt: Date | null; lastClaimTimezone: string | null } | null,
    timezone: string,
    now: Date,
  ): Promise<void> {
    if (!state?.lastClaimAt || !state.lastClaimTimezone) return;
    if (state.lastClaimTimezone === timezone) return;

    const minHours =
      (await this.config.get<number>(
        ATTENDANCE_CONFIG_KEYS.MIN_HOURS,
        ATTENDANCE_DEFAULTS.MIN_HOURS,
      )) ?? ATTENDANCE_DEFAULTS.MIN_HOURS;
    const elapsedHours = (now.getTime() - state.lastClaimAt.getTime()) / 3_600_000;

    if (elapsedHours < minHours) {
      const opensAt = new Date(state.lastClaimAt.getTime() + minHours * 3_600_000);
      throw new ConflictException(
        `Next claim opens at ${opensAt.toISOString()} after a country change.`,
      );
    }
  }

  private async timezoneFor(userId: string): Promise<string> {
    const user = await this.users.findById(userId);
    const country = user?.country ?? null;
    const timezone = resolveTimezone(country);

    // `country` is free text (e.g. a client sending "India" instead of "IN"),
    // and resolveTimezone silently falls back to UTC for anything it can't
    // map. A null/empty country is a legitimate, expected UTC case — only a
    // non-empty, unmapped value is a gap worth surfacing.
    if (timezone === 'UTC' && country) {
      this.logger.warn(
        `Attendance: unmapped country "${country}" for user ${userId}; defaulting to UTC.`,
      );
    }

    return timezone;
  }
}

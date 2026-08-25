import { Injectable } from '@nestjs/common';
import {
  Prisma,
  UserProfile,
  UserStatistics,
  UserVerification,
  VerificationStatus,
  VerificationType,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import type { StatisticField } from '../interfaces/profile.interface';

/** BigInt-typed statistics columns — increments must be passed as bigint. */
const BIGINT_STATS = new Set<StatisticField>([
  'giftsSent',
  'giftsReceived',
  'coinsReceived',
  'exp',
]);

/**
 * Prisma access to the profile aggregate (user_profiles, user_statistics,
 * user_verification). Owned by the users module alongside `users`. Default
 * rows are created with the identity in one transaction (see
 * UsersRepository.createWithProfile); `ensureDefaults` back-fills pre-existing
 * users lazily.
 */
@Injectable()
export class ProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Create the three default profile rows inside an existing transaction. */
  async initForUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await tx.userProfile.create({ data: { userId } });
    await tx.userStatistics.create({ data: { userId } });
    await tx.userVerification.create({ data: { userId } });
  }

  /** Idempotently back-fill missing profile rows for a pre-existing user. */
  async ensureDefaults(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.userProfile.upsert({ where: { userId }, create: { userId }, update: {} }),
      this.prisma.userStatistics.upsert({ where: { userId }, create: { userId }, update: {} }),
      this.prisma.userVerification.upsert({ where: { userId }, create: { userId }, update: {} }),
    ]);
  }

  // ---- Reads ----

  getProfile(userId: string): Promise<UserProfile | null> {
    return this.prisma.userProfile.findUnique({ where: { userId } });
  }

  getStatistics(userId: string): Promise<UserStatistics | null> {
    return this.prisma.userStatistics.findUnique({ where: { userId } });
  }

  getVerification(userId: string): Promise<UserVerification | null> {
    return this.prisma.userVerification.findUnique({ where: { userId } });
  }

  profilesByIds(ids: string[]): Promise<UserProfile[]> {
    return this.prisma.userProfile.findMany({ where: { userId: { in: ids } } });
  }

  statisticsByIds(ids: string[]): Promise<UserStatistics[]> {
    return this.prisma.userStatistics.findMany({ where: { userId: { in: ids } } });
  }

  verificationsByIds(ids: string[]): Promise<UserVerification[]> {
    return this.prisma.userVerification.findMany({ where: { userId: { in: ids } } });
  }

  // ---- Writes ----

  updateProfile(
    userId: string,
    data: Pick<Prisma.UserProfileUpdateInput, 'bio' | 'state' | 'city'>,
  ): Promise<UserProfile> {
    return this.prisma.userProfile.update({ where: { userId }, data });
  }

  setMediaKey(userId: string, kind: 'avatar' | 'cover', key: string): Promise<UserProfile> {
    return this.prisma.userProfile.update({
      where: { userId },
      data: kind === 'avatar' ? { avatarKey: key } : { coverKey: key },
    });
  }

  incrementStatistic(
    userId: string,
    field: StatisticField,
    delta: number,
  ): Promise<UserStatistics> {
    const isBig = BIGINT_STATS.has(field);
    const increment = isBig ? BigInt(delta) : delta;

    // Upsert, not update. A plain update throws P2025 when the row is absent,
    // and callers await this straight after the write it is counting —
    // FollowService increments right after creating the follow row — so a user
    // with no statistics row got the follow persisted, a 500 back, and a counter
    // stuck at zero forever. Retrying could not repair it either: the second
    // follow is a no-op, so the increment never ran again.
    //
    // Every column defaults, so a first-time row only needs the delta. A
    // negative delta seeds 0 rather than a negative count — if the row never
    // existed there was nothing to decrement.
    const seed = delta > 0 ? increment : isBig ? BigInt(0) : 0;
    return this.prisma.userStatistics.upsert({
      where: { userId },
      update: { [field]: { increment } },
      create: { userId, [field]: seed },
    });
  }

  submitVerification(
    userId: string,
    type: VerificationType,
    documentKey: string | null,
    category?: string | null,
  ): Promise<UserVerification> {
    let resolvedCategory = category || null;
    if (!resolvedCategory && documentKey) {
      try {
        const parsed = JSON.parse(documentKey);
        if (parsed?.category) resolvedCategory = String(parsed.category);
      } catch {
        // raw key
      }
    }

    return this.prisma.userVerification.update({
      where: { userId },
      data: {
        type,
        category: resolvedCategory,
        documentKey,
        status: VerificationStatus.PENDING,
        verified: false,
        submittedAt: new Date(),
        rejectionReason: null,
        reviewedAt: null,
        reviewedBy: null,
      },
    });
  }

  /**
   * Grant or clear the role-derived OFFICIAL badge. Separate from
   * `reviewVerification` because there is no application to review — an
   * Official is appointed by an operator, so the row is written straight to its
   * decided state.
   */
  setOfficialBadge(userId: string, grant: boolean): Promise<UserVerification> {
    return this.prisma.userVerification.update({
      where: { userId },
      data: grant
        ? {
            verified: true,
            status: VerificationStatus.APPROVED,
            type: VerificationType.OFFICIAL,
            rejectionReason: null,
            reviewedAt: new Date(),
          }
        : {
            verified: false,
            status: VerificationStatus.NONE,
            type: null,
            documentKey: null,
            rejectionReason: null,
            reviewedAt: null,
            reviewedBy: null,
          },
    });
  }

  reviewVerification(
    userId: string,
    input: { approve: boolean; reviewedBy: string; reason?: string },
  ): Promise<UserVerification> {
    return this.prisma.userVerification.update({
      where: { userId },
      data: {
        verified: input.approve,
        status: input.approve ? VerificationStatus.APPROVED : VerificationStatus.REJECTED,
        rejectionReason: input.approve ? null : (input.reason ?? null),
        reviewedAt: new Date(),
        reviewedBy: input.reviewedBy,
      },
    });
  }
}

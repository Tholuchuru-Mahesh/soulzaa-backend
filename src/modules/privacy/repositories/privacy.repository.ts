import { Injectable } from '@nestjs/common';
import { BlockedUser, Prisma, PrivacySettings, UserPreferences } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Prisma access for the privacy module: privacy_settings, blocked_users and
 * user_preferences tables.
 */
@Injectable()
export class PrivacyRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- privacy_settings ----

  findSettings(userId: string): Promise<PrivacySettings | null> {
    return this.prisma.privacySettings.findUnique({ where: { userId } });
  }

  async ensureSettings(userId: string): Promise<PrivacySettings> {
    return this.prisma.privacySettings.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  updateSettings(
    userId: string,
    data: Prisma.PrivacySettingsUpdateInput,
  ): Promise<PrivacySettings> {
    return this.prisma.privacySettings.upsert({
      where: { userId },
      create: { userId, ...(data as any) },
      update: data,
    });
  }

  // ---- user_preferences ----

  findPreferences(userId: string): Promise<UserPreferences | null> {
    return this.prisma.userPreferences.findUnique({ where: { userId } });
  }

  async ensurePreferences(userId: string): Promise<UserPreferences> {
    return this.prisma.userPreferences.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  updatePreferences(
    userId: string,
    data: Prisma.UserPreferencesUpdateInput,
  ): Promise<UserPreferences> {
    return this.prisma.userPreferences.upsert({
      where: { userId },
      create: { userId, ...(data as any) },
      update: data,
    });
  }

  // ---- blocked_users ----

  createBlock(blockerId: string, blockedId: string, reason?: string | null): Promise<BlockedUser> {
    return this.prisma.blockedUser.create({
      data: { blockerId, blockedId, reason: reason ?? null },
    });
  }

  deleteBlock(blockerId: string, blockedId: string): Promise<Prisma.BatchPayload> {
    return this.prisma.blockedUser.deleteMany({ where: { blockerId, blockedId } });
  }

  blockExists(blockerId: string, blockedId: string): Promise<BlockedUser | null> {
    return this.prisma.blockedUser.findUnique({
      where: { blockerId_blockedId: { blockerId, blockedId } },
    });
  }

  listBlocked(blockerId: string): Promise<BlockedUser[]> {
    return this.prisma.blockedUser.findMany({
      where: { blockerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getUsersDetails(userIds: string[]) {
    if (userIds.length === 0) return [];
    return this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true, fullName: true },
    });
  }

  async getUserProfiles(userIds: string[]) {
    if (userIds.length === 0) return [];
    return this.prisma.userProfile.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, avatarKey: true },
    });
  }

  /** Every user id in a block relationship with `userId` (both directions). */
  async blockRelationshipIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.blockedUser.findMany({
      where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      select: { blockerId: true, blockedId: true },
    });
    const ids = new Set<string>();
    for (const r of rows) ids.add(r.blockerId === userId ? r.blockedId : r.blockerId);
    return [...ids];
  }
}

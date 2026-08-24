import { Injectable } from '@nestjs/common';
import { Family, FamilyBan, FamilyJoinRequest, FamilyMember, Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class FamiliesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<Family | null> {
    return this.prisma.family.findUnique({
      where: { id },
    });
  }

  findByName(name: string): Promise<Family | null> {
    return this.prisma.family.findFirst({
      where: {
        name: {
          equals: name,
          mode: 'insensitive',
        },
      },
    });
  }

  findMemberByUserId(userId: string): Promise<FamilyMember | null> {
    return this.prisma.familyMember.findUnique({
      where: { userId },
    });
  }

  countMembers(familyId: string): Promise<number> {
    return this.prisma.familyMember.count({
      where: { familyId },
    });
  }

  findRequestById(id: string): Promise<FamilyJoinRequest | null> {
    return this.prisma.familyJoinRequest.findUnique({
      where: { id },
    });
  }

  findRequestByFamilyAndUser(familyId: string, userId: string): Promise<FamilyJoinRequest | null> {
    return this.prisma.familyJoinRequest.findFirst({
      where: { familyId, userId, status: 'PENDING' },
    });
  }

  async createFamily(
    familyData: Prisma.FamilyUncheckedCreateInput,
    leaderData: Omit<Prisma.FamilyMemberUncheckedCreateInput, 'familyId'>,
  ): Promise<Family> {
    return this.prisma.$transaction(async (tx) => {
      const family = await tx.family.create({
        data: familyData,
      });

      await tx.familyMember.create({
        data: {
          ...leaderData,
          familyId: family.id,
          role: 'FOUNDER',
        },
      });

      await tx.familyHistory.create({
        data: {
          familyId: family.id,
          userId: family.founderId,
          action: 'CREATE',
          details: { familyName: family.name },
        },
      });

      return family;
    });
  }

  async deleteFamily(familyId: string, founderId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.familyHistory.create({
        data: {
          familyId,
          userId: founderId,
          action: 'DELETE',
        },
      });

      await tx.familyJoinRequest.deleteMany({
        where: { familyId },
      });

      await tx.familyMember.deleteMany({
        where: { familyId },
      });

      await tx.family.delete({
        where: { id: familyId },
      });
    });
  }

  updateFamily(familyId: string, data: Prisma.FamilyUpdateInput): Promise<Family> {
    return this.prisma.family.update({
      where: { id: familyId },
      data,
    });
  }

  updateMember(memberId: string, data: Prisma.FamilyMemberUpdateInput): Promise<FamilyMember> {
    return this.prisma.familyMember.update({
      where: { id: memberId },
      data,
    });
  }

  async addMember(familyId: string, userId: string, role: any = 'MEMBER'): Promise<FamilyMember> {
    return this.prisma.$transaction(async (tx) => {
      const member = await tx.familyMember.create({
        data: {
          familyId,
          userId,
          role: role || 'MEMBER',
        },
      });

      await tx.family.update({
        where: { id: familyId },
        data: {
          memberCount: {
            increment: 1,
          },
        },
      });

      return member;
    });
  }

  async removeMember(familyId: string, userId: string, actorId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.familyMember.delete({
        where: { userId },
      });

      await tx.family.update({
        where: { id: familyId },
        data: {
          memberCount: {
            decrement: 1,
          },
        },
      });

      await tx.familyHistory.create({
        data: {
          familyId,
          userId: actorId,
          action: actorId === userId ? 'LEAVE' : 'KICK',
          details: { kickedUserId: userId },
        },
      });
    });
  }

  // ---- Ban helpers ----

  findBan(familyId: string, userId: string): Promise<FamilyBan | null> {
    return this.prisma.familyBan.findUnique({
      where: { familyId_userId: { familyId, userId } },
    });
  }

  createBan(
    familyId: string,
    userId: string,
    bannedById: string,
    reason?: string,
  ): Promise<FamilyBan> {
    return this.prisma.familyBan.upsert({
      where: { familyId_userId: { familyId, userId } },
      create: { familyId, userId, bannedById, reason },
      update: { bannedById, reason },
    });
  }

  deleteBan(familyId: string, userId: string): Promise<number> {
    return this.prisma.familyBan.deleteMany({ where: { familyId, userId } }).then((r) => r.count);
  }

  // ---- Join-request helpers ----

  createRequest(data: Prisma.FamilyJoinRequestUncheckedCreateInput): Promise<FamilyJoinRequest> {
    return this.prisma.familyJoinRequest.create({ data });
  }

  updateRequest(id: string, data: Prisma.FamilyJoinRequestUpdateInput): Promise<FamilyJoinRequest> {
    return this.prisma.familyJoinRequest.update({
      where: { id },
      data,
    });
  }

  async acceptRequest(
    requestId: string,
    familyId: string,
    userId: string,
    actorId: string,
    role: any = 'MEMBER',
  ): Promise<FamilyMember> {
    return this.prisma.$transaction(async (tx) => {
      await tx.familyJoinRequest.update({
        where: { id: requestId },
        data: { status: 'APPROVED' },
      });

      const member = await tx.familyMember.create({
        data: {
          familyId,
          userId,
          role: role || 'MEMBER',
        },
      });

      await tx.family.update({
        where: { id: familyId },
        data: {
          memberCount: {
            increment: 1,
          },
        },
      });

      await tx.familyHistory.create({
        data: {
          familyId,
          userId: actorId,
          action: 'ACCEPT_REQUEST',
          details: { acceptedUserId: userId, requestId },
        },
      });

      return member;
    });
  }

  async rejectRequest(
    requestId: string,
    familyId: string,
    userId: string,
    actorId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.familyJoinRequest.update({
        where: { id: requestId },
        data: { status: 'REJECTED' },
      });

      await tx.familyHistory.create({
        data: {
          familyId,
          userId: actorId,
          action: 'REJECT_REQUEST',
          details: { rejectedUserId: userId, requestId },
        },
      });
    });
  }

  listFamilies(skip: number, take: number, search?: string): Promise<[Family[], number]> {
    const where: Prisma.FamilyWhereInput = search
      ? {
          name: {
            contains: search,
            mode: 'insensitive',
          },
        }
      : {};

    return this.prisma.$transaction([
      this.prisma.family.findMany({
        where,
        skip: Number(skip) || 0,
        take: Number(take) || 20,
        orderBy: { level: 'desc' },
      }),
      this.prisma.family.count({ where }),
    ]);
  }

  async listMembers(familyId: string, skip: number, take: number): Promise<[any[], number]> {
    const where = { familyId };
    const [members, total] = await this.prisma.$transaction([
      this.prisma.familyMember.findMany({
        where,
        skip: Number(skip) || 0,
        take: Number(take) || 20,
        orderBy: { expContribution: 'desc' },
      }),
      this.prisma.familyMember.count({ where }),
    ]);

    const userIds = members.map((m) => m.userId);
    const users =
      userIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true, fullName: true },
          })
        : [];
    const profiles =
      userIds.length > 0
        ? await this.prisma.userProfile.findMany({
            where: { userId: { in: userIds } },
            select: { userId: true, avatarKey: true },
          })
        : [];
    const userMap = new Map(users.map((u) => [u.id, u]));
    const profileMap = new Map(profiles.map((p) => [p.userId, p]));

    const enriched = members.map((m) => {
      const u = userMap.get(m.userId);
      const p = profileMap.get(m.userId);
      const points = Number(m.coinContribution ?? m.expContribution ?? 0);
      return {
        ...m,
        contributionPoints: points,
        coinContribution: points,
        expContribution: points,
        username: u?.username || u?.fullName,
        avatarKey: p?.avatarKey,
      };
    });

    return [enriched, total];
  }

  /**
   * Everyone who runs the family: FOUNDER, CO_FOUNDER, ELDER. Used to keep
   * membership-churn notifications off the whole roster — see
   * FamilyNotificationListener. `@@index([familyId, role])` covers this.
   */
  async listOfficerIds(familyId: string): Promise<string[]> {
    const rows = await this.prisma.familyMember.findMany({
      where: { familyId, role: { in: ['FOUNDER', 'CO_FOUNDER', 'ELDER'] } },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /** Every member, officers included. */
  async listMemberIds(familyId: string): Promise<string[]> {
    const rows = await this.prisma.familyMember.findMany({
      where: { familyId },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  listRequests(
    familyId: string,
    status: string,
    skip: number,
    take: number,
  ): Promise<[FamilyJoinRequest[], number]> {
    const where = { familyId, status };
    return this.prisma.$transaction([
      this.prisma.familyJoinRequest.findMany({
        where,
        skip: Number(skip) || 0,
        take: Number(take) || 20,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.familyJoinRequest.count({ where }),
    ]);
  }

  logAction(familyId: string, userId: string, action: string, details?: Prisma.InputJsonValue) {
    return this.prisma.familyHistory.create({
      data: {
        familyId,
        userId,
        action,
        details: details ?? undefined,
      },
    });
  }

  async getUserSummary(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true, fullName: true },
    });
    const profile = await this.prisma.userProfile.findUnique({
      where: { userId },
      select: { avatarKey: true },
    });
    return {
      username: user?.username || 'Member',
      fullName: user?.fullName || null,
      avatarKey: profile?.avatarKey || null,
    };
  }

  createMessage(
    familyId: string,
    userId: string,
    content: string,
    senderName: string,
    senderRole: string,
    avatarUrl?: string | null,
    mediaType?: string | null,
    mediaUrl?: string | null,
    mediaName?: string | null,
    mediaSize?: number | null,
  ) {
    return this.prisma.familyHistory.create({
      data: {
        familyId,
        userId,
        action: 'CHAT_MESSAGE',
        details: {
          content,
          senderName,
          senderRole,
          avatarUrl: avatarUrl ?? null,
          mediaType: mediaType ?? null,
          mediaUrl: mediaUrl ?? null,
          mediaName: mediaName ?? null,
          mediaSize: mediaSize ?? null,
        },
      },
    });
  }

  formatActivityLog(
    action: string,
    actorUserId: string | null,
    details: Record<string, any>,
    nameMap: Map<string, string>,
  ): string {
    const actor = actorUserId ? nameMap.get(actorUserId) || 'A member' : 'A member';
    const targetUserId =
      details.kickedUserId ||
      details.acceptedUserId ||
      details.rejectedUserId ||
      details.targetUserId ||
      details.newLeaderId;
    const target = targetUserId ? nameMap.get(targetUserId) || 'A member' : 'A member';

    switch (action.toUpperCase()) {
      case 'CREATE':
      case 'FAMILY_CREATED':
        return `${actor} created the family`;
      case 'JOIN':
      case 'MEMBER_JOINED':
        return `${actor} joined the family`;
      case 'ACCEPT_REQUEST':
      case 'JOIN_REQUEST_APPROVED':
        return `${target} joined the family (approved by ${actor})`;
      case 'REJECT_REQUEST':
      case 'JOIN_REQUEST_REJECTED':
        return `${target}'s join request was declined by ${actor}`;
      case 'LEAVE':
      case 'MEMBER_LEFT':
        return `${actor} left the family`;
      case 'KICK':
      case 'MEMBER_KICKED':
        return `${target} was removed from the family by ${actor}`;
      case 'MEMBER_BANNED':
        return `${target} was banned from the family by ${actor}`;
      case 'PROMOTE':
      case 'PROMOTE_MEMBER':
      case 'ROLE_ASSIGNED': {
        const role = (details.newRole || details.role || 'Officer').replace(/_/g, ' ');
        return `${target} was promoted to ${role} by ${actor}`;
      }
      case 'TRANSFER_LEADERSHIP':
        return `${actor} transferred family leadership to ${target}`;
      case 'EDIT_PROFILE':
      case 'SETTINGS_UPDATED':
      case 'UPDATE':
      case 'FAMILY_UPDATED':
        return `${actor} updated the family settings`;
      default:
        return `${actor}: ${action.toLowerCase().replace(/_/g, ' ')}`;
    }
  }

  async listMessages(familyId: string, skip: number, take: number): Promise<[any[], number]> {
    const where = { familyId };
    const [records, total] = await this.prisma.$transaction([
      this.prisma.familyHistory.findMany({
        where,
        skip: Number(skip) || 0,
        take: Number(take) || 50,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.familyHistory.count({ where }),
    ]);

    // Collect all referenced user IDs for a single batch lookup
    const userIds = new Set<string>();
    for (const r of records) {
      if (r.userId) userIds.add(r.userId);
      const details = (r.details as Record<string, any>) || {};
      if (details.kickedUserId) userIds.add(details.kickedUserId);
      if (details.acceptedUserId) userIds.add(details.acceptedUserId);
      if (details.rejectedUserId) userIds.add(details.rejectedUserId);
      if (details.targetUserId) userIds.add(details.targetUserId);
      if (details.newLeaderId) userIds.add(details.newLeaderId);
      if (details.actorId) userIds.add(details.actorId);
    }

    const users =
      userIds.size > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: [...userIds] } },
            select: { id: true, username: true, fullName: true },
          })
        : [];
    const nameMap = new Map<string, string>(
      users.map((u) => [u.id, u.fullName || u.username || 'Member']),
    );

    const items = records.map((r) => {
      const details = (r.details as Record<string, any>) || {};
      if (r.action === 'CHAT_MESSAGE') {
        let cleanMedia = details.mediaUrl || null;
        if (cleanMedia && typeof cleanMedia === 'string') {
          if (cleanMedia.includes('?')) {
            cleanMedia = cleanMedia.split('?')[0];
          }
          const match = cleanMedia.match(/(chat-images\/[^\s]+|chat-videos\/[^\s]+|chat-files\/[^\s]+|chat-voice\/[^\s]+|profile-images\/[^\s]+)/);
          if (match) {
            cleanMedia = match[1];
          }
        }

        return {
          id: r.id,
          familyId: r.familyId,
          senderId: r.userId || '',
          senderName: details.senderName || nameMap.get(r.userId || '') || 'Member',
          senderRole: details.senderRole || 'MEMBER',
          content: details.content || '',
          mediaType: details.mediaType || null,
          mediaUrl: cleanMedia,
          mediaName: details.mediaName || null,
          mediaSize: details.mediaSize || null,
          avatarUrl: details.avatarUrl || null,
          timestamp: r.createdAt,
          isSystem: false,
        };
      }

      // Format human-readable activity log as a system message
      const systemContent = this.formatActivityLog(r.action, r.userId, details, nameMap);
      return {
        id: r.id,
        familyId: r.familyId,
        senderId: 'system',
        senderName: 'System',
        senderRole: 'MEMBER',
        content: systemContent,
        avatarUrl: null,
        timestamp: r.createdAt,
        isSystem: true,
      };
    });

    return [items, total];
  }

  listLogs(familyId: string, skip: number, take: number) {
    const where = { familyId };
    return this.prisma.$transaction([
      this.prisma.familyHistory.findMany({
        where,
        skip: Number(skip) || 0,
        take: Number(take) || 20,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.familyHistory.count({ where }),
    ]);
  }
}

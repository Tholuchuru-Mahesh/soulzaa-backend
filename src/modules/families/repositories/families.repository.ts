import { Injectable } from '@nestjs/common';
import {
  Family,
  FamilyJoinRequest,
  FamilyLog,
  FamilyMember,
  FamilyRequestStatus,
  FamilyRole,
  Prisma,
} from '@prisma/client';
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

  findRequestById(id: string): Promise<FamilyJoinRequest | null> {
    return this.prisma.familyJoinRequest.findUnique({
      where: { id },
    });
  }

  findRequestByFamilyAndUser(familyId: string, userId: string): Promise<FamilyJoinRequest | null> {
    return this.prisma.familyJoinRequest.findFirst({
      where: { familyId, userId, status: FamilyRequestStatus.PENDING },
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
          role: FamilyRole.LEADER,
        },
      });

      await tx.familyLog.create({
        data: {
          familyId: family.id,
          userId: family.leaderId,
          action: 'CREATE',
          metadata: { familyName: family.name },
        },
      });

      return family;
    });
  }

  async deleteFamily(familyId: string, leaderId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.familyLog.create({
        data: {
          familyId,
          userId: leaderId,
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

  async addMember(
    familyId: string,
    userId: string,
    role: FamilyRole = FamilyRole.MEMBER,
  ): Promise<FamilyMember> {
    return this.prisma.$transaction(async (tx) => {
      const member = await tx.familyMember.create({
        data: {
          familyId,
          userId,
          role,
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

      await tx.familyLog.create({
        data: {
          familyId,
          userId: actorId,
          action: actorId === userId ? 'LEAVE' : 'KICK',
          metadata: { kickedUserId: userId },
        },
      });
    });
  }

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
  ): Promise<FamilyMember> {
    return this.prisma.$transaction(async (tx) => {
      await tx.familyJoinRequest.update({
        where: { id: requestId },
        data: { status: FamilyRequestStatus.APPROVED },
      });

      const member = await tx.familyMember.create({
        data: {
          familyId,
          userId,
          role: FamilyRole.MEMBER,
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

      await tx.familyLog.create({
        data: {
          familyId,
          userId: actorId,
          action: 'ACCEPT_REQUEST',
          metadata: { acceptedUserId: userId, requestId },
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
        data: { status: FamilyRequestStatus.REJECTED },
      });

      await tx.familyLog.create({
        data: {
          familyId,
          userId: actorId,
          action: 'REJECT_REQUEST',
          metadata: { rejectedUserId: userId, requestId },
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
        skip,
        take,
        orderBy: { level: 'desc' },
      }),
      this.prisma.family.count({ where }),
    ]);
  }

  listMembers(familyId: string, skip: number, take: number): Promise<[FamilyMember[], number]> {
    const where = { familyId };
    return this.prisma.$transaction([
      this.prisma.familyMember.findMany({
        where,
        skip,
        take,
        orderBy: { role: 'asc' }, // LEADER, CO_LEADER, ELDER, MEMBER order
      }),
      this.prisma.familyMember.count({ where }),
    ]);
  }

  listRequests(
    familyId: string,
    status: FamilyRequestStatus,
    skip: number,
    take: number,
  ): Promise<[FamilyJoinRequest[], number]> {
    const where = { familyId, status };
    return this.prisma.$transaction([
      this.prisma.familyJoinRequest.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.familyJoinRequest.count({ where }),
    ]);
  }

  logAction(
    familyId: string,
    userId: string,
    action: string,
    metadata?: Prisma.InputJsonValue,
  ): Promise<FamilyLog> {
    return this.prisma.familyLog.create({
      data: {
        familyId,
        userId,
        action,
        metadata: metadata ?? undefined,
      },
    });
  }

  listLogs(familyId: string, skip: number, take: number): Promise<[FamilyLog[], number]> {
    const where = { familyId };
    return this.prisma.$transaction([
      this.prisma.familyLog.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.familyLog.count({ where }),
    ]);
  }
}

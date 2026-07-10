import { Injectable } from '@nestjs/common';
import { Invitation, InvitationStatus, InvitationType, Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/** Prisma access for the `invitations` table (user-to-user resource invites). */
@Injectable()
export class InvitationRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: {
    type: InvitationType;
    inviterId: string;
    inviteeId: string;
    targetId: string | null;
    payload: Prisma.InputJsonValue | undefined;
    expiresAt: Date;
  }): Promise<Invitation> {
    return this.prisma.invitation.create({
      data: {
        type: data.type,
        inviterId: data.inviterId,
        inviteeId: data.inviteeId,
        targetId: data.targetId,
        payload: data.payload,
        expiresAt: data.expiresAt,
      },
    });
  }

  findById(id: string): Promise<Invitation | null> {
    return this.prisma.invitation.findUnique({ where: { id } });
  }

  markStatus(id: string, status: InvitationStatus): Promise<Invitation> {
    return this.prisma.invitation.update({
      where: { id },
      data: { status, respondedAt: new Date() },
    });
  }

  async pageIncoming(
    userId: string,
    type: InvitationType | undefined,
    skip: number,
    take: number,
  ): Promise<{ rows: Invitation[]; total: number }> {
    const where: Prisma.InvitationWhereInput = {
      inviteeId: userId,
      status: InvitationStatus.PENDING,
      ...(type ? { type } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.invitation.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.invitation.count({ where }),
    ]);
    return { rows, total };
  }

  async pageOutgoing(
    userId: string,
    type: InvitationType | undefined,
    skip: number,
    take: number,
  ): Promise<{ rows: Invitation[]; total: number }> {
    const where: Prisma.InvitationWhereInput = {
      inviterId: userId,
      status: InvitationStatus.PENDING,
      ...(type ? { type } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.invitation.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.invitation.count({ where }),
    ]);
    return { rows, total };
  }

  /** Sweep expired PENDING invitations to EXPIRED. Returns the number flipped. */
  async expirePending(now: Date): Promise<number> {
    const res = await this.prisma.invitation.updateMany({
      where: { status: InvitationStatus.PENDING, expiresAt: { lt: now } },
      data: { status: InvitationStatus.EXPIRED },
    });
    return res.count;
  }
}

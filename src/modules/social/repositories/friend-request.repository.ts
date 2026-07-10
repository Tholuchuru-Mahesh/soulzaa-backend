import { Injectable } from '@nestjs/common';
import { FriendRequest, FriendRequestStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { orderPair } from './friendship.repository';

/**
 * Prisma access for the `friend_requests` table plus the atomic accept
 * transaction (create the canonical friendship + flip the request in one
 * commit). Owned by the social module.
 */
@Injectable()
export class FriendRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<FriendRequest | null> {
    return this.prisma.friendRequest.findUnique({ where: { id } });
  }

  /** The row for a directed pair, regardless of status (unique per pair). */
  findPair(requesterId: string, addresseeId: string): Promise<FriendRequest | null> {
    return this.prisma.friendRequest.findUnique({
      where: { requesterId_addresseeId: { requesterId, addresseeId } },
    });
  }

  /** A live PENDING request in the reverse direction (they already asked us). */
  findReversePending(requesterId: string, addresseeId: string): Promise<FriendRequest | null> {
    return this.prisma.friendRequest.findFirst({
      where: {
        requesterId: addresseeId,
        addresseeId: requesterId,
        status: FriendRequestStatus.PENDING,
      },
    });
  }

  /** Create or re-open a PENDING request for a directed pair. */
  upsertPending(
    requesterId: string,
    addresseeId: string,
    message: string | null,
    expiresAt: Date,
  ): Promise<FriendRequest> {
    return this.prisma.friendRequest.upsert({
      where: { requesterId_addresseeId: { requesterId, addresseeId } },
      create: { requesterId, addresseeId, message, expiresAt, status: FriendRequestStatus.PENDING },
      update: {
        message,
        expiresAt,
        status: FriendRequestStatus.PENDING,
        respondedAt: null,
        createdAt: new Date(),
      },
    });
  }

  markStatus(id: string, status: FriendRequestStatus): Promise<FriendRequest> {
    return this.prisma.friendRequest.update({
      where: { id },
      data: { status, respondedAt: new Date() },
    });
  }

  async pageIncoming(
    userId: string,
    skip: number,
    take: number,
  ): Promise<{ rows: FriendRequest[]; total: number }> {
    const where = { addresseeId: userId, status: FriendRequestStatus.PENDING };
    const [rows, total] = await Promise.all([
      this.prisma.friendRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.friendRequest.count({ where }),
    ]);
    return { rows, total };
  }

  async pageOutgoing(
    userId: string,
    skip: number,
    take: number,
  ): Promise<{ rows: FriendRequest[]; total: number }> {
    const where = { requesterId: userId, status: FriendRequestStatus.PENDING };
    const [rows, total] = await Promise.all([
      this.prisma.friendRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.friendRequest.count({ where }),
    ]);
    return { rows, total };
  }

  /**
   * Atomically accept a request: mark it ACCEPTED and upsert the canonical
   * friendship. Returns the friendship id. Idempotent on the friendship via its
   * unique pair (a race can't create two rows).
   */
  async acceptRequest(
    requestId: string,
    requesterId: string,
    addresseeId: string,
  ): Promise<string> {
    const { userAId, userBId } = orderPair(requesterId, addresseeId);
    const [, friendship] = await this.prisma.$transaction([
      this.prisma.friendRequest.update({
        where: { id: requestId },
        data: { status: FriendRequestStatus.ACCEPTED, respondedAt: new Date() },
      }),
      this.prisma.friendship.upsert({
        where: { userAId_userBId: { userAId, userBId } },
        create: { userAId, userBId },
        update: {},
      }),
    ]);
    return friendship.id;
  }

  /** Sweep expired PENDING requests to EXPIRED. Returns the number flipped. */
  async expirePending(now: Date): Promise<number> {
    const res = await this.prisma.friendRequest.updateMany({
      where: { status: FriendRequestStatus.PENDING, expiresAt: { lt: now } },
      data: { status: FriendRequestStatus.EXPIRED },
    });
    return res.count;
  }
}

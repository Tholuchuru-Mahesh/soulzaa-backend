import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from 'src/modules/notification/interfaces/notification.interface';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';

/** Marks the notification so the client can render it as a join request. */
const JOIN_REQUEST_ENTITY = 'agency_join_request';

/**
 * Users asking to join an agency, and the agency deciding.
 *
 * Membership is `AgencyRelationship`; this is what creates one. The rules,
 * chosen to match the spec's exit policy:
 *
 *  * **One agency at a time.** Removal is only accepted between the 1st and
 *    2nd of a month, so a user cannot be in two at once — a request from
 *    someone already placed is refused rather than silently moving them.
 *  * **Requests only.** An agency cannot add a user who has not asked.
 *  * **The agency decides.** No Official confirmation step.
 */
@Injectable()
export class AgencyJoinRequestService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: INotificationService,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
  ) {}

  /** A user asks to join. */
  async request(userId: string, agencyId: string, message?: string) {
    if (userId === agencyId) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'You cannot ask to join your own agency',
      );
    }

    // The target has to actually be an approved agency, not any user id.
    const approved = await this.prisma.roleRequest.findFirst({
      where: { type: 'AGENCY', status: 'APPROVED', subjectUserId: agencyId },
      select: { id: true },
    });
    if (!approved) {
      throw new NotFoundException('Agency not found');
    }

    // One agency at a time. Checked across every agency, not just this one.
    const existingMembership = await this.prisma.agencyRelationship.findFirst({
      where: { hostId: userId, status: 'ACTIVE' },
      select: { agencyId: true },
    });
    if (existingMembership) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        existingMembership.agencyId === agencyId
          ? 'You are already a member of this agency'
          : 'You are already in an agency. Leave it before joining another.',
      );
    }

    // A second pending request would give the agency two rows for one person.
    const pending = await this.prisma.agencyJoinRequest.findFirst({
      where: { userId, agencyId, status: 'PENDING' },
      select: { id: true },
    });
    if (pending) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'You have already asked to join this agency',
      );
    }

    const created = await this.prisma.agencyJoinRequest.create({
      data: { agencyId, userId, message: message?.trim() || null },
    });

    const identity = (await this.profiles.resolvePublicIdentities([userId])).get(userId);
    await this.notify(agencyId, userId, {
      event: 'REQUESTED',
      requestId: created.id,
      applicantName: identity?.displayName ?? null,
    });

    return created;
  }

  /** The agency's pending requests, oldest first — a queue, not a feed. */
  async listForAgency(agencyId: string, status: 'PENDING' | 'ACCEPTED' | 'DECLINED' = 'PENDING') {
    const rows = await this.prisma.agencyJoinRequest.findMany({
      where: { agencyId, status },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    const identities = await this.profiles.resolvePublicIdentities(rows.map((r) => r.userId));

    return {
      items: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        displayName: identities.get(row.userId)?.displayName ?? null,
        avatarUrl: identities.get(row.userId)?.avatarUrl ?? null,
        message: row.message,
        status: row.status,
        requestedAt: row.createdAt,
      })),
      total: rows.length,
    };
  }

  /** How many are waiting — for the badge on Community Management. */
  pendingCount(agencyId: string): Promise<number> {
    return this.prisma.agencyJoinRequest.count({ where: { agencyId, status: 'PENDING' } });
  }

  /**
   * Accepts, creating the membership.
   *
   * The decision and the relationship are written together: a request marked
   * accepted without a membership row would show the applicant as approved
   * while the agency never gained a member.
   */
  async accept(agencyId: string, requestId: string) {
    const request = await this.requirePending(agencyId, requestId);

    // Re-checked at decision time, not just at request time — the applicant
    // may have joined another agency while this sat in the queue.
    const elsewhere = await this.prisma.agencyRelationship.findFirst({
      where: { hostId: request.userId, status: 'ACTIVE' },
      select: { agencyId: true },
    });
    if (elsewhere) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'This user has already joined an agency',
      );
    }

    const accepted = await this.prisma.$transaction(async (tx) => {
      await tx.agencyRelationship.upsert({
        where: { agencyId_hostId: { agencyId, hostId: request.userId } },
        create: { agencyId, hostId: request.userId, status: 'ACTIVE' },
        // Re-joining after leaving reuses the row rather than failing on the
        // unique constraint.
        update: { status: 'ACTIVE', effectiveFrom: new Date(), effectiveUntil: null },
      });

      return tx.agencyJoinRequest.update({
        where: { id: requestId },
        data: { status: 'ACCEPTED', decidedAt: new Date(), decidedBy: agencyId },
      });
    });

    await this.notify(request.userId, agencyId, {
      event: 'ACCEPTED',
      requestId,
    });

    return accepted;
  }

  async decline(agencyId: string, requestId: string) {
    const request = await this.requirePending(agencyId, requestId);

    const declined = await this.prisma.agencyJoinRequest.update({
      where: { id: requestId },
      data: { status: 'DECLINED', decidedAt: new Date(), decidedBy: agencyId },
    });

    await this.notify(request.userId, agencyId, { event: 'DECLINED', requestId });
    return declined;
  }

  /** The applicant withdrawing before a decision. */
  async cancel(userId: string, requestId: string) {
    const request = await this.prisma.agencyJoinRequest.findFirst({
      where: { id: requestId, userId, status: 'PENDING' },
    });
    if (!request) {
      throw new NotFoundException('Request not found');
    }
    return this.prisma.agencyJoinRequest.update({
      where: { id: requestId },
      data: { status: 'CANCELLED', decidedAt: new Date() },
    });
  }

  /** The caller's own outstanding request, so the button can show its state. */
  async myRequest(userId: string) {
    return this.prisma.agencyJoinRequest.findFirst({
      where: { userId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Scoped to the agency, so one agency cannot decide another's queue. */
  private async requirePending(agencyId: string, requestId: string) {
    const request = await this.prisma.agencyJoinRequest.findFirst({
      where: { id: requestId, agencyId, status: 'PENDING' },
    });
    if (!request) {
      throw new NotFoundException('Request not found');
    }
    return request;
  }

  /**
   * Notification is best-effort: a failure here must not undo an accepted
   * membership, which is already committed by the time this runs.
   */
  private async notify(
    recipientId: string,
    actorId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.notifications.create({
        userId: recipientId,
        type: 'SYSTEM',
        actorId,
        entityType: JOIN_REQUEST_ENTITY,
        entityId: data.requestId as string,
        data,
      });
    } catch {
      // Swallowed deliberately — see above.
    }
  }
}

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { resolveUserCountryCode } from 'src/modules/coin-seller-settlement/utils/resolve-user-country';
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

  /**
   * Users the agency may invite: same country, not already in an agency, and
   * not already holding an open invitation or request.
   *
   * Country-scoped for the same reason coin sales are — an agency operates in
   * one territory, and listing users elsewhere would both be useless and leak
   * where strangers live.
   */
  async listInvitable(agencyId: string, options: { search?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 50);
    const country = await resolveUserCountryCode(this.prisma, agencyId);
    if (!country) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Set your agency country before inviting members',
      );
    }

    // Anyone already placed is not invitable, whichever agency they are in.
    const placed = await this.prisma.agencyRelationship.findMany({
      where: { status: 'ACTIVE' },
      select: { hostId: true },
    });
    const openRequests = await this.prisma.agencyJoinRequest.findMany({
      where: { status: 'PENDING' },
      select: { userId: true },
    });
    const excluded = new Set<string>([
      agencyId,
      ...placed.map((r) => r.hostId),
      ...openRequests.map((r) => r.userId),
    ]);

    const search = options.search?.trim();
    const candidates = await this.prisma.user.findMany({
      where: {
        id: { notIn: [...excluded] },
        ...(search ? { username: { contains: search, mode: 'insensitive' as const } } : {}),
      },
      select: { id: true, username: true, fullName: true, country: true, countryId: true },
      orderBy: { createdAt: 'desc' },
      // Over-fetched because the country filter below cannot be expressed in
      // one query — country lives in two columns.
      take: limit * 4,
    });

    const items = [];
    for (const candidate of candidates) {
      if (items.length >= limit) break;
      if ((await resolveUserCountryCode(this.prisma, candidate.id)) !== country) continue;
      items.push(candidate.id);
    }

    const identities = await this.profiles.resolvePublicIdentities(items);
    return {
      items: items.map((id) => ({
        userId: id,
        displayName: identities.get(id)?.displayName ?? null,
        avatarUrl: identities.get(id)?.avatarUrl ?? null,
      })),
      total: items.length,
    };
  }

  /**
   * Invites a user to join. They accept or decline; the agency cannot add them
   * unilaterally.
   */
  async invite(agencyId: string, userId: string, message?: string) {
    if (agencyId === userId) {
      throw new BusinessException(ERROR_CODES.VALIDATION_ERROR, 'You cannot invite yourself');
    }

    const placed = await this.prisma.agencyRelationship.findFirst({
      where: { hostId: userId, status: 'ACTIVE' },
      select: { agencyId: true },
    });
    if (placed) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'That user is already in an agency',
      );
    }

    const open = await this.prisma.agencyJoinRequest.findFirst({
      where: { userId, status: 'PENDING' },
      select: { id: true },
    });
    if (open) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'That user already has an open request or invitation',
      );
    }

    const created = await this.prisma.agencyJoinRequest.create({
      data: {
        agencyId,
        userId,
        initiatedBy: 'AGENCY',
        message: message?.trim() || null,
      },
    });

    const identity = (await this.profiles.resolvePublicIdentities([agencyId])).get(agencyId);
    await this.notify(userId, agencyId, {
      event: 'INVITED',
      requestId: created.id,
      agencyName: identity?.displayName ?? null,
    });

    return created;
  }

  /** Invitations waiting on the calling user. */
  async listMyInvitations(userId: string) {
    const rows = await this.prisma.agencyJoinRequest.findMany({
      where: { userId, status: 'PENDING', initiatedBy: 'AGENCY' },
      orderBy: { createdAt: 'desc' },
    });
    const identities = await this.profiles.resolvePublicIdentities(rows.map((r) => r.agencyId));
    return {
      items: rows.map((row) => ({
        id: row.id,
        agencyId: row.agencyId,
        agencyName: identities.get(row.agencyId)?.displayName ?? null,
        message: row.message,
        invitedAt: row.createdAt,
      })),
    };
  }

  /**
   * The invited user accepting. Mirrors `accept`, but the decider is the user,
   * so ownership is checked against `userId` rather than `agencyId`.
   */
  async acceptInvitation(userId: string, requestId: string) {
    const invitation = await this.prisma.agencyJoinRequest.findFirst({
      where: { id: requestId, userId, status: 'PENDING', initiatedBy: 'AGENCY' },
    });
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    const placed = await this.prisma.agencyRelationship.findFirst({
      where: { hostId: userId, status: 'ACTIVE' },
      select: { agencyId: true },
    });
    if (placed) {
      throw new BusinessException(ERROR_CODES.VALIDATION_ERROR, 'You are already in an agency');
    }

    const accepted = await this.prisma.$transaction(async (tx) => {
      await tx.agencyRelationship.upsert({
        where: { agencyId_hostId: { agencyId: invitation.agencyId, hostId: userId } },
        create: { agencyId: invitation.agencyId, hostId: userId, status: 'ACTIVE' },
        update: { status: 'ACTIVE', effectiveFrom: new Date(), effectiveUntil: null },
      });
      return tx.agencyJoinRequest.update({
        where: { id: requestId },
        data: { status: 'ACCEPTED', decidedAt: new Date(), decidedBy: userId },
      });
    });

    await this.notify(invitation.agencyId, userId, { event: 'INVITE_ACCEPTED', requestId });
    return accepted;
  }

  async declineInvitation(userId: string, requestId: string) {
    const invitation = await this.prisma.agencyJoinRequest.findFirst({
      where: { id: requestId, userId, status: 'PENDING', initiatedBy: 'AGENCY' },
    });
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }
    const declined = await this.prisma.agencyJoinRequest.update({
      where: { id: requestId },
      data: { status: 'DECLINED', decidedAt: new Date(), decidedBy: userId },
    });
    await this.notify(invitation.agencyId, userId, { event: 'INVITE_DECLINED', requestId });
    return declined;
  }

  /** The agency's pending requests, oldest first — a queue, not a feed. */
  async listForAgency(agencyId: string, status: 'PENDING' | 'ACCEPTED' | 'DECLINED' = 'PENDING') {
    const rows = await this.prisma.agencyJoinRequest.findMany({
      // Only what users asked for. An invitation the agency sent is not
      // something it has to answer, so it does not belong in this queue.
      where: { agencyId, status, initiatedBy: 'USER' },
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
    return this.prisma.agencyJoinRequest.count({
      where: { agencyId, status: 'PENDING', initiatedBy: 'USER' },
    });
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

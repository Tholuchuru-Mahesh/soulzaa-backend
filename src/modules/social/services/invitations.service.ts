import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Invitation, InvitationStatus, InvitationType, Prisma } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import {
  PRIVACY_SERVICE,
  type IPrivacyService,
} from 'src/modules/privacy/interfaces/privacy.interface';
import { INVITATION_TTL_MS } from '../constants/social.constants';
import {
  InvitationAcceptedEvent,
  InvitationDeclinedEvent,
  InvitationSentEvent,
} from '../events/social.events';
import type { InvitationView } from '../interfaces/social.interface';
import { InvitationRepository } from '../repositories/invitation.repository';
import { CardResolver } from './card.resolver';

/**
 * User-to-user invitations to a resource (audio room / game / family / PK /
 * event). Block-gated, expirable, invitee-only accept/decline. Publishes events
 * for realtime delivery + notifications. The client acts on `targetId` (e.g.
 * joins the room) after accepting.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly repo: InvitationRepository,
    private readonly cards: CardResolver,
    @Inject(PRIVACY_SERVICE) private readonly privacy: IPrivacyService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async create(
    inviterId: string,
    dto: {
      type: InvitationType;
      inviteeUserId: string;
      targetId?: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<{ invitationId: string; expiresAt: Date }> {
    if (inviterId === dto.inviteeUserId) {
      throw new BusinessException(
        ERROR_CODES.CANNOT_INVITE_SELF,
        'You cannot invite yourself',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (await this.privacy.isBlockedEitherWay(inviterId, dto.inviteeUserId)) {
      throw new BusinessException(
        ERROR_CODES.USER_BLOCKED,
        'You cannot invite this user',
        HttpStatus.FORBIDDEN,
      );
    }
    const row = await this.repo.create({
      type: dto.type,
      inviterId,
      inviteeId: dto.inviteeUserId,
      targetId: dto.targetId ?? null,
      payload: (dto.payload as Prisma.InputJsonValue | undefined) ?? undefined,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    });
    await this.bus.publish(
      new InvitationSentEvent({
        invitationId: row.id,
        type: row.type,
        inviterId,
        inviteeId: row.inviteeId,
        targetId: row.targetId,
        payload: row.payload,
        expiresAt: row.expiresAt,
      }),
    );
    return { invitationId: row.id, expiresAt: row.expiresAt };
  }

  async accept(
    id: string,
    userId: string,
  ): Promise<{ status: InvitationStatus; type: InvitationType; targetId: string | null }> {
    const inv = await this.loadActionable(id);
    if (inv.inviteeId !== userId) throw this.notFound();
    await this.repo.markStatus(inv.id, InvitationStatus.ACCEPTED);
    await this.bus.publish(
      new InvitationAcceptedEvent({
        invitationId: inv.id,
        type: inv.type,
        inviterId: inv.inviterId,
        inviteeId: inv.inviteeId,
        targetId: inv.targetId,
      }),
    );
    return { status: InvitationStatus.ACCEPTED, type: inv.type, targetId: inv.targetId };
  }

  async decline(id: string, userId: string): Promise<{ status: InvitationStatus }> {
    const inv = await this.loadActionable(id);
    if (inv.inviteeId !== userId) throw this.notFound();
    await this.repo.markStatus(inv.id, InvitationStatus.DECLINED);
    await this.bus.publish(
      new InvitationDeclinedEvent({
        invitationId: inv.id,
        inviterId: inv.inviterId,
        inviteeId: inv.inviteeId,
      }),
    );
    return { status: InvitationStatus.DECLINED };
  }

  async cancel(id: string, userId: string): Promise<{ status: InvitationStatus }> {
    const inv = await this.loadActionable(id);
    if (inv.inviterId !== userId) throw this.notFound();
    await this.repo.markStatus(inv.id, InvitationStatus.CANCELLED);
    return { status: InvitationStatus.CANCELLED };
  }

  async incoming(
    userId: string,
    page: number,
    limit: number,
    type?: InvitationType,
  ): Promise<Paginated<InvitationView>> {
    const { rows, total } = await this.repo.pageIncoming(userId, type, (page - 1) * limit, limit);
    return buildPaginated(await this.toViews(rows, (r) => r.inviterId), total, page, limit);
  }

  async outgoing(
    userId: string,
    page: number,
    limit: number,
    type?: InvitationType,
  ): Promise<Paginated<InvitationView>> {
    const { rows, total } = await this.repo.pageOutgoing(userId, type, (page - 1) * limit, limit);
    return buildPaginated(await this.toViews(rows, (r) => r.inviteeId), total, page, limit);
  }

  // ---- Helpers ----

  private async loadActionable(id: string): Promise<Invitation> {
    const inv = await this.repo.findById(id);
    if (!inv) throw this.notFound();
    if (inv.status !== InvitationStatus.PENDING) {
      throw new BusinessException(
        ERROR_CODES.INVITATION_NOT_PENDING,
        'This invitation is no longer pending',
        HttpStatus.CONFLICT,
      );
    }
    if (inv.expiresAt.getTime() < Date.now()) {
      throw new BusinessException(
        ERROR_CODES.INVITATION_EXPIRED,
        'This invitation has expired',
        HttpStatus.GONE,
      );
    }
    return inv;
  }

  private async toViews(
    rows: Invitation[],
    pick: (r: Invitation) => string,
  ): Promise<InvitationView[]> {
    const cards = await this.cards.resolve(rows.map(pick));
    const byId = new Map(cards.map((c) => [c.userId, c]));
    const views: InvitationView[] = [];
    for (const r of rows) {
      const user = byId.get(pick(r));
      if (!user) continue;
      views.push({
        invitationId: r.id,
        type: r.type,
        targetId: r.targetId,
        payload: r.payload,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        user,
      });
    }
    return views;
  }

  private notFound(): BusinessException {
    return new BusinessException(
      ERROR_CODES.INVITATION_NOT_FOUND,
      'Invitation not found',
      HttpStatus.NOT_FOUND,
    );
  }
}

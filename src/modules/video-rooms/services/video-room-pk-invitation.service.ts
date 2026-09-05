import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  VideoRoomPkBattle,
  VideoRoomPkInvitationStatus,
  VideoRoomPkSide,
  VideoRoomPkStatus,
} from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { loadVideoRoomPkConfig } from '../config/video-room-pk.config';
import {
  PkInvitationAcceptedEvent,
  PkInvitationRejectedEvent,
  PkInvitationSentEvent,
} from '../events/video-room-pk.events';
import { PKInvitationException } from '../exceptions/video-room-pk.exceptions';
import { VideoRoomPkInvitationRepository } from '../repositories/video-room-pk-invitation.repository';
import { VideoRoomPkStateService } from './video-room-pk-state.service';

/** The battle fields the invitation workflow actually needs. */
export type PkBattleRef = Pick<VideoRoomPkBattle, 'id' | 'roomId' | 'status'> & {
  durationSeconds?: number;
};

/**
 * `send()`'s invitee list. A bare userId defaults to RED — a dev/test
 * convenience, not a real team assignment — so a real caller that already
 * knows which side an invitee is joining (a TEAM battle's red/blue split)
 * passes `{ userId, side }` instead. Either shape is fine to mix in one call.
 */
export type PkInviteeInput = string | { userId: string; side?: VideoRoomPkSide };

function normalizeInvitee(input: PkInviteeInput): { userId: string; side: VideoRoomPkSide } {
  return typeof input === 'string'
    ? { userId: input, side: VideoRoomPkSide.RED }
    : { userId: input.userId, side: input.side ?? VideoRoomPkSide.RED };
}

/** An invitation still SENT or DELIVERED — the only two states a response can act on. */
function isActionable(status: VideoRoomPkInvitationStatus): boolean {
  return (
    status === VideoRoomPkInvitationStatus.SENT || status === VideoRoomPkInvitationStatus.DELIVERED
  );
}

/**
 * VR-12 invitation workflow: send, deliver, accept, reject, cancel, retry and
 * expire per-invitee PK invitation rows.
 *
 * Two conditional writes carry every race in this file: `VideoRoomPkInvitationRepository
 * .updateStatus` (CAS on the invitation row's own `from` status) and
 * `VideoRoomPkStateService.transition`/`tryTransition` (CAS on the battle's status). Both
 * report a lost race by returning null/throwing rather than silently double-applying, which
 * is what makes every method here safe to call twice for the same event.
 */
@Injectable()
export class VideoRoomPkInvitationService {
  private readonly logger = new Logger(VideoRoomPkInvitationService.name);

  constructor(
    private readonly repo: VideoRoomPkInvitationRepository,
    private readonly state: VideoRoomPkStateService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
  ) {}

  /**
   * Send new invitations. One row + one `INVITATION_SENT` event per invitee.
   *
   * `targetRoomId` is stamped equal to the battle's own `roomId` today — it is
   * the cross-room extension point (a future battle spanning two rooms would
   * populate it with the OTHER room), so it is set explicitly here rather than
   * left to a column default.
   */
  async send(battle: PkBattleRef, invitees: PkInviteeInput[], inviterId: string): Promise<void> {
    const { invitationTtlSeconds } = loadVideoRoomPkConfig(this.config);

    const targetInvitees = invitees
      .map(normalizeInvitee)
      .filter((i) => i.userId !== inviterId);

    for (const { userId, side } of targetInvitees) {
      const expiresAt = new Date(Date.now() + invitationTtlSeconds * 1000);

      const invitation = await this.repo.create(
        {
          battleId: battle.id,
          roomId: battle.roomId,
          targetRoomId: battle.roomId,
          inviteeUserId: userId,
          inviterUserId: inviterId,
          side,
          attempt: 1,
          expiresAt,
        },
        undefined,
      );

      await this.bus.publish(
        new PkInvitationSentEvent({
          roomId: battle.roomId,
          battleId: battle.id,
          invitationId: invitation.id,
          inviteeUserId: userId,
          inviterUserId: inviterId,
          side,
          attempt: invitation.attempt,
          expiresAt: expiresAt.toISOString(),
          durationSeconds: battle.durationSeconds,
        }),
      );
    }
  }

  /**
   * The invitee's client confirms receipt → the underlying row moves SENT →
   * DELIVERED. The battle-level INVITED → PENDING move happens once, on the
   * very first delivery ack for the battle — every ack after that finds the
   * battle already PENDING (or further along) and is a silent no-op.
   */
  async markDelivered(battle: PkBattleRef, userId: string): Promise<void> {
    const invitation = await this.repo.findActionable(battle.id, userId);
    if (invitation && invitation.status === VideoRoomPkInvitationStatus.SENT) {
      await this.repo.updateStatus(
        invitation.id,
        VideoRoomPkInvitationStatus.SENT,
        VideoRoomPkInvitationStatus.DELIVERED,
        { deliveredAt: new Date() },
      );
    }

    if (battle.status === VideoRoomPkStatus.INVITED) {
      await this.state.transition(battle.id, VideoRoomPkStatus.INVITED, VideoRoomPkStatus.PENDING);
    }
  }

  /**
   * Accept. Authority is BEING THE NAMED INVITEE — a row lookup, not a
   * permission. `START_PK` is deliberately not consulted: the person accepting a
   * challenge is the opponent, who by definition does not manage this room.
   *
   * The battle only advances to ACCEPTED once NOTHING is still actionable, so a
   * Team PK with three invitees waits for all three. `updateStatus` is
   * conditional, so a double-tapped accept updates once and the second call
   * finds nothing to change.
   */
  async accept(actorId: string, battle: VideoRoomPkBattle): Promise<void> {
    const invitation = await this.repo.findActionable(battle.id, actorId);
    if (!invitation) {
      throw new PKInvitationException(
        'You have no pending invitation for this PK battle.',
        HttpStatus.FORBIDDEN,
      );
    }

    const updated = await this.repo.updateStatus(
      invitation.id,
      invitation.status,
      VideoRoomPkInvitationStatus.ACCEPTED,
      { respondedAt: new Date() },
    );
    if (!updated) return; // lost the race with another accept — already recorded

    await this.bus.publish(
      new PkInvitationAcceptedEvent({
        roomId: battle.roomId,
        battleId: battle.id,
        invitationId: invitation.id,
        inviteeUserId: actorId,
      }),
    );

    const outstanding = (await this.repo.listForBattle(battle.id)).filter((i) =>
      isActionable(i.status),
    );
    if (outstanding.length > 0) return;

    await this.state.transition(battle.id, battle.status, VideoRoomPkStatus.ACCEPTED);
  }

  /**
   * Reject (invitee only). Mirrors `accept()`'s authority and idempotency
   * rules exactly, target status REJECTED. When nothing remains actionable
   * afterwards the battle can no longer proceed and moves to CANCELLED — the
   * same "nothing left waiting" gate `accept()` uses to reach ACCEPTED,
   * applied on the losing branch.
   */
  async reject(actorId: string, battle: VideoRoomPkBattle): Promise<void> {
    const invitation = await this.repo.findActionable(battle.id, actorId);
    if (!invitation) {
      throw new PKInvitationException(
        'You have no pending invitation for this PK battle.',
        HttpStatus.FORBIDDEN,
      );
    }

    const updated = await this.repo.updateStatus(
      invitation.id,
      invitation.status,
      VideoRoomPkInvitationStatus.REJECTED,
      { respondedAt: new Date() },
    );
    if (!updated) return; // lost the race with another response — already recorded

    await this.bus.publish(
      new PkInvitationRejectedEvent({
        roomId: battle.roomId,
        battleId: battle.id,
        invitationId: invitation.id,
        inviteeUserId: actorId,
      }),
    );

    const outstanding = (await this.repo.listForBattle(battle.id)).filter((i) =>
      isActionable(i.status),
    );
    if (outstanding.length > 0) return;

    await this.state.transition(battle.id, battle.status, VideoRoomPkStatus.CANCELLED, {
      cancelledAt: new Date(),
      failureReason: 'A PK invitation was rejected and no invitee remains outstanding.',
    });
  }

  /**
   * Bulk-cancel every still-actionable invitation for a battle (owner cancel,
   * or a lifecycle failure elsewhere). A no-op when nothing is SENT/DELIVERED
   * — a battle that already resolved every invitation (accepted, rejected,
   * expired, or already cancelled) has nothing left for this to touch. Does
   * NOT itself move the battle's own status; the caller, which holds the
   * battle row, owns that transition.
   */
  async cancelAll(battleId: string, reason: string): Promise<void> {
    const actionable = (await this.repo.listForBattle(battleId)).filter((i) =>
      isActionable(i.status),
    );
    if (actionable.length === 0) return;

    const respondedAt = new Date();
    for (const invitation of actionable) {
      await this.repo.updateStatus(
        invitation.id,
        invitation.status,
        VideoRoomPkInvitationStatus.CANCELLED,
        { respondedAt },
      );
    }
    this.logger.debug(
      `Cancelled ${actionable.length} PK invitation(s) for battle ${battleId}: ${reason}`,
    );
  }

  /**
   * Re-send to an invitee whose invitation is still SENT. Refused once it has
   * moved to DELIVERED: the client already acknowledged receipt, so it is
   * unanswered, not lost — resending would spam the invitee. Creates a NEW
   * row at `attempt = latestAttempt + 1` rather than mutating the old one; the
   * `(battleId, inviteeUserId, attempt)` unique constraint is what keeps
   * repeated retries distinct and replay-safe, and `findActionable` orders by
   * `attempt` desc so the new row supersedes it.
   */
  async retry(battleId: string, inviteeUserId: string, inviterId: string): Promise<void> {
    const invitation = await this.repo.findActionable(battleId, inviteeUserId);
    if (!invitation || invitation.status !== VideoRoomPkInvitationStatus.SENT) {
      throw new PKInvitationException(
        'Only a SENT invitation may be retried; a DELIVERED invitation was already received.',
      );
    }

    const attempt = (await this.repo.latestAttempt(battleId, inviteeUserId)) + 1;
    const { invitationTtlSeconds } = loadVideoRoomPkConfig(this.config);
    const expiresAt = new Date(Date.now() + invitationTtlSeconds * 1000);

    const created = await this.repo.create(
      {
        battleId,
        roomId: invitation.roomId,
        targetRoomId: invitation.targetRoomId,
        inviteeUserId,
        inviterUserId: inviterId,
        side: invitation.side,
        attempt,
        expiresAt,
      },
      undefined,
    );

    await this.bus.publish(
      new PkInvitationSentEvent({
        roomId: invitation.roomId,
        battleId,
        invitationId: created.id,
        inviteeUserId,
        inviterUserId: inviterId,
        side: invitation.side,
        attempt: created.attempt,
        expiresAt: expiresAt.toISOString(),
      }),
    );
  }

  /**
   * Bulk-expire invitations whose TTL has passed. Batched by `battleId` so
   * the "nothing left actionable" check — and, when true, the CANCELLED
   * transition — runs once per affected battle, not once per row.
   *
   * The transition tries INVITED then PENDING as candidate `from` states
   * rather than trusting a caller-supplied battle snapshot: this service never
   * loads the battle row (it only consumes the invitation repository), and
   * those are the only two states in which an invitation can still be SENT or
   * DELIVERED. `tryTransition` — not `transition` — because a battle that
   * raced past both (e.g. the last invitee just accepted moments before the
   * sweep ran) must leave this a silent no-op, never a thrown exception in a
   * background job.
   */
  async expireDue(now: Date, take: number): Promise<void> {
    const rows = await this.repo.findExpired(now, take);
    const touchedBattles = new Set<string>();

    for (const row of rows) {
      const updated = await this.repo.updateStatus(
        row.id,
        row.status,
        VideoRoomPkInvitationStatus.EXPIRED,
        { respondedAt: now },
      );
      if (updated) touchedBattles.add(row.battleId);
    }

    for (const battleId of touchedBattles) {
      const outstanding = (await this.repo.listForBattle(battleId)).filter((i) =>
        isActionable(i.status),
      );
      if (outstanding.length > 0) continue;

      const patch = {
        cancelledAt: now,
        failureReason: 'All outstanding PK invitations expired.',
      };
      const cancelledFromInvited = await this.state.tryTransition(
        battleId,
        VideoRoomPkStatus.INVITED,
        VideoRoomPkStatus.CANCELLED,
        patch,
      );
      if (!cancelledFromInvited) {
        await this.state.tryTransition(
          battleId,
          VideoRoomPkStatus.PENDING,
          VideoRoomPkStatus.CANCELLED,
          patch,
        );
      }
    }
  }
}

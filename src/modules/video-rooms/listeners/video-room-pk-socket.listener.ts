import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { USERS_SERVICE, type IUsersService } from 'src/modules/users/interfaces/users.service.interface';
import { VIDEO_ROOM_PK_SOCKET_EVENTS } from '../constants/video-room-pk.constants';
import { VIDEO_ROOM_NAMESPACE } from '../constants/video-room.constants';
import {
  VIDEO_ROOM_PK_EVENTS,
  type PkCancelledEvent,
  type PkEndedEvent,
  type PkInvitationAcceptedEvent,
  type PkInvitationRejectedEvent,
  type PkInvitationSentEvent,
  type PkPausedEvent,
  type PkRecoveredEvent,
  type PkResumedEvent,
  type PkRewardDistributedEvent,
  type PkScoreUpdatedEvent,
  type PkStartedEvent,
  type PkWinnerDeclaredEvent,
} from '../events/video-room-pk.events';

/**
 * Bridges PK battle events to the `/video-room` sockets (VR-12 Task 23).
 * Follows the VR-10/VR-11 pattern: no domain gateway — inbound is the shared
 * BaseGateway, outbound is EVENT_BUS relayed here.
 *
 * 11 of the 12 domain events cross the wire. `PkCreatedEvent` is deliberately
 * NOT bridged (see its subscription slot below for why).
 *
 * `pkCountdown` and `pkWinner` are socket names with no exact 1:1 domain
 * event: `pkCountdown` is derived from `PkStartedEvent`'s own
 * `countdownSeconds` (mirrors the treasure listener's UNLOCKED → UNLOCKED +
 * ANIMATION + LEVEL_CHANGED fan-out), and `pkWinner` carries BOTH
 * `PkWinnerDeclaredEvent` and `PkRewardDistributedEvent` — settlement
 * publishes them back to back (see `VideoRoomPkSettlementService.settle`),
 * and the Task 3 socket vocabulary has no separate reward-distributed event
 * for clients that only care "who won and what they got".
 */
@Injectable()
export class VideoRoomPkSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
    @Optional() @Inject(USERS_SERVICE) private readonly users?: IUsersService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<PkInvitationSentEvent>(VIDEO_ROOM_PK_EVENTS.INVITATION_SENT, async (e) => {
      let inviterUsername: string | null = null;
      let inviterAvatarUrl: string | null = null;
      let inviteeUsername: string | null = null;
      let inviteeAvatarUrl: string | null = null;
      if (this.users) {
        try {
          const inviter = await this.users.findById(e.payload.inviterUserId);
          inviterUsername = inviter?.username ?? null;
          const invitee = await this.users.findById(e.payload.inviteeUserId);
          inviteeUsername = invitee?.username ?? null;
        } catch {
          // ignore
        }
      }
      if (this.prisma) {
        try {
          const [inviterProf, inviteeProf] = await Promise.all([
            this.prisma.userProfile.findUnique({
              where: { userId: e.payload.inviterUserId },
              select: { avatarUrl: true },
            }),
            this.prisma.userProfile.findUnique({
              where: { userId: e.payload.inviteeUserId },
              select: { avatarUrl: true },
            }),
          ]);
          inviterAvatarUrl = inviterProf?.avatarUrl ?? null;
          inviteeAvatarUrl = inviteeProf?.avatarUrl ?? null;
        } catch {
          // ignore
        }
      }
      const enriched = {
        ...e.payload,
        inviterUsername,
        inviterAvatarUrl,
        inviteeUsername,
        inviteeAvatarUrl,
      };

      this.toRoom(e.payload.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.INVITATION_SENT, enriched);
      this.toRoom(e.payload.roomId, 'video_room.pk.invitation_sent', enriched);
      this.toRoom(e.payload.roomId, 'pk:invitation_sent', enriched);
      this.sockets.emitToUserEverywhere(
        e.payload.inviteeUserId,
        VIDEO_ROOM_PK_SOCKET_EVENTS.INVITATION_SENT,
        enriched,
      );
      this.sockets.emitToUserEverywhere(
        e.payload.inviteeUserId,
        'video_room.pk.invitation_sent',
        enriched,
      );
    });

    this.bus.subscribe<PkInvitationAcceptedEvent>(VIDEO_ROOM_PK_EVENTS.INVITATION_ACCEPTED, (e) => {
      this.toRoom(e.payload.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.INVITATION_ACCEPTED, e.payload);
      this.toRoom(e.payload.roomId, 'video_room.pk.invitation_accepted', e.payload);
      this.sockets.emitToUserEverywhere(
        e.payload.inviteeUserId,
        VIDEO_ROOM_PK_SOCKET_EVENTS.INVITATION_ACCEPTED,
        e.payload,
      );
    });

    this.bus.subscribe<PkInvitationRejectedEvent>(VIDEO_ROOM_PK_EVENTS.INVITATION_REJECTED, (e) => {
      this.toRoom(e.payload.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.INVITATION_REJECTED, e.payload);
      this.toRoom(e.payload.roomId, 'video_room.pk.invitation_rejected', e.payload);
      this.sockets.emitToUserEverywhere(
        e.payload.inviteeUserId,
        VIDEO_ROOM_PK_SOCKET_EVENTS.INVITATION_REJECTED,
        e.payload,
      );
    });

    // PkCreatedEvent is deliberately NOT bridged: it fires the instant a
    // battle row + invitations are created, before `invitations.send()` has
    // told anyone about it (VideoRoomPkService.invite). Broadcasting it would
    // announce a battle to the room that no client can yet accept, reject, or
    // watch. INVITATION_SENT is the first PK signal a client should ever see.

    this.bus.subscribe<PkStartedEvent>(VIDEO_ROOM_PK_EVENTS.STARTED, async (e) => {
      const p = e.payload;
      const redScore = p.teams?.find((t) => t.side === 'RED')?.score ?? 0;
      const blueScore = p.teams?.find((t) => t.side === 'BLUE')?.score ?? 0;
      const challengerUserId = p.participants?.find((part) => part.side === 'BLUE')?.userId;

      // Enrich participants with usernames and avatars
      const enrichedParticipants = await Promise.all(
        (p.participants ?? []).map(async (part) => {
          let username: string | null = null;
          let avatarUrl: string | null = null;
          if (this.users) {
            try {
              const u = await this.users.findById(part.userId);
              username = u?.username ?? null;
            } catch {
              // ignore
            }
          }
          if (this.prisma) {
            try {
              const prof = await this.prisma.userProfile.findUnique({
                where: { userId: part.userId },
                select: { avatarUrl: true },
              });
              avatarUrl = prof?.avatarUrl ?? null;
            } catch {
              // ignore
            }
          }
          return {
            ...part,
            username,
            avatarUrl,
          };
        }),
      );

      const challenger = enrichedParticipants.find((part) => part.side === 'BLUE');
      const challengerUsername = challenger?.username ?? null;
      const challengerAvatarUrl = challenger?.avatarUrl ?? null;

      const enriched = {
        ...p,
        redScore,
        blueScore,
        challengerUserId,
        challengerUsername,
        challengerAvatarUrl,
        participants: enrichedParticipants,
      };

      this.toRoom(p.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.STARTED, enriched);
      this.toRoom(p.roomId, 'video_room.pk.started', enriched);
      this.toRoom(p.roomId, 'pk:started', enriched);

      // A separate countdown trigger, derived from the same payload, so a
      // client driving only the countdown UI need not parse the full
      // started-battle payload.
      const countdownPayload = {
        roomId: p.roomId,
        battleId: p.battleId,
        countdownSeconds: p.countdownSeconds ?? 5,
        durationSeconds: p.durationSeconds,
        startedAt: p.startedAt,
        endsAt: p.endsAt,
        challengerUserId,
        challengerUsername,
        challengerAvatarUrl,
        redScore,
        blueScore,
        participants: enrichedParticipants,
        teams: p.teams,
        mode: p.mode,
      };
      this.toRoom(p.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.COUNTDOWN, countdownPayload);
      this.toRoom(p.roomId, 'video_room.pk.countdown', countdownPayload);
      this.toRoom(p.roomId, 'pk:countdown', countdownPayload);
    });

    this.bus.subscribe<PkScoreUpdatedEvent>(VIDEO_ROOM_PK_EVENTS.SCORE_UPDATED, (e) => {
      const p = e.payload;
      const redScore = p.teams?.find((t) => t.side === 'RED')?.score ?? 0;
      const blueScore = p.teams?.find((t) => t.side === 'BLUE')?.score ?? 0;
      const enriched = { ...p, redScore, blueScore };
      this.toRoom(p.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.SCORE_UPDATED, enriched);
    });

    this.bus.subscribe<PkPausedEvent>(VIDEO_ROOM_PK_EVENTS.PAUSED, (e) =>
      this.toRoom(e.payload.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.PAUSED, e.payload),
    );

    this.bus.subscribe<PkResumedEvent>(VIDEO_ROOM_PK_EVENTS.RESUMED, (e) =>
      this.toRoom(e.payload.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.RESUMED, e.payload),
    );

    this.bus.subscribe<PkEndedEvent>(VIDEO_ROOM_PK_EVENTS.ENDED, (e) => {
      const p = e.payload;
      const redScore = p.teams?.find((t) => t.side === 'RED')?.score ?? 0;
      const blueScore = p.teams?.find((t) => t.side === 'BLUE')?.score ?? 0;
      const enriched = { ...p, redScore, blueScore };
      this.toRoom(p.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.ENDED, enriched);
    });

    this.bus.subscribe<PkCancelledEvent>(VIDEO_ROOM_PK_EVENTS.CANCELLED, (e) => {
      const payload = {
        roomId: e.payload.roomId,
        battleId: e.payload.battleId,
        status: 'CANCELLED',
        cancelledBy: e.payload.cancelledBy,
        reason: e.payload.reason,
      };
      this.toRoom(e.payload.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.CANCELLED, payload);
      this.toRoom(e.payload.roomId, 'video_room.pk.cancelled', payload);
      this.toRoom(e.payload.roomId, 'pk:cancelled', payload);
    });

    this.bus.subscribe<PkWinnerDeclaredEvent>(VIDEO_ROOM_PK_EVENTS.WINNER_DECLARED, (e) =>
      this.toRoom(e.payload.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.WINNER, e.payload),
    );

    this.bus.subscribe<PkRewardDistributedEvent>(VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED, (e) => {
      const p = e.payload;
      this.toRoom(p.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.WINNER, p);
      // A payout is told to the winner wherever they are, so it lands even if
      // they navigated away from the room — the VR-10/VR-11 gift/treasure
      // delivery precedent.
      for (const reward of p.rewards) {
        this.sockets.emitToUserEverywhere(reward.userId, VIDEO_ROOM_PK_SOCKET_EVENTS.WINNER, p);
      }
    });

    this.bus.subscribe<PkRecoveredEvent>(VIDEO_ROOM_PK_EVENTS.RECOVERED, (e) =>
      this.toRoom(e.payload.roomId, VIDEO_ROOM_PK_SOCKET_EVENTS.RECOVERED, e.payload),
    );
  }

  private toRoom(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(VIDEO_ROOM_NAMESPACE, roomId, event, payload);
  }
}

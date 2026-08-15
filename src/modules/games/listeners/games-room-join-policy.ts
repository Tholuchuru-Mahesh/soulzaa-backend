import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { GameLobbyStatus, GameSessionStatus } from '@prisma/client';
import { isUUID } from 'class-validator';
import {
  ROOM_JOIN_POLICY_REGISTRY,
  type RoomJoinPolicy,
  type RoomJoinPolicyRegistry,
} from 'src/infra/socket/room-join-policy.interface';
import { GAMES_NAMESPACE } from '../constants/games.constants';
import { GamesRepository } from '../repositories/games.repository';
import { AudioRoomGameAuthzService } from '../services/audio-room-game-authz.service';

/**
 * Gates `room:join` on the `/games` namespace. Self-registers into the shared
 * policy registry on module init (mirrors `GameSocketListener`'s own
 * self-registering `OnModuleInit` pattern), so this has no bearing on
 * provider construction order — just add it to `GamesModule`'s `providers`.
 *
 * A `room:join` on `/games` targets one of two kinds of room string:
 *  - a session id (UUID) — an active `GameSession`'s live-state/aim/emote room.
 *  - a lobby join code (6-char alphanumeric, never a UUID) — the pre-match
 *    lobby roster room.
 *
 * For a session: an existing `GameParticipant` row is a `'player'`; otherwise
 * an active `RoomMember` of the session's `roomId` (if any) is a `'spectator'`
 * — read-only access to a room-bound match. A session with no `roomId` (the
 * overwhelming majority — anything not started from an audio room) has no
 * spectator path at all, matching today's behavior for everyone but the
 * participants themselves.
 *
 * For a lobby: only an existing `GameLobbyMember` may join — there is no
 * spectating a lobby that hasn't started yet.
 */
@Injectable()
export class GamesRoomJoinPolicy implements RoomJoinPolicy, OnModuleInit {
  constructor(
    @Inject(ROOM_JOIN_POLICY_REGISTRY) private readonly registry: RoomJoinPolicyRegistry,
    private readonly repo: GamesRepository,
    private readonly authz: AudioRoomGameAuthzService,
  ) {}

  onModuleInit(): void {
    this.registry.set(GAMES_NAMESPACE, this);
  }

  async canJoin(userId: string, roomId: string): Promise<'player' | 'spectator' | 'deny'> {
    if (isUUID(roomId, '4')) {
      const session = await this.repo.getSession(roomId);
      if (!session || session.status !== GameSessionStatus.ACTIVE) return 'deny';
      if (await this.repo.getParticipant(session.id, userId)) return 'player';
      if (session.roomId && (await this.authz.isMember(session.roomId, userId))) {
        return 'spectator';
      }
      return 'deny';
    }

    const lobby = await this.repo.getLobbyByCode(roomId);
    if (!lobby || lobby.status !== GameLobbyStatus.OPEN) return 'deny';
    return (await this.repo.getMember(lobby.id, userId)) ? 'player' : 'deny';
  }
}

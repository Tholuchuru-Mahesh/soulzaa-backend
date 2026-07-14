import { Inject, Injectable } from '@nestjs/common';
import { Call } from '@prisma/client';
import type { SocialUserCard } from 'src/modules/social/interfaces/social.interface';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import type { CallView } from '../interfaces/calls.service.interface';

/** Shown for a user whose profile no longer resolves (deleted account). Rendering
 * "Unknown" beats dropping a call out of history and pretending it never happened. */
const UNKNOWN_PEER: Omit<SocialUserCard, 'userId'> = {
  username: 'unknown',
  fullName: null,
  avatarUrl: null,
  verified: false,
  level: 0,
  vipLevel: 0,
};

/**
 * Assembles the client-facing call views. Kept out of the service so the lifecycle
 * logic stays about state transitions, and so "what a call looks like" is decided
 * in exactly one place — which matters here more than usual, because the same call
 * is a different object to each of its two participants.
 */
@Injectable()
export class CallViewMapper {
  constructor(@Inject(PROFILE_SERVICE) private readonly profiles: IProfileService) {}

  /** Resolve ids into cards, keyed for O(1) lookup. Unresolvable ids are absent. */
  async cards(ids: string[]): Promise<Map<string, SocialUserCard>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();

    const resolved = await this.profiles.getCards(unique);
    return new Map(
      resolved.map((c) => [
        c.id,
        {
          userId: c.id,
          username: c.username,
          fullName: c.fullName,
          avatarUrl: c.avatarUrl,
          verified: c.verified,
          level: c.level,
          vipLevel: c.vipLevel,
        },
      ]),
    );
  }

  /** The call as `viewerId` sees it: `peer` is the *other* user, `isOutgoing` their side of it. */
  toView(call: Call, viewerId: string, cards: Map<string, SocialUserCard>): CallView {
    const isOutgoing = call.callerId === viewerId;
    const peerId = isOutgoing ? call.calleeId : call.callerId;
    return {
      id: call.id,
      type: call.type,
      status: call.status,
      callerId: call.callerId,
      calleeId: call.calleeId,
      peer: cards.get(peerId) ?? { userId: peerId, ...UNKNOWN_PEER },
      isOutgoing,
      ringingExpiresAt: call.ringingExpiresAt,
      acceptedAt: call.acceptedAt,
      connectedAt: call.connectedAt,
      endedAt: call.endedAt,
      endedBy: call.endedBy,
      endReason: call.endReason,
      durationSeconds: call.durationSeconds,
      conversationId: call.conversationId,
      createdAt: call.createdAt,
    };
  }

  /** One view per participant — the payload every `call.*` bus event carries. */
  async bothViews(call: Call): Promise<Record<string, CallView>> {
    const cards = await this.cards([call.callerId, call.calleeId]);
    return {
      [call.callerId]: this.toView(call, call.callerId, cards),
      [call.calleeId]: this.toView(call, call.calleeId, cards),
    };
  }

  /** A single view for one viewer, resolving its cards in one round trip. */
  async view(call: Call, viewerId: string): Promise<CallView> {
    const cards = await this.cards([call.callerId, call.calleeId]);
    return this.toView(call, viewerId, cards);
  }
}

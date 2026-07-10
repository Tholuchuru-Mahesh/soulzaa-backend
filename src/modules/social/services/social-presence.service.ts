import { Inject, Injectable } from '@nestjs/common';
import { PresenceStatus } from '@prisma/client';
import { PresenceService } from 'src/infra/redis/presence.service';
import {
  PRIVACY_SERVICE,
  PrivacyAction,
  type IPrivacyService,
} from 'src/modules/privacy/interfaces/privacy.interface';
import type { PresenceView } from '../interfaces/social.interface';
import { PresenceStateRepository } from '../repositories/presence-state.repository';

/**
 * Read side of presence. Combines the Redis coarse-online set with the durable
 * `presence_state` row (rich status + lastSeen), gating the online + last-seen
 * fields per target via PRIVACY_SERVICE (VIEW_ONLINE / VIEW_LAST_SEEN). Fields
 * the viewer isn't permitted to see are nulled/offline, never omitted.
 */
@Injectable()
export class SocialPresenceService {
  constructor(
    private readonly stateRepo: PresenceStateRepository,
    private readonly presence: PresenceService,
    @Inject(PRIVACY_SERVICE) private readonly privacy: IPrivacyService,
  ) {}

  async getMany(viewerId: string, userIds: string[]): Promise<PresenceView[]> {
    const rows = await this.stateRepo.getMany(userIds);
    const byId = new Map(rows.map((r) => [r.userId, r]));

    return Promise.all(
      userIds.map(async (id): Promise<PresenceView> => {
        const [online, canOnline, canLastSeen] = await Promise.all([
          this.presence.isOnline(id),
          this.privacy.check(viewerId, id, PrivacyAction.VIEW_ONLINE),
          this.privacy.check(viewerId, id, PrivacyAction.VIEW_LAST_SEEN),
        ]);
        const row = byId.get(id);
        const status = row?.status ?? (online ? PresenceStatus.ONLINE : PresenceStatus.OFFLINE);
        return {
          userId: id,
          status: canOnline ? status : PresenceStatus.OFFLINE,
          currentRoomId: canOnline ? (row?.currentRoomId ?? null) : null,
          lastSeenAt: canLastSeen ? (row?.lastSeenAt ?? null) : null,
          online: canOnline ? online : false,
        };
      }),
    );
  }
}

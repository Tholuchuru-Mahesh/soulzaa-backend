import { Inject, Injectable } from '@nestjs/common';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import type { SocialUserCard } from '../interfaces/social.interface';

/**
 * Resolves user ids into lightweight social cards via PROFILE_SERVICE (the only
 * sanctioned cross-module read of user/profile data). Preserves input order and
 * silently drops ids that no longer resolve to a profile.
 */
@Injectable()
export class CardResolver {
  constructor(@Inject(PROFILE_SERVICE) private readonly profile: IProfileService) {}

  async resolve(ids: string[]): Promise<SocialUserCard[]> {
    if (ids.length === 0) return [];
    const cards = await this.profile.getCards(ids);
    const byId = new Map(cards.map((c) => [c.id, c]));
    const out: SocialUserCard[] = [];
    for (const id of ids) {
      const c = byId.get(id);
      if (c) {
        out.push({
          userId: c.id,
          username: c.username,
          fullName: c.fullName,
          avatarUrl: c.avatarUrl,
          verified: c.verified,
          level: c.level,
          vipLevel: c.vipLevel,
        });
      }
    }
    return out;
  }

  async resolveOne(id: string): Promise<SocialUserCard | null> {
    const [card] = await this.resolve([id]);
    return card ?? null;
  }
}

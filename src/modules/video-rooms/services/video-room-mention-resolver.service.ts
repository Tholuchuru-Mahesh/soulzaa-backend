import { Inject, Injectable } from '@nestjs/common';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import { VIDEO_ROOM_CHAT_MENTION_RE } from '../constants/video-room-chat.constants';
import { VideoRoomRolesRepository } from '../repositories/video-room-roles.repository';

export interface MentionContext {
  roomId: string;
  ownerId: string;
  senderId: string;
  max: number;
}

export interface ResolvedMentions {
  userIds: string[];
  /** 'OWNER' | 'ADMINS' for a group mention; null for direct @username mentions. */
  scope: string | null;
}

/**
 * Resolves `@username`, `@owner` and `@admins` tokens to user ids.
 *
 * Group tokens are checked BEFORE username lookup, so a user who registers the
 * username "owner" cannot hijack `@owner` broadcasts. Self-mentions are dropped
 * (nobody needs to be notified of their own message) and the result is capped, so
 * a message packed with mentions cannot fan out unboundedly.
 *
 * Users are reached through the cross-module `USERS_SERVICE` contract — never by
 * importing the users module's internals.
 */
@Injectable()
export class VideoRoomMentionResolver {
  constructor(
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
    private readonly roles: VideoRoomRolesRepository,
  ) {}

  async resolve(content: string, ctx: MentionContext): Promise<ResolvedMentions> {
    const tokens = new Set<string>();
    for (const match of content.matchAll(VIDEO_ROOM_CHAT_MENTION_RE)) {
      tokens.add(match[1].toLowerCase());
    }
    if (tokens.size === 0) return { userIds: [], scope: null };

    // Group mentions win over any same-named user account.
    if (tokens.has('owner')) {
      return { userIds: ctx.ownerId === ctx.senderId ? [] : [ctx.ownerId], scope: 'OWNER' };
    }
    if (tokens.has('admins')) {
      const grants = await this.roles.listActiveByRoom(ctx.roomId);
      const ids = [...new Set(grants.map((g) => g.userId))].filter((id) => id !== ctx.senderId);
      return { userIds: ids.slice(0, ctx.max), scope: 'ADMINS' };
    }

    const ids = new Set<string>();
    for (const username of tokens) {
      if (ids.size >= ctx.max) break;
      const user = await this.users.findByUsername(username);
      if (user && user.id !== ctx.senderId) ids.add(user.id);
    }
    return { userIds: [...ids], scope: null };
  }
}

import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { FriendRequest, FriendRequestStatus } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import {
  PRIVACY_SERVICE,
  PrivacyAction,
  type IPrivacyService,
} from 'src/modules/privacy/interfaces/privacy.interface';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import {
  USERS_SERVICE,
  type IUsersService,
} from 'src/modules/users/interfaces/users.service.interface';
import { BEST_FRIENDS_TOP_N, FRIEND_REQUEST_TTL_MS } from '../constants/social.constants';
import {
  FriendRemovedEvent,
  FriendRequestAcceptedEvent,
  FriendRequestRejectedEvent,
  FriendRequestSentEvent,
} from '../events/social.events';
import type { FriendRequestView, FriendView } from '../interfaces/social.interface';
import { FriendRequestRepository } from '../repositories/friend-request.repository';
import { FriendshipRepository } from '../repositories/friendship.repository';
import { CardResolver } from './card.resolver';

/**
 * Friends & friend requests. Enforces no-self-friend, block + friend-request
 * permission gating (via PRIVACY_SERVICE), duplicate-request prevention, and
 * reverse-request auto-accept. Accept creates the canonical friendship + flips
 * the request atomically; friendsCount is adjusted after commit. Publishes
 * events for realtime + notifications.
 */
@Injectable()
export class FriendsService {
  constructor(
    private readonly requests: FriendRequestRepository,
    private readonly friendships: FriendshipRepository,
    private readonly cards: CardResolver,
    @Inject(PRIVACY_SERVICE) private readonly privacy: IPrivacyService,
    @Inject(PROFILE_SERVICE) private readonly profile: IProfileService,
    @Inject(USERS_SERVICE) private readonly users: IUsersService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async sendRequest(
    requesterId: string,
    dto: { targetUserId?: string; username?: string; message?: string },
  ): Promise<{ requestId: string; status: FriendRequestStatus; friendshipId?: string }> {
    const addresseeId = await this.resolveTarget(dto.targetUserId, dto.username);
    if (addresseeId === requesterId) {
      throw new BusinessException(
        ERROR_CODES.CANNOT_FRIEND_SELF,
        'You cannot friend yourself',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (await this.friendships.exists(requesterId, addresseeId)) {
      throw new BusinessException(
        ERROR_CODES.ALREADY_FRIENDS,
        'You are already friends with this user',
        HttpStatus.CONFLICT,
      );
    }

    // If they already asked us, accepting-by-sending is the natural resolution.
    const reverse = await this.requests.findReversePending(requesterId, addresseeId);
    if (reverse) {
      const friendshipId = await this.acceptInternal(reverse);
      return { requestId: reverse.id, status: FriendRequestStatus.ACCEPTED, friendshipId };
    }

    const allowed = await this.privacy.check(
      requesterId,
      addresseeId,
      PrivacyAction.FRIEND_REQUEST,
    );
    if (!allowed) {
      throw new BusinessException(
        ERROR_CODES.FRIEND_REQUEST_FORBIDDEN,
        'This user is not accepting friend requests',
        HttpStatus.FORBIDDEN,
      );
    }

    const existing = await this.requests.findPair(requesterId, addresseeId);
    if (existing && existing.status === FriendRequestStatus.PENDING) {
      throw new BusinessException(
        ERROR_CODES.FRIEND_REQUEST_EXISTS,
        'You already have a pending request to this user',
        HttpStatus.CONFLICT,
      );
    }

    const row = await this.requests.upsertPending(
      requesterId,
      addresseeId,
      dto.message ?? null,
      new Date(Date.now() + FRIEND_REQUEST_TTL_MS),
    );
    await this.bus.publish(
      new FriendRequestSentEvent({
        requestId: row.id,
        requesterId,
        addresseeId,
        message: row.message,
        expiresAt: row.expiresAt,
      }),
    );
    return { requestId: row.id, status: row.status };
  }

  async accept(requestId: string, userId: string): Promise<{ friendshipId: string }> {
    const req = await this.loadActionable(requestId);
    if (req.addresseeId !== userId) {
      throw this.notFound();
    }
    const friendshipId = await this.acceptInternal(req);
    return { friendshipId };
  }

  async reject(requestId: string, userId: string): Promise<{ status: FriendRequestStatus }> {
    const req = await this.loadActionable(requestId);
    if (req.addresseeId !== userId) {
      throw this.notFound();
    }
    await this.requests.markStatus(req.id, FriendRequestStatus.REJECTED);
    await this.bus.publish(
      new FriendRequestRejectedEvent({
        requestId: req.id,
        requesterId: req.requesterId,
        addresseeId: req.addresseeId,
      }),
    );
    return { status: FriendRequestStatus.REJECTED };
  }

  async cancel(requestId: string, userId: string): Promise<{ status: FriendRequestStatus }> {
    const req = await this.loadActionable(requestId);
    if (req.requesterId !== userId) {
      throw this.notFound();
    }
    await this.requests.markStatus(req.id, FriendRequestStatus.CANCELLED);
    return { status: FriendRequestStatus.CANCELLED };
  }

  async incoming(
    userId: string,
    page: number,
    limit: number,
  ): Promise<Paginated<FriendRequestView>> {
    const { rows, total } = await this.requests.pageIncoming(userId, (page - 1) * limit, limit);
    const items = await this.toRequestViews(rows, (r) => r.requesterId);
    return buildPaginated(items, total, page, limit);
  }

  async outgoing(
    userId: string,
    page: number,
    limit: number,
  ): Promise<Paginated<FriendRequestView>> {
    const { rows, total } = await this.requests.pageOutgoing(userId, (page - 1) * limit, limit);
    const items = await this.toRequestViews(rows, (r) => r.addresseeId);
    return buildPaginated(items, total, page, limit);
  }

  async listFriends(
    userId: string,
    page: number,
    limit: number,
    search?: string,
    bestOnly?: boolean,
  ): Promise<Paginated<FriendView>> {
    const rows = await this.friendships.allForUser(userId);
    const base = rows.map((r) => {
      const isA = r.userAId === userId;
      return {
        friendId: isA ? r.userBId : r.userAId,
        pinned: isA ? r.isBestFriendA : r.isBestFriendB,
        score: r.interactionScore,
        since: r.createdAt,
      };
    });

    // Derived best-friends: the top-N by interaction score (with any activity)
    // get a 1-based priority. Effective best = explicit pin OR derived.
    const priorityMap = new Map<string, number>();
    [...base]
      .sort((a, b) => b.score - a.score)
      .slice(0, BEST_FRIENDS_TOP_N)
      .forEach((e, i) => {
        if (e.score > 0) priorityMap.set(e.friendId, i + 1);
      });

    let entries = base.map((e) => ({
      friendId: e.friendId,
      isBest: e.pinned || priorityMap.has(e.friendId),
      priority: priorityMap.get(e.friendId) ?? null,
      score: e.score,
      since: e.since,
    }));

    if (bestOnly) entries = entries.filter((e) => e.isBest);
    entries.sort(
      (a, b) =>
        Number(b.isBest) - Number(a.isBest) ||
        b.score - a.score ||
        b.since.getTime() - a.since.getTime(),
    );

    if (search) {
      const q = search.trim().toLowerCase();
      const cards = await this.cards.resolve(entries.map((e) => e.friendId));
      const byId = new Map(cards.map((c) => [c.userId, c]));
      entries = entries.filter((e) => {
        const c = byId.get(e.friendId);
        return (
          c !== undefined &&
          (c.username.toLowerCase().includes(q) || (c.fullName ?? '').toLowerCase().includes(q))
        );
      });
    }

    const total = entries.length;
    const pageEntries = entries.slice((page - 1) * limit, (page - 1) * limit + limit);
    const cards = await this.cards.resolve(pageEntries.map((e) => e.friendId));
    const byId = new Map(cards.map((c) => [c.userId, c]));
    const items: FriendView[] = [];
    for (const e of pageEntries) {
      const c = byId.get(e.friendId);
      if (!c) continue;
      items.push({
        ...c,
        isBestFriend: e.isBest,
        priority: e.priority,
        presence: null,
        friendsSince: e.since,
      });
    }
    return buildPaginated(items, total, page, limit);
  }

  async remove(userId: string, friendId: string): Promise<{ removed: boolean }> {
    const removed = await this.friendships.delete(userId, friendId);
    if (!removed) {
      throw new BusinessException(
        ERROR_CODES.NOT_FRIENDS,
        'You are not friends with this user',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.profile.incrementStatistic(userId, 'friendsCount', -1);
    await this.profile.incrementStatistic(friendId, 'friendsCount', -1);
    await this.bus.publish(new FriendRemovedEvent({ removerId: userId, removedId: friendId }));
    return { removed: true };
  }

  async setBestFriend(
    userId: string,
    friendId: string,
    best: boolean,
  ): Promise<{ isBestFriend: boolean }> {
    const row = await this.friendships.setBestFriend(userId, friendId, best);
    if (!row) {
      throw new BusinessException(
        ERROR_CODES.NOT_FRIENDS,
        'You are not friends with this user',
        HttpStatus.NOT_FOUND,
      );
    }
    return { isBestFriend: best };
  }

  // ---- Helpers ----

  private async acceptInternal(req: FriendRequest): Promise<string> {
    const friendshipId = await this.requests.acceptRequest(
      req.id,
      req.requesterId,
      req.addresseeId,
    );
    await this.profile.incrementStatistic(req.requesterId, 'friendsCount', 1);
    await this.profile.incrementStatistic(req.addresseeId, 'friendsCount', 1);
    await this.bus.publish(
      new FriendRequestAcceptedEvent({
        requestId: req.id,
        friendshipId,
        requesterId: req.requesterId,
        addresseeId: req.addresseeId,
      }),
    );
    return friendshipId;
  }

  private async loadActionable(requestId: string): Promise<FriendRequest> {
    const req = await this.requests.findById(requestId);
    if (!req || req.status !== FriendRequestStatus.PENDING) {
      throw this.notFound();
    }
    if (req.expiresAt.getTime() < Date.now()) {
      throw new BusinessException(
        ERROR_CODES.FRIEND_REQUEST_EXPIRED,
        'This friend request has expired',
        HttpStatus.GONE,
      );
    }
    return req;
  }

  private async toRequestViews(
    rows: FriendRequest[],
    pick: (r: FriendRequest) => string,
  ): Promise<FriendRequestView[]> {
    const cards = await this.cards.resolve(rows.map(pick));
    const byId = new Map(cards.map((c) => [c.userId, c]));
    const views: FriendRequestView[] = [];
    for (const r of rows) {
      const user = byId.get(pick(r));
      if (!user) continue;
      views.push({
        requestId: r.id,
        status: r.status,
        message: r.message,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        user,
      });
    }
    return views;
  }

  private async resolveTarget(userId?: string, username?: string): Promise<string> {
    if (userId) return userId;
    if (username) {
      const user = await this.users.findByUsername(username);
      if (user) return user.id;
    }
    throw new BusinessException(
      ERROR_CODES.NOT_FOUND,
      'Provide a valid userId or username',
      HttpStatus.NOT_FOUND,
    );
  }

  private notFound(): BusinessException {
    return new BusinessException(
      ERROR_CODES.FRIEND_REQUEST_NOT_FOUND,
      'Friend request not found',
      HttpStatus.NOT_FOUND,
    );
  }
}

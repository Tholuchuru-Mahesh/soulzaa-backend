import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FriendRequestRepository } from '../repositories/friend-request.repository';
import { InvitationRepository } from '../repositories/invitation.repository';

/** How often the expiry sweep runs. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Housekeeping sweep that flips PENDING friend requests / invitations past their
 * `expiresAt` to EXPIRED. Runs on a fixed interval; `updateMany` is idempotent
 * and indexed (`@@index([status, expiresAt])`), so it is safe for every instance
 * to run (no leader election needed). Self-contained — no BullMQ/scheduler dep.
 */
@Injectable()
export class SocialExpiryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SocialExpiryScheduler.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly requests: FriendRequestRepository,
    private readonly invitations: InvitationRepository,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    // Don't keep the event loop alive solely for the sweep.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    try {
      const now = new Date();
      const [friendRequests, invitations] = await Promise.all([
        this.requests.expirePending(now),
        this.invitations.expirePending(now),
      ]);
      if (friendRequests > 0 || invitations > 0) {
        this.logger.log(
          `expired ${friendRequests} friend request(s), ${invitations} invitation(s)`,
        );
      }
    } catch (err) {
      this.logger.error('social expiry sweep failed', err as Error);
    }
  }
}

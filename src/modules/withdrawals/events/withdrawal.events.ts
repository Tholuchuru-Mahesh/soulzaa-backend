import { DomainEvent } from 'src/common/events';

/**
 * Withdrawal lifecycle events on the EVENT_BUS.
 *
 * Replaces `WithdrawalEventService.publishWithdrawalEvent(name: string, payload:
 * any)`, which was scaffolding with no callers and no types — nothing had ever
 * been published, so a user whose withdrawal was approved or rejected was never
 * told.
 */
export const WITHDRAWAL_EVENTS = {
  APPROVED: 'withdrawal.approved',
  REJECTED: 'withdrawal.rejected',
} as const;

export interface WithdrawalDecisionPayload {
  withdrawalId: string;
  userId: string;
  /** Coins, as a number. The column is BigInt; withdrawal amounts fit. */
  amount: number;
  /**
   * Why it was rejected. Present on rejection so the notification can say more
   * than "no" — a user who is not told the reason opens a support ticket.
   */
  reason?: string;
}

export class WithdrawalApprovedEvent extends DomainEvent<WithdrawalDecisionPayload> {
  readonly name = WITHDRAWAL_EVENTS.APPROVED;
}

export class WithdrawalRejectedEvent extends DomainEvent<WithdrawalDecisionPayload> {
  readonly name = WITHDRAWAL_EVENTS.REJECTED;
}

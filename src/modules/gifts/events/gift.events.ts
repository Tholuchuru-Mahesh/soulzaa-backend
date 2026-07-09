import type { GiftContextType, GiftType } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * Gift domain events on the EVENT_BUS. The audio-rooms module bridges the room-
 * facing ones (sent/combo/lucky) to the `/audio-room` socket namespace; the EXP,
 * rankings, analytics and notification modules consume the same events without
 * importing gift internals. This is the cross-module seam for "exp rewards" and
 * "rankings" — the payload carries the EXP deltas and coin values.
 */
export const GIFT_EVENTS = {
  SENT: 'gift.sent',
  COMBO: 'gift.combo',
  LUCKY_WIN: 'gift.lucky_win',
} as const;

/** Full snapshot of a completed gift send (broadcast + analytics + exp seam). */
export interface GiftSentPayload {
  transactionId: string;
  senderId: string;
  receiverId: string;
  giftId: string;
  giftType: GiftType;
  giftName: string;
  contextType: GiftContextType;
  contextId: string;
  quantity: number;
  comboTier: number;
  unitCoinValue: number;
  totalCoinValue: number;
  creatorEarnings: number;
  luckyMultiplier: number;
  isLuckyWin: boolean;
  senderExp: number;
  receiverExp: number;
  createdAt: string;
}

export class GiftSentEvent extends DomainEvent<GiftSentPayload> {
  readonly name = GIFT_EVENTS.SENT;
}

export class GiftComboEvent extends DomainEvent<{
  contextType: GiftContextType;
  contextId: string;
  senderId: string;
  giftId: string;
  comboTier: number;
}> {
  readonly name = GIFT_EVENTS.COMBO;
}

export class GiftLuckyWinEvent extends DomainEvent<{
  contextType: GiftContextType;
  contextId: string;
  senderId: string;
  giftId: string;
  luckyMultiplier: number;
  totalCoinValue: number;
}> {
  readonly name = GIFT_EVENTS.LUCKY_WIN;
}

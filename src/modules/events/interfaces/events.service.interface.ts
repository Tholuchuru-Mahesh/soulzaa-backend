import type { EventType } from '@prisma/client';

/**
 * Public contract for the events module — the ONLY surface other modules may
 * depend on, alongside the EVENT_BUS. The accrual pipelines (EXP, and the future
 * recharge flow) consult `getActiveMultiplier` to apply live DOUBLE_EXP /
 * DOUBLE_RECHARGE bonuses. Claiming reward events happens through the events REST
 * controller.
 */
export const EVENTS_SERVICE = Symbol('EVENTS_SERVICE');

export interface IEventsService {
  /**
   * The current multiplier for a DOUBLE_* event type (≥1). Returns the highest
   * multiplier among the currently-active events of that type, or 1 if none.
   */
  getActiveMultiplier(type: EventType): Promise<number>;
}

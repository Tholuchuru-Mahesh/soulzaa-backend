import type { ExpSource } from '@prisma/client';

/**
 * Public contract for the EXP module — the ONLY surface other modules may
 * depend on, alongside the EVENT_BUS. Awards accrue user/room EXP idempotently
 * and auto-level-up (granting the configured rewards). Consumers award EXP for
 * their own activity (daily login, tasks, games) via this seam; gifts and room
 * joins are consumed internally from domain events.
 */
export const EXP_SERVICE = Symbol('EXP_SERVICE');

/** Result of an EXP award. */
export interface ExpAwardResult {
  totalExp: number;
  level: number;
  leveledUp: boolean;
}

/** A user's current EXP + level snapshot. */
export interface UserExpView {
  userId: string;
  totalExp: number;
  level: number;
  nextLevelExp: number | null;
}

export interface IExpService {
  /** Award EXP to a user (idempotent on `idempotencyKey`); auto-levels-up. */
  award(input: {
    userId: string;
    amount: number;
    source: ExpSource;
    idempotencyKey: string;
    referenceType?: string;
    referenceId?: string;
  }): Promise<ExpAwardResult>;

  /** Award EXP to a room (idempotent); auto-levels-up the room. */
  awardRoom(input: {
    roomId: string;
    amount: number;
    source: ExpSource;
    idempotencyKey: string;
    referenceId?: string;
  }): Promise<ExpAwardResult>;

  /** A user's EXP + level. */
  getUserExp(userId: string): Promise<UserExpView>;
}

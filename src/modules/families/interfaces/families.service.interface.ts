/**
 * Public contract for the families module — the ONLY surface other modules may
 * depend on (this token/interface or the EVENT_BUS). Internals stay private.
 */
export const FAMILIES_SERVICE = Symbol('FAMILIES_SERVICE');

export interface IFamiliesService {
  /** Retrieves the family ID a user belongs to, or null if they aren't in any family. */
  getMemberFamilyId(userId: string): Promise<string | null>;

  /** Safely increments a family's EXP and handles leveling up. */
  addFamilyExp(familyId: string, amount: number): Promise<void>;

  /** Increments contribution points for a specific family member. */
  incrementMemberContribution(userId: string, points: number): Promise<void>;

  /**
   * User ids of everyone who runs the family — FOUNDER, CO_FOUNDER, ELDER.
   *
   * Exposed so consumers can address the people who act on membership changes
   * without fanning out to the entire roster: a 500-member family would
   * otherwise turn one join into 500 notification rows.
   */
  getOfficerIds(familyId: string): Promise<string[]>;

  /** User ids of every member, officers included. */
  getMemberIds(familyId: string): Promise<string[]>;
}

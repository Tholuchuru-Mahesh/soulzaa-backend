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
}

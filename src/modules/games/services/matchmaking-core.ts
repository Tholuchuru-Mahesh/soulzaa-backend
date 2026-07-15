/**
 * Pure, side-effect-free matchmaking + team decisions. Like `game-live-state.ts`,
 * this holds only deterministic logic (no Redis, no wallet, no NestJS) so every
 * branch is unit-testable without mocks. The service layer wraps these with I/O
 * and translates the `AssignResult` errors into BusinessExceptions.
 */
import { GameMode, GameTeam } from '@prisma/client';

/** Matchmaking bucket flavour. DUEL pairs 2 into a CLASSIC lobby; TEAM_2V2 pairs 4. */
export type MatchType = 'DUEL' | 'TEAM_2V2';

/** Why a ready-check dissolved — user-facing (declined/timeout/exhausted) or operational. */
export type MatchCancelReason =
  | 'declined'
  | 'timeout'
  | 'exhausted'
  | 'stake_failed'
  | 'server_shutdown'
  | 'redis_unavailable'
  | 'maintenance';

/** How many queued players a bucket needs before a match can form. */
export function requiredSize(matchType: MatchType): number {
  return matchType === 'TEAM_2V2' ? 4 : 2;
}

/** The lobby/session mode a matched bucket becomes. */
export function matchModeFor(matchType: MatchType): GameMode {
  return matchType === 'TEAM_2V2' ? GameMode.TEAM_2V2 : GameMode.CLASSIC;
}

/** One player's frozen seat + team for a starting session. */
export interface SeatAssignment {
  userId: string;
  team: GameTeam | null;
  seat: number;
}

export type AssignResult =
  { ok: true; seats: SeatAssignment[] } | { ok: false; error: 'WRONG_PLAYER_COUNT' | 'UNBALANCED' };

/**
 * Resolve final seat + team for every member at start.
 *  - CLASSIC: seat = join order, team = null.
 *  - TEAM_2V2: exactly 4 members; honour explicit `picks`, greedily fill any
 *    unassigned members into open A-then-B slots, and emit seats positionally as
 *    [A0, B0, A1, B1] so seats {0,2}=Team A and {1,3}=Team B — the layout both the
 *    Ludo and Carrom engines read. Join order is preserved within each team.
 */
export function assignTeamsAndSeats(
  members: string[],
  picks: Map<string, GameTeam>,
  mode: GameMode,
): AssignResult {
  if (mode !== GameMode.TEAM_2V2) {
    return {
      ok: true,
      seats: members.map((userId, seat) => ({ userId, team: null, seat })),
    };
  }

  if (members.length !== 4) return { ok: false, error: 'WRONG_PLAYER_COUNT' };

  const teamOf = new Map<string, GameTeam>();
  let aCount = 0;
  let bCount = 0;
  for (const m of members) {
    const pick = picks.get(m);
    if (!pick) continue;
    teamOf.set(m, pick);
    if (pick === GameTeam.A) aCount++;
    else bCount++;
  }
  if (aCount > 2 || bCount > 2) return { ok: false, error: 'UNBALANCED' };

  for (const m of members) {
    if (teamOf.has(m)) continue;
    if (aCount < 2) {
      teamOf.set(m, GameTeam.A);
      aCount++;
    } else if (bCount < 2) {
      teamOf.set(m, GameTeam.B);
      bCount++;
    } else {
      return { ok: false, error: 'UNBALANCED' };
    }
  }
  if (aCount !== 2 || bCount !== 2) return { ok: false, error: 'UNBALANCED' };

  const teamA = members.filter((m) => teamOf.get(m) === GameTeam.A);
  const teamB = members.filter((m) => teamOf.get(m) === GameTeam.B);
  return {
    ok: true,
    seats: [
      { userId: teamA[0], team: GameTeam.A, seat: 0 },
      { userId: teamB[0], team: GameTeam.B, seat: 1 },
      { userId: teamA[1], team: GameTeam.A, seat: 2 },
      { userId: teamB[1], team: GameTeam.B, seat: 3 },
    ],
  };
}

/** The user ids on `winningTeam` — the winners a host's team-report expands into. */
export function expandTeamWinners(
  participants: { userId: string; team: GameTeam | null }[],
  winningTeam: GameTeam,
): string[] {
  return participants.filter((p) => p.team === winningTeam).map((p) => p.userId);
}

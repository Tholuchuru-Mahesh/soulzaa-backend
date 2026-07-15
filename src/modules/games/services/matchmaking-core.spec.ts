import { GameMode, GameTeam } from '@prisma/client';
import {
  assignTeamsAndSeats,
  expandTeamWinners,
  matchModeFor,
  requiredSize,
} from './matchmaking-core';

/** Build a picks map from a plain object for readability. */
function picks(obj: Record<string, GameTeam>): Map<string, GameTeam> {
  return new Map(Object.entries(obj));
}

describe('matchmaking-core', () => {
  describe('requiredSize', () => {
    it('needs 2 players for a DUEL', () => {
      expect(requiredSize('DUEL')).toBe(2);
    });
    it('needs 4 players for TEAM_2V2', () => {
      expect(requiredSize('TEAM_2V2')).toBe(4);
    });
  });

  describe('matchModeFor', () => {
    it('maps DUEL to a CLASSIC lobby', () => {
      expect(matchModeFor('DUEL')).toBe(GameMode.CLASSIC);
    });
    it('maps TEAM_2V2 to a TEAM_2V2 lobby', () => {
      expect(matchModeFor('TEAM_2V2')).toBe(GameMode.TEAM_2V2);
    });
  });

  describe('assignTeamsAndSeats — CLASSIC', () => {
    it('seats members in join order with no team', () => {
      const result = assignTeamsAndSeats(['a', 'b', 'c'], picks({}), GameMode.CLASSIC);
      expect(result).toEqual({
        ok: true,
        seats: [
          { userId: 'a', team: null, seat: 0 },
          { userId: 'b', team: null, seat: 1 },
          { userId: 'c', team: null, seat: 2 },
        ],
      });
    });
  });

  describe('assignTeamsAndSeats — TEAM_2V2', () => {
    it('places teams positionally: A=seats{0,2}, B=seats{1,3}', () => {
      const result = assignTeamsAndSeats(
        ['a', 'b', 'c', 'd'],
        picks({ a: GameTeam.A, b: GameTeam.B, c: GameTeam.A, d: GameTeam.B }),
        GameMode.TEAM_2V2,
      );
      expect(result).toEqual({
        ok: true,
        seats: [
          { userId: 'a', team: GameTeam.A, seat: 0 },
          { userId: 'b', team: GameTeam.B, seat: 1 },
          { userId: 'c', team: GameTeam.A, seat: 2 },
          { userId: 'd', team: GameTeam.B, seat: 3 },
        ],
      });
    });

    it('auto-balances unpicked members into open slots (partial picks)', () => {
      // a picked A, d picked B; b and c unassigned fill the open A/B slots.
      const result = assignTeamsAndSeats(
        ['a', 'b', 'c', 'd'],
        picks({ a: GameTeam.A, d: GameTeam.B }),
        GameMode.TEAM_2V2,
      );
      // Open slots after picks: A has 1 (a), B has 1 (d). Greedy fill A-then-B in
      // join order: b -> A (fills A), c -> B (fills B).
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const byUser = Object.fromEntries(result.seats.map((s) => [s.userId, s.team]));
      expect(byUser).toEqual({ a: GameTeam.A, b: GameTeam.A, c: GameTeam.B, d: GameTeam.B });
      // Positional invariant: seats {0,2} are team A, {1,3} are team B.
      for (const s of result.seats) {
        expect(s.team).toBe(s.seat % 2 === 0 ? GameTeam.A : GameTeam.B);
      }
    });

    it('auto-balances all members when nobody picked (matchmaking case)', () => {
      const result = assignTeamsAndSeats(['a', 'b', 'c', 'd'], picks({}), GameMode.TEAM_2V2);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Greedy A-then-B: a->A, b->A(full), c->B, d->B.
      const byUser = Object.fromEntries(result.seats.map((s) => [s.userId, s.team]));
      expect(byUser).toEqual({ a: GameTeam.A, b: GameTeam.A, c: GameTeam.B, d: GameTeam.B });
      // Every seat filled 0..3, positional invariant holds.
      expect(result.seats.map((s) => s.seat).sort()).toEqual([0, 1, 2, 3]);
      for (const s of result.seats) {
        expect(s.team).toBe(s.seat % 2 === 0 ? GameTeam.A : GameTeam.B);
      }
    });

    it('preserves join order within each team when seating', () => {
      // d picked A (joined last); a,b,c unpicked. Team A = {d, a} but seat order
      // must follow join order within the team: a (seat 0) before d (seat 2).
      const result = assignTeamsAndSeats(
        ['a', 'b', 'c', 'd'],
        picks({ d: GameTeam.A }),
        GameMode.TEAM_2V2,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const seatOf = Object.fromEntries(result.seats.map((s) => [s.userId, s.seat]));
      // a fills the other A slot; team A members {a,d} occupy seats {0,2} in join order.
      expect(seatOf.a).toBe(0);
      expect(seatOf.d).toBe(2);
    });

    it('rejects the wrong player count', () => {
      expect(assignTeamsAndSeats(['a', 'b', 'c'], picks({}), GameMode.TEAM_2V2)).toEqual({
        ok: false,
        error: 'WRONG_PLAYER_COUNT',
      });
      expect(assignTeamsAndSeats(['a', 'b', 'c', 'd', 'e'], picks({}), GameMode.TEAM_2V2)).toEqual({
        ok: false,
        error: 'WRONG_PLAYER_COUNT',
      });
    });

    it('rejects an unbalanced pick (three on one team)', () => {
      const result = assignTeamsAndSeats(
        ['a', 'b', 'c', 'd'],
        picks({ a: GameTeam.A, b: GameTeam.A, c: GameTeam.A }),
        GameMode.TEAM_2V2,
      );
      expect(result).toEqual({ ok: false, error: 'UNBALANCED' });
    });
  });

  describe('expandTeamWinners', () => {
    const participants = [
      { userId: 'a', team: GameTeam.A },
      { userId: 'b', team: GameTeam.B },
      { userId: 'c', team: GameTeam.A },
      { userId: 'd', team: GameTeam.B },
    ];

    it('returns both members of the winning team', () => {
      expect(expandTeamWinners(participants, GameTeam.A).sort()).toEqual(['a', 'c']);
      expect(expandTeamWinners(participants, GameTeam.B).sort()).toEqual(['b', 'd']);
    });

    it('ignores participants with no team', () => {
      const mixed = [...participants, { userId: 'e', team: null }];
      expect(expandTeamWinners(mixed, GameTeam.A).sort()).toEqual(['a', 'c']);
    });
  });
});

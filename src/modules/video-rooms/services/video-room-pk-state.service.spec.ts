import { VideoRoomPkStatus } from '@prisma/client';
import { PKBattleException } from '../exceptions/video-room-pk.exceptions';
import { VideoRoomPkStateService } from './video-room-pk-state.service';

const repo = () => ({ transition: jest.fn() });

describe('VideoRoomPkStateService', () => {
  it('permits a legal edge', () => {
    const svc = new VideoRoomPkStateService(repo() as never);
    expect(() =>
      svc.assertTransition(VideoRoomPkStatus.LIVE, VideoRoomPkStatus.PAUSED),
    ).not.toThrow();
  });

  it('rejects an illegal edge with PKBattleException', () => {
    const svc = new VideoRoomPkStateService(repo() as never);
    expect(() => svc.assertTransition(VideoRoomPkStatus.CREATED, VideoRoomPkStatus.LIVE)).toThrow(
      PKBattleException,
    );
  });

  it('rejects any move out of a terminal state', () => {
    const svc = new VideoRoomPkStateService(repo() as never);
    expect(() => svc.assertTransition(VideoRoomPkStatus.COMPLETED, VideoRoomPkStatus.LIVE)).toThrow(
      PKBattleException,
    );
  });

  it('throws when the conditional update loses the race', async () => {
    const r = repo();
    r.transition.mockResolvedValue(null);
    const svc = new VideoRoomPkStateService(r as never);

    await expect(
      svc.transition('b1', VideoRoomPkStatus.LIVE, VideoRoomPkStatus.PAUSED),
    ).rejects.toThrow(PKBattleException);
  });

  // Settlement must be able to lose without exploding: a replayed end job that
  // finds the battle already COMPLETED should exit quietly, not alert.
  it('tryTransition returns null instead of throwing when it loses', async () => {
    const r = repo();
    r.transition.mockResolvedValue(null);
    const svc = new VideoRoomPkStateService(r as never);

    expect(
      await svc.tryTransition('b1', VideoRoomPkStatus.LIVE, VideoRoomPkStatus.COMPLETED),
    ).toBeNull();
  });

  it('passes the patch through to the repository', async () => {
    const r = repo();
    r.transition.mockResolvedValue({ id: 'b1' });
    const svc = new VideoRoomPkStateService(r as never);
    const patch = { pausedAt: new Date('2026-07-22T00:00:00Z') };

    await svc.transition('b1', VideoRoomPkStatus.LIVE, VideoRoomPkStatus.PAUSED, patch);

    expect(r.transition).toHaveBeenCalledWith(
      'b1',
      VideoRoomPkStatus.LIVE,
      VideoRoomPkStatus.PAUSED,
      patch,
      undefined,
    );
  });

  // Beyond the brief: pin the TERMINAL-vs-ordinary message branch in
  // assertTransition. The branch exists to give operators a better error —
  // nothing proves it actually fires differently until this test does.
  describe('assertTransition message branch', () => {
    const svc = new VideoRoomPkStateService(repo() as never);

    it.each([VideoRoomPkStatus.COMPLETED, VideoRoomPkStatus.CANCELLED, VideoRoomPkStatus.FAILED])(
      'uses the terminal-specific message when leaving %s',
      (from) => {
        try {
          svc.assertTransition(from, VideoRoomPkStatus.LIVE);
          throw new Error('expected assertTransition to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(PKBattleException);
          expect((err as PKBattleException).message).toMatch(/already finished/i);
        }
      },
    );

    it('uses the ordinary illegal-edge message for a non-terminal source', () => {
      try {
        svc.assertTransition(VideoRoomPkStatus.CREATED, VideoRoomPkStatus.LIVE);
        throw new Error('expected assertTransition to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(PKBattleException);
        expect((err as PKBattleException).message).not.toMatch(/already finished/i);
        expect((err as PKBattleException).message).toMatch(/cannot move from/i);
      }
    });
  });

  // Beyond the brief: prove tryTransition asserts BEFORE touching the
  // repository. Without this, an illegal edge could reach the database.
  // `tryTransition` is declared `async` precisely so this illegal-edge throw
  // surfaces as a rejected promise (safe for `.catch()` chaining) rather than
  // a synchronous throw — see the dedicated `.catch()` test below.
  it('tryTransition asserts before calling the repository, and never calls it on an illegal edge', async () => {
    const r = repo();
    const svc = new VideoRoomPkStateService(r as never);

    await expect(
      svc.tryTransition('b1', VideoRoomPkStatus.CREATED, VideoRoomPkStatus.LIVE),
    ).rejects.toThrow(PKBattleException);
    expect(r.transition).not.toHaveBeenCalled();
  });

  // Proves the contract through a .catch() chain, not through await/try-catch
  // (which passed even before the fix and would prove nothing here). If
  // tryTransition were not `async`, assertTransition's synchronous throw would
  // escape this .catch() entirely and surface as an uncaught exception instead
  // of a rejected promise.
  it('rejects (does not throw synchronously) on an illegal edge, so .catch() chaining is safe', async () => {
    const r = repo();
    const svc = new VideoRoomPkStateService(r as never);
    const caught = await svc
      .tryTransition('b1', VideoRoomPkStatus.COMPLETED, VideoRoomPkStatus.LIVE)
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(PKBattleException);
    expect(r.transition).not.toHaveBeenCalled();
  });
});

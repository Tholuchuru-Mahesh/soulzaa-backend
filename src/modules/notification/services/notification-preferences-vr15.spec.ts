import { NotificationService } from './notification.service';

// The brief's spec constructs `new NotificationService(repo, prefRepo, bus)`
// (three positional args). The actual constructor is
// `(repo, prefs, policy, bus, devices)` — five args — so the mocks below are
// adjusted to that real signature. The assertion under test (the five new
// toggles default to `true` when no preference row exists) is unchanged.
describe('NotificationService VR-15 preferences', () => {
  it('defaults the five video-room toggles to true when no row exists', async () => {
    const prefRepo = { find: jest.fn().mockResolvedValue(null), upsert: jest.fn() };
    const svc = new NotificationService(
      {
        create: jest.fn(),
        page: jest.fn(),
        markRead: jest.fn(),
        markAllRead: jest.fn(),
        unreadCount: jest.fn(),
      } as never,
      prefRepo as never,
      { resolve: jest.fn(), allows: jest.fn(), needsUnreadCount: jest.fn() } as never,
      { publish: jest.fn() } as never,
      { pushToUser: jest.fn() } as never,
    );
    const prefs = await svc.preferences('u1');
    expect(prefs.roomEvents).toBe(true);
    expect(prefs.seatEvents).toBe(true);
    expect(prefs.treasureEvents).toBe(true);
    expect(prefs.pkEvents).toBe(true);
    expect(prefs.announcementEvents).toBe(true);
  });
});

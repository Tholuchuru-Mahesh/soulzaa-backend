// src/modules/platform-moderation/controllers/platform-moderation-admin.controller.spec.ts
import { PlatformModerationAdminController } from './platform-moderation-admin.controller';

describe('PlatformModerationAdminController', () => {
  let bans: Record<string, jest.Mock>;
  let audit: Record<string, jest.Mock>;
  // broadBans is prepared for Task 8's constructor wiring but is unused until then.
  let broadBans: Record<string, jest.Mock>;
  let controller: PlatformModerationAdminController;

  beforeEach(() => {
    bans = {
      list: jest.fn().mockResolvedValue([[{ id: 'ban-1' }], 1]),
      unbanUser: jest.fn().mockResolvedValue({ id: 'ban-1', status: 'LIFTED' }),
      extendBan: jest.fn().mockResolvedValue({ id: 'ban-1', expiresAt: new Date('2026-08-20T00:00:00.000Z') }),
    };
    audit = { list: jest.fn().mockResolvedValue([[], 0]) };
    broadBans = {
      list: jest.fn().mockResolvedValue([[], 0]),
      liftBroadBan: jest.fn(),
      extendBroadBan: jest.fn(),
    };
    controller = new PlatformModerationAdminController(
      bans as never,
      audit as never,
      broadBans as never,
    );
  });

  it('listBans() paginates and returns the repository result', async () => {
    const result = await controller.listBans({ page: 1, limit: 20 } as never);
    expect(bans.list).toHaveBeenCalledWith({ status: undefined, targetUserId: undefined }, 0, 20);
    expect(result.total).toBe(1);
  });

  it('lift() delegates to PlatformBanService.unbanUser with the current admin id', async () => {
    await controller.lift({ id: 'admin-1', roles: ['ADMIN'] } as never, 'ban-1');
    expect(bans.unbanUser).toHaveBeenCalledWith('admin-1', 'ban-1');
  });

  describe('extendBan', () => {
    it('delegates to PlatformBanService.extendBan with the admin id, ban id, and additional hours', async () => {
      const result = await controller.extendBan(
        { id: 'admin-1' } as never,
        'ban-1',
        { additionalHours: 24 },
      );
      expect(bans.extendBan).toHaveBeenCalledWith('admin-1', 'ban-1', 24);
      expect(result.id).toBe('ban-1');
    });
  });

  describe('broad-bans admin routes', () => {
    it('listBroadBans paginates and delegates to BroadBanService.list', async () => {
      broadBans.list.mockResolvedValueOnce([[{ id: 'bb-1' }], 1]);
      const result = await controller.listBroadBans({ page: 1, limit: 20 } as never);
      expect(broadBans.list).toHaveBeenCalledWith({ status: undefined, ownerId: undefined }, 0, 20);
      expect(result.total).toBe(1);
    });

    it('revokeBroadBan delegates to BroadBanService.liftBroadBan with admin id', async () => {
      broadBans.liftBroadBan.mockResolvedValueOnce({ id: 'bb-1', status: 'LIFTED' });
      const result = await controller.revokeBroadBan({ id: 'admin-1' } as never, 'bb-1');
      expect(broadBans.liftBroadBan).toHaveBeenCalledWith('admin-1', 'bb-1');
      expect(result.status).toBe('LIFTED');
    });

    it('extendBroadBan delegates to BroadBanService.extendBroadBan', async () => {
      broadBans.extendBroadBan.mockResolvedValueOnce({ id: 'bb-1', expiresAt: new Date() });
      await controller.extendBroadBan({ id: 'admin-1' } as never, 'bb-1', { additionalHours: 48 });
      expect(broadBans.extendBroadBan).toHaveBeenCalledWith('admin-1', 'bb-1', 48);
    });
  });
});

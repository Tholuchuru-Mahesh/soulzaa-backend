// src/modules/platform-moderation/controllers/platform-moderation-admin.controller.spec.ts
import { PlatformModerationAdminController } from './platform-moderation-admin.controller';

describe('PlatformModerationAdminController', () => {
  let bans: Record<string, jest.Mock>;
  let audit: Record<string, jest.Mock>;
  let controller: PlatformModerationAdminController;

  beforeEach(() => {
    bans = {
      list: jest.fn().mockResolvedValue([[{ id: 'ban-1' }], 1]),
      unbanUser: jest.fn().mockResolvedValue({ id: 'ban-1', status: 'LIFTED' }),
    };
    audit = { list: jest.fn().mockResolvedValue([[], 0]) };
    controller = new PlatformModerationAdminController(bans as never, audit as never);
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
});

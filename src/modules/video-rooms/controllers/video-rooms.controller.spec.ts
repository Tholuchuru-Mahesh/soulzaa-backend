import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { VideoRoomsController } from './video-rooms.controller';

const user = { id: 'u1', roles: [] } as AuthenticatedUser;
const expectedActor = { id: 'u1', roles: [] };

describe('VideoRoomsController', () => {
  let lifecycle: any;
  let query: any;
  let settings: any;
  let controller: VideoRoomsController;

  beforeEach(() => {
    lifecycle = {
      create: jest.fn().mockResolvedValue({ id: 'r1' }),
      update: jest.fn().mockResolvedValue({ id: 'r1' }),
      remove: jest.fn().mockResolvedValue({ deleted: true }),
      activate: jest.fn().mockResolvedValue({ id: 'r1' }),
      close: jest.fn().mockResolvedValue({ id: 'r1' }),
      reopen: jest.fn().mockResolvedValue({ id: 'r1' }),
      lock: jest.fn().mockResolvedValue({ id: 'r1' }),
      unlock: jest.fn().mockResolvedValue({ id: 'r1' }),
      restore: jest.fn().mockResolvedValue({ id: 'r1' }),
    };
    query = {
      list: jest.fn().mockResolvedValue({ items: [] }),
      search: jest.fn().mockResolvedValue({ items: [] }),
      trending: jest.fn().mockResolvedValue([]),
      popular: jest.fn().mockResolvedValue({ items: [] }),
      featured: jest.fn().mockResolvedValue({ items: [] }),
      mine: jest.fn().mockResolvedValue([]),
      getDetail: jest.fn().mockResolvedValue({ id: 'r1' }),
      verifyStatus: jest.fn().mockResolvedValue({ roomId: 'r1' }),
    };
    settings = {
      update: jest.fn().mockResolvedValue({ roomId: 'r1' }),
    };
    const entryPayment = {
      payEntryFee: jest.fn().mockResolvedValue({ id: 'tx1' }),
    };
    controller = new VideoRoomsController(lifecycle, query, settings, entryPayment as any);
  });

  it('create delegates with the mapped actor + dto', async () => {
    await controller.create(user, { name: 'x' } as any);
    expect(lifecycle.create).toHaveBeenCalledWith(expectedActor, { name: 'x' });
  });

  it('list forwards the query + actor', async () => {
    await controller.list(user, { page: 1 } as any);
    expect(query.list).toHaveBeenCalledWith({ page: 1 }, expectedActor);
  });

  it('search forwards the query + actor', async () => {
    await controller.search(user, { page: 1 } as any);
    expect(query.search).toHaveBeenCalledWith({ page: 1 }, expectedActor);
  });

  it('trending forwards the limit', async () => {
    await controller.trending({ limit: 7 } as any);
    expect(query.trending).toHaveBeenCalledWith(7);
  });

  it('popular + featured forward query + actor', async () => {
    await controller.popular(user, { page: 1 } as any);
    await controller.featured(user, { page: 1 } as any);
    expect(query.popular).toHaveBeenCalledWith({ page: 1 }, expectedActor);
    expect(query.featured).toHaveBeenCalledWith({ page: 1 }, expectedActor);
  });

  it('mine forwards the actor', async () => {
    await controller.mine(user);
    expect(query.mine).toHaveBeenCalledWith(expectedActor);
  });

  it('detail + status forward the id', async () => {
    await controller.detail('r1');
    await controller.status('r1');
    expect(query.getDetail).toHaveBeenCalledWith('r1');
    expect(query.verifyStatus).toHaveBeenCalledWith('r1');
  });

  it('update forwards actor + id + dto', async () => {
    await controller.update(user, 'r1', { name: 'y' } as any);
    expect(lifecycle.update).toHaveBeenCalledWith(expectedActor, 'r1', { name: 'y' });
  });

  it('remove forwards actor + id', async () => {
    const res = await controller.remove(user, 'r1');
    expect(lifecycle.remove).toHaveBeenCalledWith(expectedActor, 'r1');
    expect(res).toEqual({ deleted: true });
  });

  it('activate / close / reopen / unlock / restore forward actor + id', async () => {
    await controller.activate(user, 'r1');
    await controller.close(user, 'r1');
    await controller.reopen(user, 'r1');
    await controller.unlock(user, 'r1');
    await controller.restore(user, 'r1');
    expect(lifecycle.activate).toHaveBeenCalledWith(expectedActor, 'r1');
    expect(lifecycle.close).toHaveBeenCalledWith(expectedActor, 'r1');
    expect(lifecycle.reopen).toHaveBeenCalledWith(expectedActor, 'r1');
    expect(lifecycle.unlock).toHaveBeenCalledWith(expectedActor, 'r1');
    expect(lifecycle.restore).toHaveBeenCalledWith(expectedActor, 'r1');
  });

  it('lock forwards actor + id + body', async () => {
    await controller.lock(user, 'r1', { password: 'pw' } as any);
    expect(lifecycle.lock).toHaveBeenCalledWith(expectedActor, 'r1', { password: 'pw' });
  });

  describe('VR-17 PATCH :id/settings', () => {
    it('delegates to the settings service with the resolved actor', async () => {
      await controller.updateSettings(user, 'r1', { allowGifts: false } as any);
      expect(settings.update).toHaveBeenCalledWith(expectedActor, 'r1', { allowGifts: false });
    });
  });
});

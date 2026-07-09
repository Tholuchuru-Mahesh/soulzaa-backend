import { BackpackItemSource, BackpackItemType } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions';
import { LockService } from 'src/infra/redis/lock.service';
import { BackpackRepository } from '../repositories/backpack.repository';
import { BackpackService } from './backpack.service';

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    userId: 'user-1',
    type: BackpackItemType.FRAME,
    refId: null,
    name: 'Gold Frame',
    source: BackpackItemSource.TREASURE_BOX,
    quantity: 1,
    equipped: false,
    transferable: false,
    grantKey: 'gk-1',
    metadata: null,
    acquiredAt: new Date(),
    expiresAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('BackpackService', () => {
  let repo: Record<string, jest.Mock>;
  let locks: { withLock: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let service: BackpackService;

  beforeEach(() => {
    repo = {
      findByGrantKey: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((d) => Promise.resolve(item(d))),
      getItem: jest.fn().mockResolvedValue(item()),
      listItems: jest.fn().mockResolvedValue([[], 0]),
      setEquipped: jest.fn().mockResolvedValue(undefined),
      unequipType: jest.fn().mockResolvedValue(undefined),
      transfer: jest
        .fn()
        .mockImplementation((_id, to) => Promise.resolve(item({ id: 'item-2', userId: to }))),
      log: jest.fn().mockResolvedValue(undefined),
      listLogs: jest.fn().mockResolvedValue([[], 0]),
    };
    locks = { withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    service = new BackpackService(
      repo as unknown as BackpackRepository,
      locks as unknown as LockService,
      bus,
    );
  });

  describe('grant', () => {
    it('creates an item and publishes a granted event', async () => {
      const res = await service.grant({
        userId: 'user-1',
        type: BackpackItemType.FRAME,
        name: 'Gold Frame',
        source: BackpackItemSource.TREASURE_BOX,
        grantKey: 'gk-1',
      });
      expect(repo.create).toHaveBeenCalled();
      expect(res.duplicate).toBe(false);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'backpack.item_granted' }),
      );
    });

    it('is idempotent on grantKey', async () => {
      repo.findByGrantKey.mockResolvedValue(item({ id: 'existing' }));
      const res = await service.grant({
        userId: 'user-1',
        type: BackpackItemType.FRAME,
        name: 'Gold Frame',
        source: BackpackItemSource.TREASURE_BOX,
        grantKey: 'gk-1',
      });
      expect(res).toEqual({ itemId: 'existing', duplicate: true });
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('equip', () => {
    it('unequips others of the same type then equips the item', async () => {
      await service.equip('user-1', 'item-1');
      expect(repo.unequipType).toHaveBeenCalledWith('user-1', BackpackItemType.FRAME);
      expect(repo.setEquipped).toHaveBeenCalledWith('item-1', true);
    });

    it('rejects equipping a non-equippable type', async () => {
      repo.getItem.mockResolvedValue(item({ type: BackpackItemType.DECORATION }));
      await expect(service.equip('user-1', 'item-1')).rejects.toMatchObject({
        errorCode: 'BACKPACK_ITEM_NOT_EQUIPPABLE',
      });
    });

    it('rejects an item you do not own', async () => {
      repo.getItem.mockResolvedValue(item({ userId: 'someone-else' }));
      await expect(service.equip('user-1', 'item-1')).rejects.toMatchObject({
        errorCode: 'BACKPACK_ITEM_NOT_FOUND',
      });
    });

    it('rejects an expired item', async () => {
      repo.getItem.mockResolvedValue(item({ expiresAt: new Date(Date.now() - 1000) }));
      await expect(service.equip('user-1', 'item-1')).rejects.toMatchObject({
        errorCode: 'BACKPACK_ITEM_EXPIRED',
      });
    });
  });

  describe('transfer', () => {
    it('moves a transferable item and logs both sides', async () => {
      repo.getItem.mockResolvedValue(item({ transferable: true }));
      await service.transfer('user-1', 'item-1', 'user-2');
      expect(repo.transfer).toHaveBeenCalledWith('item-1', 'user-2');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'backpack.item_transferred' }),
      );
    });

    it('rejects a non-transferable item', async () => {
      repo.getItem.mockResolvedValue(item({ transferable: false }));
      await expect(service.transfer('user-1', 'item-1', 'user-2')).rejects.toMatchObject({
        errorCode: 'BACKPACK_ITEM_NOT_TRANSFERABLE',
      });
    });

    it('rejects transferring to yourself', async () => {
      await expect(service.transfer('user-1', 'item-1', 'user-1')).rejects.toBeInstanceOf(
        BusinessException,
      );
    });
  });
});

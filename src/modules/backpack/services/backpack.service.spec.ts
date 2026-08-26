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
      findByUserIdAndRefId: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((d) => Promise.resolve(item(d))),
      updateItem: jest.fn().mockImplementation((id, d) => Promise.resolve(item({ id, ...d }))),
      deleteItem: jest.fn().mockImplementation((id) => Promise.resolve(item({ id }))),
      getItem: jest.fn().mockResolvedValue(item()),
      listItems: jest.fn().mockResolvedValue([[], 0]),
      setEquipped: jest.fn().mockResolvedValue(undefined),
      unequipType: jest.fn().mockResolvedValue(undefined),
      transfer: jest
        .fn()
        .mockImplementation((_id, to) => Promise.resolve(item({ id: 'item-2', userId: to }))),
      syncUserCosmeticsOnTransfer: jest.fn().mockResolvedValue(undefined),
      log: jest.fn().mockResolvedValue(undefined),
      listLogs: jest.fn().mockResolvedValue([[], 0]),
    };
    locks = { withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    service = new BackpackService(
      repo as unknown as BackpackRepository,
      locks as unknown as LockService,
      bus,
      { invalidateProfile: jest.fn().mockResolvedValue(undefined) } as any,
      { resolve: jest.fn().mockImplementation((key) => Promise.resolve(key)) } as any,
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

    it('merges TTL and extends expiry when receiving the exact same gift again', async () => {
      const now = Date.now();
      const oneDayFromNow = new Date(now + 1 * 24 * 60 * 60 * 1000);
      const threeDaysFromNow = new Date(now + 3 * 24 * 60 * 60 * 1000);

      repo.findByGrantKey.mockResolvedValue(null);
      repo.findByUserIdAndRefId.mockResolvedValue(
        item({
          id: 'existing-item-1',
          refId: 'cosmetic-1',
          expiresAt: oneDayFromNow,
          transferable: true,
        }),
      );
      repo.updateItem.mockImplementation((id, data) =>
        Promise.resolve(item({ id, ...data })),
      );

      const res = await service.grant({
        userId: 'user-1',
        type: BackpackItemType.FRAME,
        refId: 'cosmetic-1',
        name: 'Gold Frame',
        source: BackpackItemSource.GIFT,
        transferable: false,
        grantKey: 'new-gift-grant-key',
        expiresAt: threeDaysFromNow,
      });

      expect(res).toEqual({ itemId: 'existing-item-1', duplicate: true });
      expect(repo.create).not.toHaveBeenCalled();
      expect(repo.updateItem).toHaveBeenCalledWith(
        'existing-item-1',
        expect.objectContaining({
          transferable: false,
        }),
        undefined,
      );

      const updateCallData = repo.updateItem.mock.calls[0][1];
      const mergedExpiresAt: Date = updateCallData.expiresAt;
      // Merged expiry should be approximately 4 days from now (1 day remaining + 3 days incoming)
      const diffDays = (mergedExpiresAt.getTime() - now) / (24 * 60 * 60 * 1000);
      expect(Math.round(diffDays)).toBe(4);
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

    it('merges TTL into recipient existing item on transfer', async () => {
      const now = Date.now();
      const oneDayFromNow = new Date(now + 1 * 24 * 60 * 60 * 1000);
      const twoDaysFromNow = new Date(now + 2 * 24 * 60 * 60 * 1000);

      repo.getItem.mockResolvedValue(
        item({
          id: 'item-1',
          userId: 'user-1',
          refId: 'cosmetic-1',
          transferable: true,
          expiresAt: twoDaysFromNow,
        }),
      );
      repo.findByUserIdAndRefId.mockResolvedValue(
        item({
          id: 'recipient-item-1',
          userId: 'user-2',
          refId: 'cosmetic-1',
          expiresAt: oneDayFromNow,
        }),
      );
      repo.updateItem.mockImplementation((id, data) =>
        Promise.resolve(item({ id, ...data })),
      );
      repo.deleteItem.mockResolvedValue(item({ id: 'item-1' }));

      await service.transfer('user-1', 'item-1', 'user-2');

      expect(repo.updateItem).toHaveBeenCalledWith(
        'recipient-item-1',
        expect.objectContaining({
          transferable: false,
        }),
      );
      expect(repo.deleteItem).toHaveBeenCalledWith('item-1');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'backpack.item_transferred',
          payload: expect.objectContaining({
            fromUserId: 'user-1',
            toUserId: 'user-2',
            itemId: 'item-1',
            newItemId: 'recipient-item-1',
          }),
        }),
      );

      const updateCallData = repo.updateItem.mock.calls[0][1];
      const mergedExpiresAt: Date = updateCallData.expiresAt;
      const diffDays = (mergedExpiresAt.getTime() - now) / (24 * 60 * 60 * 1000);
      expect(Math.round(diffDays)).toBe(3);
    });
  });
});

import { BackpackItemSource, WalletTxnReason } from '@prisma/client';
import { RewardDistributor } from './reward-distributor.service';
import type { RewardEntry } from '../constants/treasure.constants';

describe('RewardDistributor — dynamic reward payout', () => {
  let distributor: RewardDistributor;
  let wallet: { credit: jest.Mock };
  let backpack: { grant: jest.Mock };
  let prisma: any;
  let media: { resolve: jest.Mock };

  const baseInput = {
    recipients: [
      { rank: 1, userId: 'u1' },
      { rank: 2, userId: 'u2' },
    ],
    idempotencyPrefix: 'tb-open:box-1',
    walletReason: WalletTxnReason.TREASURE_BOX,
    backpackSource: BackpackItemSource.TREASURE_BOX,
    referenceType: 'treasure_box',
    referenceId: 'box-1',
  };

  beforeEach(() => {
    wallet = { credit: jest.fn().mockResolvedValue({ transactionId: 'w-tx-1' }) };
    backpack = { grant: jest.fn().mockResolvedValue({ itemId: 'bp-1', duplicate: false }) };
    prisma = {
      cosmetic: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'cos-1',
          type: 'FRAME',
          rarity: 'EPIC',
          mediaUrl: 'cosmetic-assets/frame.png',
          thumbnailUrl: 'cosmetic-assets/frame-thumb.png',
          transferable: false,
          metadata: {},
        }),
      },
      userCosmetic: { upsert: jest.fn().mockResolvedValue({}) },
    };
    media = {
      resolve: jest.fn((k: string | null) => Promise.resolve(k ? `https://cdn/${k}` : null)),
    };
    distributor = new RewardDistributor(
      wallet as any,
      backpack as any,
      prisma as any,
      media as any,
    );
  });

  it('credits free coins to the ranked winner (idempotency key per reward slot)', async () => {
    const rewards: RewardEntry[] = [{ rank: 1, kind: 'COINS', coins: 5000 }];
    const out = await distributor.distribute({ ...baseInput, rewards });

    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        amount: 5000,
        idempotencyKey: 'tb-open:box-1:r1#0:coins',
      }),
      undefined,
    );
    expect(out[0]).toMatchObject({ kind: 'COINS', coins: 5000n, walletTxnId: 'w-tx-1' });
  });

  it('pays every reward at a rank when a rank carries more than one', async () => {
    prisma.cosmetic.findUnique.mockResolvedValue({
      id: 'cos-1',
      type: 'THEME',
      rarity: 'RARE',
      mediaUrl: null,
      thumbnailUrl: null,
      transferable: false,
      metadata: {},
    });
    const rewards: RewardEntry[] = [
      { rank: 1, kind: 'COINS', coins: 1000 },
      {
        rank: 1,
        kind: 'BACKPACK_ITEM',
        itemType: 'THEME' as any,
        itemName: 'Aurora',
        itemRefId: 'cos-1',
      },
    ];
    const out = await distributor.distribute({ ...baseInput, rewards });

    expect(out).toHaveLength(2);
    expect(wallet.credit).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'tb-open:box-1:r1#0:coins' }),
      undefined,
    );
    expect(backpack.grant).toHaveBeenCalledWith(
      expect.objectContaining({ grantKey: 'tb-open:box-1:r1#1:item' }),
      undefined,
    );
  });

  it('applies the admin-configured TTL as the reward expiry (0 = permanent)', async () => {
    prisma.cosmetic.findUnique.mockResolvedValue({
      id: 'cos-1',
      type: 'FRAME',
      rarity: 'EPIC',
      mediaUrl: null,
      thumbnailUrl: null,
      transferable: false,
      metadata: { durationDays: 999 },
    });

    const timed = await distributor.distribute({
      ...baseInput,
      rewards: [
        {
          rank: 1,
          kind: 'BACKPACK_ITEM',
          itemType: 'FRAME' as any,
          itemName: 'F',
          itemRefId: 'cos-1',
          ttlDays: 7,
        },
      ],
    });
    expect(timed[0].expiresAt).toBeInstanceOf(Date);
    const grantCall = backpack.grant.mock.calls.at(-1)![0];
    expect(grantCall.expiresAt).toBeInstanceOf(Date);

    backpack.grant.mockClear();
    const permanent = await distributor.distribute({
      ...baseInput,
      rewards: [
        {
          rank: 1,
          kind: 'BACKPACK_ITEM',
          itemType: 'FRAME' as any,
          itemName: 'F',
          itemRefId: 'cos-1',
          ttlDays: 0,
        },
      ],
    });
    // ttlDays 0 wins over the cosmetic's own 999-day duration → permanent.
    expect(permanent[0].expiresAt).toBeNull();
    expect(backpack.grant.mock.calls.at(-1)![0].expiresAt).toBeUndefined();
  });

  it('grants a catalog cosmetic into the backpack and mirrors user_cosmetics for equip', async () => {
    const rewards: RewardEntry[] = [
      {
        rank: 1,
        kind: 'BACKPACK_ITEM',
        itemType: 'FRAME' as any,
        itemName: 'Golden Halo',
        itemRefId: 'cos-1',
      },
    ];
    const out = await distributor.distribute({ ...baseInput, rewards });

    expect(backpack.grant).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        type: 'FRAME',
        refId: 'cos-1',
        grantKey: 'tb-open:box-1:r1#0:item',
      }),
      undefined,
    );
    expect(prisma.userCosmetic.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_cosmeticId: { userId: 'u1', cosmeticId: 'cos-1' } },
      }),
    );
    expect(out[0]).toMatchObject({
      kind: 'BACKPACK_ITEM',
      itemRefId: 'cos-1',
      backpackItemId: 'bp-1',
      thumbnailUrl: 'https://cdn/cosmetic-assets/frame-thumb.png',
    });
  });

  it('skips a legacy cosmetic reward that has no catalog asset link', async () => {
    const rewards: RewardEntry[] = [
      { rank: 1, kind: 'BACKPACK_ITEM', itemType: 'THEME' as any, itemName: 'Bronze Entry Theme' },
    ];
    const out = await distributor.distribute({ ...baseInput, rewards });

    expect(backpack.grant).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it('does not pay a rank with no contributor', async () => {
    const rewards: RewardEntry[] = [{ rank: 3, kind: 'COINS', coins: 100 }];
    const out = await distributor.distribute({ ...baseInput, rewards });

    expect(wallet.credit).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });
});

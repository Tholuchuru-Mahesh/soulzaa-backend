import { TreasureAdminService } from './treasure-admin.service';
import type { TreasureConfigDto } from '../dto/treasure.dto';
import type { TreasureRepository } from '../repositories/treasure.repository';
import type { RocketRepository } from '../repositories/rocket.repository';
import type { ICosmeticsService } from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';

describe('TreasureAdminService — dynamic reward validation', () => {
  let service: TreasureAdminService;
  let treasureRepo: { upsertConfig: jest.Mock; listConfigs: jest.Mock };
  let cosmetics: { getCosmetic: jest.Mock };

  const FRAME = {
    id: '11111111-1111-1111-1111-111111111111',
    type: 'FRAME',
    name: 'Golden Halo',
    enabled: true,
    transferable: false,
  };

  beforeEach(() => {
    treasureRepo = {
      upsertConfig: jest
        .fn()
        .mockImplementation((_l, data) => Promise.resolve({ id: 'c1', ...data })),
      listConfigs: jest.fn().mockResolvedValue([]),
    };
    cosmetics = { getCosmetic: jest.fn() };
    service = new TreasureAdminService(
      treasureRepo as unknown as TreasureRepository,
      {} as unknown as RocketRepository,
      cosmetics as unknown as ICosmeticsService,
    );
  });

  const dto = (rewards: any[]): TreasureConfigDto =>
    ({ level: 1, threshold: 15000, enabled: true, rewards }) as TreasureConfigDto;

  it('binds a cosmetic reward to the catalog asset and derives its name', async () => {
    cosmetics.getCosmetic.mockResolvedValue(FRAME);
    await service.upsertTreasureConfig(
      'admin-1',
      dto([
        {
          rank: 1,
          kind: 'BACKPACK_ITEM',
          itemType: 'FRAME',
          itemRefId: FRAME.id,
          itemName: 'ignored',
        },
      ]),
    );
    const persisted = treasureRepo.upsertConfig.mock.calls[0][1].rewards as any[];
    expect(persisted[0]).toMatchObject({
      rank: 1,
      kind: 'BACKPACK_ITEM',
      itemType: 'FRAME',
      itemRefId: FRAME.id,
      itemName: 'Golden Halo',
    });
  });

  it('rejects a cosmetic reward with no catalog asset selected', async () => {
    await expect(
      service.upsertTreasureConfig(
        'admin-1',
        dto([{ rank: 1, kind: 'BACKPACK_ITEM', itemType: 'FRAME' }]),
      ),
    ).rejects.toMatchObject({ errorCode: expect.any(String) });
    expect(treasureRepo.upsertConfig).not.toHaveBeenCalled();
  });

  it('rejects an unknown or disabled asset', async () => {
    cosmetics.getCosmetic.mockResolvedValue({ ...FRAME, enabled: false });
    await expect(
      service.upsertTreasureConfig(
        'admin-1',
        dto([{ rank: 1, kind: 'BACKPACK_ITEM', itemType: 'FRAME', itemRefId: FRAME.id }]),
      ),
    ).rejects.toBeDefined();
  });

  it('rejects a type mismatch between reward and cosmetic', async () => {
    cosmetics.getCosmetic.mockResolvedValue({ ...FRAME, type: 'THEME' });
    await expect(
      service.upsertTreasureConfig(
        'admin-1',
        dto([{ rank: 1, kind: 'BACKPACK_ITEM', itemType: 'FRAME', itemRefId: FRAME.id }]),
      ),
    ).rejects.toBeDefined();
  });

  it('rejects a coins reward without a positive amount', async () => {
    await expect(
      service.upsertTreasureConfig('admin-1', dto([{ rank: 1, kind: 'COINS', coins: 0 }])),
    ).rejects.toBeDefined();
  });

  it('normalises a valid coins reward', async () => {
    await service.upsertTreasureConfig('admin-1', dto([{ rank: 1, kind: 'COINS', coins: 2500 }]));
    const persisted = treasureRepo.upsertConfig.mock.calls[0][1].rewards as any[];
    expect(persisted[0]).toEqual({ rank: 1, kind: 'COINS', coins: 2500 });
  });

  it('rejects two coin rewards at the same rank (must be one amount)', async () => {
    await expect(
      service.upsertTreasureConfig(
        'admin-1',
        dto([
          { rank: 1, kind: 'COINS', coins: 100 },
          { rank: 1, kind: 'COINS', coins: 200 },
        ]),
      ),
    ).rejects.toMatchObject({ errorCode: expect.any(String) });
  });

  it('accepts multiple distinct rewards at the same rank', async () => {
    const THEME = {
      ...FRAME,
      id: '22222222-2222-2222-2222-222222222222',
      type: 'THEME',
      name: 'Aurora',
    };
    cosmetics.getCosmetic.mockImplementation((id: string) =>
      Promise.resolve(id === FRAME.id ? FRAME : THEME),
    );
    await service.upsertTreasureConfig(
      'admin-1',
      dto([
        { rank: 1, kind: 'BACKPACK_ITEM', itemType: 'FRAME', itemRefId: FRAME.id },
        { rank: 1, kind: 'BACKPACK_ITEM', itemType: 'THEME', itemRefId: THEME.id },
        { rank: 1, kind: 'COINS', coins: 5000 },
      ]),
    );
    const persisted = treasureRepo.upsertConfig.mock.calls[0][1].rewards as any[];
    expect(persisted).toHaveLength(3);
    expect(persisted.filter((r) => r.rank === 1)).toHaveLength(3);
  });

  it('rejects the same cosmetic twice at one rank', async () => {
    cosmetics.getCosmetic.mockResolvedValue(FRAME);
    await expect(
      service.upsertTreasureConfig(
        'admin-1',
        dto([
          { rank: 1, kind: 'BACKPACK_ITEM', itemType: 'FRAME', itemRefId: FRAME.id },
          { rank: 1, kind: 'BACKPACK_ITEM', itemType: 'FRAME', itemRefId: FRAME.id },
        ]),
      ),
    ).rejects.toMatchObject({ errorCode: expect.any(String) });
  });

  it('persists the configured TTL (0 = permanent) on cosmetic rewards', async () => {
    cosmetics.getCosmetic.mockResolvedValue(FRAME);
    await service.upsertTreasureConfig(
      'admin-1',
      dto([
        { rank: 1, kind: 'BACKPACK_ITEM', itemType: 'FRAME', itemRefId: FRAME.id, ttlDays: 30 },
        { rank: 2, kind: 'BACKPACK_ITEM', itemType: 'FRAME', itemRefId: FRAME.id, ttlDays: 0 },
      ]),
    );
    const persisted = treasureRepo.upsertConfig.mock.calls[0][1].rewards as any[];
    expect(persisted[0].ttlDays).toBe(30);
    expect(persisted[1].ttlDays).toBe(0);
  });
});

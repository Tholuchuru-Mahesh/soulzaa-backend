import {
  WalletCurrency,
  WalletTxnReason,
  WealthClaimStatus,
  WealthRewardFrequency,
  WealthRewardGrantType,
} from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import type { ICosmeticsService } from 'src/modules/cosmetics/interfaces/cosmetics.service.interface';
import type { IWalletService } from 'src/modules/wallet/interfaces/wallet.service.interface';
import { WealthRepository } from '../repositories/wealth.repository';
import { WealthRewardService } from './wealth-reward.service';

function reward(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'reward-1',
    level: 3,
    rewardType: 'GOLD_COINS',
    rewardValue: { amount: 500 },
    frequency: WealthRewardFrequency.ONE_TIME,
    grantType: WealthRewardGrantType.AUTOMATIC,
    isActive: true,
    startAt: null,
    endAt: null,
    ...overrides,
  };
}

describe('WealthRewardService', () => {
  let repo: Record<string, jest.Mock>;
  let bus: jest.Mocked<IEventBus>;
  let wallet: { credit: jest.Mock };
  let cosmetics: { grantToUser: jest.Mock };
  let service: WealthRewardService;

  beforeEach(() => {
    repo = {
      listRewardsActive: jest.fn().mockResolvedValue([]),
      findRewardClaim: jest.fn().mockResolvedValue(null),
      grantRewardClaim: jest
        .fn()
        .mockResolvedValue({ id: 'claim-1', status: WealthClaimStatus.GRANTED }),
      markClaimed: jest.fn().mockResolvedValue(undefined),
      getReward: jest.fn().mockResolvedValue(reward()),
      listClaims: jest.fn().mockResolvedValue([[], 0]),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    wallet = {
      credit: jest.fn().mockResolvedValue({
        transactionId: 't1',
        balanceAfter: 500,
        duplicate: false,
        currency: WalletCurrency.GOLD,
      }),
    };
    cosmetics = {
      grantToUser: jest.fn().mockResolvedValue({ backpackItemId: 'i1', duplicate: false }),
    };
    service = new WealthRewardService(
      repo as unknown as WealthRepository,
      bus,
      wallet as unknown as IWalletService,
      cosmetics as unknown as ICosmeticsService,
    );
  });

  describe('grantAutomaticForCrossedLevels — level-up grants', () => {
    it('grants every active AUTOMATIC reward newly unlocked in (fromLevel, toLevel]', async () => {
      repo.listRewardsActive.mockResolvedValue([
        reward({ id: 'r-1', level: 1 }),
        reward({ id: 'r-2', level: 2 }),
        reward({ id: 'r-3', level: 3 }),
        reward({ id: 'r-4', level: 4 }), // above toLevel, not granted
      ]);

      await service.grantAutomaticForCrossedLevels('u1', 0, 3, '2026-08');

      expect(repo.grantRewardClaim).toHaveBeenCalledWith('u1', 'r-1', 'LIFETIME');
      expect(repo.grantRewardClaim).toHaveBeenCalledWith('u1', 'r-2', 'LIFETIME');
      expect(repo.grantRewardClaim).toHaveBeenCalledWith('u1', 'r-3', 'LIFETIME');
      expect(repo.grantRewardClaim).not.toHaveBeenCalledWith('u1', 'r-4', expect.anything());
    });

    it('never grants a CLAIMABLE reward automatically', async () => {
      repo.listRewardsActive.mockResolvedValue([
        reward({ id: 'r-1', level: 1, grantType: WealthRewardGrantType.CLAIMABLE }),
      ]);

      await service.grantAutomaticForCrossedLevels('u1', 0, 3, '2026-08');

      expect(repo.grantRewardClaim).not.toHaveBeenCalled();
    });

    it('fulfills a GOLD_COINS reward via the wallet, exactly once, keyed per grant', async () => {
      repo.listRewardsActive.mockResolvedValue([reward({ id: 'r-1', level: 1 })]);

      await service.grantAutomaticForCrossedLevels('u1', 0, 1, '2026-08');

      expect(wallet.credit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          currency: WalletCurrency.GOLD,
          amount: 500,
          reason: WalletTxnReason.EVENT_REWARD,
          referenceType: 'wealth_level_reward',
          referenceId: 'r-1',
        }),
      );
    });

    it('does not re-fulfill a reward already granted for that period (idempotency guard)', async () => {
      repo.listRewardsActive.mockResolvedValue([reward({ id: 'r-1', level: 1 })]);
      repo.findRewardClaim.mockResolvedValue({
        id: 'claim-existing',
        status: WealthClaimStatus.GRANTED,
      });

      await service.grantAutomaticForCrossedLevels('u1', 0, 1, '2026-08');

      expect(repo.grantRewardClaim).not.toHaveBeenCalled();
      expect(wallet.credit).not.toHaveBeenCalled();
    });
  });

  describe('grantAutomaticForPeriod — monthly recurring rewards', () => {
    it('re-grants MONTHLY automatic rewards at or below the level, skips ONE_TIME', async () => {
      repo.listRewardsActive.mockResolvedValue([
        reward({ id: 'r-monthly', level: 2, frequency: WealthRewardFrequency.MONTHLY }),
        reward({ id: 'r-onetime', level: 2, frequency: WealthRewardFrequency.ONE_TIME }),
        reward({ id: 'r-above', level: 5, frequency: WealthRewardFrequency.MONTHLY }),
      ]);

      await service.grantAutomaticForPeriod('u1', 3, '2026-09');

      expect(repo.grantRewardClaim).toHaveBeenCalledWith('u1', 'r-monthly', '2026-09');
      expect(repo.grantRewardClaim).not.toHaveBeenCalledWith('u1', 'r-onetime', expect.anything());
      expect(repo.grantRewardClaim).not.toHaveBeenCalledWith('u1', 'r-above', expect.anything());
    });
  });

  describe('claimReward', () => {
    it('claims a CLAIMABLE reward the user is eligible for', async () => {
      repo.getReward.mockResolvedValue(
        reward({ grantType: WealthRewardGrantType.CLAIMABLE, level: 2 }),
      );

      const res = await service.claimReward('u1', 'reward-1', 3);

      expect(res).toEqual({ claimed: true });
      expect(repo.markClaimed).toHaveBeenCalledWith('claim-1');
      expect(wallet.credit).toHaveBeenCalled();
    });

    it('rejects claiming an AUTOMATIC reward manually', async () => {
      repo.getReward.mockResolvedValue(reward({ grantType: WealthRewardGrantType.AUTOMATIC }));

      await expect(service.claimReward('u1', 'reward-1', 5)).rejects.toThrow();
      expect(repo.grantRewardClaim).not.toHaveBeenCalled();
    });

    it('rejects claiming when the user level is below the reward level', async () => {
      repo.getReward.mockResolvedValue(
        reward({ grantType: WealthRewardGrantType.CLAIMABLE, level: 5 }),
      );

      await expect(service.claimReward('u1', 'reward-1', 2)).rejects.toThrow();
      expect(repo.grantRewardClaim).not.toHaveBeenCalled();
    });

    it('rejects claiming a reward outside its active window', async () => {
      const future = new Date(Date.now() + 86_400_000);
      repo.getReward.mockResolvedValue(
        reward({ grantType: WealthRewardGrantType.CLAIMABLE, level: 0, startAt: future }),
      );

      await expect(service.claimReward('u1', 'reward-1', 5)).rejects.toThrow();
    });

    it('throws when the reward does not exist', async () => {
      repo.getReward.mockResolvedValue(null);

      await expect(service.claimReward('u1', 'missing', 5)).rejects.toThrow();
    });

    it('is idempotent — double-claiming (double click, retry, concurrent request) never grants twice', async () => {
      repo.getReward.mockResolvedValue(
        reward({ grantType: WealthRewardGrantType.CLAIMABLE, level: 0 }),
      );
      repo.findRewardClaim.mockResolvedValue({ id: 'claim-1', status: WealthClaimStatus.CLAIMED });

      const res = await service.claimReward('u1', 'reward-1', 5);

      expect(res).toEqual({ claimed: true });
      expect(repo.grantRewardClaim).not.toHaveBeenCalled();
      expect(wallet.credit).not.toHaveBeenCalled();
    });

    it('is idempotent even when the GRANTED-but-not-yet-CLAIMED race is lost to a concurrent claim', async () => {
      // findRewardClaim sees nothing (both requests raced past the check),
      // but the DB-unique upsert in grantRewardClaim returns the row the
      // other request already created and claimed.
      repo.getReward.mockResolvedValue(
        reward({ grantType: WealthRewardGrantType.CLAIMABLE, level: 0 }),
      );
      repo.findRewardClaim.mockResolvedValue(null);
      repo.grantRewardClaim.mockResolvedValue({ id: 'claim-1', status: WealthClaimStatus.CLAIMED });

      const res = await service.claimReward('u1', 'reward-1', 5);

      expect(res).toEqual({ claimed: true });
      expect(repo.markClaimed).not.toHaveBeenCalled();
      expect(wallet.credit).not.toHaveBeenCalled();
    });
  });
});

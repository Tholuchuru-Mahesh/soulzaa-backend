import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma, SpinWheel, WalletCurrency, WalletTxnReason } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { LockService } from 'src/infra/redis/lock.service';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import {
  WALLET_SERVICE,
  type IWalletService,
} from 'src/modules/wallet/interfaces/wallet.service.interface';
import {
  drawWeightedSegment,
  spinLockKey,
  type SpinSegment,
} from '../constants/room-utilities.constants';
import { CreateSpinWheelDto } from '../dto/room-utilities.dto';
import { SpinResultEvent } from '../events/room-utilities.events';
import { SpinWheelRepository } from '../repositories/spin-wheel.repository';
import { RoomUtilAuthz } from './room-util-authz.service';

/**
 * Spin wheel (AR-15): a host defines a weighted-segment wheel and spins it. The
 * landed segment is drawn server-side (weighted, per-wheel locked); if the
 * segment carries `rewardCoins`, the spinner's wallet is credited idempotently.
 */
@Injectable()
export class SpinWheelService {
  constructor(
    private readonly repo: SpinWheelRepository,
    private readonly authz: RoomUtilAuthz,
    private readonly locks: LockService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(WALLET_SERVICE) private readonly wallet: IWalletService,
  ) {}

  async createWheel(actor: RoomActor, roomId: string, dto: CreateSpinWheelDto): Promise<unknown> {
    await this.authz.assertHostAction(roomId, actor);
    const segments: SpinSegment[] = dto.segments.map((s) => ({
      label: s.label,
      weight: s.weight,
      color: s.color,
      rewardCoins: s.rewardCoins,
    }));
    const wheel = await this.repo.createWheel({
      roomId,
      creatorId: actor.id,
      title: dto.title,
      segments: segments as unknown as Prisma.InputJsonValue,
    });
    return this.wheelView(wheel);
  }

  async spin(actor: RoomActor, roomId: string, wheelId: string): Promise<unknown> {
    await this.authz.assertHostAction(roomId, actor);
    return this.locks.withLock(spinLockKey(wheelId), async () => {
      const wheel = await this.repo.findWheel(wheelId);
      if (!wheel || wheel.roomId !== roomId) {
        throw new BusinessException(
          ERROR_CODES.SPIN_WHEEL_NOT_FOUND,
          'Spin wheel not found.',
          HttpStatus.NOT_FOUND,
        );
      }
      const segments = this.segments(wheel);
      const index = drawWeightedSegment(segments);
      const segment = segments[index];
      const rewardCoins =
        segment.rewardCoins && segment.rewardCoins > 0 ? segment.rewardCoins : null;

      const result = await this.repo.createResult({
        wheelId,
        roomId,
        userId: actor.id,
        segmentIndex: index,
        segmentLabel: segment.label,
        rewardCoins: rewardCoins !== null ? BigInt(rewardCoins) : null,
      });

      if (rewardCoins !== null) {
        const credit = await this.wallet.credit({
          userId: actor.id,
          currency: WalletCurrency.GOLD,
          amount: rewardCoins,
          reason: WalletTxnReason.SPIN_WHEEL_REWARD,
          idempotencyKey: `spin:${result.id}`,
          referenceType: 'spin_wheel',
          referenceId: wheelId,
          metadata: { roomId, segmentIndex: index },
        });
        await this.repo.setResultTxn(result.id, credit.transactionId);
      }

      await this.bus.publish(
        new SpinResultEvent({
          roomId,
          wheelId,
          resultId: result.id,
          userId: actor.id,
          segmentIndex: index,
          segmentLabel: segment.label,
          rewardCoins,
          createdAt: result.createdAt.toISOString(),
        }),
      );
      return {
        id: result.id,
        wheelId,
        segmentIndex: index,
        segmentLabel: segment.label,
        rewardCoins,
        createdAt: result.createdAt,
      };
    });
  }

  async getWheel(roomId: string, wheelId: string): Promise<unknown> {
    const wheel = await this.repo.findWheel(wheelId);
    if (!wheel || wheel.roomId !== roomId) {
      throw new BusinessException(
        ERROR_CODES.SPIN_WHEEL_NOT_FOUND,
        'Spin wheel not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return this.wheelView(wheel);
  }

  async getActiveWheels(roomId: string): Promise<unknown> {
    const wheels = await this.repo.listActiveWheels(roomId);
    return { active: wheels.map((w) => this.wheelView(w)) };
  }

  async history(
    roomId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listResults(roomId, q.skip, q.limit);
    return buildPaginated(
      rows.map((r) => ({
        id: r.id,
        wheelId: r.wheelId,
        userId: r.userId,
        segmentIndex: r.segmentIndex,
        segmentLabel: r.segmentLabel,
        rewardCoins: r.rewardCoins !== null ? Number(r.rewardCoins) : null,
        createdAt: r.createdAt,
      })),
      total,
      q.page,
      q.limit,
    );
  }

  // ---- Internals ----

  private segments(wheel: SpinWheel): SpinSegment[] {
    return (wheel.segments as unknown as SpinSegment[]) ?? [];
  }

  private wheelView(wheel: SpinWheel) {
    return {
      id: wheel.id,
      roomId: wheel.roomId,
      creatorId: wheel.creatorId,
      title: wheel.title,
      status: wheel.status,
      segments: this.segments(wheel).map((s, i) => ({
        index: i,
        label: s.label,
        weight: s.weight,
        color: s.color ?? null,
        rewardCoins: s.rewardCoins ?? null,
      })),
      createdAt: wheel.createdAt,
    };
  }
}

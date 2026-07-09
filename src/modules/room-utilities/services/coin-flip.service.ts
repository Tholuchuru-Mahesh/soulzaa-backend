import { Inject, Injectable } from '@nestjs/common';
import { CoinFace } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import { CoinFlippedEvent } from '../events/room-utilities.events';
import { InteractiveToolsRepository } from '../repositories/interactive-tools.repository';
import { RoomUtilAuthz } from './room-util-authz.service';

/** Coin flip (AR-15): a host flips a fair coin; the face is server-decided. */
@Injectable()
export class CoinFlipService {
  constructor(
    private readonly repo: InteractiveToolsRepository,
    private readonly authz: RoomUtilAuthz,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async flip(actor: RoomActor, roomId: string): Promise<unknown> {
    await this.authz.assertHostAction(roomId, actor);
    const result = randomInt(0, 2) === 0 ? CoinFace.HEADS : CoinFace.TAILS;
    const row = await this.repo.createCoinFlip({ roomId, userId: actor.id, result });
    await this.bus.publish(
      new CoinFlippedEvent({
        roomId,
        flipId: row.id,
        userId: actor.id,
        result,
        createdAt: row.createdAt.toISOString(),
      }),
    );
    return { id: row.id, result, createdAt: row.createdAt };
  }

  async history(
    roomId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listCoinHistory(roomId, q.skip, q.limit);
    return buildPaginated(
      rows.map((r) => ({ id: r.id, userId: r.userId, result: r.result, createdAt: r.createdAt })),
      total,
      q.page,
      q.limit,
    );
  }
}

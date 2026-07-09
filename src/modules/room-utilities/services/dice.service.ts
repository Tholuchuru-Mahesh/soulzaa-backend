import { Inject, Injectable } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated } from 'src/common/utils/pagination.util';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import { rollDice } from '../constants/room-utilities.constants';
import { DiceRolledEvent } from '../events/room-utilities.events';
import { InteractiveToolsRepository } from '../repositories/interactive-tools.repository';
import { RoomUtilAuthz } from './room-util-authz.service';

/** Dice (AR-15): a host rolls 1..6 fair d6 dice; the result is server-decided. */
@Injectable()
export class DiceService {
  constructor(
    private readonly repo: InteractiveToolsRepository,
    private readonly authz: RoomUtilAuthz,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async roll(actor: RoomActor, roomId: string, diceCount = 1): Promise<unknown> {
    await this.authz.assertHostAction(roomId, actor);
    const { values, total } = rollDice(diceCount);
    const row = await this.repo.createDiceRoll({
      roomId,
      userId: actor.id,
      diceCount,
      values,
      total,
    });
    await this.bus.publish(
      new DiceRolledEvent({
        roomId,
        rollId: row.id,
        userId: actor.id,
        values,
        total,
        createdAt: row.createdAt.toISOString(),
      }),
    );
    return { id: row.id, values, total, createdAt: row.createdAt };
  }

  async history(
    roomId: string,
    q: { skip: number; limit: number; page: number },
  ): Promise<Paginated<unknown>> {
    const [rows, total] = await this.repo.listDiceHistory(roomId, q.skip, q.limit);
    return buildPaginated(
      rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        values: r.values,
        total: r.total,
        createdAt: r.createdAt,
      })),
      total,
      q.page,
      q.limit,
    );
  }
}

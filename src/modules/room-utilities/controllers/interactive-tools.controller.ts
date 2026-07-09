import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import type { RoomActor } from 'src/modules/audio-rooms/interfaces/room-actor.interface';
import { RandomPickDto, RollDiceDto } from '../dto/room-utilities.dto';
import { CoinFlipService } from '../services/coin-flip.service';
import { DiceService } from '../services/dice.service';
import { RandomPickerService } from '../services/random-picker.service';

/**
 * One-shot interactive tools REST surface (dice, coin flip, random picker) under
 * base `rooms/:id`. Every roll/flip/pick requires owner/admin authority
 * (enforced in the services); outcomes are server-decided and broadcast.
 */
@ApiTags('room-utilities')
@ApiBearerAuth()
@Controller('rooms')
export class InteractiveToolsController {
  constructor(
    private readonly dice: DiceService,
    private readonly coin: CoinFlipService,
    private readonly picker: RandomPickerService,
  ) {}

  private actor(user: AuthenticatedUser): RoomActor {
    return { id: user.id, roles: user.roles };
  }

  // ---- Dice ----

  @Post(':id/dice/roll')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Roll dice (owner/admin)' })
  rollDice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: RollDiceDto,
  ) {
    return this.dice.roll(this.actor(user), id, dto.diceCount ?? 1);
  }

  @Get(':id/dice/history')
  @ApiOperation({ summary: 'Dice roll history' })
  diceHistory(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.dice.history(id, { skip: q.skip, limit: q.limit, page: q.page });
  }

  // ---- Coin flip ----

  @Post(':id/coin-flip')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Flip a coin (owner/admin)' })
  flipCoin(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.coin.flip(this.actor(user), id);
  }

  @Get(':id/coin-flip/history')
  @ApiOperation({ summary: 'Coin flip history' })
  coinHistory(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.coin.history(id, { skip: q.skip, limit: q.limit, page: q.page });
  }

  // ---- Random picker ----

  @Post(':id/random-pick')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Pick a random member or number (owner/admin)' })
  randomPick(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: RandomPickDto,
  ) {
    return this.picker.pick(this.actor(user), id, dto);
  }

  @Get(':id/random-pick/history')
  @ApiOperation({ summary: 'Random pick history' })
  pickHistory(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.picker.history(id, { skip: q.skip, limit: q.limit, page: q.page });
  }
}

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { ListBackpackDto, TransferItemDto } from '../dto/backpack.dto';
import { BackpackService } from '../services/backpack.service';

/**
 * Backpack REST surface (base `backpack`). JWT-guarded globally. Read the
 * inventory + history; equip/unequip cosmetics; transfer transferable items.
 * Rewards are deposited by the economy features, never granted directly here.
 */
@ApiTags('backpack')
@ApiBearerAuth()
@Controller('backpack')
export class BackpackController {
  constructor(private readonly backpack: BackpackService) {}

  @Get('items')
  @ApiOperation({ summary: 'List backpack items (paginated)' })
  items(@CurrentUser('id') userId: string, @Query() q: ListBackpackDto) {
    return this.backpack.list(userId, {
      skip: q.skip,
      limit: q.limit,
      page: q.page,
      type: q.type,
      equipped: q.equipped,
    });
  }

  @Get('history')
  @ApiOperation({ summary: 'Backpack action history' })
  history(@CurrentUser('id') userId: string, @Query() q: PaginationQueryDto) {
    return this.backpack.history(userId, { skip: q.skip, limit: q.limit, page: q.page });
  }

  @Post('items/:itemId/equip')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Equip an item (one per type)' })
  async equip(@CurrentUser('id') userId: string, @Param('itemId', ParseUuidPipe) itemId: string) {
    await this.backpack.equip(userId, itemId);
    return { equipped: true };
  }

  @Post('items/:itemId/unequip')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unequip an item' })
  async unequip(@CurrentUser('id') userId: string, @Param('itemId', ParseUuidPipe) itemId: string) {
    await this.backpack.unequip(userId, itemId);
    return { unequipped: true };
  }

  @Post('items/:itemId/transfer')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Transfer a transferable item to another user' })
  async transfer(
    @CurrentUser('id') userId: string,
    @Param('itemId', ParseUuidPipe) itemId: string,
    @Body() dto: TransferItemDto,
  ) {
    await this.backpack.transfer(userId, itemId, dto.toUserId);
    return { transferred: true };
  }
}

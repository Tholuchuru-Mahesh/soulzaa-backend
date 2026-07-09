import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { CosmeticType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { CosmeticsStoreService } from '../services/cosmetics-store.service';

class StoreQueryDto {
  @ApiPropertyOptional({ enum: CosmeticType })
  @IsOptional()
  @IsEnum(CosmeticType)
  type?: CosmeticType;
}

class PurchaseCosmeticDto {
  @ApiPropertyOptional({ description: 'Client idempotency key (a replay returns the original).' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;
}

/**
 * Premium cosmetics store (base `cosmetics/store`). JWT-guarded. Lists
 * purchasable premium cosmetics and buys one with gold (full account only).
 */
@ApiTags('cosmetics-store')
@ApiBearerAuth()
@Controller('cosmetics/store')
export class CosmeticsStoreController {
  constructor(private readonly store: CosmeticsStoreService) {}

  @Get()
  @ApiOperation({ summary: 'Premium cosmetics available for purchase' })
  list(@Query() q: StoreQueryDto) {
    return this.store.listStore(q.type);
  }

  @Get('purchases')
  @ApiOperation({ summary: 'My cosmetic purchase history' })
  purchases(@CurrentUser('id') userId: string, @Query() q: PaginationQueryDto) {
    return this.store.purchases(userId, { skip: q.skip, limit: q.limit, page: q.page });
  }

  @Post(':cosmeticId/purchase')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Buy a premium cosmetic with gold' })
  purchase(
    @CurrentUser('id') userId: string,
    @Param('cosmeticId', ParseUuidPipe) cosmeticId: string,
    @Body() dto: PurchaseCosmeticDto,
  ) {
    return this.store.purchase(userId, cosmeticId, dto.idempotencyKey);
  }
}

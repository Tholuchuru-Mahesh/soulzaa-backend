import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { CosmeticType } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { CosmeticsService } from '../services/cosmetics.service';

class ListOwnedQueryDto {
  @ApiPropertyOptional({ enum: CosmeticType })
  @IsOptional()
  @IsEnum(CosmeticType)
  type?: CosmeticType;
}

@ApiTags('user-cosmetics')
@ApiBearerAuth()
@Controller('cosmetics')
export class UserCosmeticsController {
  constructor(private readonly cosmetics: CosmeticsService) {}

  @Get('my')
  @ApiOperation({ summary: 'List owned cosmetics (frames, themes, effects)' })
  my(@CurrentUser('id') userId: string, @Query() q: ListOwnedQueryDto) {
    return this.cosmetics.listOwnedCosmetics(userId, q.type);
  }

  @Post('equip/:cosmeticId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Equip a cosmetic item' })
  equip(@CurrentUser('id') userId: string, @Param('cosmeticId', ParseUuidPipe) cosmeticId: string) {
    return this.cosmetics.equipCosmetic(userId, cosmeticId);
  }

  @Post('unequip/:cosmeticId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unequip a cosmetic item' })
  unequip(
    @CurrentUser('id') userId: string,
    @Param('cosmeticId', ParseUuidPipe) cosmeticId: string,
  ) {
    return this.cosmetics.unequipCosmetic(userId, cosmeticId);
  }
}

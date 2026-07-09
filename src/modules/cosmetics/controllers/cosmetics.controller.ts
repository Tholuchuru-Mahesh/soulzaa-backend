import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CosmeticType } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CosmeticsService } from '../services/cosmetics.service';

class CatalogQueryDto {
  @ApiPropertyOptional({ enum: CosmeticType })
  @IsOptional()
  @IsEnum(CosmeticType)
  type?: CosmeticType;
}

/**
 * Public cosmetics catalog (base `cosmetics`). JWT-guarded globally. Read-only —
 * clients resolve frame/badge/entrance-effect visuals; grants happen through the
 * economy features, never here.
 */
@ApiTags('cosmetics')
@ApiBearerAuth()
@Controller('cosmetics')
export class CosmeticsController {
  constructor(private readonly cosmetics: CosmeticsService) {}

  @Get()
  @ApiOperation({ summary: 'Active cosmetics catalog' })
  list(@Query() q: CatalogQueryDto) {
    return this.cosmetics.listCatalog(q.type);
  }
}

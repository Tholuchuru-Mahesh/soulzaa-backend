import { ApiPropertyOptional } from '@nestjs/swagger';
import { BroadBanStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class ListBroadBansDto {
  @ApiPropertyOptional({ enum: BroadBanStatus })
  @IsOptional()
  @IsEnum(BroadBanStatus)
  status?: BroadBanStatus;

  @ApiPropertyOptional({ description: 'Filter by Broad owner (uuid)' })
  @IsOptional()
  @IsUUID()
  ownerId?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Raw offset, overrides page if supplied' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;
}

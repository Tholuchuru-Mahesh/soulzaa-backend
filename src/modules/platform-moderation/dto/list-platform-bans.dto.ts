// src/modules/platform-moderation/dto/list-platform-bans.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PlatformBanStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

export class ListPlatformBansDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PlatformBanStatus })
  @IsOptional()
  @IsEnum(PlatformBanStatus)
  status?: PlatformBanStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  targetUserId?: string;
}

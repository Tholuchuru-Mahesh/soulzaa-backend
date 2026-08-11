import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import type { PkHistoryFilter } from 'src/modules/audio-rooms/interfaces/pk-battle.service.interface';

const FILTERS = ['all', 'wins', 'losses', 'draws'] as const;

export class PkHistoryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: FILTERS, default: 'all' })
  @IsOptional()
  @IsIn(FILTERS)
  filter: PkHistoryFilter = 'all';
}

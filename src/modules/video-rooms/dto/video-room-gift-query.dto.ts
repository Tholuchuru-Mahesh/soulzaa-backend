import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

/** Filters over a room's gift ledger. All filters are optional and combine with AND. */
export class VideoRoomGiftHistoryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only gifts sent by this user.' })
  @IsOptional()
  @IsUUID()
  senderId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only gifts received by this user.' })
  @IsOptional()
  @IsUUID()
  receiverId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only sends of this catalog gift.' })
  @IsOptional()
  @IsUUID()
  giftId?: string;

  @ApiPropertyOptional({ description: 'Inclusive lower bound on createdAt (ISO-8601).' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Inclusive upper bound on createdAt (ISO-8601).' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

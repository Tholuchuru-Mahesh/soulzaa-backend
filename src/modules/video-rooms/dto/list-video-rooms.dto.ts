import { ApiPropertyOptional } from '@nestjs/swagger';
import { VideoRoomStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

/**
 * List/discover video rooms query. Extends the shared offset-pagination DTO with
 * optional discovery filters. NOTE (VR-0): the list endpoint returns 501.
 */
export class ListVideoRoomsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by room category id.' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Filter by room language code.' })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({ enum: VideoRoomStatus, description: 'Filter by room status.' })
  @IsOptional()
  @IsEnum(VideoRoomStatus)
  status?: VideoRoomStatus;
}

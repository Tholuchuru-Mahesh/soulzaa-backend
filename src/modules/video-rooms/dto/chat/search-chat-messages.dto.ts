import { ApiPropertyOptional } from '@nestjs/swagger';
import { VideoRoomMessageType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsDate, IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { VIDEO_ROOM_CHAT_SEARCH_TERM_MAX } from '../../constants/video-room-chat.constants';

/** Search room chat by keyword, sender, type and date range. */
export class SearchChatMessagesDto extends PaginationQueryDto {
  @ApiPropertyOptional({ maxLength: VIDEO_ROOM_CHAT_SEARCH_TERM_MAX, example: 'hello' })
  @IsOptional()
  @IsString()
  @Length(1, VIDEO_ROOM_CHAT_SEARCH_TERM_MAX)
  q?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  senderId?: string;

  @ApiPropertyOptional({ enum: VideoRoomMessageType })
  @IsOptional()
  @IsEnum(VideoRoomMessageType)
  type?: VideoRoomMessageType;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @ApiPropertyOptional({ description: 'Only messages with an active pin.' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  pinnedOnly?: boolean;

  @ApiPropertyOptional({
    description:
      'Only ANNOUNCEMENT-type messages. Wins over an explicit conflicting `type` filter.',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  announcementsOnly?: boolean;
}

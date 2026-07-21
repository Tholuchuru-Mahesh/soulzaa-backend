import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VideoRoomMessageType } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { VIDEO_ROOM_CHAT_EMOJI_MAX_LENGTH } from '../../constants/video-room-chat.constants';

/**
 * Send a room chat message. The hard ceiling here is a safety bound; the room's
 * own `chatMaxMessageLength` is enforced by ChatPolicyService, which is the only
 * place that knows the room's settings.
 *
 * SYSTEM is intentionally NOT an accepted type — system rows are platform-minted
 * (ChatPolicyService rejects a client-supplied SYSTEM message outright).
 */
export class SendChatMessageDto {
  @ApiProperty({ minLength: 1, maxLength: 4000, example: 'hey @alice 👋' })
  @IsString()
  @Length(1, 4000)
  content!: string;

  @ApiPropertyOptional({
    enum: VideoRoomMessageType,
    default: VideoRoomMessageType.TEXT,
    description: `Emoji messages are capped at ${VIDEO_ROOM_CHAT_EMOJI_MAX_LENGTH} characters.`,
  })
  @IsOptional()
  @IsEnum(VideoRoomMessageType)
  type?: VideoRoomMessageType;

  @ApiPropertyOptional({ format: 'uuid', description: 'Message being replied to.' })
  @IsOptional()
  @IsUUID()
  replyToId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Original message, when forwarding.' })
  @IsOptional()
  @IsUUID()
  forwardedFromId?: string;

  @ApiPropertyOptional({
    type: [Object],
    description: 'Future-ready attachment descriptors. No upload pipeline ships in VR-9.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  attachments?: unknown[];
}

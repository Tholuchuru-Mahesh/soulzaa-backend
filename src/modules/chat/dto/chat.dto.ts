import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttachmentType, DirectMessageType, ReportReason } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsMimeType,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { TYPING_KINDS, type TypingKind } from '../constants/chat.constants';

/** Hard ceiling on message length. The configured limit (`chat.messageMaxLength`) may be lower. */
const MESSAGE_HARD_MAX = 4000;

// ============================ Conversations ============================

export class OpenConversationDto {
  @ApiProperty({ description: 'The user to open (or resume) a direct conversation with' })
  @IsUUID()
  peerUserId!: string;
}

/**
 * The Chats-screen categories. Every one is resolved server-side, because a
 * client-side filter over a *page* is wrong by construction: filtering 20 fetched
 * rows down to 3 makes both the list and its counts lie.
 */
export const CONVERSATION_FILTERS = [
  'INBOX',
  'FRIENDS',
  'UNREAD',
  'REQUESTS',
  'ARCHIVED',
  'FAVORITES',
  'BLOCKED',
] as const;

export type ConversationFilterValue = (typeof CONVERSATION_FILTERS)[number];

export class ListConversationsDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: CONVERSATION_FILTERS,
    default: 'INBOX',
    description:
      'INBOX = accepted & unarchived; FRIENDS = peers in the friend graph; UNREAD = has unread; ' +
      'REQUESTS = pending inbound; FAVORITES = starred; BLOCKED = peers this user has blocked',
  })
  @IsOptional()
  @IsEnum(CONVERSATION_FILTERS)
  filter: ConversationFilterValue = 'INBOX';

  @ApiPropertyOptional({ description: 'Filter by peer username or full name' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional({
    description:
      'Keyset cursor — the id of the last conversation on the previous page. ' +
      'Returns only conversations ordered after it, so a chat that jumps to the ' +
      'top mid-scroll cannot shift the window and duplicate rows (which offset paging does).',
  })
  @IsOptional()
  @IsUUID()
  cursor?: string;
}

export class UpdateConversationSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isArchived?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isFavorite?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isMuted?: boolean;

  @ApiPropertyOptional({ description: 'Mute expiry; omit (with isMuted) to mute indefinitely' })
  @IsOptional()
  @IsDateString()
  mutedUntil?: string;
}

export class EditMessageDto {
  @ApiProperty({ description: 'The replacement body' })
  @IsString()
  @MinLength(1)
  @MaxLength(MESSAGE_HARD_MAX)
  content!: string;
}

export class ReportConversationDto {
  @ApiProperty({ enum: ReportReason })
  @IsEnum(ReportReason)
  reason!: ReportReason;

  @ApiPropertyOptional({
    description: 'Report one message rather than the whole conversation',
  })
  @IsOptional()
  @IsUUID()
  messageId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class SaveDraftDto {
  @ApiPropertyOptional({ description: 'Composer text; empty string clears the draft' })
  @IsOptional()
  @IsString()
  @MaxLength(MESSAGE_HARD_MAX)
  text?: string;
}

// ============================== Messages ==============================

export class AttachmentDto {
  @ApiProperty({ enum: AttachmentType })
  @IsEnum(AttachmentType)
  type!: AttachmentType;

  @ApiProperty({
    description: 'S3 object key returned by POST /storage/presign + /storage/confirm',
  })
  @IsString()
  @MaxLength(512)
  storageKey!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  thumbnailKey?: string;

  @ApiProperty({ example: 'image/jpeg' })
  @IsMimeType()
  mimeType!: string;

  @ApiProperty({ example: 204_800 })
  @IsInt()
  @IsPositive()
  sizeBytes!: number;

  @ApiPropertyOptional({ description: 'Voice/video length in milliseconds' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  durationMs?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @IsPositive()
  width?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @IsPositive()
  height?: number;

  @ApiPropertyOptional({ description: 'Normalised 0-100 peaks for voice-note rendering' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(256)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(100, { each: true })
  waveform?: number[];

  @ApiPropertyOptional({ description: 'Original filename, shown for FILE attachments' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;
}

export class SendMessageDto {
  @ApiProperty({
    description:
      'Sender-generated idempotency key. Retrying a send with the same clientId resolves to the same message instead of duplicating it.',
  })
  @IsUUID()
  clientId!: string;

  @ApiPropertyOptional({ enum: DirectMessageType, default: DirectMessageType.TEXT })
  @IsOptional()
  @IsEnum(DirectMessageType)
  type: DirectMessageType = DirectMessageType.TEXT;

  @ApiPropertyOptional({
    description: 'Message body. Required for TEXT/GIF/STICKER; may be an empty caption for media.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MESSAGE_HARD_MAX)
  content?: string;

  @ApiPropertyOptional({ description: 'Message being replied to' })
  @IsOptional()
  @IsUUID()
  replyToId?: string;

  @ApiPropertyOptional({ type: [AttachmentDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];

  @ApiPropertyOptional({
    description:
      'Payload for the rich types. GIFT → {giftId,...}; PROFILE_SHARE → {userId}; ' +
      'ROOM_INVITE → {roomId}; CALL_LOG → {callType, durationSeconds}. The service ' +
      'validates that the required key for the message type is present.',
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ListMessagesDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Keyset cursor — return only messages older than this message id',
  })
  @IsOptional()
  @IsUUID()
  before?: string;
}

export class ReactDto {
  @ApiProperty({ example: '❤️' })
  @IsString()
  @MinLength(1)
  @MaxLength(16)
  emoji!: string;
}

// ========================= Receipts & indicators =========================

export class MarkReadDto {
  @ApiProperty({ description: 'Newest message the user has seen; advances the read watermark' })
  @IsUUID()
  messageId!: string;
}

export class TypingDto {
  @ApiProperty()
  @IsBoolean()
  isTyping!: boolean;

  @ApiPropertyOptional({ enum: Object.values(TYPING_KINDS), default: TYPING_KINDS.TEXT })
  @IsOptional()
  @IsEnum(TYPING_KINDS)
  kind: TypingKind = TYPING_KINDS.TEXT;
}

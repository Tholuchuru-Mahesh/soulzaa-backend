import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BlockedWordAction,
  BlockedWordSeverity,
  ChatMessageType,
  ChatReportStatus,
  ReportReason,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  Validate,
  ValidateIf,
  type ValidationArguments,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import {
  CHAT_ANNOUNCEMENT_MAX,
  CHAT_BLOCKED_WORD_NOTES_MAX,
  CHAT_BLOCKED_WORD_PATTERN_MAX,
  CHAT_GIF_URL_MAX,
  CHAT_MESSAGE_HARD_MAX,
  CHAT_REPORT_DESCRIPTION_MAX,
} from '../constants/chat.constants';

/** Rejects a `pattern` that is flagged `isRegex` but does not compile. */
@ValidatorConstraint({ name: 'isCompilableRegex', async: false })
export class IsCompilableRegexConstraint implements ValidatorConstraintInterface {
  validate(pattern: unknown, args: ValidationArguments): boolean {
    if ((args.object as Record<string, unknown>).isRegex !== true) return true;
    if (typeof pattern !== 'string') return false;
    try {
      new RegExp(pattern);
      return true;
    } catch {
      return false;
    }
  }

  defaultMessage(): string {
    return 'pattern is not a valid regular expression';
  }
}

/** Send a chat message (text/emoji/gif). GIF requires `gifUrl`. */
export class SendMessageDto {
  @ApiProperty({ enum: ChatMessageType, default: ChatMessageType.TEXT })
  @IsOptional()
  @IsEnum(ChatMessageType)
  type: ChatMessageType = ChatMessageType.TEXT;

  @ApiProperty({ maxLength: CHAT_MESSAGE_HARD_MAX })
  @IsString()
  @MinLength(1)
  @MaxLength(CHAT_MESSAGE_HARD_MAX)
  content!: string;

  @ApiPropertyOptional({ maxLength: CHAT_GIF_URL_MAX })
  @ValidateIf((o: SendMessageDto) => o.type === ChatMessageType.GIF || o.gifUrl !== undefined)
  @IsString()
  @MaxLength(CHAT_GIF_URL_MAX)
  gifUrl?: string;

  @ApiPropertyOptional({ type: [String], description: '@usernames referenced in the message.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  mentions?: string[];

  @ApiPropertyOptional({ description: 'Message being replied to.' })
  @IsOptional()
  @IsUUID()
  replyToId?: string;
}

/** Broadcast an ephemeral floating emoji reaction (not persisted). */
export class ReactDto {
  @ApiProperty({ description: 'A single emoji from the allowed set.' })
  @IsString()
  @MinLength(1)
  @MaxLength(16)
  emoji!: string;
}

/** Typing indicator (ephemeral). */
export class TypingDto {
  @ApiProperty()
  @IsBoolean()
  isTyping!: boolean;
}

/** Post an admin announcement message. */
export class AnnounceDto {
  @ApiProperty({ maxLength: CHAT_ANNOUNCEMENT_MAX })
  @IsString()
  @MinLength(1)
  @MaxLength(CHAT_ANNOUNCEMENT_MAX)
  content!: string;
}

/** Report a specific chat message. */
export class ReportMessageDto {
  @ApiProperty({ enum: ReportReason })
  @IsEnum(ReportReason)
  reason!: ReportReason;

  @ApiPropertyOptional({ maxLength: CHAT_REPORT_DESCRIPTION_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(CHAT_REPORT_DESCRIPTION_MAX)
  description?: string;
}

/** Moderator resolution of a chat report. */
export class ReviewChatReportDto {
  @ApiProperty({
    enum: [ChatReportStatus.REVIEWED, ChatReportStatus.DISMISSED, ChatReportStatus.ACTIONED],
  })
  @IsEnum(ChatReportStatus)
  status!: ChatReportStatus;

  @ApiPropertyOptional({ maxLength: CHAT_REPORT_DESCRIPTION_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(CHAT_REPORT_DESCRIPTION_MAX)
  resolution?: string;
}

/** Paginated message-history query (offset, optional keyset `before`). */
export class ListMessagesDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Return messages created before this message id (keyset).' })
  @IsOptional()
  @IsUUID()
  before?: string;
}

/** Filters for paginated chat-report listings. */
export class ListChatReportsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ChatReportStatus })
  @IsOptional()
  @IsEnum(ChatReportStatus)
  status?: ChatReportStatus;
}

/** Create a blocked-word dictionary entry (platform admin). */
export class BlockedWordDto {
  @ApiProperty({ maxLength: CHAT_BLOCKED_WORD_PATTERN_MAX })
  @IsString()
  @MinLength(1)
  @MaxLength(CHAT_BLOCKED_WORD_PATTERN_MAX)
  @Validate(IsCompilableRegexConstraint)
  pattern!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isRegex?: boolean;

  @ApiPropertyOptional({ default: 'en', description: 'ISO language tag (or "*" for any).' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  language?: string;

  @ApiProperty({ enum: BlockedWordSeverity })
  @IsEnum(BlockedWordSeverity)
  severity!: BlockedWordSeverity;

  @ApiProperty({ enum: BlockedWordAction })
  @IsEnum(BlockedWordAction)
  action!: BlockedWordAction;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ maxLength: CHAT_BLOCKED_WORD_NOTES_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(CHAT_BLOCKED_WORD_NOTES_MAX)
  notes?: string;
}

/** Partial update of a blocked-word entry. */
export class UpdateBlockedWordDto {
  @ApiPropertyOptional({ maxLength: CHAT_BLOCKED_WORD_PATTERN_MAX })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(CHAT_BLOCKED_WORD_PATTERN_MAX)
  @Validate(IsCompilableRegexConstraint)
  pattern?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isRegex?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(16)
  language?: string;

  @ApiPropertyOptional({ enum: BlockedWordSeverity })
  @IsOptional()
  @IsEnum(BlockedWordSeverity)
  severity?: BlockedWordSeverity;

  @ApiPropertyOptional({ enum: BlockedWordAction })
  @IsOptional()
  @IsEnum(BlockedWordAction)
  action?: BlockedWordAction;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ maxLength: CHAT_BLOCKED_WORD_NOTES_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(CHAT_BLOCKED_WORD_NOTES_MAX)
  notes?: string;
}

/** Filters for paginated blocked-word listings. */
export class ListBlockedWordsDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(16)
  language?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  enabled?: boolean;
}

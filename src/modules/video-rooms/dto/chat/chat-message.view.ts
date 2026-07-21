import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VideoRoomMessageType } from '@prisma/client';

/**
 * The client-facing message status. SENDING and FAILED are CLIENT-ONLY (the row
 * does not exist server-side yet); DELIVERED and READ are per-recipient facts
 * derived from `video_room_chat_cursors`, never properties of the message. Only
 * SENT / EDITED / DELETED / RECALLED are derivable from the row itself.
 */
export enum ChatMessageStatus {
  SENDING = 'SENDING',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  READ = 'READ',
  EDITED = 'EDITED',
  DELETED = 'DELETED',
  RECALLED = 'RECALLED',
  FAILED = 'FAILED',
}

/** Swagger response shape for a chat message. */
export class ChatMessageView {
  @ApiProperty({ format: 'uuid' }) messageId!: string;
  @ApiProperty({ format: 'uuid' }) roomId!: string;
  @ApiProperty({ format: 'uuid' }) senderId!: string;
  @ApiProperty({ enum: VideoRoomMessageType }) type!: VideoRoomMessageType;
  @ApiProperty() content!: string;
  @ApiProperty({ enum: ChatMessageStatus }) status!: ChatMessageStatus;
  @ApiProperty({ type: [String], format: 'uuid' }) mentions!: string[];
  @ApiPropertyOptional({ nullable: true }) mentionScope!: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'uuid' }) replyToId!: string | null;
  @ApiPropertyOptional({ format: 'uuid' }) announcementId?: string;
  @ApiPropertyOptional() systemEvent?: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

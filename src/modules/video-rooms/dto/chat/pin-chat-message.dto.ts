import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Pin a message. Requires the PIN_MESSAGES permission. */
export class PinChatMessageDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  messageId!: string;
}

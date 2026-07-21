import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Advance a delivered/read cursor to a given message. */
export class ChatReceiptDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  messageId!: string;
}

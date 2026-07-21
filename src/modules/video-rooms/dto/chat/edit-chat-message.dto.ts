import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/** Edit a message's content. Author-only, inside the edit window. */
export class EditChatMessageDto {
  @ApiProperty({ minLength: 1, maxLength: 4000 })
  @IsString()
  @Length(1, 4000)
  content!: string;
}

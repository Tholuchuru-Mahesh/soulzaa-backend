import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** VR-15 — payload for the owner/admin/mod SYSTEM notification broadcast. */
export class SystemNotificationDto {
  @ApiProperty({ description: 'Short notification title', maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @ApiProperty({ description: 'Notification body', maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  body!: string;
}

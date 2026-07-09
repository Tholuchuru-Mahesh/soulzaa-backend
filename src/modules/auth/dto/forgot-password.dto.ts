import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/** Start password recovery for an email or mobile identifier. */
export class ForgotPasswordDto {
  @ApiProperty({ example: 'aditya@example.com', description: 'Email or mobile number' })
  @IsString()
  @MaxLength(256)
  identifier!: string;
}

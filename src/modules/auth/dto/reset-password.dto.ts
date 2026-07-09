import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { IsStrongPassword } from './validators/is-strong-password.validator';

/** Complete password recovery with the emailed/SMS'd reset token. */
export class ResetPasswordDto {
  @ApiProperty({ description: 'Single-use reset token from forgot-password' })
  @IsString()
  token!: string;

  @ApiProperty({ example: 'N3w@Str0ng', description: 'Min 8, upper, lower, number, special' })
  @IsStrongPassword()
  newPassword!: string;
}

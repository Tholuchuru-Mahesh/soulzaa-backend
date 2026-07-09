import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { IsStrongPassword } from './validators/is-strong-password.validator';

/** Authenticated password change (requires the current password). */
export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  currentPassword!: string;

  @ApiProperty({ example: 'N3w@Str0ng', description: 'Min 8, upper, lower, number, special' })
  @IsStrongPassword()
  newPassword!: string;
}

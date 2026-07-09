import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/** Body carrying the refresh token (also accepted as a Bearer header). */
export class RefreshTokenDto {
  @ApiProperty({ description: 'The refresh JWT issued at login' })
  @IsString()
  refreshToken!: string;
}

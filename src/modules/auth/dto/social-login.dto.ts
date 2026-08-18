import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
import { DeviceInfoDto } from './device-info.dto';

/**
 * Social login — the client sends the provider credential and the server
 * verifies it. Google and Apple send an ID token (a JWT); Facebook sends an
 * access token, which the server checks against the Graph API instead. The
 * field keeps the name `idToken` because clients already send it under that
 * key, and renaming it would break every shipped app build.
 */
export class SocialLoginDto {
  @ApiProperty({ enum: ['GOOGLE', 'APPLE', 'FACEBOOK'] })
  @IsIn(['GOOGLE', 'APPLE', 'FACEBOOK'])
  provider!: 'GOOGLE' | 'APPLE' | 'FACEBOOK';

  @ApiProperty({
    description:
      'Provider credential: an ID token (JWT) for Google/Apple, an access token for Facebook',
  })
  @IsString()
  idToken!: string;

  @ApiPropertyOptional({ type: DeviceInfoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceInfoDto)
  device?: DeviceInfoDto;
}

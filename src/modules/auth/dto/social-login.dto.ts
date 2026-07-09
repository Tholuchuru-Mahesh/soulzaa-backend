import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
import { DeviceInfoDto } from './device-info.dto';

/** Google/Apple login — the client sends the provider ID token to verify. */
export class SocialLoginDto {
  @ApiProperty({ enum: ['GOOGLE', 'APPLE'] })
  @IsIn(['GOOGLE', 'APPLE'])
  provider!: 'GOOGLE' | 'APPLE';

  @ApiProperty({ description: 'Provider-issued ID token (JWT) to verify server-side' })
  @IsString()
  idToken!: string;

  @ApiPropertyOptional({ type: DeviceInfoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceInfoDto)
  device?: DeviceInfoDto;
}

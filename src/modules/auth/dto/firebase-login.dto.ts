import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsString, ValidateNested } from 'class-validator';
import { DeviceInfoDto } from './device-info.dto';

export class FirebaseLoginDto {
  @ApiProperty({ description: 'Firebase-issued ID token (JWT) verified server-side' })
  @IsString()
  idToken!: string;

  @ApiPropertyOptional({ type: DeviceInfoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceInfoDto)
  device?: DeviceInfoDto;
}

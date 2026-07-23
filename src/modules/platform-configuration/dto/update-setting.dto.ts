import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateSettingDto {
  @ApiProperty({ description: 'New value for setting (as string or serialized JSON)' })
  @IsNotEmpty()
  value!: any;

  @ApiPropertyOptional({ description: 'Optional reason for update' })
  @IsString()
  @IsOptional()
  reason?: string;
}

export class ResetSettingDto {
  @ApiPropertyOptional({ description: 'Optional reason for reset' })
  @IsString()
  @IsOptional()
  reason?: string;
}

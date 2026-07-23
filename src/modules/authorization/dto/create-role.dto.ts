import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateRoleDto {
  @ApiProperty({ description: 'Unique role identifier name', example: 'REGIONAL_ADMIN' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    description: 'Human-readable display name',
    example: 'Regional Administrator',
  })
  @IsString()
  @IsOptional()
  displayName?: string;

  @ApiPropertyOptional({
    description: 'Role description',
    example: 'Role for managing regional operations',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Whether role is a protected system role', default: false })
  @IsBoolean()
  @IsOptional()
  isSystem?: boolean;
}

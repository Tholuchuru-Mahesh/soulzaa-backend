import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ScopeType } from '@prisma/client';
import { IsEnum, IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class CreateRoleScopeDto {
  @ApiProperty({
    description: 'UserRole assignment ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsNotEmpty()
  userRoleId!: string;

  @ApiProperty({
    enum: ScopeType,
    description: 'Geographic Scope Type (GLOBAL, COUNTRY, STATE, REGION)',
  })
  @IsEnum(ScopeType)
  @IsNotEmpty()
  scopeType!: ScopeType;

  @ApiPropertyOptional({ description: 'Country ID for COUNTRY/STATE/REGION scope' })
  @IsUUID()
  @IsOptional()
  countryId?: string;

  @ApiPropertyOptional({ description: 'State ID for STATE/REGION scope' })
  @IsUUID()
  @IsOptional()
  stateId?: string;

  @ApiPropertyOptional({ description: 'Region ID for REGION scope' })
  @IsUUID()
  @IsOptional()
  regionId?: string;
}

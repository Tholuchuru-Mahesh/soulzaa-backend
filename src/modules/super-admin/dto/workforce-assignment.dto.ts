import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ScopeType } from '@prisma/client';
import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class AssignWorkforceDto {
  @ApiProperty({
    description: 'User ID of personnel being assigned',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsNotEmpty()
  userId!: string;

  @ApiProperty({
    description:
      'Target workforce role (ADMIN, COUNTRY_MANAGER, OFFICIAL, MODERATOR, BUSINESS_DEVELOPMENT)',
    example: 'OFFICIAL',
  })
  @IsString()
  @IsNotEmpty()
  role!: string;

  @ApiProperty({
    description: 'Scope Type (GLOBAL, COUNTRY, STATE, REGION)',
    enum: ScopeType,
    example: ScopeType.STATE,
  })
  @IsEnum(ScopeType)
  @IsNotEmpty()
  scopeType!: ScopeType;

  @ApiPropertyOptional({ description: 'Country UUID if scopeType is COUNTRY' })
  @IsUUID()
  @IsOptional()
  countryId?: string;

  @ApiPropertyOptional({ description: 'State UUID if scopeType is STATE' })
  @IsUUID()
  @IsOptional()
  stateId?: string;

  @ApiPropertyOptional({ description: 'Region UUID if scopeType is REGION' })
  @IsUUID()
  @IsOptional()
  regionId?: string;
}

export class TransferWorkforceDto {
  @ApiProperty({
    description: 'User ID of personnel being transferred',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsNotEmpty()
  userId!: string;

  @ApiProperty({
    description: 'Target Scope Type (GLOBAL, COUNTRY, STATE, REGION)',
    enum: ScopeType,
  })
  @IsEnum(ScopeType)
  @IsNotEmpty()
  targetScopeType!: ScopeType;

  @ApiPropertyOptional({ description: 'Target Country UUID' })
  @IsUUID()
  @IsOptional()
  targetCountryId?: string;

  @ApiPropertyOptional({ description: 'Target State UUID' })
  @IsUUID()
  @IsOptional()
  targetStateId?: string;

  @ApiPropertyOptional({ description: 'Target Region UUID' })
  @IsUUID()
  @IsOptional()
  targetRegionId?: string;
}

export class ReassignWorkforceScopeDto {
  @ApiProperty({
    description: 'User ID of personnel being reassigned',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsNotEmpty()
  userId!: string;

  @ApiProperty({ description: 'Scope Type (GLOBAL, COUNTRY, STATE, REGION)', enum: ScopeType })
  @IsEnum(ScopeType)
  @IsNotEmpty()
  scopeType!: ScopeType;

  @ApiPropertyOptional({ description: 'Country UUID' })
  @IsUUID()
  @IsOptional()
  countryId?: string;

  @ApiPropertyOptional({ description: 'State UUID' })
  @IsUUID()
  @IsOptional()
  stateId?: string;

  @ApiPropertyOptional({ description: 'Region UUID' })
  @IsUUID()
  @IsOptional()
  regionId?: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ScopeType } from '@prisma/client';
import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class AssignUserRoleDto {
  @ApiProperty({ description: 'Role ID or Role name to assign', example: 'COUNTRY_MANAGER' })
  @IsString()
  @IsNotEmpty()
  role!: string;

  @ApiPropertyOptional({ description: 'Optional geographic scope type', enum: ScopeType })
  @IsEnum(ScopeType)
  @IsOptional()
  scopeType?: ScopeType;

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

/**
 * Used by the new flow: the Super Admin enters the user's registered e-mail
 * address instead of having to look up a UUID first.
 */
export class AssignUserRoleByEmailDto {
  @ApiProperty({
    description: 'Registered email of the user to assign the role to',
    example: 'official@example.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @ApiProperty({ description: 'Role name to assign', example: 'OFFICIAL' })
  @IsString()
  @IsNotEmpty()
  role!: string;

  @ApiPropertyOptional({ description: 'Optional geographic scope type', enum: ScopeType })
  @IsEnum(ScopeType)
  @IsOptional()
  scopeType?: ScopeType;

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

export class UpdateUserRoleDto {
  @ApiProperty({ description: 'Current Role ID or Role name to be replaced' })
  @IsString()
  @IsNotEmpty()
  currentRole!: string;

  @ApiProperty({ description: 'New Role ID or Role name to assign' })
  @IsString()
  @IsNotEmpty()
  newRole!: string;

  @ApiPropertyOptional({
    description: 'Optional geographic scope type for new role',
    enum: ScopeType,
  })
  @IsEnum(ScopeType)
  @IsOptional()
  scopeType?: ScopeType;

  @ApiPropertyOptional({ description: 'Country UUID if new scope is COUNTRY' })
  @IsUUID()
  @IsOptional()
  countryId?: string;

  @ApiPropertyOptional({ description: 'State UUID if new scope is STATE' })
  @IsUUID()
  @IsOptional()
  stateId?: string;

  @ApiPropertyOptional({ description: 'Region UUID if new scope is REGION' })
  @IsUUID()
  @IsOptional()
  regionId?: string;
}

export class PromoteDemoteUserDto {
  @ApiProperty({ description: 'Target Role name to assign (e.g. ADMIN, OFFICIAL, MODERATOR)' })
  @IsString()
  @IsNotEmpty()
  targetRole!: string;

  @ApiPropertyOptional({
    description: 'Optional geographic scope type for target role',
    enum: ScopeType,
  })
  @IsEnum(ScopeType)
  @IsOptional()
  scopeType?: ScopeType;

  @ApiPropertyOptional({ description: 'Country UUID if scope is COUNTRY' })
  @IsUUID()
  @IsOptional()
  countryId?: string;

  @ApiPropertyOptional({ description: 'State UUID if scope is STATE' })
  @IsUUID()
  @IsOptional()
  stateId?: string;

  @ApiPropertyOptional({ description: 'Region UUID if scope is REGION' })
  @IsUUID()
  @IsOptional()
  regionId?: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class WorkforceSearchFilterDto {
  @ApiPropertyOptional({ description: 'Search term for name, username, email, phone, or User ID' })
  @IsString()
  @IsOptional()
  query?: string;

  @ApiPropertyOptional({
    description:
      'Filter by workforce role (ADMIN, COUNTRY_MANAGER, OFFICIAL, MODERATOR, BUSINESS_DEVELOPMENT)',
  })
  @IsString()
  @IsOptional()
  role?: string;

  @ApiPropertyOptional({ description: 'Filter by Country ID' })
  @IsUUID()
  @IsOptional()
  countryId?: string;

  @ApiPropertyOptional({ description: 'Filter by State ID' })
  @IsUUID()
  @IsOptional()
  stateId?: string;

  @ApiPropertyOptional({ description: 'Filter by Region ID' })
  @IsUUID()
  @IsOptional()
  regionId?: string;

  @ApiPropertyOptional({ description: 'Filter by account status', enum: AccountStatus })
  @IsEnum(AccountStatus)
  @IsOptional()
  accountStatus?: AccountStatus;

  @ApiPropertyOptional({
    description: 'Filter by active operational status (true = active, false = inactive)',
  })
  @Type(() => Boolean)
  @IsOptional()
  assignmentStatus?: boolean;

  @ApiPropertyOptional({ description: 'Registered after date (ISO String)' })
  @IsString()
  @IsOptional()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Registered before date (ISO String)' })
  @IsString()
  @IsOptional()
  dateTo?: string;

  @ApiPropertyOptional({ description: 'Page number (default 1)', default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Page limit (default 20, max 100)', default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Field to sort by (createdAt, username, email, status)',
    default: 'createdAt',
  })
  @IsString()
  @IsOptional()
  sortBy?: string = 'createdAt';

  @ApiPropertyOptional({ description: 'Sort direction (asc or desc)', default: 'desc' })
  @IsString()
  @IsOptional()
  sortOrder?: 'asc' | 'desc' = 'desc';
}

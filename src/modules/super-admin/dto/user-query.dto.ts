import { ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class UserSearchFilterDto {
  @ApiPropertyOptional({ description: 'Search term for name, username, email, phone, or User ID' })
  @IsString()
  @IsOptional()
  query?: string;

  @ApiPropertyOptional({
    description:
      'Filter by assigned Platform Role name (e.g. ADMIN, COUNTRY_MANAGER, OFFICIAL, MODERATOR)',
  })
  @IsString()
  @IsOptional()
  role?: string;

  @ApiPropertyOptional({ description: 'Filter by assigned Country UUID' })
  @IsUUID()
  @IsOptional()
  countryId?: string;

  @ApiPropertyOptional({ description: 'Filter by assigned State UUID' })
  @IsUUID()
  @IsOptional()
  stateId?: string;

  @ApiPropertyOptional({ description: 'Filter by assigned Region UUID' })
  @IsUUID()
  @IsOptional()
  regionId?: string;

  @ApiPropertyOptional({ description: 'Filter by account status', enum: AccountStatus })
  @IsEnum(AccountStatus)
  @IsOptional()
  status?: AccountStatus;

  @ApiPropertyOptional({ description: 'Filter users registered after date (ISO String)' })
  @IsString()
  @IsOptional()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Filter users registered before date (ISO String)' })
  @IsString()
  @IsOptional()
  dateTo?: string;

  @ApiPropertyOptional({ description: 'Filter by creator user ID' })
  @IsUUID()
  @IsOptional()
  createdBy?: string;

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

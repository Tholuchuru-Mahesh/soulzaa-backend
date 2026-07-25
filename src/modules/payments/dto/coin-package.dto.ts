import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateCoinPackageDto {
  @ApiProperty({ description: 'Package unique code (e.g. PKG_100_COINS)' })
  @IsNotEmpty()
  @IsString()
  code!: string;

  @ApiProperty({ description: 'Package display name (e.g. 100 Soul Coins Starter Pack)' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ description: 'Base Soul Coins quantity', example: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsNotEmpty()
  coins!: number;

  @ApiPropertyOptional({ description: 'Bonus Soul Coins quantity', example: 10, default: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  bonusCoins?: number = 0;

  @ApiProperty({ description: 'Price amount (e.g. 0.99)', example: 0.99 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @IsNotEmpty()
  priceAmount!: number;

  @ApiPropertyOptional({ description: 'ISO Currency Code (e.g. USD, EUR, INR)', default: 'USD' })
  @IsString()
  @IsOptional()
  currency?: string = 'USD';

  @ApiPropertyOptional({
    description: 'Target Country ISO Code (e.g. US, IN, GLOBAL)',
    default: 'GLOBAL',
  })
  @IsString()
  @IsOptional()
  country?: string = 'GLOBAL';

  @ApiPropertyOptional({ description: 'Target Platform (IOS, ANDROID, WEB, ALL)', default: 'ALL' })
  @IsString()
  @IsOptional()
  platform?: string = 'ALL';

  @ApiPropertyOptional({ description: 'Active status toggle', default: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean = true;

  @ApiPropertyOptional({ description: 'Sort display order', default: 0 })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  sortOrder?: number = 0;
}

export class UpdateCoinPackageDto {
  @ApiPropertyOptional({ description: 'Package display name' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: 'Base Soul Coins quantity' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  coins?: number;

  @ApiPropertyOptional({ description: 'Bonus Soul Coins quantity' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  bonusCoins?: number;

  @ApiPropertyOptional({ description: 'Price amount' })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @IsOptional()
  priceAmount?: number;

  @ApiPropertyOptional({ description: 'Active status toggle' })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Sort display order' })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  sortOrder?: number;
}

export class PackageQueryDto {
  @ApiPropertyOptional({ description: 'Filter by platform (IOS, ANDROID, WEB, ALL)' })
  @IsString()
  @IsOptional()
  platform?: string;

  @ApiPropertyOptional({ description: 'Filter by country ISO code' })
  @IsString()
  @IsOptional()
  country?: string;

  @ApiPropertyOptional({ description: 'Filter active status (true/false)' })
  @Type(() => Boolean)
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

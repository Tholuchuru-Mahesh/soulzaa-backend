import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { CoinOfferEligibility } from '@prisma/client';

export class CreateCoinOfferDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsInt()
  @Min(1)
  @Max(1000)
  percentage!: number;

  @IsEnum(CoinOfferEligibility)
  eligibility!: CoinOfferEligibility;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateCoinOfferDto {
  @IsString()
  @MinLength(1)
  @IsOptional()
  title?: string;

  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  percentage?: number;

  @IsEnum(CoinOfferEligibility)
  @IsOptional()
  eligibility?: CoinOfferEligibility;
}

export class CoinOfferResponseDto {
  id!: string;
  title!: string;
  percentage!: number;
  eligibility!: CoinOfferEligibility;
  isActive!: boolean;
  createdAt!: Date;
  updatedAt!: Date;
}

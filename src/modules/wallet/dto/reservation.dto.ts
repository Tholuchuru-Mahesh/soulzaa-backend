import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WalletCurrency } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

export class ReserveCoinsDto {
  @ApiProperty({ description: 'Target user ID' })
  @IsNotEmpty()
  @IsString()
  userId!: string;

  @ApiProperty({ description: 'Amount of coins to hold in reservation', example: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsNotEmpty()
  amount!: number;

  @ApiProperty({
    description: 'Purpose of reservation (e.g. GAME_STAKE, WITHDRAWAL_HOLD, TREASURE_HOLD)',
  })
  @IsNotEmpty()
  @IsString()
  purpose!: string;

  @ApiPropertyOptional({ enum: WalletCurrency, default: WalletCurrency.GOLD })
  @IsEnum(WalletCurrency)
  @IsOptional()
  currency?: WalletCurrency = WalletCurrency.GOLD;

  @ApiPropertyOptional({ description: 'Reference entity type' })
  @IsString()
  @IsOptional()
  referenceType?: string;

  @ApiPropertyOptional({ description: 'Reference entity ID' })
  @IsString()
  @IsOptional()
  referenceId?: string;

  @ApiPropertyOptional({ description: 'Expiration in seconds (default 300 seconds)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  expiresInSeconds?: number = 300;
}

export class ReleaseReservationDto {
  @ApiPropertyOptional({ description: 'Optional reason for releasing reservation hold' })
  @IsString()
  @IsOptional()
  reason?: string;
}

export class ConsumeReservationDto {
  @ApiProperty({ description: 'Globally unique idempotency key for consuming reservation' })
  @IsNotEmpty()
  @IsString()
  idempotencyKey!: string;

  @ApiPropertyOptional({
    description: 'Destination user ID or wallet ID if transferring to recipient/system',
  })
  @IsString()
  @IsOptional()
  destinationUserId?: string;

  @ApiPropertyOptional({ description: 'Optional reason for consuming reservation' })
  @IsString()
  @IsOptional()
  reason?: string;
}

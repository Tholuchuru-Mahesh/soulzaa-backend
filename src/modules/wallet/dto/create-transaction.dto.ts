import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WalletCurrency, WalletTxnReason } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

export class CreditWalletDto {
  @ApiProperty({ description: 'Target user ID' })
  @IsNotEmpty()
  @IsString()
  userId!: string;

  @ApiProperty({ description: 'Amount of coins to credit', example: 1000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsNotEmpty()
  amount!: number;

  @ApiPropertyOptional({ enum: WalletCurrency, default: WalletCurrency.GOLD })
  @IsEnum(WalletCurrency)
  @IsOptional()
  currency?: WalletCurrency = WalletCurrency.GOLD;

  @ApiPropertyOptional({ enum: WalletTxnReason, default: WalletTxnReason.ADMIN_CREDIT })
  @IsEnum(WalletTxnReason)
  @IsOptional()
  reason?: WalletTxnReason = WalletTxnReason.ADMIN_CREDIT;

  @ApiProperty({ description: 'Globally unique idempotency key for replay protection' })
  @IsNotEmpty()
  @IsString()
  idempotencyKey!: string;

  @ApiPropertyOptional({ description: 'Source reference type (e.g. admin_grant, event_bonus)' })
  @IsString()
  @IsOptional()
  referenceType?: string;

  @ApiPropertyOptional({ description: 'Source reference entity ID' })
  @IsString()
  @IsOptional()
  referenceId?: string;

  @ApiPropertyOptional({ description: 'Description or reason snippet' })
  @IsString()
  @IsOptional()
  description?: string;
}

export class DebitWalletDto {
  @ApiProperty({ description: 'Target user ID' })
  @IsNotEmpty()
  @IsString()
  userId!: string;

  @ApiProperty({ description: 'Amount of coins to debit', example: 500 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsNotEmpty()
  amount!: number;

  @ApiPropertyOptional({ enum: WalletCurrency, default: WalletCurrency.GOLD })
  @IsEnum(WalletCurrency)
  @IsOptional()
  currency?: WalletCurrency = WalletCurrency.GOLD;

  @ApiPropertyOptional({ enum: WalletTxnReason, default: WalletTxnReason.ADMIN_DEBIT })
  @IsEnum(WalletTxnReason)
  @IsOptional()
  reason?: WalletTxnReason = WalletTxnReason.ADMIN_DEBIT;

  @ApiProperty({ description: 'Globally unique idempotency key for replay protection' })
  @IsNotEmpty()
  @IsString()
  idempotencyKey!: string;

  @ApiPropertyOptional({ description: 'Source reference type' })
  @IsString()
  @IsOptional()
  referenceType?: string;

  @ApiPropertyOptional({ description: 'Source reference entity ID' })
  @IsString()
  @IsOptional()
  referenceId?: string;

  @ApiPropertyOptional({ description: 'Description or reason snippet' })
  @IsString()
  @IsOptional()
  description?: string;
}

export class TransferWalletDto {
  @ApiProperty({ description: 'Sender source user ID' })
  @IsNotEmpty()
  @IsString()
  senderUserId!: string;

  @ApiProperty({ description: 'Recipient destination user ID' })
  @IsNotEmpty()
  @IsString()
  recipientUserId!: string;

  @ApiProperty({ description: 'Amount of coins to transfer', example: 250 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsNotEmpty()
  amount!: number;

  @ApiPropertyOptional({ enum: WalletCurrency, default: WalletCurrency.GOLD })
  @IsEnum(WalletCurrency)
  @IsOptional()
  currency?: WalletCurrency = WalletCurrency.GOLD;

  @ApiProperty({ description: 'Globally unique idempotency key for replay protection' })
  @IsNotEmpty()
  @IsString()
  idempotencyKey!: string;

  @ApiPropertyOptional({ description: 'Source reference type (e.g. peer_transfer)' })
  @IsString()
  @IsOptional()
  referenceType?: string;

  @ApiPropertyOptional({ description: 'Source reference entity ID' })
  @IsString()
  @IsOptional()
  referenceId?: string;

  @ApiPropertyOptional({ description: 'Description or reason snippet' })
  @IsString()
  @IsOptional()
  description?: string;
}

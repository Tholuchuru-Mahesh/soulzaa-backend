import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WalletCurrency, WalletEntryType, WalletTxnReason } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

/** Filter for a user's wallet transaction history. */
export class ListWalletTransactionsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: WalletCurrency })
  @IsOptional()
  @IsEnum(WalletCurrency)
  currency?: WalletCurrency;
}

/** Admin manual balance adjustment (credit or debit) — audited + authorized. */
export class AdminAdjustWalletDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;

  @ApiProperty({ enum: WalletCurrency })
  @IsEnum(WalletCurrency)
  currency!: WalletCurrency;

  @ApiProperty({ enum: WalletEntryType })
  @IsEnum(WalletEntryType)
  type!: WalletEntryType;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiProperty({ maxLength: 500, description: 'Reason for the manual adjustment (audited).' })
  @IsString()
  @MaxLength(500)
  note!: string;
}

/** Query for a user's rewards feed. */
export class WalletRewardsQueryDto extends PaginationQueryDto {}

/** Query for a user's unified wallet history (filterable). */
export class WalletHistoryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: WalletCurrency })
  @IsOptional()
  @IsEnum(WalletCurrency)
  currency?: WalletCurrency;

  @ApiPropertyOptional({ enum: WalletTxnReason })
  @IsOptional()
  @IsEnum(WalletTxnReason)
  reason?: WalletTxnReason;
}

/** Host/creator earnings summary. `settlementReady` is the current EARNINGS balance. */
export class HostEarningsDto {
  @ApiProperty() totalEarned!: number;
  @ApiProperty() settlementReady!: number;
  @ApiProperty({ type: Object }) bySource!: { gifts: number; treasure: number; pk: number };
}

/** Admin-triggered reconciliation for one user. */
export class WalletRecoveryDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;
}

/** One reward the user received (ledger-derived). */
export class RewardDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: WalletTxnReason }) reason!: WalletTxnReason;
  @ApiProperty({ enum: WalletCurrency }) currency!: WalletCurrency;
  @ApiProperty() amount!: number;
  @ApiProperty({ nullable: true }) source!: string | null;
  @ApiProperty({ nullable: true }) referenceId!: string | null;
  @ApiProperty() createdAt!: Date;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class WalletQueryDto {
  @ApiPropertyOptional({ description: 'Search term for user ID' })
  @IsString()
  @IsOptional()
  userId?: string;

  @ApiPropertyOptional({
    description:
      'Filter by Wallet Type (e.g. USER_WALLET, SYSTEM_WALLET, TREASURY_WALLET, ESCROW_WALLET)',
  })
  @IsString()
  @IsOptional()
  type?: string;

  @ApiPropertyOptional({
    description: 'Filter by Wallet Status (ACTIVE, LOCKED, FROZEN, SUSPENDED)',
  })
  @IsString()
  @IsOptional()
  status?: string;

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
}

export class LedgerQueryDto {
  @ApiPropertyOptional({ description: 'Filter by Wallet Entry Type (CREDIT or DEBIT)' })
  @IsString()
  @IsOptional()
  type?: string;

  @ApiPropertyOptional({
    description: 'Filter by Wallet Txn Reason (e.g. RECHARGE, GIFT_SEND, ADMIN_CREDIT)',
  })
  @IsString()
  @IsOptional()
  reason?: string;

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
}

export class TransactionQueryFilterDto {
  @ApiPropertyOptional({
    description: 'Filter by Transaction Type (PURCHASE, GIFT, REWARD, WITHDRAWAL, TRANSFER, etc.)',
  })
  @IsString()
  @IsOptional()
  transactionType?: string;

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
}

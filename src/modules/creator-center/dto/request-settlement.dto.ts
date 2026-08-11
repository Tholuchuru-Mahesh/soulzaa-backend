import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, IsPositive, IsString } from 'class-validator';

/**
 * Shape only — the actual business rules (minimum/maximum amount, balance
 * sufficiency, daily limit, one-pending-at-a-time) are enforced by the
 * existing `WithdrawalValidationService` inside `WithdrawalService.requestWithdrawal`,
 * not duplicated here.
 */
export class RequestSettlementDto {
  @ApiProperty({ description: 'Amount to withdraw, in coins' })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  amountCoins!: number;

  @ApiPropertyOptional({ default: 'BANK_TRANSFER' })
  @IsOptional()
  @IsString()
  payoutMethod?: string;

  @ApiPropertyOptional({ description: 'Payout account details (bank/UPI/etc.)' })
  @IsOptional()
  @IsObject()
  payoutDetails?: Record<string, unknown>;
}

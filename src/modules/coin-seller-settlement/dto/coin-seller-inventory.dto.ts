import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Every financial entry point on this controller takes a caller-supplied
 * idempotency key (PRD §32). It is validated rather than optional: a missing
 * key is the caller silently opting out of replay protection on a money
 * movement, which is exactly what the previous `randomUUID()` default did.
 */
export class PurchaseInventoryDto {
  @ApiProperty({ description: 'Inventory package to purchase' })
  @IsUUID()
  packageId!: string;

  @ApiProperty({ description: 'Caller-generated key making this purchase exactly-once' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  idempotencyKey!: string;
}

export class SellCoinsDto {
  @ApiProperty({ description: 'User receiving the Gold Coins' })
  @IsUUID()
  buyerId!: string;

  @ApiProperty({ description: 'Whole number of Gold Coins to sell' })
  @IsInt()
  @IsPositive()
  amount!: number;

  @ApiProperty({ description: 'Caller-generated key making this sale exactly-once' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  idempotencyKey!: string;
}


/**
 * What the client hands back from Razorpay checkout.
 *
 * The amount is deliberately absent: it is read from the order row server-side,
 * because an amount the client can name is a price the client can choose.
 */
export class ConfirmInventoryPaymentDto {
  @ApiProperty({ description: 'Our purchase order the payment settles' })
  @IsUUID()
  purchaseOrderId!: string;

  @ApiProperty({ description: 'razorpay_payment_id returned by checkout' })
  @IsString()
  @MinLength(4)
  @MaxLength(128)
  razorpayPaymentId!: string;

  @ApiProperty({ description: 'razorpay_signature returned by checkout' })
  @IsString()
  @MinLength(16)
  @MaxLength(256)
  razorpaySignature!: string;
}

export class CoinHistoryQueryDto {
  @ApiPropertyOptional({ description: 'SENT (sales to users) or ADDED (inventory purchases)' })
  @IsOptional()
  @IsIn(['SENT', 'ADDED'])
  type?: 'SENT' | 'ADDED';

  @ApiPropertyOptional({ description: 'Page size, 1-100', default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

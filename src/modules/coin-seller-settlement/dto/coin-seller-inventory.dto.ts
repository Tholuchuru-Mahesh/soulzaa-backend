import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsPositive, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

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

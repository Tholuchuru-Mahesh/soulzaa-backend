import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentProvider } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreatePurchaseOrderDto {
  @ApiProperty({ description: 'Purchasable coin package ID' })
  @IsNotEmpty()
  @IsString()
  packageId!: string;

  @ApiProperty({ enum: PaymentProvider, description: 'Payment Provider' })
  @IsEnum(PaymentProvider)
  @IsNotEmpty()
  provider!: PaymentProvider;

  @ApiProperty({ description: 'Globally unique idempotency key for order creation' })
  @IsNotEmpty()
  @IsString()
  idempotencyKey!: string;

  @ApiPropertyOptional({ description: 'Optional metadata snippet' })
  @IsOptional()
  metadata?: any;
}

export class VerifyPurchaseDto {
  @ApiProperty({ description: 'Purchase order ID or order number' })
  @IsNotEmpty()
  @IsString()
  orderId!: string;

  @ApiProperty({ description: 'Receipt data payload or token received from payment provider' })
  @IsNotEmpty()
  @IsString()
  receiptData!: string;

  @ApiPropertyOptional({ description: 'Cryptographic signature (if applicable)' })
  @IsString()
  @IsOptional()
  signature?: string;

  @ApiPropertyOptional({
    description: 'Unique transaction ID from payment provider (for anti-replay check)',
  })
  @IsString()
  @IsOptional()
  providerTxnId?: string;
}

export class OrderQueryDto {
  @ApiPropertyOptional({
    description: 'Filter by Purchase Order Status (CREATED, COMPLETED, FAILED, etc.)',
  })
  @IsString()
  @IsOptional()
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by Payment Provider' })
  @IsString()
  @IsOptional()
  provider?: string;

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

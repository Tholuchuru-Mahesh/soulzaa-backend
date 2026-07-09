import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WalletCurrency, WalletEntryType } from '@prisma/client';
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

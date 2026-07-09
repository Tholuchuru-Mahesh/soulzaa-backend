import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LuckyPacketDistribution, WalletCurrency } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import {
  LUCKY_PACKET_MAX_EXPIRY_SECONDS,
  LUCKY_PACKET_MAX_TOTAL,
  LUCKY_PACKET_MAX_WINNERS,
  LUCKY_PACKET_MESSAGE_MAX,
  LUCKY_PACKET_MIN_EXPIRY_SECONDS,
  LUCKY_PACKET_MIN_TOTAL,
  LUCKY_PACKET_MIN_WINNERS,
} from '../constants/lucky-packet.constants';

/** Host creates a lucky packet funded from their wallet. */
export class CreateLuckyPacketDto {
  @ApiProperty({ minimum: LUCKY_PACKET_MIN_TOTAL, maximum: LUCKY_PACKET_MAX_TOTAL })
  @Type(() => Number)
  @IsInt()
  @Min(LUCKY_PACKET_MIN_TOTAL)
  @Max(LUCKY_PACKET_MAX_TOTAL)
  totalCoins!: number;

  @ApiProperty({ minimum: LUCKY_PACKET_MIN_WINNERS, maximum: LUCKY_PACKET_MAX_WINNERS })
  @Type(() => Number)
  @IsInt()
  @Min(LUCKY_PACKET_MIN_WINNERS)
  @Max(LUCKY_PACKET_MAX_WINNERS)
  winnerCount!: number;

  @ApiProperty({ enum: LuckyPacketDistribution })
  @IsEnum(LuckyPacketDistribution)
  distribution!: LuckyPacketDistribution;

  @ApiPropertyOptional({
    enum: WalletCurrency,
    default: WalletCurrency.GOLD,
    description: 'Currency to fund the packet (GOLD or FREE).',
  })
  @IsOptional()
  @IsEnum(WalletCurrency)
  currency?: WalletCurrency;

  @ApiPropertyOptional({ maxLength: LUCKY_PACKET_MESSAGE_MAX })
  @IsOptional()
  @IsString()
  @Length(1, LUCKY_PACKET_MESSAGE_MAX)
  message?: string;

  @ApiProperty({
    minimum: LUCKY_PACKET_MIN_EXPIRY_SECONDS,
    maximum: LUCKY_PACKET_MAX_EXPIRY_SECONDS,
    description: 'Claim window in seconds.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(LUCKY_PACKET_MIN_EXPIRY_SECONDS)
  @Max(LUCKY_PACKET_MAX_EXPIRY_SECONDS)
  expiresInSeconds!: number;

  @ApiPropertyOptional({
    description: 'Client-supplied idempotency key so a retried create never double-debits.',
  })
  @IsOptional()
  @IsString()
  @Length(8, 100)
  idempotencyKey?: string;
}

/** Paginated + searchable claim history for a packet. */
export class ClaimHistoryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter claims by claimant user id.' })
  @IsOptional()
  @IsString()
  search?: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * VR-11 treasure DTOs.
 *
 * The create body is deliberately near-empty: the ladder shape comes from
 * `video_room_treasure_levels`, not from the client, so an owner cannot mint
 * themselves a custom pool by crafting a request. `poolOverride` is the one
 * admin-configurable escape hatch and is still bounded server-side.
 */
export class CreateTreasureBoxDto {
  @ApiPropertyOptional({
    description:
      'Fixed pool per box in GOLD, overriding the configured percentage. Switches ' +
      'every level of THIS ladder to the ADMIN_OVERRIDE strategy; other ladders are ' +
      'unaffected because the rules are frozen into the session at create time.',
    example: 2500,
    minimum: 0,
    maximum: 10_000_000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  poolOverride?: number;
}

export class TreasureHistoryQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100, example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class TreasureProgressDto {
  @ApiProperty({ example: 'b3f1c2d4-...' }) boxId!: string;
  @ApiProperty({ example: 2 }) level!: number;
  @ApiProperty({ enum: ['PENDING', 'ACTIVE', 'UNLOCKING', 'OPENED'] }) status!: string;
  @ApiProperty({ example: 12000 }) progress!: number;
  @ApiProperty({ example: 60000 }) threshold!: number;
  @ApiProperty({ example: 48000, description: 'Coins still needed to unlock.' })
  remaining!: number;
  @ApiProperty({ example: 20, description: 'Completion percentage, 0–100 (clamped).' })
  percent!: number;
  @ApiProperty({ nullable: true, example: null }) openedAt!: string | null;
}

export class TreasureResponseDto {
  @ApiProperty({ example: true }) active!: boolean;
  @ApiPropertyOptional({ example: 'a91c7b2e-...' }) sessionId?: string;
  @ApiPropertyOptional({
    enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CLOSED', 'ARCHIVED'],
    description:
      'COMPLETED means the ladder ran to its end; CLOSED means an owner stopped it early.',
  })
  status?: string;
  @ApiPropertyOptional({ example: 2 }) currentLevel?: number;
  @ApiPropertyOptional({ type: [TreasureProgressDto] }) boxes?: TreasureProgressDto[];
}

export class TreasureWinnerDto {
  @ApiProperty() boxId!: string;
  @ApiProperty() sessionId!: string;
  @ApiProperty() userId!: string;
  @ApiProperty({
    enum: ['RANDOM', 'WEIGHTED_RANDOM', 'ACTIVITY_BASED', 'CONTRIBUTION_BASED', 'VIP_PRIORITY'],
  })
  algorithm!: string;
  @ApiProperty({ example: 3333, description: 'Share of the pool in basis points.' })
  shareBps!: number;
  @ApiProperty({ example: 500 }) amount!: number;
  @ApiProperty({ example: 24, description: 'Users who passed eligibility at unlock.' })
  eligibleCount!: number;
  @ApiProperty({ example: 50, description: 'Users sampled from presence before filtering.' })
  candidateCount!: number;
  @ApiProperty({ example: '2026-07-22T10:00:00.000Z' }) selectedAt!: string;
}

export class TreasureRewardDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ example: 500 }) amount!: number;
  @ApiProperty({ enum: ['PENDING', 'DISTRIBUTED', 'FAILED'] }) status!: string;
  @ApiProperty({ nullable: true }) walletTxnId!: string | null;
  @ApiProperty({ nullable: true }) distributedAt!: string | null;
}

export class TreasureStatisticsDto {
  @ApiProperty({ example: 4, description: 'Boxes unlocked in this room, all time.' })
  totalPools!: number;
  @ApiProperty({
    example: 12000,
    description: 'GOLD minted to winners, all time. Platform-funded, not taken from gifts.',
  })
  totalMinted!: number;
  @ApiProperty({ example: 12 }) totalWinners!: number;
  @ApiProperty({
    nullable: true,
    description:
      'Live counters for the ladder currently running (Redis). Null when no ladder is live. ' +
      'Useful while a session is in flight, when the durable aggregate lags.',
    example: { boxesOpened: 2, totalMinted: 7500, totalWinners: 6 },
  })
  live!: { boxesOpened: number; totalMinted: number; totalWinners: number } | null;
}

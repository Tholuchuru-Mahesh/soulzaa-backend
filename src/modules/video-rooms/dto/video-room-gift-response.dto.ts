import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Response schemas for the VR-10 gift endpoints.
 *
 * Declared as classes rather than interfaces so `@nestjs/swagger` emits real
 * response schemas — an interface disappears at compile time and leaves the
 * generated OpenAPI document with an untyped 200, which is what client codegen
 * consumes.
 */

/** One receiver's leg of a send. */
export class VideoRoomGiftLegDto {
  @ApiProperty({ format: 'uuid', description: 'Ledger row id for this receiver.' })
  transactionId!: string;

  @ApiProperty({ format: 'uuid' })
  receiverId!: string;

  @ApiProperty({ example: 100, description: 'Coins this receiver’s gift was worth.' })
  coinValue!: number;

  @ApiProperty({ example: 30, description: 'Coins credited to the receiver’s EARNINGS wallet.' })
  receiverEarnings!: number;
}

/** `POST /gifts/send` — the completed, already-paid-for batch. */
export class VideoRoomGiftResponseDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Correlates every leg of this send, and every delivery event for it.',
  })
  batchId!: string;

  @ApiProperty({ format: 'uuid' })
  roomId!: string;

  @ApiProperty({ format: 'uuid' })
  giftId!: string;

  @ApiProperty({ example: 3, description: 'Streak length. Display only — never multiplies cost.' })
  comboTier!: number;

  @ApiProperty({
    example: 200,
    description: 'Total coins debited (per-receiver value x recipients).',
  })
  totalCoinValue!: number;

  @ApiProperty({ type: [VideoRoomGiftLegDto] })
  transactions!: VideoRoomGiftLegDto[];
}

export class GiftTopEntryDto {
  @ApiProperty({ format: 'uuid' })
  giftId!: string;

  @ApiProperty({ example: 42, description: 'Times this gift has been sent in the room.' })
  count!: number;
}

export class GiftTopSenderDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ example: 9000, description: 'Coins spent on gifts in this room.' })
  coins!: number;
}

/** `GET /gifts/statistics` — the summary every member receives. */
export class VideoRoomGiftStatisticsDto {
  @ApiProperty({ example: 128 })
  totalGifts!: number;

  @ApiProperty({ example: 51_200 })
  totalGiftCoins!: number;

  @ApiProperty({ type: [GiftTopEntryDto] })
  topGifts!: GiftTopEntryDto[];

  @ApiProperty({ type: [GiftTopSenderDto] })
  topSenders!: GiftTopSenderDto[];
}

export class GiftReceiverEarningsDto {
  @ApiProperty({ format: 'uuid' })
  receiverId!: string;

  @ApiProperty({ example: 300 })
  coins!: number;

  @ApiProperty({ example: 10 })
  gifts!: number;
}

export class GiftSenderTotalDto {
  @ApiProperty({ format: 'uuid' })
  senderId!: string;

  @ApiProperty({ example: 1000 })
  coins!: number;

  @ApiProperty({ example: 10 })
  gifts!: number;
}

/** `GET /gifts/statistics` for VIEW_ANALYTICS holders — summary plus per-user detail. */
export class VideoRoomGiftBreakdownDto extends VideoRoomGiftStatisticsDto {
  @ApiProperty({ type: [GiftReceiverEarningsDto] })
  receiverEarnings!: GiftReceiverEarningsDto[];

  @ApiProperty({ type: [GiftSenderTotalDto] })
  senderTotals!: GiftSenderTotalDto[];

  @ApiProperty({ example: 17 })
  uniqueSenders!: number;
}

/** `GET /gifts/combo` — one live streak. */
export class VideoRoomGiftComboDto {
  @ApiProperty({ format: 'uuid' })
  senderId!: string;

  @ApiProperty({ format: 'uuid' })
  giftId!: string;

  @ApiProperty({ example: 5, description: 'Current streak length. Display only.' })
  tier!: number;

  @ApiProperty({ description: 'When this streak lapses if not extended (ISO-8601).' })
  expiresAt!: string;
}

/** `GET /gifts/recent` — one entry of the live ticker. */
export class VideoRoomRecentGiftDto {
  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ format: 'uuid' })
  batchId!: string;

  @ApiProperty({ format: 'uuid' })
  senderId!: string;

  @ApiProperty({ format: 'uuid' })
  receiverId!: string;

  @ApiProperty({ format: 'uuid' })
  giftId!: string;

  @ApiProperty({ example: 'Rocket' })
  giftName!: string;

  @ApiProperty({ example: 1 })
  quantity!: number;

  @ApiProperty({ example: 2 })
  comboTier!: number;

  @ApiProperty({ example: 100 })
  totalCoinValue!: number;

  @ApiProperty({ description: 'ISO-8601.' })
  createdAt!: string;
}

/** Body for an admin reversal. */
export class ReverseVideoRoomGiftDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    description: 'Why this gift is being reversed. Recorded on the ledger row and the audit trail.',
    example: 'Chargeback on the originating recharge.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/** One reversed leg. */
export class VideoRoomGiftReversalDto {
  @ApiProperty({ format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ format: 'uuid' })
  receiverId!: string;

  @ApiProperty({ example: 100, description: 'Coins returned to the sender.' })
  refundedToSender!: number;

  @ApiProperty({
    example: 30,
    description: 'Earnings debited back from the receiver.',
  })
  clawedBackFromReceiver!: number;

  @ApiPropertyOptional({ description: 'Present when the whole batch was reversed.' })
  batchId?: string;
}

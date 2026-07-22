import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/** Who a video-room gift is aimed at. */
export enum VideoRoomGiftTarget {
  /** One named recipient. */
  SINGLE = 'SINGLE',
  /** An explicit list of recipients. */
  MULTI = 'MULTI',
  /** Everyone currently occupying a seat, excluding the sender. */
  SEAT_ALL = 'SEAT_ALL',
  /** Everyone in the room. Rejected unless VIDEO_ROOM_GIFT_ALLOW_ROOM_ALL is on. */
  ROOM_ALL = 'ROOM_ALL',
}

/**
 * Send a gift in a video room. Cost is `gift.coinValue × quantity × recipients`
 * — every recipient receives a whole gift — and the whole send is
 * all-or-nothing.
 */
export class SendVideoRoomGiftDto {
  @ApiProperty({ format: 'uuid', description: 'Catalog gift id.' })
  @IsUUID()
  giftId!: string;

  @ApiProperty({
    enum: VideoRoomGiftTarget,
    example: VideoRoomGiftTarget.SINGLE,
    description: 'Recipient selector. ROOM_ALL is gated by server config.',
  })
  @IsEnum(VideoRoomGiftTarget)
  target!: VideoRoomGiftTarget;

  @ApiPropertyOptional({ format: 'uuid', description: 'Required when target = SINGLE.' })
  @ValidateIf((o: SendVideoRoomGiftDto) => o.target === VideoRoomGiftTarget.SINGLE)
  @IsUUID()
  receiverId?: string;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: 'Required when target = MULTI.',
  })
  @ValidateIf((o: SendVideoRoomGiftDto) => o.target === VideoRoomGiftTarget.MULTI)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  receiverIds?: string[];

  @ApiProperty({ minimum: 1, maximum: 999, default: 1, description: 'Gifts per recipient.' })
  @IsInt()
  @Min(1)
  @Max(999)
  quantity = 1;

  @ApiPropertyOptional({
    description:
      'Client-supplied key making the send exactly-once. Replaying the same key returns the original transactions instead of charging again.',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}

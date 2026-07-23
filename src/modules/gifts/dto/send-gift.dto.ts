import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GiftContextType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export class SendGiftDto {
  @ApiProperty({ description: 'Target Gift ID or Gift Code' })
  @IsNotEmpty()
  @IsString()
  giftId!: string;

  @ApiProperty({ description: 'Receiver User ID' })
  @IsNotEmpty()
  @IsString()
  receiverId!: string;

  @ApiProperty({
    enum: GiftContextType,
    description: 'Gifting context (AUDIO_ROOM, VIDEO_ROOM, PK_BATTLE, etc.)',
    default: GiftContextType.AUDIO_ROOM,
  })
  @IsEnum(GiftContextType)
  @IsNotEmpty()
  contextType!: GiftContextType;

  @ApiProperty({ description: 'Target Context ID (Room ID, Battle ID, Chat ID)' })
  @IsNotEmpty()
  @IsString()
  contextId!: string;

  @ApiPropertyOptional({
    description: 'Quantity of gifts sent (default 1)',
    example: 1,
    default: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  quantity?: number = 1;

  @ApiPropertyOptional({ description: 'Combo streak tier multiplier count', default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  comboTier?: number = 1;

  @ApiProperty({ description: 'Globally unique idempotency key for gift transaction' })
  @IsNotEmpty()
  @IsString()
  idempotencyKey!: string;

  @ApiPropertyOptional({ description: 'Optional metadata JSON snippet' })
  @IsOptional()
  metadata?: any;
}

export class GiftHistoryQueryDto {
  @ApiPropertyOptional({
    description: 'Filter by Gift Context Type (AUDIO_ROOM, VIDEO_ROOM, etc.)',
  })
  @IsString()
  @IsOptional()
  contextType?: string;

  @ApiPropertyOptional({ description: 'Filter by Context ID (Room ID, etc.)' })
  @IsString()
  @IsOptional()
  contextId?: string;

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

export class InventoryQueryDto {
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

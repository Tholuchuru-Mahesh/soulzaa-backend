import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OfficialInventoryCategory, InventoryRecipientType } from '@prisma/client';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class DistributeInventoryDto {
  @ApiProperty({ description: 'ID of the inventory item to distribute' })
  @IsUUID()
  @IsNotEmpty()
  inventoryItemId!: string;

  @ApiProperty({ enum: InventoryRecipientType, description: 'Type of recipient (AGENCY, CREATOR, USER)' })
  @IsEnum(InventoryRecipientType)
  recipientType!: InventoryRecipientType;

  @ApiPropertyOptional({ description: 'User or Agency ID of recipient' })
  @IsOptional()
  @IsString()
  recipientId?: string;

  @ApiProperty({ description: 'Name of the recipient (e.g. Star Vibe agency)' })
  @IsString()
  @IsNotEmpty()
  recipientName!: string;

  @ApiPropertyOptional({ description: 'Recipient code or agency code (e.g. AGY2578)' })
  @IsOptional()
  @IsString()
  recipientCode?: string;

  @ApiProperty({ description: 'Quantity of assets to distribute', minimum: 1 })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiProperty({ description: 'Reason for distribution', example: 'Event reward' })
  @IsString()
  @IsNotEmpty()
  reason!: string;

  @ApiPropertyOptional({ description: 'Remarks or notes', example: 'Distribution for dasara regional event winners.' })
  @IsOptional()
  @IsString()
  remarks?: string;
}

export class CreateInventoryItemDto {
  @ApiProperty({ description: 'Name of the item' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ enum: OfficialInventoryCategory, description: 'Item category' })
  @IsEnum(OfficialInventoryCategory)
  category!: OfficialInventoryCategory;

  @ApiPropertyOptional({ description: 'Item description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Thumbnail URL' })
  @IsOptional()
  @IsString()
  thumbnailUrl?: string;

  @ApiProperty({ description: 'Initial available quantity', minimum: 0 })
  @IsInt()
  @Min(0)
  availableQty!: number;

  @ApiPropertyOptional({ description: 'Source of the asset', default: 'Manager' })
  @IsOptional()
  @IsString()
  source?: string;

  @ApiPropertyOptional({ description: 'Related event name' })
  @IsOptional()
  @IsString()
  relatedEventName?: string;

  @ApiPropertyOptional({ description: 'Low stock threshold', default: 20 })
  @IsOptional()
  @IsInt()
  lowStockThreshold?: number;

  @ApiPropertyOptional({ description: 'Official ID (for Admin allocation)' })
  @IsOptional()
  @IsUUID()
  officialId?: string;
}

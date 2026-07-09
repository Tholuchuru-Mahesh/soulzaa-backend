import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BackpackItemType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

/** Filter for a user's backpack inventory. */
export class ListBackpackDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: BackpackItemType })
  @IsOptional()
  @IsEnum(BackpackItemType)
  type?: BackpackItemType;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  equipped?: boolean;
}

/** Transfer a transferable item to another user. */
export class TransferItemDto {
  @ApiProperty()
  @IsUUID()
  toUserId!: string;
}

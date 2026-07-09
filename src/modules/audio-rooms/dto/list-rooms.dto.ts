import { ApiPropertyOptional } from '@nestjs/swagger';
import { RoomVisibility } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

/** Filters for the paginated room discovery listing. */
export class ListRoomsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by room category id.' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ example: 'en', description: 'Filter by ISO 639-1 language code.' })
  @IsOptional()
  @IsString()
  @Length(2, 8)
  language?: string;

  @ApiPropertyOptional({ description: 'Case-insensitive match on room name.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  search?: string;

  @ApiPropertyOptional({
    enum: RoomVisibility,
    description: 'Admin-only filter; non-privileged callers only ever see PUBLIC rooms.',
  })
  @IsOptional()
  @IsEnum(RoomVisibility)
  visibility?: RoomVisibility;
}

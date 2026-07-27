import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

// NOTE: despite the filename, no send DTO lives here any more. The live one is
// `SendGiftDto` in `./gift.dto.ts`, used by GiftController; a second,
// identically-named class used to sit here and was the one the module barrel
// re-exported, while nothing called it. It went with the legacy
// GiftTransactionService engine it belonged to, along with an unused
// InventoryQueryDto. Only the history query below has live consumers.

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

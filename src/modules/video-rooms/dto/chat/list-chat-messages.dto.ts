import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

/**
 * Chat history. Supports BOTH pagination styles on purpose: `before` gives
 * keyset pagination (stable and cheap at depth — the scalable path), while
 * `page`/`limit` keeps parity with the platform's paginated envelope. Supplying
 * `before` suppresses `skip`.
 */
export class ListChatMessagesDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Keyset cursor: messages older than this id.',
  })
  @IsOptional()
  @IsUUID()
  before?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

export class LiveHistoryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by specific Room ID' })
  @IsOptional()
  @IsString()
  roomId?: string;

  @ApiPropertyOptional({ description: 'Filter by room type: VIDEO or AUDIO' })
  @IsOptional()
  @IsString()
  roomType?: string;
}

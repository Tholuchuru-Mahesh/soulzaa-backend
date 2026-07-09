import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

/** User search query — text term + optional country filter, with pagination. */
export class SearchUserDto extends PaginationQueryDto {
  @ApiProperty({ example: 'aditya', description: 'Search term (username or full name)' })
  @IsString()
  @Length(1, 64)
  q!: string;

  @ApiPropertyOptional({ example: 'IN' })
  @IsOptional()
  @IsString()
  @Length(2, 64)
  country?: string;
}

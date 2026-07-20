import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { VideoRoomAccessPolicy } from '../constants/video-room-lifecycle';
import { ListVideoRoomsDto } from './list-video-rooms.dto';

/**
 * Faceted discovery/search query. Extends the list filters (category / language /
 * status + pagination) with country and tags. Every facet is index-backed
 * (category/language/country B-trees, GIN on tags). NOTE (VR-1): the search
 * endpoint returns 501 until the discovery phase.
 */
export class SearchVideoRoomsDto extends ListVideoRoomsDto {
  @ApiPropertyOptional({ description: 'Filter by country code.' })
  @IsOptional()
  @IsString()
  @Length(2, 8)
  country?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Only rooms carrying ALL of these tags (array-contains).',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({
    enum: VideoRoomAccessPolicy,
    description: 'Filter by declared access policy (e.g. VIP_ONLY, INVITE_ONLY).',
  })
  @IsOptional()
  @IsEnum(VideoRoomAccessPolicy)
  accessPolicy?: VideoRoomAccessPolicy;
}

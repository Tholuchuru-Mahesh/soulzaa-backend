import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VideoRoomReportStatus, VideoRoomStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

export class LockRoomAdminDto {
  @ApiProperty({ description: 'Lock or unlock status for the video room' })
  @IsBoolean()
  isLocked!: boolean;
}

export class DisableChatAdminDto {
  @ApiProperty({ description: 'Disable or enable chat mode in the video room' })
  @IsBoolean()
  isChatDisabled!: boolean;
}

export class RemoveParticipantAdminDto {
  @ApiProperty({ description: 'Target user ID to remove/kick from the video room' })
  @IsUUID()
  targetUserId!: string;

  @ApiPropertyOptional({ description: 'Optional administrative reason for removal' })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class BanUserAdminDto {
  @ApiPropertyOptional({ description: 'Optional ban duration in seconds (omit for permanent)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  durationSeconds?: number;

  @ApiPropertyOptional({ description: 'Administrative reason for ban' })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class MuteUserAdminDto {
  @ApiPropertyOptional({ description: 'Optional mute duration in seconds (omit for permanent)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  durationSeconds?: number;

  @ApiPropertyOptional({ description: 'Administrative reason for mute' })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class ReviewReportAdminDto {
  @ApiProperty({ enum: VideoRoomReportStatus, description: 'Review status to assign' })
  @IsEnum(VideoRoomReportStatus)
  status!: VideoRoomReportStatus;

  @ApiPropertyOptional({ description: 'Administrative review note' })
  @IsOptional()
  @IsString()
  note?: string;
}

export class AdminListRoomsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: VideoRoomStatus, description: 'Filter by room status' })
  @IsOptional()
  @IsEnum(VideoRoomStatus)
  status?: VideoRoomStatus;

  @ApiPropertyOptional({ description: 'Filter by room owner user ID' })
  @IsOptional()
  @IsUUID()
  ownerId?: string;

  @ApiPropertyOptional({ description: 'Filter by locked state' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isLocked?: boolean;

  @ApiPropertyOptional({ description: 'Search term for room name' })
  @IsOptional()
  @IsString()
  search?: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ContentRequestCategory, ContentRequestStatus } from '@prisma/client';

export class CreateContentRequestDto {
  @ApiProperty({ enum: ContentRequestCategory })
  @IsEnum(ContentRequestCategory)
  category!: ContentRequestCategory;

  @ApiProperty({ description: 'Brief title for the content request' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ description: 'Detailed description of the issue' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'ID of the subject user the request is about' })
  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @ApiPropertyOptional({
    description: 'Reference ID of the content item (roomId, streamId, postId, etc.)',
  })
  @IsOptional()
  @IsString()
  referenceId?: string;
}

export class UpdateContentRequestDto {
  @ApiProperty({ enum: ContentRequestStatus })
  @IsEnum(ContentRequestStatus)
  status!: ContentRequestStatus;
}

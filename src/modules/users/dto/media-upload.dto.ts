import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsMimeType, IsPositive, IsString, MaxLength } from 'class-validator';

/** Request a presigned URL to upload an avatar/cover (category fixed server-side). */
export class MediaPresignDto {
  @ApiProperty({ example: 'avatar.jpg' })
  @IsString()
  @MaxLength(255)
  filename!: string;

  @ApiProperty({ example: 'image/jpeg' })
  @IsMimeType()
  contentType!: string;

  @ApiProperty({ example: 204800, description: 'File size in bytes' })
  @IsInt()
  @IsPositive()
  size!: number;
}

/** Finalize an avatar/cover upload after the client PUTs to the presigned URL. */
export class MediaConfirmDto {
  @ApiProperty({ description: 'The object key returned by the presign step' })
  @IsString()
  @MaxLength(1024)
  key!: string;
}

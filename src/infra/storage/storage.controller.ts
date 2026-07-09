import { Body, Controller, Delete, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ConfirmUploadDto } from './dto/confirm-upload.dto';
import { PresignUploadDto } from './dto/presign-upload.dto';
import { UploadService } from './upload.service';

@ApiTags('storage')
@ApiBearerAuth()
@Controller('storage')
export class StorageController {
  constructor(private readonly uploads: UploadService) {}

  @Post('presign')
  @ApiOperation({ summary: 'Get a presigned URL to upload a file directly to S3' })
  presign(@Body() dto: PresignUploadDto, @CurrentUser('id') userId: string) {
    return this.uploads.createPresignedUpload({
      category: dto.category,
      filename: dto.filename,
      contentType: dto.contentType,
      size: dto.size,
      userId,
    });
  }

  @Post('confirm')
  @ApiOperation({ summary: 'Confirm an upload; triggers async image optimisation' })
  confirm(@Body() dto: ConfirmUploadDto, @CurrentUser('id') userId: string) {
    return this.uploads.confirmUpload({ key: dto.key, category: dto.category, userId });
  }

  @Get('download-url')
  @ApiOperation({ summary: 'Get a presigned URL to download one of your objects' })
  async downloadUrl(@Query('key') key: string, @CurrentUser('id') userId: string) {
    return { downloadUrl: await this.uploads.getDownloadUrl(key, userId) };
  }

  @Delete()
  @ApiOperation({ summary: 'Delete one of your objects' })
  async remove(@Query('key') key: string, @CurrentUser('id') userId: string) {
    await this.uploads.deleteUpload(key, userId);
    return { deleted: true, key };
  }
}

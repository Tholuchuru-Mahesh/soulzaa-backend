import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { InvestigationRecordingService } from '../services/investigation-recording.service';

@ApiTags('investigation-recordings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('investigation-recordings')
export class InvestigationRecordingController {
  constructor(private readonly service: InvestigationRecordingService) {}

  @Get()
  @RequirePermissions('investigation.recording.view')
  @ApiOperation({ summary: 'List all investigation recordings (Admin/SuperAdmin only)' })
  listAll(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listAll({ status }, Number(page ?? 1), Number(limit ?? 20));
  }

  @Get('status/:evidenceId')
  @RequirePermissions('investigation.recording.view')
  @ApiOperation({ summary: 'Get live recording status (PROCESSING, READY, ERROR)' })
  getStatus(@Param('evidenceId') evidenceId: string) {
    return this.service.getEvidenceStatus(evidenceId);
  }

  @Get('timeline/:evidenceId')
  @ApiOperation({ summary: 'Get synchronized speaker timeline segments for evidence recording' })
  getSpeakerTimeline(@Param('evidenceId') evidenceId: string) {
    return this.service.getSpeakerTimeline(evidenceId);
  }

  @Post('retry/:evidenceId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('investigation.recording.view')
  @ApiOperation({ summary: 'Retry failed evidence capture & packaging' })
  retryEvidence(@Param('evidenceId') evidenceId: string) {
    return this.service.retryEvidence(evidenceId);
  }

  @Post('upload-audio/:evidenceId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Upload real recorded room audio for an evidence report' })
  async uploadAudio(@Param('evidenceId') evidenceId: string, @Req() req: Request) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const audioBuffer = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] || 'audio/aac';
    return this.service.saveEvidenceAudio(evidenceId, audioBuffer, contentType);
  }

  @Get('stream/:evidenceId')
  @ApiOperation({
    summary: 'Securely stream 4-minute evidence recording with playback seek/range support',
  })
  async streamEvidence(
    @Param('evidenceId') evidenceId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const { buffer, contentType } = await this.service.getEvidenceMediaPayload(evidenceId);
    const totalSize = buffer.length;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
      const chunkSize = end - start + 1;
      const chunk = buffer.subarray(start, end + 1);

      res.writeHead(HttpStatus.PARTIAL_CONTENT, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Cache-Control': 'private, no-cache, no-store, must-revalidate',
      });
      res.end(chunk);
    } else {
      res.writeHead(HttpStatus.OK, {
        'Content-Length': totalSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-cache, no-store, must-revalidate',
      });
      res.end(buffer);
    }
  }

  @Get('moderator/:moderatorId')
  @RequirePermissions('investigation.recording.view')
  @ApiOperation({ summary: 'List recordings by moderator' })
  listByModerator(
    @Param('moderatorId', ParseUuidPipe) moderatorId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listByModerator(moderatorId, Number(page ?? 1), Number(limit ?? 20));
  }

  @Get('case/:targetUserId')
  @RequirePermissions('investigation.recording.view')
  @ApiOperation({
    summary:
      'Unified moderation case view: every recording + audit log entry against a target user',
  })
  getCaseView(@Param('targetUserId', ParseUuidPipe) targetUserId: string) {
    return this.service.getCaseView(targetUserId);
  }

  @Get('evidence/:evidenceId')
  @RequirePermissions('investigation.recording.view')
  @ApiOperation({ summary: 'Get recording by evidence ID' })
  getByEvidenceId(@Param('evidenceId') evidenceId: string) {
    return this.service.getByEvidenceId(evidenceId);
  }

  @Get(':id')
  @RequirePermissions('investigation.recording.view')
  @ApiOperation({ summary: 'Get single recording by ID' })
  getOne(@Param('id', ParseUuidPipe) id: string) {
    return this.service.getRecording(id);
  }
}

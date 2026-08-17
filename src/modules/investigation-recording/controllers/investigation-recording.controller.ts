import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { InvestigationRecordingService } from '../services/investigation-recording.service';

@ApiTags('investigation-recordings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('admin/investigation-recordings')
export class InvestigationRecordingController {
  constructor(private readonly service: InvestigationRecordingService) {}

  @Get()
  @RequirePermissions('investigation.recording.view')
  @ApiOperation({ summary: 'List all investigation recordings (Admin/SuperAdmin only)' })
  listAll(
    @Query('status') status?: string,
    @Query('regionId') regionId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listAll({ status, regionId }, Number(page ?? 1), Number(limit ?? 20));
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

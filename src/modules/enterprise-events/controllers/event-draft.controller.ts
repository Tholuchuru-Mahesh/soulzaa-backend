import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import { CreateEventDraftDto, UpdateEventDraftDto } from '../dto/event-draft.dto';
import { DraftWriteInput, EventDraftService } from '../services/event-draft.service';

/**
 * Agency-facing event authoring. Deliberately separate from
 * EnterpriseEventController: that surface is `event.manage` and can move an
 * event to any status, which is exactly what an agency must not be able to do.
 *
 * Every route derives the agency from the bearer token — an `agencyId` is never
 * accepted from the client, matching every other agency controller.
 */
@ApiTags('Agency Event Drafts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@UseInterceptors(AuditLogInterceptor)
@Controller('enterprise-events/drafts')
export class EventDraftController {
  constructor(private readonly drafts: EventDraftService) {}

  @Post()
  @RequirePermissions('event.create')
  @ApiOperation({ summary: 'Create an event draft (status DRAFT)' })
  @ApiResponse({ status: 201, description: 'Draft created' })
  createDraft(@Body() dto: CreateEventDraftDto, @CurrentUser() user: AuthenticatedUser) {
    return this.drafts.createDraft(this.toInput(dto) as DraftWriteInput, user.id);
  }

  @Get('mine')
  @RequirePermissions('event.create')
  @ApiOperation({ summary: "List the calling agency's events" })
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.drafts.listMine(user.id);
  }

  @Get(':id')
  @RequirePermissions('event.create')
  @ApiOperation({ summary: "Read one of the calling agency's events" })
  getMine(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.drafts.getMine(id, user.id);
  }

  @Patch(':id')
  @RequirePermissions('event.create')
  @ApiOperation({ summary: 'Update a DRAFT or REJECTED event' })
  updateDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEventDraftDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.drafts.updateDraft(id, this.toInput(dto), user.id);
  }

  @Post(':id/submit')
  @RequirePermissions('event.submit_for_approval')
  @ApiOperation({ summary: 'Submit for Official/Admin approval (→ PENDING_APPROVAL)' })
  @ApiResponse({ status: 400, description: 'Not submittable from the current status' })
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.drafts.submitForApproval(id, user.id);
  }

  @Delete(':id')
  @RequirePermissions('event.create')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a draft' })
  deleteDraft(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.drafts.deleteDraft(id, user.id);
  }

  /** ISO strings on the wire become Dates at the service boundary. */
  private toInput(dto: CreateEventDraftDto | UpdateEventDraftDto): Partial<DraftWriteInput> {
    return {
      name: dto.name,
      description: dto.description,
      banner: dto.banner,
      thumbnail: dto.thumbnail,
      maxParticipants: dto.maxParticipants,
      participationRules: dto.participationRules,
      eligibilityRules: dto.eligibilityRules,
      rewardDefinition: dto.rewardDefinition,
      ...(dto.startTime ? { startTime: new Date(dto.startTime) } : {}),
      ...(dto.endTime ? { endTime: new Date(dto.endTime) } : {}),
      ...(dto.regStartTime ? { regStartTime: new Date(dto.regStartTime) } : {}),
      ...(dto.regEndTime ? { regEndTime: new Date(dto.regEndTime) } : {}),
    };
  }
}

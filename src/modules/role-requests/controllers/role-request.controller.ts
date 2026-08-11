import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RoleRequestType } from '@prisma/client';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import {
  RejectRoleRequestDto,
  ReviewDocumentDto,
  StageActionDto,
  SubmitRoleRequestDto,
} from '../dto/role-request.dto';
import { RoleRequestDocumentService } from '../services/role-request-document.service';
import { RoleRequestService } from '../services/role-request.service';

/**
 * Role approval chains: submit, review, decide.
 *
 * Reviewer routes are permission-gated *and* territory-gated — holding
 * `role_request.review` lets you review, but the routing service still checks
 * you hold the scope covering that request, so an Official cannot approve
 * another region's applicant.
 */
@ApiTags('Role Requests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('role-requests')
export class RoleRequestController {
  constructor(
    private readonly service: RoleRequestService,
    private readonly documents: RoleRequestDocumentService,
  ) {}

  @ApiOperation({ summary: 'Submit a role request' })
  @ApiResponse({ status: 201, description: 'Request filed with a reference' })
  @ApiResponse({ status: 400, description: 'Subject has no assigned region' })
  @ApiResponse({ status: 409, description: 'An open request of this type already exists' })
  @RequirePermissions('role_request.submit')
  @Post()
  submit(@Body() dto: SubmitRoleRequestDto, @CurrentUser('id') actorId: string) {
    return this.service.submit(dto, actorId);
  }

  @ApiOperation({ summary: 'My reviewer queue, narrowed to my territory' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size (default 25, max 100)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Page offset (default 0)' })
  @ApiResponse({ status: 200, description: 'Open requests awaiting my review' })
  @RequirePermissions('role_request.review')
  @Get('queue')
  queue(
    @CurrentUser('id') actorId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.queue(actorId, Number(limit) || 25, Number(offset) || 0);
  }

  /**
   * Declared before `:id` on purpose — Nest matches routes in declaration order,
   * and `/role-requests/mine` would otherwise be swallowed by the UUID param
   * route and fail validation.
   *
   * No permission decorator: this returns only the caller's own request, so
   * gating it on `role_request.view` would lock applicants out of their own
   * application status.
   */
  @ApiOperation({ summary: "The caller's own latest request of a type" })
  @ApiQuery({ name: 'type', required: false, enum: RoleRequestType })
  @ApiResponse({ status: 200, description: 'The request, or null if never applied' })
  @Get('mine')
  findMine(
    @CurrentUser('id') userId: string,
    @Query('type', new DefaultValuePipe(RoleRequestType.AGENCY), new ParseEnumPipe(RoleRequestType))
    type: RoleRequestType,
  ) {
    return this.service.findMine(userId, type);
  }

  @ApiOperation({ summary: 'A request with its full audit trail' })
  @ApiResponse({ status: 200, description: 'Request and ordered actions' })
  @RequirePermissions('role_request.view')
  @Get(':id')
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findById(id);
  }

  @ApiOperation({ summary: 'Documents attached to a request, with their check verdicts' })
  @ApiResponse({ status: 200, description: 'Documents in slot order' })
  @RequirePermissions('role_request.view')
  @Get(':id/documents')
  listDocuments(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.listForRequest(id);
  }

  @ApiOperation({ summary: 'A short-lived link to open one document' })
  @ApiResponse({ status: 200, description: 'Presigned download URL' })
  @ApiResponse({ status: 403, description: 'Not a reviewer for this request territory' })
  @RequirePermissions('role_request.view')
  @Get('documents/:documentId/download')
  documentDownloadUrl(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.documents.downloadUrl(documentId, actorId);
  }

  @ApiOperation({ summary: 'Accept or reject a single document' })
  @ApiResponse({ status: 200, description: 'Document decision recorded' })
  @ApiResponse({ status: 400, description: 'Rejection without a reason' })
  @RequirePermissions('role_request.review')
  @Post('documents/:documentId/review')
  reviewDocument(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: ReviewDocumentDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.documents.review(documentId, actorId, dto.status, dto.notes);
  }

  @ApiOperation({ summary: 'Advance to the next stage (approves at the final stage)' })
  @ApiResponse({ status: 200, description: 'Request advanced' })
  @ApiResponse({ status: 403, description: 'Not the reviewer for this stage or territory' })
  @RequirePermissions('role_request.review')
  @Post(':id/advance')
  advance(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StageActionDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.service.advance({ requestId: id, actorId, ...dto });
  }

  @ApiOperation({ summary: 'Send back to the subject for more information' })
  @ApiResponse({ status: 200, description: 'Request marked NEEDS_INFO' })
  @RequirePermissions('role_request.review')
  @Post(':id/send-back')
  sendBack(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StageActionDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.service.sendBack({ requestId: id, actorId, ...dto });
  }

  @ApiOperation({ summary: 'Approve and grant the role' })
  @ApiResponse({ status: 200, description: 'Request approved, role granted' })
  @RequirePermissions('role_request.decide')
  @Post(':id/approve')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StageActionDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.service.approve({ requestId: id, actorId, ...dto });
  }

  @ApiOperation({ summary: 'Reject the request' })
  @ApiResponse({ status: 200, description: 'Request rejected' })
  @RequirePermissions('role_request.decide')
  @Post(':id/reject')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectRoleRequestDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.service.reject({ requestId: id, actorId, ...dto });
  }

  @ApiOperation({ summary: 'Withdraw my own request' })
  @ApiResponse({ status: 200, description: 'Request withdrawn' })
  @ApiResponse({ status: 403, description: 'Only the subject may withdraw' })
  @Post(':id/withdraw')
  withdraw(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string) {
    return this.service.withdraw(id, userId);
  }
}

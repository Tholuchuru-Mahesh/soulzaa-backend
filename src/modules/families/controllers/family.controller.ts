import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  AuditLogAction,
  RequirePermissions,
} from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import {
  FamilyAuditService,
  FamilyConfigurationService,
  FamilyHistoryService,
  FamilyInvitationService,
  FamilyMemberService,
  FamilyQueryService,
  FamilyRequestService,
  FamilyRoleService,
  FamilyService,
  FamilyStatisticsService,
} from '../services';

@ApiTags('Enterprise Family System')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('families')
export class FamilyController {
  constructor(
    private readonly familyService: FamilyService,
    private readonly memberService: FamilyMemberService,
    private readonly roleService: FamilyRoleService,
    private readonly invitationService: FamilyInvitationService,
    private readonly requestService: FamilyRequestService,
    private readonly historyService: FamilyHistoryService,
    private readonly statisticsService: FamilyStatisticsService,
    private readonly queryService: FamilyQueryService,
    private readonly auditService: FamilyAuditService,
    private readonly configService: FamilyConfigurationService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('family.create')
  @UseInterceptors(AuditLogInterceptor)
  @AuditLogAction('FAMILY_CREATED', 'family')
  @ApiOperation({ summary: 'Create a new family community' })
  @ApiResponse({ status: 201, description: 'Family created' })
  createFamily(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: {
      name: string;
      tag: string;
      description?: string;
      badge?: string;
      logo?: string;
      privacy?: string;
    },
  ) {
    return this.familyService.createFamily({
      founderId: user.id,
      name: body.name,
      tag: body.tag,
      description: body.description,
      badge: body.badge,
      logo: body.logo,
      privacy: body.privacy,
    });
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('family.update')
  @UseInterceptors(AuditLogInterceptor)
  @AuditLogAction('FAMILY_UPDATED', 'family')
  @ApiOperation({ summary: 'Update family profile' })
  updateFamily(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) familyId: string,
    @Body() body: any,
  ) {
    return this.familyService.updateFamily({
      familyId,
      actorUserId: user.id,
      ...body,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('family.delete')
  @ApiOperation({ summary: 'Disband / Delete a family' })
  deleteFamily(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) familyId: string,
  ) {
    return this.familyService.deleteFamily(familyId, user.id);
  }

  @Post(':id/join')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('family.view')
  @ApiOperation({ summary: 'Submit join request or auto-join family' })
  joinFamily(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) familyId: string) {
    return this.requestService.submitJoinRequest(familyId, user.id);
  }

  @Post(':id/leave')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('family.view')
  @ApiOperation({ summary: 'Leave family' })
  leaveFamily(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) familyId: string,
  ) {
    return this.memberService.leaveFamily(familyId, user.id);
  }

  @Post(':id/invite')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('family.member.manage')
  @ApiOperation({ summary: 'Invite a user to join family' })
  inviteMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) familyId: string,
    @Body() body: { inviteeId: string },
  ) {
    return this.invitationService.sendInvitation({
      familyId,
      inviterId: user.id,
      inviteeId: body.inviteeId,
    });
  }

  @Post('invitations/:id/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('family.view')
  @ApiOperation({ summary: 'Accept family invitation' })
  acceptInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) invitationId: string,
  ) {
    return this.invitationService.acceptInvitation(invitationId, user.id);
  }

  @Post('invitations/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('family.view')
  @ApiOperation({ summary: 'Reject family invitation' })
  rejectInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) invitationId: string,
  ) {
    return this.invitationService.rejectInvitation(invitationId, user.id);
  }

  @Post('requests/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('family.member.manage')
  @ApiOperation({ summary: 'Approve pending join request' })
  approveJoinRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) requestId: string,
  ) {
    return this.requestService.approveJoinRequest(requestId, user.id);
  }

  @Post('requests/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('family.member.manage')
  @ApiOperation({ summary: 'Reject pending join request' })
  rejectJoinRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) requestId: string,
  ) {
    return this.requestService.rejectJoinRequest(requestId, user.id);
  }

  @Post(':id/kick')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('family.member.manage')
  @ApiOperation({ summary: 'Kick a member from family' })
  kickMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) familyId: string,
    @Body() body: { targetUserId: string; reason?: string },
  ) {
    return this.memberService.kickMember({
      familyId,
      actorUserId: user.id,
      targetUserId: body.targetUserId,
      reason: body.reason,
    });
  }

  @Post(':id/ban')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('family.member.manage')
  @ApiOperation({ summary: 'Ban a member from family' })
  banMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) familyId: string,
    @Body() body: { targetUserId: string; reason?: string },
  ) {
    return this.memberService.banMember({
      familyId,
      actorUserId: user.id,
      targetUserId: body.targetUserId,
      reason: body.reason,
    });
  }

  @Post(':id/unban')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('family.member.manage')
  @ApiOperation({ summary: 'Unban a user from family' })
  unbanMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) familyId: string,
    @Body() body: { targetUserId: string },
  ) {
    return this.memberService.unbanMember(familyId, user.id, body.targetUserId);
  }

  @Post(':id/transfer')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('family.update')
  @ApiOperation({ summary: 'Transfer family ownership to another member' })
  transferOwnership(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) familyId: string,
    @Body() body: { newFounderUserId: string },
  ) {
    return this.familyService.transferOwnership(familyId, user.id, body.newFounderUserId);
  }

  @Post(':id/role')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('family.role.manage')
  @ApiOperation({ summary: 'Promote or demote family member role' })
  changeRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) familyId: string,
    @Body() body: { targetUserId: string; newRole: any },
  ) {
    return this.roleService.changeMemberRole({
      familyId,
      actorUserId: user.id,
      targetUserId: body.targetUserId,
      newRole: body.newRole,
    });
  }

  @Get('summary')
  @RequirePermissions('family.view')
  @ApiOperation({ summary: 'Global family summary metrics' })
  getSummary() {
    return this.queryService.getGlobalSummary();
  }

  @Get('search')
  @RequirePermissions('family.view')
  @ApiOperation({ summary: 'Search active families by name or tag' })
  searchFamilies(@Query('q') query: string, @Query() q: PaginationQueryDto) {
    return this.queryService.searchFamilies(query || '', q.page, q.limit);
  }

  @Get('top')
  @RequirePermissions('family.view')
  @ApiOperation({ summary: 'Top family leaderboards by level and EXP' })
  getTopFamilies(@Query('limit') limit = 10) {
    return this.queryService.getTopFamilies(Number(limit));
  }

  @Get(':id/members')
  @RequirePermissions('family.view')
  @ApiOperation({ summary: 'Get family member list' })
  getMembers(@Param('id', ParseUuidPipe) familyId: string, @Query() q: PaginationQueryDto) {
    return this.queryService.getFamilyMembers(familyId, q.page, q.limit);
  }

  @Get(':id/statistics')
  @RequirePermissions('family.statistics.view')
  @ApiOperation({ summary: 'Family statistics' })
  getStatistics(@Param('id', ParseUuidPipe) familyId: string) {
    return this.statisticsService.getFamilyStatistics(familyId);
  }

  @Get(':id/history')
  @RequirePermissions('family.view')
  @ApiOperation({ summary: 'Family activity history' })
  getHistory(@Param('id', ParseUuidPipe) familyId: string, @Query() q: PaginationQueryDto) {
    return this.historyService.getFamilyHistory(familyId, { page: q.page, limit: q.limit });
  }

  @Get('audit')
  @RequirePermissions('family.audit.view')
  @ApiOperation({ summary: 'Family operational audit event logs' })
  getAudit(@Query() q: PaginationQueryDto) {
    return this.auditService.getAuditLogs(undefined, q.page, q.limit);
  }

  @Get('configuration')
  @RequirePermissions('family.role.manage')
  @ApiOperation({ summary: 'Active family configuration parameters' })
  getConfiguration() {
    return this.configService.getFamilyConfig();
  }
}

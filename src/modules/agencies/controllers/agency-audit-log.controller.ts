import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { RequireRoles } from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacRolesGuard } from 'src/modules/authorization/guards/rbac-roles.guard';
import { AgencyAuditLogQueryDto } from '../dto/agency-audit-log-query.dto';
import { AgencyAuditLogService } from '../services/agency-audit-log.service';

/**
 * The agency's own audit trail — read-only.
 *
 * There is deliberately no write, edit or delete route: the spec requires
 * audit entries to be permanently traceable and neither modifiable nor
 * deletable. Scoped to the JWT caller, so no agency id is accepted.
 */
@ApiTags('agency-audit-logs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacRolesGuard)
@RequireRoles('AGENCY')
@Controller('agencies/me/audit-logs')
export class AgencyAuditLogController {
  constructor(private readonly logs: AgencyAuditLogService) {}

  @Get()
  @ApiOperation({ summary: "The calling agency's audit trail, newest first" })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: AgencyAuditLogQueryDto) {
    return this.logs.list(user.id, {
      module: query.module,
      search: query.search,
      page: query.page,
      limit: query.limit,
    });
  }

  @Get('modules')
  @ApiOperation({ summary: 'Resources this agency has audit entries for' })
  // Declared before `:logId` so the literal segment is matched first, rather
  // than being captured as an id.
  modules(@CurrentUser() user: AuthenticatedUser) {
    return this.logs.listModules(user.id);
  }

  @Get(':logId')
  @ApiOperation({ summary: 'One audit entry in full, with device and network detail' })
  @ApiResponse({ status: 404, description: 'Not found, or not this agency’s entry' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('logId', ParseUUIDPipe) logId: string) {
    return this.logs.get(user.id, logId);
  }
}

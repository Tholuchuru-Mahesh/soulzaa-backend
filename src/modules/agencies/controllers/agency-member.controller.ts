import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { RequireRoles } from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacRolesGuard } from 'src/modules/authorization/guards/rbac-roles.guard';
import { AgencyMemberQueryDto } from '../dto/agency-member-query.dto';
import { AgencyMemberService } from '../services/agency-member.service';

/**
 * Community Management — the agency's own members.
 *
 * Scoped to the JWT caller exactly as the dashboard is: no `agencyId` is
 * accepted in any form, and the member id in the detail route is checked
 * against this agency's relationships before anything is read. An agency may
 * only see its own users.
 */
@ApiTags('agency-community')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacRolesGuard)
@RequireRoles('AGENCY')
@Controller('agencies/me/members')
export class AgencyMemberController {
  constructor(private readonly members: AgencyMemberService) {}

  @Get()
  @ApiOperation({ summary: "The calling agency's members, newest joiner first" })
  @ApiResponse({ status: 200, description: 'Paginated members with coins and active state' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: AgencyMemberQueryDto) {
    return this.members.listMembers(user.id, {
      search: query.search,
      page: query.page,
      limit: query.limit,
    });
  }

  @Get(':userId')
  @ApiOperation({ summary: "One member's profile, activity and performance" })
  @ApiResponse({ status: 404, description: 'Not a member of the calling agency' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.members.getMember(user.id, userId);
  }
}

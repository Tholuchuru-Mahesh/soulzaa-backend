import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { RequireRoles } from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacRolesGuard } from 'src/modules/authorization/guards/rbac-roles.guard';
import { AgencyJoinRequestService } from '../services/agency-join-request.service';

export class RequestToJoinDto {
  @ApiPropertyOptional({ description: 'Optional note to the agency.' })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  message?: string;
}

export class JoinRequestQueryDto {
  @ApiPropertyOptional({ enum: ['PENDING', 'ACCEPTED', 'DECLINED'], default: 'PENDING' })
  @IsOptional()
  @IsIn(['PENDING', 'ACCEPTED', 'DECLINED'])
  status?: 'PENDING' | 'ACCEPTED' | 'DECLINED';
}

/**
 * Asking to join an agency. Any signed-in member may call these — the whole
 * point is that the caller is not in the agency yet.
 */
@ApiTags('agency-join')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('agencies')
export class AgencyJoinController {
  constructor(private readonly joins: AgencyJoinRequestService) {}

  @Post(':agencyId/join')
  @ApiOperation({ summary: 'Ask to join an agency' })
  request(
    @CurrentUser() user: AuthenticatedUser,
    @Param('agencyId', ParseUUIDPipe) agencyId: string,
    @Body() dto: RequestToJoinDto,
  ) {
    return this.joins.request(user.id, agencyId, dto.message);
  }

  @Get('join-requests/mine')
  @ApiOperation({ summary: "The caller's own outstanding request, if any" })
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.joins.myRequest(user.id);
  }

  @Post('join-requests/:requestId/cancel')
  @ApiOperation({ summary: 'Withdraw your own request' })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    return this.joins.cancel(user.id, requestId);
  }
}

/**
 * The agency's side of the queue — listing and deciding. Requires the AGENCY
 * role, and every call is scoped to the caller's own agency.
 */
@ApiTags('agency-join')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacRolesGuard)
@RequireRoles('AGENCY')
@Controller('agencies/me/join-requests')
export class AgencyJoinReviewController {
  constructor(private readonly joins: AgencyJoinRequestService) {}

  @Get()
  @ApiOperation({ summary: 'Join requests for the calling agency, oldest first' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: JoinRequestQueryDto) {
    return this.joins.listForAgency(user.id, query.status ?? 'PENDING');
  }

  @Get('count')
  @ApiOperation({ summary: 'How many requests are waiting' })
  // Before `:requestId`, so the literal segment wins.
  count(@CurrentUser() user: AuthenticatedUser) {
    return this.joins.pendingCount(user.id).then((pending) => ({ pending }));
  }

  @Post(':requestId/accept')
  @ApiOperation({ summary: 'Accept, adding the user to the agency' })
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    return this.joins.accept(user.id, requestId);
  }

  @Post(':requestId/decline')
  @ApiOperation({ summary: 'Decline the request' })
  decline(
    @CurrentUser() user: AuthenticatedUser,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    return this.joins.decline(user.id, requestId);
  }
}

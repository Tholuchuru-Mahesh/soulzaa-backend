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
import { CreateChallengeDto, UpdateChallengeDto } from '../dto/challenge.dto';
import { ChallengeService } from '../services/challenge.service';

@ApiTags('Agency Challenges')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@UseInterceptors(AuditLogInterceptor)
@Controller('challenges')
export class ChallengeController {
  constructor(private readonly challenges: ChallengeService) {}

  @Post('drafts')
  @RequirePermissions('event.create')
  @ApiOperation({ summary: 'Create a challenge draft' })
  @ApiResponse({ status: 201, description: 'Draft created' })
  createDraft(@Body() dto: CreateChallengeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.challenges.createDraft(dto, user.id);
  }

  @Get('mine')
  @RequirePermissions('event.create')
  @ApiOperation({ summary: "List the calling agency's challenges" })
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.challenges.listMine(user.id);
  }

  @Get(':id')
  @RequirePermissions('event.create')
  @ApiOperation({ summary: "Read one of the calling agency's challenges" })
  getMine(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.challenges.getMine(id, user.id);
  }

  @Patch('drafts/:id')
  @RequirePermissions('event.create')
  @ApiOperation({ summary: 'Update a DRAFT or REJECTED challenge' })
  updateDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateChallengeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.challenges.updateDraft(id, dto, user.id);
  }

  @Post(':id/submit')
  @RequirePermissions('event.submit_for_approval')
  @ApiOperation({ summary: 'Submit for Admin approval (→ PENDING_APPROVAL)' })
  @ApiResponse({ status: 200, description: 'Challenge submitted for approval' })
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.challenges.submitForApproval(id, user.id);
  }

  @Delete('drafts/:id')
  @RequirePermissions('event.create')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a challenge draft' })
  deleteDraft(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.challenges.deleteDraft(id, user.id);
  }
}

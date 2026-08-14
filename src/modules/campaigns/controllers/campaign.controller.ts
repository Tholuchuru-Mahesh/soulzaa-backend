import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CampaignStatus } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { CreateCampaignDto, UpdateCampaignDto } from '../dto/campaign.dto';
import { CampaignService } from '../services/campaign.service';

/**
 * Campaigns — Official Portal surface for creating and managing territory-
 * scoped promotional campaigns.
 */
@ApiTags('Official — Campaigns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@RequirePermissions('mobile.workforce.view')
@Controller('mobile/campaigns')
export class CampaignController {
  constructor(private readonly service: CampaignService) {}

  @ApiOperation({ summary: 'Create a campaign in my territory' })
  @ApiResponse({ status: 201, description: 'Campaign created' })
  @Post()
  create(
    @CurrentUser('id') officialId: string,
    @Body() dto: CreateCampaignDto,
  ) {
    return this.service.create(officialId, dto);
  }

  @ApiOperation({ summary: 'List campaigns in my territory (scoped)' })
  @ApiQuery({ name: 'status', required: false, enum: CampaignStatus })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiResponse({ status: 200, description: 'Scoped, paginated campaign list' })
  @Get()
  list(
    @CurrentUser('id') officialId: string,
    @Query('status') status?: CampaignStatus,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.service.list(officialId, { status, limit, offset });
  }

  @ApiOperation({ summary: 'Get a single campaign by ID' })
  @Get(':id')
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findById(id);
  }

  @ApiOperation({ summary: 'Update campaign status / dates' })
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') actorId: string,
    @Body() dto: UpdateCampaignDto,
  ) {
    return this.service.update(id, actorId, dto);
  }
}

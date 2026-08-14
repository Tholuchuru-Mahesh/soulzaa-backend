import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseEnumPipe,
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
import { ContentRequestStatus } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import {
  CreateContentRequestDto,
  UpdateContentRequestDto,
} from '../dto/content-request.dto';
import { ContentRequestService } from '../services/content-request.service';

/**
 * Content Requests — Official Portal surface for raising content review
 * tickets against users or platform content within the Official's territory.
 *
 * All routes require `content_request.review` permission.
 */
@ApiTags('Official — Content Requests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@RequirePermissions('content_request.review')
@Controller('mobile/content-requests')
export class ContentRequestController {
  constructor(private readonly service: ContentRequestService) {}

  @ApiOperation({ summary: 'Create a content review request (Official)' })
  @ApiResponse({ status: 201, description: 'Content request created' })
  @Post()
  create(
    @CurrentUser('id') officialId: string,
    @Body() dto: CreateContentRequestDto,
  ) {
    return this.service.create(officialId, dto);
  }

  @ApiOperation({ summary: 'List content requests in my territory (scoped)' })
  @ApiQuery({ name: 'status', required: false, enum: ContentRequestStatus })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiResponse({ status: 200, description: 'Scoped content request list' })
  @Get()
  list(
    @CurrentUser('id') officialId: string,
    @Query('status') status?: ContentRequestStatus,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.service.list(officialId, { status, limit, offset });
  }

  @ApiOperation({ summary: 'Get a single content request by ID' })
  @ApiResponse({ status: 200, description: 'Content request detail' })
  @ApiResponse({ status: 404, description: 'Not found' })
  @Get(':id')
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findById(id);
  }

  @ApiOperation({ summary: 'Update content request status (Official)' })
  @ApiResponse({ status: 200, description: 'Status updated' })
  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') actorId: string,
    @Body() dto: UpdateContentRequestDto,
  ) {
    return this.service.updateStatus(id, actorId, dto);
  }
}

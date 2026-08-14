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
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { CreateCommunityProgramDto, UpdateCommunityProgramDto } from '../dto/campaign.dto';
import { CommunityProgramService } from '../services/community-program.service';

/**
 * Community Programs — Official Portal surface for creating and managing
 * ongoing community-engagement programs in the Official's territory.
 */
@ApiTags('Official — Community Programs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@RequirePermissions('mobile.workforce.view')
@Controller('mobile/community-programs')
export class CommunityProgramController {
  constructor(private readonly service: CommunityProgramService) {}

  @ApiOperation({ summary: 'Create a community program in my territory' })
  @ApiResponse({ status: 201, description: 'Program created' })
  @Post()
  create(@CurrentUser('id') officialId: string, @Body() dto: CreateCommunityProgramDto) {
    return this.service.create(officialId, dto);
  }

  @ApiOperation({ summary: 'List community programs in my territory (scoped)' })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiResponse({ status: 200, description: 'Scoped, paginated program list' })
  @Get()
  list(
    @CurrentUser('id') officialId: string,
    @Query('isActive') isActive?: string,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    const activeFilter = isActive !== undefined ? isActive === 'true' : undefined;
    return this.service.list(officialId, { isActive: activeFilter, limit, offset });
  }

  @ApiOperation({ summary: 'Get a single community program by ID' })
  @Get(':id')
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findById(id);
  }

  @ApiOperation({ summary: 'Update community program details / active status' })
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') actorId: string,
    @Body() dto: UpdateCommunityProgramDto,
  ) {
    return this.service.update(id, actorId, dto);
  }
}

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
import { CreateEventDto, UpdateEventDto } from '../dto/events.dto';
import { EventsOfficialService } from '../services/events-official.service';

/**
 * Regional Events — Official Portal surface for creating and listing
 * territory-scoped platform events.
 *
 * Events created here are automatically scoped to the Official's territory
 * (countryId / stateId / regionId) so they only appear in that region's
 * feed. Uses `event.manage` permission.
 */
@ApiTags('Official — Regional Events')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@RequirePermissions('event.manage')
@Controller('mobile/regional-events')
export class EventsOfficialController {
  constructor(private readonly service: EventsOfficialService) {}

  @ApiOperation({ summary: 'Create a territory-scoped regional event (Official)' })
  @ApiResponse({ status: 201, description: 'Regional event created and scoped' })
  @Post()
  create(@CurrentUser('id') officialId: string, @Body() dto: CreateEventDto) {
    return this.service.create(officialId, dto);
  }

  @ApiOperation({ summary: 'List regional events in my territory (scoped)' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiResponse({ status: 200, description: 'Scoped, paginated regional event list' })
  @Get()
  list(
    @CurrentUser('id') officialId: string,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.service.list(officialId, { limit, offset });
  }

  @ApiOperation({ summary: 'Update a regional event (Official)' })
  @ApiResponse({ status: 200, description: 'Event updated' })
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') officialId: string,
    @Body() dto: UpdateEventDto,
  ) {
    return this.service.update(officialId, id, dto);
  }
}

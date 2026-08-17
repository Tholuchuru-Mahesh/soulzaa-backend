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
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { LiveStreamingService } from '../services/live-streaming.service';

class StartStreamDto {
  declare title: string;
  description?: string;
}

@ApiTags('Live Streaming')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('live-streaming')
export class LiveStreamingController {
  constructor(
    private readonly service: LiveStreamingService,
    private readonly prisma: PrismaService,
  ) {}

  @ApiOperation({ summary: 'Start a live stream (snapshots caller geography)' })
  @ApiResponse({ status: 201, description: 'Live stream started' })
  @Post()
  async start(@CurrentUser('id') streamerId: string, @Body() dto: StartStreamDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: streamerId },
      select: { countryId: true, stateId: true },
    });

    return this.service.startStream({
      streamerId,
      title: dto.title,
      description: dto.description,
      countryId: user?.countryId,
      stateId: user?.stateId,
    });
  }

  @ApiOperation({ summary: 'End my live stream' })
  @ApiResponse({ status: 200, description: 'Stream ended' })
  @Patch(':id/end')
  end(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') streamerId: string) {
    return this.service.endStream(id, streamerId);
  }

  @ApiOperation({ summary: 'List all currently live streams (scoped for Officials)' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiResponse({ status: 200, description: 'List of live streams with viewer counts' })
  @RequirePermissions('mobile.workforce.view')
  @Get('live')
  listLive(
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    // Unrestricted for now — Official filtering happens at dashboard level via WorkforceScopeService
    return this.service.listLive({}, limit, offset);
  }

  @ApiOperation({ summary: 'List my streams (past + current)' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @Get('mine')
  mine(
    @CurrentUser('id') streamerId: string,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.service.findByStreamer(streamerId, limit, offset);
  }
}

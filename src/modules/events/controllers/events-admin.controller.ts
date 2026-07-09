import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { EventType } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { CreateEventDto, UpdateEventDto } from '../dto/events.dto';
import { EventsAdminService } from '../services/events-admin.service';

class ListEventsAdminDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: EventType })
  @IsOptional()
  @IsEnum(EventType)
  type?: EventType;
}

/**
 * Platform-admin event management (base `admin/events`). Restricted to
 * ADMIN/SUPER_ADMIN.
 */
@ApiTags('events-admin')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/events')
export class EventsAdminController {
  constructor(private readonly admin: EventsAdminService) {}

  @Get()
  @ApiOperation({ summary: 'List events (paginated)' })
  list(@Query() q: ListEventsAdminDto) {
    return this.admin.list(q);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an event' })
  create(@CurrentUser('id') adminId: string, @Body() dto: CreateEventDto) {
    return this.admin.create(adminId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an event' })
  update(
    @CurrentUser('id') adminId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: UpdateEventDto,
  ) {
    return this.admin.update(adminId, id, dto);
  }
}

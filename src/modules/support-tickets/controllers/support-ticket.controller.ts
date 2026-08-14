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
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SupportTicketCategory, SupportTicketPriority, SupportTicketStatus } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import {
  AssignTicketDto,
  CreateSupportTicketDto,
  EscalateTicketDto,
  ReplyToTicketDto,
  UpdateTicketStatusDto,
} from '../dto/support-ticket.dto';
import { SupportTicketQueryService } from '../services/support-ticket-query.service';
import { SupportTicketService } from '../services/support-ticket.service';

/**
 * Support ticket lifecycle for users and Official workforce.
 *
 * Any authenticated user may submit and reply to their own tickets.
 * Officials (with `support_ticket.review` permission) see all tickets in their
 * territory and may update status, assign, reply as staff, and escalate.
 */
@ApiTags('Support Tickets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('support-tickets')
export class SupportTicketController {
  constructor(
    private readonly service: SupportTicketService,
    private readonly query: SupportTicketQueryService,
  ) {}

  // ── User routes (any authenticated user) ─────────────────────────────

  @ApiOperation({ summary: 'Submit a new support ticket' })
  @ApiResponse({ status: 201, description: 'Ticket created' })
  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateSupportTicketDto) {
    return this.service.create(userId, dto);
  }

  @ApiOperation({ summary: 'List my own tickets' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @Get('mine')
  myTickets(
    @CurrentUser('id') userId: string,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.query.listBySubmitter(userId, limit, offset);
  }

  // ── Official routes (scoped to territory) ────────────────────────────

  @ApiOperation({ summary: 'Official: List all tickets in territory (scoped)' })
  @ApiQuery({ name: 'status', required: false, enum: SupportTicketStatus })
  @ApiQuery({ name: 'category', required: false, enum: SupportTicketCategory })
  @ApiQuery({ name: 'priority', required: false, enum: SupportTicketPriority })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @RequirePermissions('support_ticket.review')
  @Get()
  list(
    @CurrentUser('id') officialId: string,
    @Query('status') status?: SupportTicketStatus,
    @Query('category') category?: SupportTicketCategory,
    @Query('priority') priority?: SupportTicketPriority,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    return this.query.listForOfficial(officialId, {
      status,
      category,
      priority,
      limit: limit ?? 25,
      offset: offset ?? 0,
    });
  }

  @ApiOperation({ summary: 'Get a single ticket with message thread' })
  @ApiResponse({ status: 200, description: 'Ticket detail with messages and audit trail' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  @RequirePermissions('support_ticket.review')
  @Get(':id')
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.query.findById(id);
  }

  @ApiOperation({ summary: 'Reply to a ticket (as staff / Official)' })
  @ApiResponse({ status: 201, description: 'Message posted' })
  @RequirePermissions('support_ticket.review')
  @Post(':id/reply')
  replyAsStaff(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') officialId: string,
    @Body() dto: ReplyToTicketDto,
  ) {
    return this.service.reply(id, officialId, dto, true);
  }

  @ApiOperation({ summary: 'User replies to their own ticket' })
  @Post(':id/user-reply')
  replyAsUser(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ReplyToTicketDto,
  ) {
    return this.service.reply(id, userId, dto, false);
  }

  @ApiOperation({ summary: 'Update ticket status (Official)' })
  @ApiResponse({ status: 200, description: 'Status updated' })
  @RequirePermissions('support_ticket.review')
  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') officialId: string,
    @Body() dto: UpdateTicketStatusDto,
  ) {
    return this.service.updateStatus(id, officialId, dto);
  }

  @ApiOperation({ summary: 'Assign ticket to an Official' })
  @ApiResponse({ status: 200, description: 'Ticket assigned' })
  @RequirePermissions('support_ticket.review')
  @Patch(':id/assign')
  assign(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') actorId: string,
    @Body() dto: AssignTicketDto,
  ) {
    return this.service.assign(id, actorId, dto);
  }

  @ApiOperation({ summary: 'Escalate ticket to Admin level' })
  @ApiResponse({ status: 200, description: 'Ticket escalated' })
  @RequirePermissions('support_ticket.review')
  @Patch(':id/escalate')
  escalate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') actorId: string,
    @Body() dto: EscalateTicketDto,
  ) {
    return this.service.escalate(id, actorId, dto);
  }
}

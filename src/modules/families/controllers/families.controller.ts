import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  CreateFamilyDto,
  KickMemberDto,
  ManageRequestDto,
  PromoteMemberDto,
  SendFamilyMessageDto,
  TransferLeadershipDto,
  UpdateFamilyDto,
} from '../dto/families.dto';
import { FamiliesService } from '../services/families.service';

@ApiTags('families')
@ApiBearerAuth()
@Controller('families')
export class FamiliesController {
  constructor(private readonly families: FamiliesService) {}

  @Post()
  @NotGuest()
  @ApiOperation({ summary: 'Create a new family (guild)' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateFamilyDto) {
    return this.families.create(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List and search families' })
  list(@Query() q: PaginationQueryDto & { search?: string }) {
    return this.families.listFamilies(q.page, q.limit, q.search);
  }

  @Get('me')
  @NotGuest()
  @ApiOperation({ summary: 'Get current user family and membership details' })
  getMyFamily(@CurrentUser('id') userId: string) {
    return this.families.getMyFamily(userId);
  }

  @Get('config')
  @ApiOperation({ summary: 'Get active dynamic family configurations and limits' })
  getConfig() {
    return this.families.getConfig();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details of a family by ID' })
  get(@Param('id', ParseUuidPipe) id: string) {
    return this.families.get(id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Update family profile details' })
  update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: UpdateFamilyDto,
  ) {
    return this.families.update(userId, id, dto);
  }

  @Post(':id/join')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Request to join a family (or join immediately if auto-accept is on)' })
  join(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    return this.families.join(userId, id);
  }

  @Get(':id/requests')
  @NotGuest()
  @ApiOperation({ summary: 'List pending join requests for the family (Elders+)' })
  requests(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Query() q: PaginationQueryDto,
  ) {
    return this.families.listRequests(userId, id, {
      skip: q.skip,
      limit: q.limit,
      page: q.page,
    });
  }

  @Post(':id/requests/:requestId/resolve')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Approve or reject a join request (Elders+)' })
  resolveRequest(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Param('requestId', ParseUuidPipe) requestId: string,
    @Body() dto: ManageRequestDto,
  ) {
    return this.families.handleRequest(userId, id, requestId, dto);
  }

  @Post(':id/leave')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Leave the family' })
  leave(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    return this.families.leave(userId, id);
  }

  @Post(':id/kick')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Kick a member from the family' })
  kick(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: KickMemberDto,
  ) {
    return this.families.kick(userId, id, dto.userId);
  }

  @Post(':id/promote')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Promote or demote a family member' })
  promote(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: PromoteMemberDto,
  ) {
    return this.families.promote(userId, id, dto);
  }

  @Post(':id/transfer-leadership')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Transfer family leadership to another member' })
  transferLeadership(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: TransferLeadershipDto,
  ) {
    return this.families.transferLeadership(userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @NotGuest()
  @ApiOperation({ summary: 'Disband and delete the family (Leader only)' })
  disband(@CurrentUser('id') userId: string, @Param('id', ParseUuidPipe) id: string) {
    return this.families.disband(userId, id);
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'Get list of members in the family' })
  members(@Param('id', ParseUuidPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.families.listMembers(id, q.page, q.limit);
  }

  @Get(':id/logs')
  @NotGuest()
  @ApiOperation({ summary: 'Get audit logs for family actions' })
  logs(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Query() q: PaginationQueryDto,
  ) {
    return this.families.listLogs(userId, id, q.page, q.limit);
  }

  @Get(':id/messages')
  @NotGuest()
  @ApiOperation({ summary: 'Get family group chat message history' })
  listMessages(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Query() q: PaginationQueryDto,
  ) {
    return this.families.listMessages(userId, id, q.page, q.limit);
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.OK)
  @NotGuest()
  @ApiOperation({ summary: 'Send a message to the family group chat' })
  sendMessage(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: SendFamilyMessageDto,
  ) {
    return this.families.sendMessage(userId, id, dto);
  }
}

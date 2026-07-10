import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CreateInvitationDto } from '../dto/create-invitation.dto';
import { ListInvitationsDto } from '../dto/list-invitations.dto';
import { InvitationsService } from '../services/invitations.service';

/**
 * Invitations HTTP surface. Static `incoming`/`outgoing` routes are declared
 * before the `:id/*` action routes.
 */
@ApiTags('social')
@ApiBearerAuth()
@Controller('social/invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Invite a user to a room/game/family/PK/event' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateInvitationDto) {
    return this.invitations.create(userId, dto);
  }

  @Get('incoming')
  @ApiOperation({ summary: 'List pending invitations I received' })
  incoming(@CurrentUser('id') userId: string, @Query() q: ListInvitationsDto) {
    return this.invitations.incoming(userId, q.page, q.limit, q.type);
  }

  @Get('outgoing')
  @ApiOperation({ summary: 'List pending invitations I sent' })
  outgoing(@CurrentUser('id') userId: string, @Query() q: ListInvitationsDto) {
    return this.invitations.outgoing(userId, q.page, q.limit, q.type);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept an invitation I received' })
  accept(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.invitations.accept(id, userId);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline an invitation I received' })
  decline(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.invitations.decline(id, userId);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an invitation I sent' })
  cancel(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.invitations.cancel(id, userId);
  }
}

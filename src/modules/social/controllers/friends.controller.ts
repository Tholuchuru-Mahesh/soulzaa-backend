import {
  Body,
  Controller,
  Delete,
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
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { ListFriendsDto } from '../dto/list-friends.dto';
import { SendFriendRequestDto } from '../dto/send-friend-request.dto';
import { FriendsService } from '../services/friends.service';

/**
 * Friends & friend-requests HTTP surface. Static `requests/*` routes are
 * declared before the `:friendUserId` param routes so they take precedence.
 */
@ApiTags('social')
@ApiBearerAuth()
@Controller('social/friends')
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  @Post('requests')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a friend request' })
  send(@CurrentUser('id') userId: string, @Body() dto: SendFriendRequestDto) {
    return this.friends.sendRequest(userId, dto);
  }

  @Post('requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel (withdraw) a friend request I sent' })
  cancel(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.friends.cancel(id, userId);
  }

  @Post('requests/:id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a friend request I received' })
  accept(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.friends.accept(id, userId);
  }

  @Post('requests/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a friend request I received' })
  reject(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.friends.reject(id, userId);
  }

  @Get('requests/incoming')
  @ApiOperation({ summary: 'List pending friend requests I received' })
  incoming(@CurrentUser('id') userId: string, @Query() q: PaginationQueryDto) {
    return this.friends.incoming(userId, q.page, q.limit);
  }

  @Get('requests/outgoing')
  @ApiOperation({ summary: 'List pending friend requests I sent' })
  outgoing(@CurrentUser('id') userId: string, @Query() q: PaginationQueryDto) {
    return this.friends.outgoing(userId, q.page, q.limit);
  }

  @Get()
  @ApiOperation({ summary: 'List my friends (search + best-only filter)' })
  list(@CurrentUser('id') userId: string, @Query() q: ListFriendsDto) {
    return this.friends.listFriends(userId, q.page, q.limit, q.search, q.bestOnly);
  }

  @Delete(':friendUserId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a friend' })
  remove(
    @CurrentUser('id') userId: string,
    @Param('friendUserId', ParseUUIDPipe) friendId: string,
  ) {
    return this.friends.remove(userId, friendId);
  }

  @Post(':friendUserId/best')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pin a friend as a best friend' })
  pinBest(
    @CurrentUser('id') userId: string,
    @Param('friendUserId', ParseUUIDPipe) friendId: string,
  ) {
    return this.friends.setBestFriend(userId, friendId, true);
  }

  @Delete(':friendUserId/best')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unpin a friend as a best friend' })
  unpinBest(
    @CurrentUser('id') userId: string,
    @Param('friendUserId', ParseUUIDPipe) friendId: string,
  ) {
    return this.friends.setBestFriend(userId, friendId, false);
  }
}

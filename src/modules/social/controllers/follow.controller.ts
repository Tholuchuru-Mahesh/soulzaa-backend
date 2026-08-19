import {
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
import { FollowService } from '../services/follow.service';

/**
 * Follow HTTP surface. All routes require a valid access token. Follow/unfollow
 * operate as the caller against a target user id; the list endpoints read any
 * user's followers/following (privacy of the counts themselves is enforced at
 * the profile layer).
 */
@ApiTags('social')
@ApiBearerAuth()
@Controller('social/follow')
export class FollowController {
  constructor(private readonly follow: FollowService) {}

  @Post(':targetUserId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Follow a user' })
  followUser(
    @CurrentUser('id') userId: string,
    @Param('targetUserId', ParseUUIDPipe) targetId: string,
  ) {
    return this.follow.follow(userId, targetId);
  }

  @Delete(':targetUserId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unfollow a user' })
  unfollowUser(
    @CurrentUser('id') userId: string,
    @Param('targetUserId', ParseUUIDPipe) targetId: string,
  ) {
    return this.follow.unfollow(userId, targetId);
  }

  @Get('followers/:userId')
  @ApiOperation({ summary: "List a user's followers" })
  listFollowers(
    @CurrentUser('id') viewerId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() q: PaginationQueryDto,
  ) {
    return this.follow.followers(userId, q.page, q.limit, viewerId);
  }

  @Get('following/:userId')
  @ApiOperation({ summary: 'List who a user follows' })
  listFollowing(
    @CurrentUser('id') viewerId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() q: PaginationQueryDto,
  ) {
    return this.follow.following(userId, q.page, q.limit, viewerId);
  }

  @Get('mutual/:userId')
  @ApiOperation({ summary: 'List mutual connections (accounts we both follow)' })
  listMutual(
    @CurrentUser('id') viewerId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() q: PaginationQueryDto,
  ) {
    return this.follow.mutual(viewerId, userId, q.page, q.limit);
  }
}

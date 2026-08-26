import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CreateCommentDto } from '../dto/create-comment.dto';
import { CreatePostDto } from '../dto/create-post.dto';
import { FeedQueryDto } from '../dto/feed-query.dto';
import { ReportPostDto } from '../dto/report-post.dto';
import { PostCommentService } from '../services/post-comment.service';
import { PostLikeService } from '../services/post-like.service';
import { PostQueryService } from '../services/post-query.service';
import { PostReportService } from '../services/post-report.service';
import { PostService } from '../services/post.service';

@ApiTags('Posts & Feed')
@ApiBearerAuth()
@Controller('posts')
export class PostController {
  constructor(
    private readonly postService: PostService,
    private readonly queryService: PostQueryService,
    private readonly likeService: PostLikeService,
    private readonly commentService: PostCommentService,
    private readonly reportService: PostReportService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a post (photos and/or description)' })
  async create(@Body() dto: CreatePostDto, @CurrentUser('id') userId: string) {
    const post = await this.postService.createPost({ authorId: userId, ...dto });
    return this.queryService.getById(post.id, userId);
  }

  @Get('feed')
  @ApiOperation({ summary: 'Global feed, ranked by engagement score' })
  async feed(@Query() query: FeedQueryDto, @CurrentUser('id') userId: string) {
    return this.queryService.getFeed(userId, query.page, query.limit);
  }

  @Post(':id/like')
  @ApiOperation({ summary: 'Like a post' })
  async like(@Param('id') id: string, @CurrentUser('id') userId: string) {
    await this.likeService.like(id, userId);
    return { liked: true };
  }

  @Delete(':id/like')
  @ApiOperation({ summary: 'Unlike a post' })
  async unlike(@Param('id') id: string, @CurrentUser('id') userId: string) {
    await this.likeService.unlike(id, userId);
    return { liked: false };
  }

  @Get(':id/comments')
  @ApiOperation({ summary: 'List comments on a post' })
  async comments(@Param('id') id: string, @Query() query: FeedQueryDto) {
    return this.commentService.listComments(id, query.page, query.limit);
  }

  @Post(':id/comments')
  @ApiOperation({ summary: 'Comment on a post' })
  async comment(@Param('id') id: string, @Body() dto: CreateCommentDto, @CurrentUser('id') userId: string) {
    return this.commentService.addComment(id, userId, dto.body);
  }

  @Delete(':id/comments/:commentId')
  @ApiOperation({ summary: 'Delete a comment (author or moderator)' })
  async deleteComment(@Param('commentId') commentId: string, @CurrentUser('id') userId: string) {
    await this.commentService.deleteComment(commentId, userId);
    return { deleted: true };
  }

  @Post(':id/report')
  @ApiOperation({ summary: 'Report a post' })
  async report(@Param('id') id: string, @Body() dto: ReportPostDto, @CurrentUser('id') userId: string) {
    return this.reportService.report(id, userId, dto.reason);
  }

  // ─── Wildcard Routes (:id) ──────────────────────────────────────────
  @Get(':id')
  @ApiOperation({ summary: 'Get a post by id' })
  async getById(@Param('id') id: string, @CurrentUser('id') userId: string) {
    const post = await this.queryService.getById(id, userId);
    if (!post) throw new NotFoundException('Post not found');
    return post;
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a post (author or moderator)' })
  async delete(@Param('id') id: string, @CurrentUser('id') userId: string) {
    await this.postService.deletePost(id, userId);
    return { deleted: true };
  }
}

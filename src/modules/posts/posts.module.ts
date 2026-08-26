import { Module } from '@nestjs/common';
import { PostController } from './controllers/post.controller';
import { PostScoreListener } from './listeners/post-score.listener';
import { PostNotificationListener } from './listeners/post-notification.listener';
import { PostScoreScheduler } from './scheduler/post-score.scheduler';
import { PostCommentService } from './services/post-comment.service';
import { PostLikeService } from './services/post-like.service';
import { PostQueryService } from './services/post-query.service';
import { PostReportService } from './services/post-report.service';
import { PostScoreService } from './services/post-score.service';
import { PostService } from './services/post.service';

@Module({
  controllers: [PostController],
  providers: [
    PostService,
    PostQueryService,
    PostLikeService,
    PostCommentService,
    PostReportService,
    PostScoreService,
    PostScoreListener,
    PostNotificationListener,
    PostScoreScheduler,
  ],
})
export class PostsModule {}

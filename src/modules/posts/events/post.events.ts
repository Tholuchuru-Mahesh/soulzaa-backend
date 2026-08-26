import { DomainEvent } from 'src/common/events';

export const POST_EVENTS = {
  CREATED: 'post.created',
  LIKED: 'post.liked',
  UNLIKED: 'post.unliked',
  COMMENTED: 'post.commented',
  COMMENT_DELETED: 'post.comment_deleted',
} as const;

export class PostCreatedEvent extends DomainEvent<{ postId: string; authorId: string }> {
  readonly name = POST_EVENTS.CREATED;
}

export class PostLikedEvent extends DomainEvent<{ postId: string; userId: string }> {
  readonly name = POST_EVENTS.LIKED;
}

export class PostUnlikedEvent extends DomainEvent<{ postId: string; userId: string }> {
  readonly name = POST_EVENTS.UNLIKED;
}

export class PostCommentedEvent extends DomainEvent<{
  postId: string;
  authorId: string;
  commentId: string;
}> {
  readonly name = POST_EVENTS.COMMENTED;
}

export class PostCommentDeletedEvent extends DomainEvent<{ postId: string; commentId: string }> {
  readonly name = POST_EVENTS.COMMENT_DELETED;
}

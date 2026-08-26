import { PostController } from './post.controller';

describe('PostController', () => {
  function build() {
    const postService = { createPost: jest.fn(), deletePost: jest.fn() };
    const queryService = { getFeed: jest.fn(), getById: jest.fn() };
    const likeService = { like: jest.fn(), unlike: jest.fn() };
    const commentService = {
      addComment: jest.fn(),
      listComments: jest.fn(),
      deleteComment: jest.fn(),
    };
    const reportService = { report: jest.fn() };
    const controller = new PostController(
      postService as any,
      queryService as any,
      likeService as any,
      commentService as any,
      reportService as any,
    );
    return { controller, postService, queryService, likeService, commentService, reportService };
  }

  it('create() creates the post then returns the shaped summary', async () => {
    const { controller, postService, queryService } = build();
    postService.createPost.mockResolvedValue({ id: 'p1' });
    queryService.getById.mockResolvedValue({ id: 'p1', description: 'hi' });

    const result = await controller.create({ description: 'hi' } as any, 'u1');

    expect(postService.createPost).toHaveBeenCalledWith({ authorId: 'u1', description: 'hi' });
    expect(queryService.getById).toHaveBeenCalledWith('p1', 'u1');
    expect(result).toEqual({ id: 'p1', description: 'hi' });
  });

  it('feed() passes the viewer id and query through to the query service', async () => {
    const { controller, queryService } = build();
    queryService.getFeed.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 1,
    });

    await controller.feed({ page: 2, limit: 10 } as any, 'u1');

    expect(queryService.getFeed).toHaveBeenCalledWith('u1', 2, 10);
  });

  it('like() delegates to PostLikeService.like', async () => {
    const { controller, likeService } = build();
    await controller.like('p1', 'u1');
    expect(likeService.like).toHaveBeenCalledWith('p1', 'u1');
  });

  it('deleteComment() delegates to PostCommentService.deleteComment', async () => {
    const { controller, commentService } = build();
    await controller.deleteComment('c1', 'u1');
    expect(commentService.deleteComment).toHaveBeenCalledWith('c1', 'u1');
  });
});

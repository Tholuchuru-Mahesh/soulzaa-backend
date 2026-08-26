export interface PostSummaryAuthor {
  id: string;
  username: string;
  fullName: string | null;
  avatarUrl: string | null;
}

export interface PostSummary {
  id: string;
  description: string | null;
  photoUrls: string[];
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  createdAt: Date;
  author: PostSummaryAuthor;
}

export interface PostCommentView {
  id: string;
  postId: string;
  body: string;
  createdAt: Date;
  author: PostSummaryAuthor;
}

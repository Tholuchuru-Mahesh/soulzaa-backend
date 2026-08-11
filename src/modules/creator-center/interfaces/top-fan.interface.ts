/** One ranked fan on the caller's Top Fans board. */
export interface TopFanView {
  rank: number;
  userId: string;
  username: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  level: number;
  vipLevel: number;
  totalCoins: number;
  giftCount: number;
  lastGiftAt: Date | null;
}

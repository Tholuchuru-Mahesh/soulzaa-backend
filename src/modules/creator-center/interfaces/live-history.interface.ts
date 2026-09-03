/** One row in the creator's Live History list/detail. */
export interface LiveHistoryEntryView {
  sessionId: string;
  roomId: string;
  roomName: string | null;
  roomImageUrl: string | null;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number | null;
  status: 'LIVE' | 'ENDED';
  endReason: string;
  /** Total joins / attendees recorded during the session window. */
  visitors: number;
  uniqueVisitors: number;
  peakParticipants: number;
  /** Gift items count received during the broadcast. */
  totalGifts: number;
  /** Total coin value of gifts received. */
  giftValue: number;
  /** Creator's net earnings (diamonds/coins). */
  creatorEarnings: number;
  /** Legacy alias for giftValue string. */
  giftCoins: string;
  newFollowers: number;
  roomType: 'VIDEO' | 'AUDIO';
}

export interface LiveHistoryTopGifterView {
  userId: string;
  username: string;
  name: string;
  avatarUrl: string | null;
  rank: number;
  coins: number;
}

export interface LiveHistoryGiftBreakdownView {
  giftId: string;
  name: string;
  iconUrl: string | null;
  quantity: number;
  coins: number;
}

export interface LiveHistoryDetailView {
  session: {
    sessionId: string;
    roomId: string;
    roomName: string | null;
    roomImageUrl: string | null;
    roomType: 'VIDEO' | 'AUDIO';
    status: 'LIVE' | 'ENDED';
    endReason: string;
    startedAt: Date;
    endedAt: Date | null;
    durationSeconds: number;
  };
  viewerAnalytics: {
    totalUniqueViewers: number;
    peakConcurrentViewers: number;
    avgViewers: number;
    totalVisits: number;
    newFollowers: number;
    totalLikes: number;
  };
  giftAnalytics: {
    totalGifts: number;
    giftValueCoins: number;
    uniqueGifters: number;
    creatorEarnings: number;
    topGifters: LiveHistoryTopGifterView[];
    giftBreakdown: LiveHistoryGiftBreakdownView[];
  };
}

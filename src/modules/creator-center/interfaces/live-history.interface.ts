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
  /** Total joins recorded during the session window. */
  visitors: number;
  uniqueVisitors: number;
  peakParticipants: number;
  /** Gift coins the creator received during the session, as a JSON-safe string. */
  giftCoins: string;
  newFollowers: number;
}

/** Time period filters supported by the Video Room Analytics Engine */
export enum VideoRoomAnalyticsPeriod {
  LAST_HOUR = 'LAST_HOUR',
  TODAY = 'TODAY',
  YESTERDAY = 'YESTERDAY',
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
  CUSTOM = 'CUSTOM',
}

/** Specific metric types aggregated by the Video Room Analytics Engine */
export enum VideoRoomAnalyticsMetricType {
  ROOM_ACTIVITY = 'ROOM_ACTIVITY',
  HOST_PERFORMANCE = 'HOST_PERFORMANCE',
  VIEWER_ENGAGEMENT = 'VIEWER_ENGAGEMENT',
  MEMBER_OCCUPANCY = 'MEMBER_OCCUPANCY',
  CHAT_ACTIVITY = 'CHAT_ACTIVITY',
  GIFT_REVENUE = 'GIFT_REVENUE',
  TREASURE_ACTIVITY = 'TREASURE_ACTIVITY',
  PK_BATTLE = 'PK_BATTLE',
  MODERATION_ACTION = 'MODERATION_ACTION',
  ECONOMY_FLOW = 'ECONOMY_FLOW',
}

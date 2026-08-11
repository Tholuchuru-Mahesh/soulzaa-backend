import type { Paginated } from 'src/common/interfaces/api-response.interface';
import {
  QueryRevenueDto,
  RevenueReportView,
  RoomActivityView,
  RoomAttendanceView,
  RoomEngagementView,
  RoomSpeakingView,
} from '../dto/analytics.dto';

export const ANALYTICS_SERVICE = Symbol('ANALYTICS_SERVICE');

export interface IAnalyticsService {
  /** Get aggregated room-level activity statistics. */
  getRoomActivity(roomId: string): Promise<RoomActivityView>;

  /** Get list of speakers and their accumulated speaking durations. */
  getSpeakingDurations(
    roomId: string,
    skip: number,
    limit: number,
    page: number,
  ): Promise<Paginated<RoomSpeakingView>>;

  /** Get attendance history of the room. */
  getAttendance(
    roomId: string,
    skip: number,
    limit: number,
    page: number,
  ): Promise<Paginated<RoomAttendanceView>>;

  /** Get engagement statistics of the room. */
  getEngagement(roomId: string): Promise<RoomEngagementView>;

  /** Get daily aggregated revenue report matching filters. */
  getRevenue(query: QueryRevenueDto): Promise<RevenueReportView[]>;

  /** Raw visitor rows (userId, joinedAt, leftAt) for a room within a time window —
   *  for callers computing their own derived stats (e.g. per-session unique
   *  visitors / peak concurrency), not a paginated display listing. */
  getVisitorsInRange(roomId: string, start: Date, end: Date): Promise<VisitorWindowEntry[]>;
}

/** A visitor's presence window, for peak-concurrency / uniqueness computation. */
export interface VisitorWindowEntry {
  userId: string;
  joinedAt: Date;
  leftAt: Date | null;
}

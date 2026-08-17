import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { gradeFor, scoreMember, type ScoreInputs } from '../constants/member-score.constants';
import type {
  MemberChartPoint,
  MemberDetailMetric,
  PerformanceRange,
} from '../interfaces/agency-member.interface';
import { AgencyMemberService } from './agency-member.service';
import { AgencyMemberScoreService } from './agency-member-score.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many daily points each range plots. */
const RANGE_DAYS: Record<PerformanceRange, number> = { week: 7, month: 30, quarter: 90 };

/**
 * Each chart point is a rolling window of this many days.
 *
 * Rolling rather than per-day because a one-day score is mostly noise: a member
 * who logs in six days out of seven would plot as a sawtooth between 0 and 100
 * and tell the reader nothing about their trend.
 */
const ROLLING_DAYS = 7;

/** The window the four Details Metrics are measured over, and against. */
const METRIC_WINDOW_DAYS = 30;

/** One day's raw activity, before it is scored. */
interface DayBucket {
  logins: number;
  audio: number;
  video: number;
  giftsSent: number;
  giftsReceived: number;
}

/**
 * The Performance tab: rank, grade, the engagement chart and detail metrics.
 *
 * Its own endpoint rather than part of the Overview payload, because the rank
 * it needs costs an agency-wide computation and the chart costs a 90-day read —
 * neither of which should be paid for by someone who only opened the profile to
 * check an email address.
 */
@Injectable()
export class AgencyMemberPerformanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly members: AgencyMemberService,
    private readonly scores: AgencyMemberScoreService,
  ) {}

  async getPerformance(agencyId: string, userId: string, range: PerformanceRange = 'month') {
    await this.members.assertMember(agencyId, userId);

    const days = RANGE_DAYS[range] ?? RANGE_DAYS.month;
    const now = new Date();
    const todayStart = this.startOfDay(now);
    // Exclusive end-of-today, so the window length is a whole number of days
    // regardless of the hour the request arrives.
    const to = new Date(todayStart.getTime() + DAY_MS);

    // The first point of the range needs the six days before it to fill its
    // rolling window; the metrics need 60 days for their baseline comparison.
    // One read covers whichever reaches further back.
    const chartFrom = new Date(todayStart.getTime() - (days - 1 + ROLLING_DAYS - 1) * DAY_MS);
    const metricsFrom = new Date(to.getTime() - 2 * METRIC_WINDOW_DAYS * DAY_MS);
    const from = chartFrom < metricsFrom ? chartFrom : metricsFrom;

    const [buckets, score] = await Promise.all([
      this.readBuckets(userId, from, to),
      this.scores.rankAgency(agencyId).then((ranked) => ranked.get(userId) ?? null),
    ]);

    const engagementScore = score?.score ?? 0;

    return {
      rank: score
        ? { position: score.rank, totalMembers: score.totalMembers, topPercent: score.topPercent }
        : null,
      grade: score
        ? { code: score.grade.code, label: score.grade.label, caption: score.grade.caption }
        : this.plainGrade(engagementScore),
      engagement: {
        score: engagementScore,
        outOf: 100,
        topPercent: score?.topPercent ?? null,
      },
      chart: { range, points: this.buildSeries(buckets, todayStart, days) },
      metrics: this.buildMetrics(buckets, todayStart, engagementScore),
    };
  }

  /** Five reads, bucketed by calendar day — never one query per point. */
  private async readBuckets(userId: string, from: Date, to: Date): Promise<Map<string, DayBucket>> {
    const window = { gte: from, lt: to };
    const [logins, audioJoins, videoJoins, sent, received] = await Promise.all([
      this.prisma.sessionHistory.findMany({
        where: { userId, event: 'CREATED', createdAt: window },
        select: { createdAt: true },
      }),
      this.prisma.roomMember.findMany({
        where: { userId, joinedAt: window },
        select: { joinedAt: true },
      }),
      this.prisma.videoRoomMember.findMany({
        where: { userId, joinedAt: window },
        select: { joinedAt: true },
      }),
      this.prisma.giftTransaction.findMany({
        where: { senderId: userId, createdAt: window },
        select: { createdAt: true },
      }),
      this.prisma.giftTransaction.findMany({
        where: { receiverId: userId, createdAt: window },
        select: { createdAt: true },
      }),
    ]);

    const buckets = new Map<string, DayBucket>();
    const add = (at: Date, field: keyof DayBucket) => {
      const key = this.dayKey(at);
      const bucket = buckets.get(key) ?? {
        logins: 0,
        audio: 0,
        video: 0,
        giftsSent: 0,
        giftsReceived: 0,
      };
      bucket[field] += 1;
      buckets.set(key, bucket);
    };

    for (const row of logins) add(row.createdAt, 'logins');
    for (const row of audioJoins) add(row.joinedAt, 'audio');
    for (const row of videoJoins) add(row.joinedAt, 'video');
    for (const row of sent) add(row.createdAt, 'giftsSent');
    for (const row of received) add(row.createdAt, 'giftsReceived');

    return buckets;
  }

  /** One rolling-window score per day across the range. */
  private buildSeries(
    buckets: Map<string, DayBucket>,
    todayStart: Date,
    days: number,
  ): MemberChartPoint[] {
    const points: MemberChartPoint[] = [];

    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const day = new Date(todayStart.getTime() - offset * DAY_MS);
      const inputs = this.inputsOver(buckets, day, ROLLING_DAYS);
      points.push({
        date: this.dayKey(day),
        // Caps scale with the 7-day window, so this lands on the same 0-100
        // axis as the 30-day headline score and the two stay comparable.
        value: scoreMember(inputs, ROLLING_DAYS),
      });
    }

    return points;
  }

  /**
   * The four Details Metrics, each a percentage of the 30-day window so they
   * sit on one comparable scale.
   */
  private buildMetrics(
    buckets: Map<string, DayBucket>,
    todayStart: Date,
    engagementScore: number,
  ): MemberDetailMetric[] {
    const previous = new Date(todayStart.getTime() - METRIC_WINDOW_DAYS * DAY_MS);

    const activeDays = (end: Date, field: keyof DayBucket): number => {
      let count = 0;
      for (let offset = 0; offset < METRIC_WINDOW_DAYS; offset += 1) {
        const bucket = buckets.get(this.dayKey(new Date(end.getTime() - offset * DAY_MS)));
        if (bucket && bucket[field] > 0) count += 1;
      }
      return count;
    };

    const asPercent = (dayCount: number): number =>
      Math.round((dayCount / METRIC_WINDOW_DAYS) * 100);

    const metric = (
      key: MemberDetailMetric['key'],
      label: string,
      field: keyof DayBucket,
    ): MemberDetailMetric => {
      const percent = asPercent(activeDays(todayStart, field));
      const baseline = asPercent(activeDays(previous, field));
      return { key, label, percent, changePercent: this.percentChange(baseline, percent) };
    };

    const engagementBaseline = scoreMember(this.inputsOver(buckets, previous, METRIC_WINDOW_DAYS));

    return [
      {
        key: 'ENGAGEMENT_RATE',
        label: 'Engagement rate',
        percent: engagementScore,
        changePercent: this.percentChange(engagementBaseline, engagementScore),
      },
      metric('VIDEO_ROOM', 'Video room participation', 'video'),
      metric('AUDIO_ROOM', 'Audio room participation', 'audio'),
      metric('DAYS_ACTIVE', 'Days active', 'logins'),
    ];
  }

  /** Score inputs for the [windowDays] ending on [end], inclusive. */
  private inputsOver(buckets: Map<string, DayBucket>, end: Date, windowDays: number): ScoreInputs {
    const inputs: ScoreInputs = {
      loginDays: 0,
      roomsJoined: 0,
      giftsSent: 0,
      giftsReceived: 0,
    };

    for (let offset = 0; offset < windowDays; offset += 1) {
      const bucket = buckets.get(this.dayKey(new Date(end.getTime() - offset * DAY_MS)));
      if (!bucket) continue;
      // Login *days*, not logins: three sign-ins before lunch is one day.
      if (bucket.logins > 0) inputs.loginDays += 1;
      inputs.roomsJoined += bucket.audio + bucket.video;
      inputs.giftsSent += bucket.giftsSent;
      inputs.giftsReceived += bucket.giftsReceived;
    }

    return inputs;
  }

  private plainGrade(score: number) {
    const band = gradeFor(score);
    return { code: band.code, label: band.label, caption: band.caption };
  }

  private percentChange(before: number, after: number): number | null {
    if (before === 0) return null;
    return Math.round(((after - before) / before) * 1000) / 10;
  }

  private startOfDay(at: Date): Date {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  }

  private dayKey(at: Date): string {
    return at.toISOString().slice(0, 10);
  }
}

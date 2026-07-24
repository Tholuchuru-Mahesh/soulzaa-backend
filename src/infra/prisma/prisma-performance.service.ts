import { Injectable, Logger } from '@nestjs/common';

export interface SlowQueryRecord {
  query: string;
  durationMs: number;
  timestamp: string;
  suggestion?: string;
}

@Injectable()
export class PrismaPerformanceService {
  private readonly logger = new Logger(PrismaPerformanceService.name);
  private readonly slowQueries: SlowQueryRecord[] = [];
  private totalQueriesExecuted = 0;
  private totalQueryTimeMs = 0;

  recordQuery(query: string, durationMs: number): void {
    this.totalQueriesExecuted++;
    this.totalQueryTimeMs += durationMs;

    if (durationMs > 100) {
      // Slow query threshold > 100ms
      const suggestion = this.analyzeQuery(query);
      const record: SlowQueryRecord = {
        query,
        durationMs,
        timestamp: new Date().toISOString(),
        suggestion,
      };

      this.slowQueries.unshift(record);
      if (this.slowQueries.length > 50) {
        this.slowQueries.pop();
      }
      this.logger.warn(`Slow Query Detected (${durationMs}ms): ${query}`);
    }
  }

  getSlowQueries(): SlowQueryRecord[] {
    return this.slowQueries;
  }

  getDatabaseStatistics() {
    const avgLatency =
      this.totalQueriesExecuted > 0
        ? Number((this.totalQueryTimeMs / this.totalQueriesExecuted).toFixed(2))
        : 0;

    return {
      totalQueriesExecuted: this.totalQueriesExecuted,
      totalQueryTimeMs: this.totalQueryTimeMs,
      averageQueryLatencyMs: avgLatency,
      slowQueriesCount: this.slowQueries.length,
    };
  }

  getPerformanceReport() {
    return {
      statistics: this.getDatabaseStatistics(),
      slowQueries: this.slowQueries.slice(0, 10),
      indexCandidates: [
        'video_rooms (status, created_at)',
        'audio_rooms (status, owner_id)',
        'wallet_transactions (user_id, status)',
      ],
      generatedAt: new Date().toISOString(),
    };
  }

  private analyzeQuery(query: string): string {
    const lower = query.toLowerCase();
    if (lower.includes('where') && !lower.includes('index')) {
      return 'Consider adding a composite index for filtered columns';
    }
    if (lower.includes('join')) {
      return 'Check JOIN key indexing and reduce fetched column list';
    }
    return 'Optimize query filter predicates and result pagination';
  }
}

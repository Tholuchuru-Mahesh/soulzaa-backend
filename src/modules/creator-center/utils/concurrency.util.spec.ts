import { peakConcurrent } from './concurrency.util';

const t = (iso: string) => new Date(iso);

describe('peakConcurrent', () => {
  it('returns 0 for no visitors', () => {
    expect(peakConcurrent([], t('2026-01-01T00:00:00Z'), t('2026-01-01T01:00:00Z'))).toBe(0);
  });

  it('counts non-overlapping visits as peak 1', () => {
    const intervals = [
      { joinedAt: t('2026-01-01T00:00:00Z'), leftAt: t('2026-01-01T00:10:00Z') },
      { joinedAt: t('2026-01-01T00:20:00Z'), leftAt: t('2026-01-01T00:30:00Z') },
    ];
    expect(peakConcurrent(intervals, t('2026-01-01T00:00:00Z'), t('2026-01-01T01:00:00Z'))).toBe(1);
  });

  it('counts fully overlapping visits as their concurrent count', () => {
    const intervals = [
      { joinedAt: t('2026-01-01T00:00:00Z'), leftAt: t('2026-01-01T00:30:00Z') },
      { joinedAt: t('2026-01-01T00:05:00Z'), leftAt: t('2026-01-01T00:20:00Z') },
      { joinedAt: t('2026-01-01T00:10:00Z'), leftAt: t('2026-01-01T00:15:00Z') },
    ];
    expect(peakConcurrent(intervals, t('2026-01-01T00:00:00Z'), t('2026-01-01T01:00:00Z'))).toBe(3);
  });

  it('clamps a still-present visitor (leftAt null) to the window end', () => {
    const intervals = [{ joinedAt: t('2026-01-01T00:00:00Z'), leftAt: null }];
    const peak = peakConcurrent(intervals, t('2026-01-01T00:00:00Z'), t('2026-01-01T01:00:00Z'));
    expect(peak).toBe(1);
  });

  it('clamps a visit that started before the window to the window start', () => {
    const intervals = [{ joinedAt: t('2025-12-31T23:00:00Z'), leftAt: t('2026-01-01T00:30:00Z') }];
    const peak = peakConcurrent(intervals, t('2026-01-01T00:00:00Z'), t('2026-01-01T01:00:00Z'));
    expect(peak).toBe(1);
  });

  it('does not double-count a same-instant leave/join handoff', () => {
    const intervals = [
      { joinedAt: t('2026-01-01T00:00:00Z'), leftAt: t('2026-01-01T00:10:00Z') },
      { joinedAt: t('2026-01-01T00:10:00Z'), leftAt: t('2026-01-01T00:20:00Z') },
    ];
    expect(peakConcurrent(intervals, t('2026-01-01T00:00:00Z'), t('2026-01-01T01:00:00Z'))).toBe(1);
  });
});

/**
 * Static reason → severity/rule-code reference tables for the Moderator
 * Portal Reports pages. These replace `mobile-workforce.service.ts`'s old
 * room-type-based fabrication (video always "Highest", audio always
 * "Medium", rule code always ".1"/".4" regardless of reason). The Highest
 * tier is anchored on `HIGH_PRIORITY_REPORT_REASONS` (THREATS, SEXUAL_CONTENT),
 * the one real severity signal duplicated across the audio/video/live-stream
 * report services today — extended with ADULT_CONTENT, the same category
 * under RoomReport's reason enum. `deriveRuleViolated`'s codes are a
 * codebase-defined reference catalog, not an externally sourced compliance
 * document — same reason always maps to the same code, but don't treat the
 * numbers as legally meaningful.
 */

const HIGHEST_PRIORITY_REASONS = new Set(['THREATS', 'SEXUAL_CONTENT', 'ADULT_CONTENT']);

const LOW_PRIORITY_REASONS = new Set(['SPAM', 'FRAUD', 'COPYRIGHT', 'OTHER']);

export function deriveReportPriority(
  reason: string,
): 'Highest priority' | 'Medium priority' | 'Low priority' {
  if (HIGHEST_PRIORITY_REASONS.has(reason)) return 'Highest priority';
  if (LOW_PRIORITY_REASONS.has(reason)) return 'Low priority';
  return 'Medium priority';
}

const RULE_CATALOG: Record<string, string> = {
  SEXUAL_CONTENT: 'Sexual content & nudity (3.1)',
  ADULT_CONTENT: 'Sexual content & nudity (3.1)',
  INAPPROPRIATE_CONTENT: 'Inappropriate content (3.2)',
  HATE_SPEECH: 'Hate speech & discrimination (2.1)',
  HARASSMENT: 'Harassment & bullying (2.2)',
  BULLYING: 'Harassment & bullying (2.2)',
  THREATS: 'Threats & violence (2.3)',
  ABUSE: 'Platform abuse (4.1)',
  SPAM: 'Spam & fraudulent activity (4.2)',
  FRAUD: 'Spam & fraudulent activity (4.2)',
  FAKE_PROFILE: 'Fake profile & impersonation (1.1)',
  FAKE_ACCOUNT: 'Fake profile & impersonation (1.1)',
  COPYRIGHT: 'Copyright infringement (5.1)',
  LIVE_STREAM_VIOLATION: 'Live stream policy violation (6.1)',
  COMMUNITY_GUIDELINE_VIOLATION: 'Community guideline violation (6.2)',
  USER: 'Community guideline violation (6.2)',
  MESSAGE: 'Community guideline violation (6.2)',
};

const DEFAULT_RULE = 'Other community guideline violation (7.1)';

export function deriveRuleViolated(reason: string): string {
  return RULE_CATALOG[reason] ?? DEFAULT_RULE;
}

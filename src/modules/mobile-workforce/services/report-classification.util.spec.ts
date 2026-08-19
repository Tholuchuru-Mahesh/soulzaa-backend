import { deriveReportPriority, deriveRuleViolated } from './report-classification.util';

describe('deriveReportPriority', () => {
  it.each(['THREATS', 'SEXUAL_CONTENT', 'ADULT_CONTENT'])('%s is Highest priority', (reason) => {
    expect(deriveReportPriority(reason)).toBe('Highest priority');
  });

  it.each([
    'HARASSMENT',
    'HATE_SPEECH',
    'BULLYING',
    'ABUSE',
    'FAKE_PROFILE',
    'FAKE_ACCOUNT',
    'INAPPROPRIATE_CONTENT',
    'LIVE_STREAM_VIOLATION',
    'COMMUNITY_GUIDELINE_VIOLATION',
    'USER',
    'MESSAGE',
  ])('%s is Medium priority', (reason) => {
    expect(deriveReportPriority(reason)).toBe('Medium priority');
  });

  it.each(['SPAM', 'FRAUD', 'COPYRIGHT', 'OTHER'])('%s is Low priority', (reason) => {
    expect(deriveReportPriority(reason)).toBe('Low priority');
  });

  it('defaults an unmapped reason to Medium priority, never Low', () => {
    expect(deriveReportPriority('SOME_FUTURE_ENUM_VALUE')).toBe('Medium priority');
  });
});

describe('deriveRuleViolated', () => {
  it('maps SEXUAL_CONTENT and ADULT_CONTENT to the same rule code', () => {
    expect(deriveRuleViolated('SEXUAL_CONTENT')).toBe('Sexual content & nudity (3.1)');
    expect(deriveRuleViolated('ADULT_CONTENT')).toBe('Sexual content & nudity (3.1)');
  });

  it('maps HATE_SPEECH, THREATS, and HARASSMENT/BULLYING to distinct codes', () => {
    expect(deriveRuleViolated('HATE_SPEECH')).toBe('Hate speech & discrimination (2.1)');
    expect(deriveRuleViolated('THREATS')).toBe('Threats & violence (2.3)');
    expect(deriveRuleViolated('HARASSMENT')).toBe('Harassment & bullying (2.2)');
    expect(deriveRuleViolated('BULLYING')).toBe('Harassment & bullying (2.2)');
  });

  it('falls back to a generic code for OTHER or an unmapped reason', () => {
    expect(deriveRuleViolated('OTHER')).toBe('Other community guideline violation (7.1)');
    expect(deriveRuleViolated('SOME_FUTURE_ENUM_VALUE')).toBe(
      'Other community guideline violation (7.1)',
    );
  });
});

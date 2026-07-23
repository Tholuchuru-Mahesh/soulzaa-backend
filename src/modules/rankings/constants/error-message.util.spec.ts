import { errorMessage } from './error-message.util';

describe('errorMessage', () => {
  it('returns the message of a real Error', () => {
    expect(errorMessage(new Error('CONNRESET'))).toBe('CONNRESET');
  });

  it('string-coerces a non-Error rejection rather than throwing', () => {
    expect(errorMessage('plain string reason')).toBe('plain string reason');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage({ code: 'ECONNRESET' })).toBe('[object Object]');
  });

  it('never throws for undefined or null — the exact shape of a bare `Promise.reject()` / `throw undefined`', () => {
    expect(() => errorMessage(undefined)).not.toThrow();
    expect(() => errorMessage(null)).not.toThrow();
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage(null)).toBe('null');
  });
});

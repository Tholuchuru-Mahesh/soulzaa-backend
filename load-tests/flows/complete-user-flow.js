import { group, check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { login } from '../utils/auth.js';
import { authenticatedRequest } from '../utils/http.js';
import { config } from '../config/environments.js';

/**
 * One token per VU.
 *
 * The rate limiter buckets per authenticated user (CustomThrottlerGuard.getTracker
 * returns `user:<id>`), so sharing a single token across VUs funnels every request
 * into one 100/60s bucket and the test ends up measuring the throttler instead of
 * the API. Seed real accounts first:
 *
 *   node scripts/seed-users.js 10 http://localhost:3000/api
 *
 * Falls back to a single shared token (TEST_TOKEN, or one login) when .tokens.json
 * is absent — fine for a 1-2 VU sanity check, misleading above that.
 */
const tokens = new SharedArray('tokens', function () {
  try {
    return JSON.parse(open('../.tokens.json')).tokens;
  } catch (e) {
    return [];
  }
});

export function setup() {
  if (tokens.length > 0) {
    return { pooled: true, count: tokens.length };
  }
  const token = login(0);
  if (!token) {
    throw new Error(
      'No .tokens.json and login failed — run: node scripts/seed-users.js 10 <baseUrl>',
    );
  }
  return { pooled: false, fallbackToken: token };
}

export default function (data) {
  // __VU is 1-based; wrap so VU count and token count need not match exactly.
  const token = data.pooled ? tokens[(__VU - 1) % tokens.length] : data.fallbackToken;
  const BASE_URL = config.BASE_URL;

  group('Complete User Flow: Profile -> Feed -> Claims', function () {
    group('Get Profile', function () {
      const res = authenticatedRequest('GET', `${BASE_URL}/users/me`, null, token);
      check(res, { 'profile retrieved': (r) => r.status === 200 });
      sleep(1);
    });

    group('View Dashboard', function () {
      const res = authenticatedRequest('GET', `${BASE_URL}/events?limit=10&page=1`, null, token);
      check(res, { 'dashboard loaded': (r) => r.status === 200 });
      sleep(2); // Simulated read time
    });

    group('View Event Claims', function () {
      const res = authenticatedRequest('GET', `${BASE_URL}/events/claims`, null, token);
      check(res, { 'claims loaded': (r) => r.status === 200 });
      sleep(1);
    });
  });
}

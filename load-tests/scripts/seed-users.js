#!/usr/bin/env node
/**
 * Seeds load-test accounts and writes their access tokens to .tokens.json.
 *
 *   node scripts/seed-users.js [count] [baseUrl]
 *   node scripts/seed-users.js 10 http://localhost:3000/api
 *
 * Why this lives outside k6: /auth/* is throttled far tighter than the rest of
 * the API (10 req/60s per IP, see CustomThrottlerGuard). Logging in N users from
 * inside setup() would trip that limit before the test even starts, so we mint
 * the tokens here — paced to stay under it — and let k6 read them from disk.
 *
 * Note: access tokens are short-lived (~15 min). Re-run this immediately before
 * any scenario longer than that, or the later stages will 401.
 */
const fs = require('fs');
const path = require('path');

const COUNT = Number(process.argv[2] || 10);
const BASE_URL = process.argv[3] || 'http://localhost:3000/api';
const PASSWORD = process.env.LOADTEST_PASSWORD || 'L0adTest@2026';
const OUT = path.join(__dirname, '..', '.tokens.json');

// /auth/* allows 10 per 60s per IP; 6.5s spacing keeps us just under it.
const AUTH_SPACING_MS = 6500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, json };
}

/** Register the user, falling back to login when the account already exists. */
async function mintToken(email) {
  let res = await post(`${BASE_URL}/auth/register`, { email, password: PASSWORD });

  if (res.status === 429) {
    console.warn(`  rate limited on register, backing off 60s...`);
    await sleep(60_000);
    res = await post(`${BASE_URL}/auth/register`, { email, password: PASSWORD });
  }

  // Already registered on a previous run — log in instead.
  if (res.status === 409 || res.status === 400 || res.status === 422) {
    await sleep(AUTH_SPACING_MS);
    res = await post(`${BASE_URL}/auth/login`, { email, password: PASSWORD });
  }

  const token = res.json?.data?.tokens?.accessToken;
  if (!token) {
    throw new Error(
      `could not mint a token for ${email} (HTTP ${res.status}): ${JSON.stringify(res.json)}`,
    );
  }
  return token;
}

(async () => {
  console.log(`Seeding ${COUNT} load-test users against ${BASE_URL}`);
  console.log(`Pacing ${AUTH_SPACING_MS}ms between auth calls to respect the throttler.\n`);

  const tokens = [];
  for (let i = 1; i <= COUNT; i++) {
    const email = `loadtest_${String(i).padStart(3, '0')}@example.com`;
    process.stdout.write(`[${i}/${COUNT}] ${email} ... `);
    tokens.push(await mintToken(email));
    console.log('ok');
    if (i < COUNT) await sleep(AUTH_SPACING_MS);
  }

  fs.writeFileSync(OUT, JSON.stringify({ mintedAt: new Date().toISOString(), tokens }, null, 2));
  console.log(`\n✅ Wrote ${tokens.length} tokens to ${OUT}`);
})().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});

import userFlow, { setup as flowSetup } from '../flows/complete-user-flow.js';
import { sleep } from 'k6';

export const options = {
  vus: 100,
  duration: '1m',
  thresholds: {
    http_req_failed: ['rate<0.01'], // http errors should be less than 1%
    http_req_duration: ['p(95)<1000', 'p(99)<2000'], // 95% of requests should be below 1s
    // Guards against a false pass: with zero traffic the percentiles above are
    // computed over an empty sample set, so they report 0 and "succeed".
    http_reqs: ['count>100'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  return flowSetup();
}

export default function(data) {
  // Execute the realistic user flow
  userFlow(data);
  sleep(1);
}

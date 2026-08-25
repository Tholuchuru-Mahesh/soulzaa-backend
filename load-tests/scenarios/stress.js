import userFlow, { setup as flowSetup } from '../flows/complete-user-flow.js';
import { sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 100 },
    { duration: '5m', target: 100 },
    { duration: '2m', target: 250 },
    { duration: '5m', target: 250 },
    { duration: '2m', target: 500 },
    { duration: '5m', target: 500 },
    { duration: '2m', target: 1000 },
    { duration: '5m', target: 1000 },
    { duration: '5m', target: 1500 }, // Push to breaking point
    { duration: '5m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.1'], // Expect some failures during stress
  },
};

export function setup() {
  return flowSetup();
}

export default function(data) {
  userFlow(data);
  sleep(1);
}

import userFlow, { setup as flowSetup } from '../flows/complete-user-flow.js';
import { sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 50 },  // Baseline
    { duration: '2m', target: 50 },  // Normal usage
    { duration: '10s', target: 500 }, // SPIKE! 
    { duration: '3m', target: 500 }, // Sustain spike
    { duration: '10s', target: 50 }, // Rapid recovery
    { duration: '3m', target: 50 },  // Normal usage
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'], 
  },
};

export function setup() {
  return flowSetup();
}

export default function(data) {
  userFlow(data);
  sleep(1);
}

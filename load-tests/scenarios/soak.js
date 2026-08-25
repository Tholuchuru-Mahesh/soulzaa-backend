import userFlow, { setup as flowSetup } from '../flows/complete-user-flow.js';
import { sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 100 }, // Ramp up
    { duration: '60m', target: 100 },// Soak for 1 hour to find memory leaks
    { duration: '2m', target: 0 },   // Ramp down
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'], 
    http_req_duration: ['p(99)<2000'],
  },
};

export function setup() {
  return flowSetup();
}

export default function(data) {
  userFlow(data);
  sleep(1);
}

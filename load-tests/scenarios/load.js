import userFlow, { setup as flowSetup } from '../flows/complete-user-flow.js';
import { sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 50 },  // Ramp-up to 50 users over 2 minutes
    { duration: '5m', target: 50 },  // Stay at 50 users for 5 minutes
    { duration: '2m', target: 100 }, // Ramp-up to 100 users
    { duration: '5m', target: 100 }, // Stay at 100 users
    { duration: '5m', target: 250 }, // Ramp-up to 250 users
    { duration: '10m', target: 250 },// Stay at 250
    { duration: '5m', target: 500 }, // Ramp-up to 500 users
    { duration: '10m', target: 500 },// Stay at 500
    { duration: '5m', target: 0 },   // Ramp-down to 0
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'], 
    http_req_duration: ['p(95)<2000', 'p(99)<5000'], // More lenient under heavy load
  },
};

export function setup() {
  return flowSetup();
}

export default function(data) {
  userFlow(data);
  sleep(1);
}

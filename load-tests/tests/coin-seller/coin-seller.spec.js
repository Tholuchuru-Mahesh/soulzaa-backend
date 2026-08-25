import { check, group } from 'k6';
import { authenticatedRequest } from '../../utils/http.js';
import { login } from '../../utils/auth.js';
import { config } from '../../config/environments.js';

export function setup() {
  const token = login();
  return { token };
}

export default function(data) {
  const token = data.token;
  const BASE_URL = config.BASE_URL;

  group('GET /coin-seller/official/list', function() {
    const url = `${BASE_URL}/coin-seller/official/list`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /coin-seller/official/:sellerId/inventory', function() {
    const url = `${BASE_URL}/coin-seller/official/12345/inventory`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /coin-seller/settlement/summary', function() {
    const url = `${BASE_URL}/coin-seller/settlement/summary`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /coin-seller/settlement/history', function() {
    const url = `${BASE_URL}/coin-seller/settlement/history`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /coin-seller/settlement/seller/:sellerId', function() {
    const url = `${BASE_URL}/coin-seller/settlement/seller/12345`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /coin-seller/settlement/statistics/:sellerId', function() {
    const url = `${BASE_URL}/coin-seller/settlement/statistics/12345`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /coin-seller/settlement/audit', function() {
    const url = `${BASE_URL}/coin-seller/settlement/audit`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /coin-seller/settlement/configuration', function() {
    const url = `${BASE_URL}/coin-seller/settlement/configuration`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('PUT /coin-seller/settlement/configuration', function() {
    const url = `${BASE_URL}/coin-seller/settlement/configuration`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('PUT')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('PUT', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /coin-seller/settlement/reports', function() {
    const url = `${BASE_URL}/coin-seller/settlement/reports`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('POST /coin-seller/settlement/relationship/assign', function() {
    const url = `${BASE_URL}/coin-seller/settlement/relationship/assign`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('POST')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('POST', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('POST /coin-seller/webhooks/razorpay', function() {
    const url = `${BASE_URL}/coin-seller/webhooks/razorpay`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('POST')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('POST', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

}

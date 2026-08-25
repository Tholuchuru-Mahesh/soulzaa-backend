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

  group('POST /gifts/send', function() {
    const url = `${BASE_URL}/gifts/send`;
    
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

  group('GET /gifts/catalog', function() {
    const url = `${BASE_URL}/gifts/catalog`;
    
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

  group('GET /gifts/history', function() {
    const url = `${BASE_URL}/gifts/history`;
    
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

  group('GET /gifts/leaderboard', function() {
    const url = `${BASE_URL}/gifts/leaderboard`;
    
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

  group('GET /gifts/catalog', function() {
    const url = `${BASE_URL}/gifts/catalog`;
    
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

  group('GET /gifts/categories', function() {
    const url = `${BASE_URL}/gifts/categories`;
    
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

  group('GET /gifts/search', function() {
    const url = `${BASE_URL}/gifts/search`;
    
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

  group('GET /gifts/popular', function() {
    const url = `${BASE_URL}/gifts/popular`;
    
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

  group('GET /gifts/my-history', function() {
    const url = `${BASE_URL}/gifts/my-history`;
    
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

  group('GET /gifts/inventory', function() {
    const url = `${BASE_URL}/gifts/inventory`;
    
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

  group('GET /gifts/catalog/:id', function() {
    const url = `${BASE_URL}/gifts/catalog/12345`;
    
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

  group('GET /gifts', function() {
    const url = `${BASE_URL}/gifts`;
    
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

}

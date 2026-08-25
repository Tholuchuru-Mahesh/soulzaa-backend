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

  group('GET /cosmetics/store', function() {
    const url = `${BASE_URL}/cosmetics/store`;
    
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

  group('GET /cosmetics/store/purchases', function() {
    const url = `${BASE_URL}/cosmetics/store/purchases`;
    
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

  group('POST /cosmetics/store/:cosmeticId/purchase', function() {
    const url = `${BASE_URL}/cosmetics/store/12345/purchase`;
    
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

  group('GET /cosmetics', function() {
    const url = `${BASE_URL}/cosmetics`;
    
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

  group('GET /cosmetics/my', function() {
    const url = `${BASE_URL}/cosmetics/my`;
    
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

  group('POST /cosmetics/equip/:cosmeticId', function() {
    const url = `${BASE_URL}/cosmetics/equip/12345`;
    
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

  group('POST /cosmetics/unequip/:cosmeticId', function() {
    const url = `${BASE_URL}/cosmetics/unequip/12345`;
    
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

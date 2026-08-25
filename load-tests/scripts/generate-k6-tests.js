const fs = require('fs');
const path = require('path');

const routesPath = path.join(__dirname, '../../scratch/routes.txt');
const testsDir = path.join(__dirname, '../tests');

if (!fs.existsSync(routesPath)) {
  console.error(`Routes file not found at ${routesPath}. Please run the extractor script first.`);
  process.exit(1);
}

const routesContent = fs.readFileSync(routesPath, 'utf8');
const routes = routesContent.split('\n').filter(r => r.trim() !== '');

// Group by top-level module (e.g. /users, /events, etc.)
const modules = {};

routes.forEach(routeLine => {
  const parts = routeLine.split(/\s+/);
  if (parts.length < 2) return;
  const method = parts[0];
  const endpoint = parts[1];
  
  // Extract module name from endpoint
  const segments = endpoint.split('/').filter(s => s.length > 0);
  let mod = segments.length > 0 ? segments[0] : 'root';
  
  if (!modules[mod]) modules[mod] = [];
  modules[mod].push({ method, endpoint });
});

// Ensure tests directory exists
if (!fs.existsSync(testsDir)) {
  fs.mkdirSync(testsDir, { recursive: true });
}

// Generate k6 test scripts for each module
Object.keys(modules).forEach(mod => {
  const modDir = path.join(testsDir, mod);
  if (!fs.existsSync(modDir)) {
    fs.mkdirSync(modDir, { recursive: true });
  }

  const endpoints = modules[mod];
  
  let scriptContent = `import { check, group } from 'k6';
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

`;

  endpoints.forEach(({ method, endpoint }) => {
    // Basic conversion of express params (:id) to template literals
    // e.g. /users/:id -> /users/\${id}
    const pathTemplate = endpoint.replace(/:([a-zA-Z0-9_]+)/g, '12345'); 
    
    scriptContent += `  group('${method} ${endpoint}', function() {
    const url = \`\${BASE_URL}${pathTemplate}\`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('${method}')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('${method}', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

`;
  });

  scriptContent += `}\n`;
  
  fs.writeFileSync(path.join(modDir, `${mod}.spec.js`), scriptContent);
});

console.log(`Successfully generated tests for ${Object.keys(modules).length} modules covering ${routes.length} endpoints.`);

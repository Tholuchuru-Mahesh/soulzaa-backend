const http = require('http');

function postLogin() {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ identity: 'e2e_official', password: 'Password123!' });
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3000,
      path: '/api/auth/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getTickets(token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3000,
      path: '/api/support-tickets',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function test() {
  try {
    const login = await postLogin();
    console.log('LOGIN SUCCESS:', login.success, 'TOKEN OBTAINED:', !!login.data?.accessToken);
    const token = login.data?.accessToken;
    if (token) {
      const tickets = await getTickets(token);
      console.log('GET TICKETS STATUS:', tickets.status);
      console.log('TICKETS COUNT:', tickets.data?.data?.items?.length ?? tickets.data?.data?.length);
    }
  } catch (err) {
    console.error('TEST ERROR:', err);
  }
}

test();

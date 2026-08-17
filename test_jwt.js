const { PrismaClient } = require('@prisma/client');
const http = require('http');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();

async function test() {
  const official = await prisma.user.findFirst({ where: { username: 'e2e_official' } });
  const secret = process.env.JWT_SECRET || 'dev_secret_key_change_in_prod';
  const token = jwt.sign(
    { sub: official.id, username: official.username, roles: official.roles },
    secret,
    { expiresIn: '1h' }
  );

  console.log('GENERATED TOKEN FOR OFFICIAL:', official.username);

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
    res.on('end', () => {
      console.log('HTTP STATUS:', res.statusCode);
      const parsed = JSON.parse(body);
      console.log('RESPONSE SUCCESS:', parsed.success);
      console.log('ITEMS COUNT:', parsed.data?.items?.length ?? parsed.data?.length);
      console.log('SAMPLE ITEM:', parsed.data?.items?.[0] ?? parsed.data?.[0]);
    });
  });

  req.on('error', err => console.error('HTTP ERR:', err));
  req.end();
}

test().finally(() => prisma.$disconnect());

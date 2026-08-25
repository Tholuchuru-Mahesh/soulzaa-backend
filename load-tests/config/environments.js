export const environments = {
  development: {
    BASE_URL: __ENV.BASE_URL || 'http://localhost:3000/api',
  },
  staging: {
    BASE_URL: __ENV.BASE_URL || 'http://13.48.251.144/api',
  },
  production: {
    BASE_URL: __ENV.BASE_URL || 'https://api.soulzaa.com/api',
  },
};

const currentEnv = __ENV.APP_ENV || 'development';

export const config = environments[currentEnv];

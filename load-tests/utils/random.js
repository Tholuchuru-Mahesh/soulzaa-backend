export function randomIntBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

export function randomItem(array) {
  return array[randomIntBetween(0, array.length - 1)];
}

export function randomString(length) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let res = '';
  for (let i = 0, n = charset.length; i < length; ++i) {
    res += charset.charAt(Math.floor(Math.random() * n));
  }
  return res;
}

export function randomEmail() {
  return `loadtest_${randomString(8)}@example.com`;
}

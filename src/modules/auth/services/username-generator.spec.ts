import { generateUsernameFromEmail } from './username-generator';

/**
 * Registering with only an email still has to produce a `username`, which is
 * `@unique` on the users table and constrained to 4–20 characters of letters,
 * digits and underscores. Anything this returns goes straight into that column,
 * so it must satisfy the constraint on every path — including the ugly ones.
 */
describe('generateUsernameFromEmail', () => {
  const free = () => Promise.resolve(false);
  const taken = (names: string[]) => (u: string) => Promise.resolve(names.includes(u));

  const VALID = /^[a-z0-9_]{4,20}$/;

  it('uses the local part of the address', async () => {
    await expect(generateUsernameFromEmail('vasu@soulzaa.com', free)).resolves.toBe('vasu');
  });

  it('lowercases it', async () => {
    await expect(generateUsernameFromEmail('Vasu.Reddy@soulzaa.com', free)).resolves.toBe(
      'vasu_reddy',
    );
  });

  it('replaces characters the column will not accept', async () => {
    const name = await generateUsernameFromEmail('a.b-c+tag@soulzaa.com', free);
    expect(name).toMatch(VALID);
    expect(name).toBe('a_b_c_tag');
  });

  it('pads a local part shorter than the 4-character minimum', async () => {
    const name = await generateUsernameFromEmail('jo@soulzaa.com', free);
    expect(name).toMatch(VALID);
    expect(name.startsWith('jo')).toBe(true);
  });

  it('truncates a local part longer than 20 characters', async () => {
    const name = await generateUsernameFromEmail(
      'averyveryverylongaddressindeed@soulzaa.com',
      free,
    );
    expect(name).toMatch(VALID);
    expect(name.length).toBeLessThanOrEqual(20);
  });

  it('suffixes when the obvious name is already taken', async () => {
    await expect(generateUsernameFromEmail('vasu@soulzaa.com', taken(['vasu']))).resolves.toBe(
      'vasu1',
    );
  });

  it('keeps counting past several collisions', async () => {
    await expect(
      generateUsernameFromEmail('vasu@soulzaa.com', taken(['vasu', 'vasu1', 'vasu2'])),
    ).resolves.toBe('vasu3');
  });

  it('stays within 20 characters even while suffixing', async () => {
    const base = 'abcdefghijklmnopqrst'; // exactly 20
    const name = await generateUsernameFromEmail(
      `${base}@soulzaa.com`,
      taken([base, `${base.slice(0, 19)}1`]),
    );
    expect(name).toMatch(VALID);
    expect(name.length).toBeLessThanOrEqual(20);
  });

  it('still returns something valid for an address with no usable characters', async () => {
    const name = await generateUsernameFromEmail('!!!@soulzaa.com', free);
    expect(name).toMatch(VALID);
  });

  it('gives up on sequential suffixes rather than looping forever', async () => {
    // Every candidate taken — it must still resolve, not hang.
    const name = await generateUsernameFromEmail('vasu@soulzaa.com', () => Promise.resolve(true));
    expect(name).toMatch(VALID);
  });
});

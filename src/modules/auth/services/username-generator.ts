import { randomBytes } from 'node:crypto';

/** The users table's constraint: 4–20 of letters, digits and underscores. */
const MIN_LENGTH = 4;
const MAX_LENGTH = 20;

/** How many `name1`, `name2`… candidates to try before falling back to random. */
const SEQUENTIAL_ATTEMPTS = 25;

/**
 * Derives a unique username from an email address.
 *
 * Sign-up asks only for an email and a password, but `users.username` is
 * NOT NULL and `@unique`, so one has to be minted here. Every value this
 * returns satisfies the column's constraint — including for addresses whose
 * local part is too short, too long, or made entirely of punctuation.
 *
 * `isTaken` is injected so the caller owns the lookup (and so this stays
 * testable without a database).
 */
export async function generateUsernameFromEmail(
  email: string,
  isTaken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const base = normalise(email);

  if (!(await isTaken(base))) return base;

  for (let n = 1; n <= SEQUENTIAL_ATTEMPTS; n++) {
    const suffix = String(n);
    // Trim the stem, not the suffix — otherwise a 20-character local part could
    // never produce a distinct candidate.
    const stem = base.slice(0, MAX_LENGTH - suffix.length);
    const candidate = `${stem}${suffix}`;
    if (!(await isTaken(candidate))) return candidate;
  }

  // Everything obvious is taken. A random tail is not pretty, but registration
  // succeeding matters more than the name, and the user can change it later.
  const tail = randomBytes(4).toString('hex').slice(0, 6);
  return `${base.slice(0, MAX_LENGTH - tail.length)}${tail}`;
}

/** Local part → a value the column accepts, before any uniqueness check. */
function normalise(email: string): string {
  const local = email.split('@')[0] ?? '';
  let cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (cleaned.length === 0) cleaned = 'user';

  cleaned = cleaned.slice(0, MAX_LENGTH);

  if (cleaned.length < MIN_LENGTH) {
    // Pad deterministically rather than with randomness: the caller only falls
    // back to random once a real collision proves it necessary.
    cleaned = `${cleaned}${'0'.repeat(MIN_LENGTH - cleaned.length)}`;
  }
  return cleaned;
}

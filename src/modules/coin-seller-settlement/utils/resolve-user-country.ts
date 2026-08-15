import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * The country a user sells or buys coins in, as a country **code**.
 *
 * Both sides of the cross-border check go through this, so they are always
 * compared on the same basis. Comparing raw `users.country` strings meant
 * "India" and "IN" read as different countries and blocked a legitimate sale.
 *
 * Resolution order:
 *  1. `countryId` — the normalised hierarchy, written by the agency
 *     application flow, and the only source that cannot be misspelt.
 *  2. free-text `country`, itself resolved through the countries table so a
 *     name collapses to the same code as an abbreviation.
 *  3. the raw text, upper-cased, for a country not in the table yet.
 *
 * Returns null when the user has no location at all — the caller decides
 * whether that is fatal, because it means something different for a seller
 * than for a buyer.
 */
export async function resolveUserCountryCode(
  prisma: PrismaService,
  userId: string,
): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { country: true, countryId: true },
  });
  if (!user) return null;

  if (user.countryId) {
    const country = await prisma.country.findUnique({
      where: { id: user.countryId },
      select: { code: true },
    });
    if (country?.code) return country.code.toUpperCase();
  }

  const text = user.country?.trim();
  if (!text) return null;

  const matched = await prisma.country.findFirst({
    where: {
      OR: [
        { code: { equals: text, mode: 'insensitive' } },
        { name: { equals: text, mode: 'insensitive' } },
      ],
    },
    select: { code: true },
  });

  return (matched?.code ?? text).toUpperCase();
}

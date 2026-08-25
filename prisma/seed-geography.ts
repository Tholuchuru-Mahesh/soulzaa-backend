import { PrismaClient } from '@prisma/client';
import { Country as CSC_Country, State as CSC_State } from 'country-state-city';

const prisma = new PrismaClient();

interface OperationalRegionDef {
  code: string;
  name: string;
  description?: string;
}

/**
 * Known operational / metro sub-regions for agency routing and RBAC scopes.
 * Keyed by `${countryCode}:${stateCode}` (e.g., "IN:KA").
 */
const OPERATIONAL_REGIONS: Record<string, OperationalRegionDef[]> = {
  'IN:KA': [
    { code: 'BLR', name: 'Bengaluru Region' },
    { code: 'MYS', name: 'Mysuru Region' },
    { code: 'IXE', name: 'Mangaluru Region' },
    { code: 'HBX', name: 'Hubballi-Dharwad Region' },
    { code: 'IXG', name: 'Belagavi Region' },
  ],
  'IN:AP': [
    { code: 'VJA', name: 'Vijayawada Region' },
    { code: 'VTZ', name: 'Visakhapatnam Region' },
    { code: 'TIR', name: 'Tirupati Region' },
    { code: 'GNT', name: 'Guntur Region' },
    { code: 'KNL', name: 'Kurnool Region' },
  ],
  'IN:TN': [
    { code: 'CHN', name: 'Chennai Region' },
    { code: 'CJB', name: 'Coimbatore Region' },
    { code: 'IXM', name: 'Madurai Region' },
    { code: 'TRZ', name: 'Tiruchirappalli Region' },
    { code: 'SXV', name: 'Salem Region' },
  ],
  'IN:TG': [
    { code: 'HYD', name: 'Hyderabad Region' },
    { code: 'WGL', name: 'Warangal Region' },
    { code: 'NZB', name: 'Nizamabad Region' },
    { code: 'KRM', name: 'Karimnagar Region' },
    { code: 'KMM', name: 'Khammam Region' },
  ],
  'IN:MH': [
    { code: 'BOM', name: 'Mumbai Region' },
    { code: 'PNQ', name: 'Pune Region' },
    { code: 'NAG', name: 'Nagpur Region' },
    { code: 'ISK', name: 'Nashik Region' },
    { code: 'IXU', name: 'Chhatrapati Sambhajinagar (Aurangabad)' },
    { code: 'THA', name: 'Thane Region' },
  ],
  'IN:DL': [
    { code: 'DEL-C', name: 'Central Delhi' },
    { code: 'DEL-S', name: 'South Delhi' },
    { code: 'DEL-N', name: 'North Delhi' },
    { code: 'DEL-E', name: 'East Delhi' },
    { code: 'DEL-W', name: 'West Delhi' },
  ],
  'IN:KL': [
    { code: 'COK', name: 'Kochi / Ernakulam' },
    { code: 'TRV', name: 'Thiruvananthapuram' },
    { code: 'CCJ', name: 'Kozhikode' },
    { code: 'TCR', name: 'Thrissur' },
  ],
  'IN:WB': [
    { code: 'CCU', name: 'Kolkata Metropolitan' },
    { code: 'IXB', name: 'Siliguri / North Bengal' },
    { code: 'DGP', name: 'Durgapur-Asansol' },
  ],
  'IN:GJ': [
    { code: 'AMD', name: 'Ahmedabad' },
    { code: 'STV', name: 'Surat' },
    { code: 'BDQ', name: 'Vadodara' },
    { code: 'RAJ', name: 'Rajkot' },
  ],
  'IN:RJ': [
    { code: 'JAI', name: 'Jaipur' },
    { code: 'JDH', name: 'Jodhpur' },
    { code: 'UDR', name: 'Udaipur' },
    { code: 'KTA', name: 'Kota' },
  ],
  'IN:UP': [
    { code: 'LKO', name: 'Lucknow' },
    { code: 'KNP', name: 'Kanpur' },
    { code: 'NOI', name: 'Noida-Greater Noida' },
    { code: 'VNS', name: 'Varanasi' },
    { code: 'AGR', name: 'Agra' },
    { code: 'PRG', name: 'Prayagraj' },
  ],
  'US:CA': [
    { code: 'LAX', name: 'Los Angeles Metro' },
    { code: 'SFO', name: 'San Francisco Bay Area' },
    { code: 'SAN', name: 'San Diego Region' },
  ],
  'US:NY': [
    { code: 'NYC', name: 'New York City Metro' },
    { code: 'BUF', name: 'Buffalo-Niagara' },
  ],
  'US:TX': [
    { code: 'DFW', name: 'Dallas-Fort Worth' },
    { code: 'HOU', name: 'Greater Houston' },
    { code: 'AUS', name: 'Austin Metro' },
  ],
  'AE:DU': [{ code: 'DXB', name: 'Dubai Emirate' }],
  'AE:AZ': [{ code: 'AUH', name: 'Abu Dhabi Emirate' }],
  'GB:ENG': [
    { code: 'LON', name: 'Greater London' },
    { code: 'MAN', name: 'Greater Manchester' },
    { code: 'BIR', name: 'West Midlands (Birmingham)' },
  ],
};

async function seedGeography(): Promise<void> {
  console.log('🌍 Dynamically Seeding Global Geography Reference Data via ISO-3166...');

  // Dynamically load all 250+ countries from maintained ISO dataset
  const allCountries = CSC_Country.getAllCountries();
  console.log(`📦 Loaded ${allCountries.length} countries from ISO-3166 dataset.`);

  let totalCountries = 0;
  let totalStates = 0;
  let totalRegions = 0;

  for (const c of allCountries) {
    const countryCode = c.isoCode.trim().toUpperCase();
    if (!countryCode) continue;

    const country = await prisma.country.upsert({
      where: { code: countryCode },
      create: {
        code: countryCode,
        name: c.name,
        description: `${c.name} (${c.currency ? `${c.currency} · ` : ''}${c.phonecode ? `+${c.phonecode.replace('+', '')}` : ''})`,
        isActive: true,
      },
      update: {
        name: c.name,
        description: `${c.name} (${c.currency ? `${c.currency} · ` : ''}${c.phonecode ? `+${c.phonecode.replace('+', '')}` : ''})`,
        isActive: true,
      },
    });
    totalCountries++;

    // Dynamically load states/provinces for this country from ISO-3166-2
    const states = CSC_State.getStatesOfCountry(countryCode);
    const seenStateCodes = new Set<string>();

    for (const [stateIndex, s] of states.entries()) {
      let stateCode = (s.isoCode || s.name).trim().toUpperCase();
      if (!stateCode || seenStateCodes.has(stateCode)) {
        stateCode = `${countryCode}-${String(stateIndex + 1).padStart(2, '0')}`;
      }
      seenStateCodes.add(stateCode);

      const moderatorRegionCode = `${countryCode}-S-${String(stateIndex + 1).padStart(2, '0')}`;

      const state = await prisma.state.upsert({
        where: {
          countryId_code: {
            countryId: country.id,
            code: stateCode,
          },
        },
        create: {
          countryId: country.id,
          code: stateCode,
          name: s.name,
          description: null,
          isActive: true,
          moderatorRegionCode,
        },
        update: {
          name: s.name,
          isActive: true,
          moderatorRegionCode,
        },
      });
      totalStates++;

      // Seed operational sub-regions if configured
      const operationalRegions = OPERATIONAL_REGIONS[`${countryCode}:${stateCode}`] || [];
      for (const r of operationalRegions) {
        await prisma.region.upsert({
          where: {
            stateId_code: {
              stateId: state.id,
              code: r.code,
            },
          },
          create: {
            stateId: state.id,
            code: r.code,
            name: r.name,
            description: r.description ?? null,
            isActive: true,
          },
          update: {
            name: r.name,
            description: r.description ?? null,
            isActive: true,
          },
        });
        totalRegions++;
      }
    }
  }

  console.log(
    `✅ Dynamic Global Geography Seeded Successfully: ${totalCountries} countries, ${totalStates} states/provinces, ${totalRegions} regions.`,
  );
}

seedGeography()
  .catch((e) => {
    console.error('❌ Failed to seed geography:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

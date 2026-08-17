import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface RegionDef {
  code: string;
  name: string;
  description?: string;
}

interface StateDef {
  code: string;
  name: string;
  description?: string;
  regions: RegionDef[];
}

interface CountryDef {
  code: string;
  name: string;
  description?: string;
  states: StateDef[];
}

const GLOBAL_GEOGRAPHY: CountryDef[] = [
  // ── India ─────────────────────────────────────────────────────────────────
  {
    code: 'IN',
    name: 'India',
    description: 'Republic of India',
    states: [
      {
        code: 'KA',
        name: 'Karnataka',
        regions: [
          { code: 'BLR', name: 'Bengaluru Region' },
          { code: 'MYS', name: 'Mysuru Region' },
          { code: 'IXE', name: 'Mangaluru Region' },
          { code: 'HBX', name: 'Hubballi-Dharwad Region' },
          { code: 'IXG', name: 'Belagavi Region' },
        ],
      },
      {
        code: 'AP',
        name: 'Andhra Pradesh',
        regions: [
          { code: 'VJA', name: 'Vijayawada Region' },
          { code: 'VTZ', name: 'Visakhapatnam Region' },
          { code: 'TIR', name: 'Tirupati Region' },
          { code: 'GNT', name: 'Guntur Region' },
          { code: 'KNL', name: 'Kurnool Region' },
        ],
      },
      {
        code: 'TN',
        name: 'Tamil Nadu',
        regions: [
          { code: 'CHN', name: 'Chennai Region' },
          { code: 'CJB', name: 'Coimbatore Region' },
          { code: 'IXM', name: 'Madurai Region' },
          { code: 'TRZ', name: 'Tiruchirappalli Region' },
          { code: 'SXV', name: 'Salem Region' },
        ],
      },
      {
        code: 'TG',
        name: 'Telangana',
        regions: [
          { code: 'HYD', name: 'Hyderabad Region' },
          { code: 'WGL', name: 'Warangal Region' },
          { code: 'NZB', name: 'Nizamabad Region' },
          { code: 'KRM', name: 'Karimnagar Region' },
          { code: 'KMM', name: 'Khammam Region' },
        ],
      },
      {
        code: 'MH',
        name: 'Maharashtra',
        regions: [
          { code: 'BOM', name: 'Mumbai Region' },
          { code: 'PNQ', name: 'Pune Region' },
          { code: 'NAG', name: 'Nagpur Region' },
          { code: 'ISK', name: 'Nashik Region' },
          { code: 'IXU', name: 'Chhatrapati Sambhajinagar (Aurangabad)' },
          { code: 'THA', name: 'Thane Region' },
        ],
      },
      {
        code: 'DL',
        name: 'Delhi NCR',
        regions: [
          { code: 'DEL-C', name: 'Central Delhi' },
          { code: 'DEL-S', name: 'South Delhi' },
          { code: 'DEL-N', name: 'North Delhi' },
          { code: 'DEL-E', name: 'East Delhi' },
          { code: 'DEL-W', name: 'West Delhi' },
        ],
      },
      {
        code: 'KL',
        name: 'Kerala',
        regions: [
          { code: 'COK', name: 'Kochi Region' },
          { code: 'TRV', name: 'Thiruvananthapuram Region' },
          { code: 'CCJ', name: 'Kozhikode Region' },
          { code: 'TCR', name: 'Thrissur Region' },
        ],
      },
      {
        code: 'GJ',
        name: 'Gujarat',
        regions: [
          { code: 'AMD', name: 'Ahmedabad Region' },
          { code: 'STV', name: 'Surat Region' },
          { code: 'BDQ', name: 'Vadodara Region' },
          { code: 'RAJ', name: 'Rajkot Region' },
          { code: 'GAN', name: 'Gandhinagar Region' },
        ],
      },
      {
        code: 'UP',
        name: 'Uttar Pradesh',
        regions: [
          { code: 'LKO', name: 'Lucknow Region' },
          { code: 'NOI', name: 'Noida / Greater Noida' },
          { code: 'KNP', name: 'Kanpur Region' },
          { code: 'VNS', name: 'Varanasi Region' },
          { code: 'AGR', name: 'Agra Region' },
          { code: 'IXD', name: 'Prayagraj Region' },
        ],
      },
      {
        code: 'WB',
        name: 'West Bengal',
        regions: [
          { code: 'CCU', name: 'Kolkata Region' },
          { code: 'IXB', name: 'Siliguri Region' },
          { code: 'RDP', name: 'Durgapur Region' },
          { code: 'ASN', name: 'Asansol Region' },
        ],
      },
      {
        code: 'RJ',
        name: 'Rajasthan',
        regions: [
          { code: 'JAI', name: 'Jaipur Region' },
          { code: 'JDH', name: 'Jodhpur Region' },
          { code: 'UDR', name: 'Udaipur Region' },
          { code: 'KOT', name: 'Kota Region' },
        ],
      },
      {
        code: 'MP',
        name: 'Madhya Pradesh',
        regions: [
          { code: 'IDR', name: 'Indore Region' },
          { code: 'BHO', name: 'Bhopal Region' },
          { code: 'GWL', name: 'Gwalior Region' },
          { code: 'JLR', name: 'Jabalpur Region' },
        ],
      },
      {
        code: 'PB',
        name: 'Punjab',
        regions: [
          { code: 'LUH', name: 'Ludhiana Region' },
          { code: 'ATQ', name: 'Amritsar Region' },
          { code: 'JAL', name: 'Jalandhar Region' },
          { code: 'MOH', name: 'Mohali Region' },
        ],
      },
      {
        code: 'HR',
        name: 'Haryana',
        regions: [
          { code: 'GUR', name: 'Gurugram Region' },
          { code: 'FBD', name: 'Faridabad Region' },
          { code: 'PAN', name: 'Panipat Region' },
          { code: 'AMB', name: 'Ambala Region' },
        ],
      },
      {
        code: 'BR',
        name: 'Bihar',
        regions: [
          { code: 'PAT', name: 'Patna Region' },
          { code: 'GAY', name: 'Gaya Region' },
          { code: 'MUZ', name: 'Muzaffarpur Region' },
          { code: 'BGP', name: 'Bhagalpur Region' },
        ],
      },
      {
        code: 'OD',
        name: 'Odisha',
        regions: [
          { code: 'BBI', name: 'Bhubaneswar Region' },
          { code: 'CTC', name: 'Cuttack Region' },
          { code: 'RRK', name: 'Rourkela Region' },
          { code: 'PUR', name: 'Puri Region' },
        ],
      },
      {
        code: 'AS',
        name: 'Assam',
        regions: [
          { code: 'GAU', name: 'Guwahati Region' },
          { code: 'DIB', name: 'Dibrugarh Region' },
          { code: 'IXS', name: 'Silchar Region' },
          { code: 'JRH', name: 'Jorhat Region' },
        ],
      },
      {
        code: 'JH',
        name: 'Jharkhand',
        regions: [
          { code: 'IXR', name: 'Ranchi Region' },
          { code: 'IXW', name: 'Jamshedpur Region' },
          { code: 'DHN', name: 'Dhanbad Region' },
        ],
      },
      {
        code: 'CG',
        name: 'Chhattisgarh',
        regions: [
          { code: 'RPR', name: 'Raipur Region' },
          { code: 'PAB', name: 'Bilaspur Region' },
          { code: 'DUR', name: 'Durg-Bhilai Region' },
        ],
      },
      {
        code: 'UK',
        name: 'Uttarakhand',
        regions: [
          { code: 'DED', name: 'Dehradun Region' },
          { code: 'HAR', name: 'Haridwar Region' },
          { code: 'NAI', name: 'Nainital Region' },
        ],
      },
      {
        code: 'HP',
        name: 'Himachal Pradesh',
        regions: [
          { code: 'SLV', name: 'Shimla Region' },
          { code: 'DHM', name: 'Dharamshala Region' },
          { code: 'KUU', name: 'Kullu-Manali Region' },
        ],
      },
      {
        code: 'GA',
        name: 'Goa',
        regions: [
          { code: 'GOA-N', name: 'North Goa' },
          { code: 'GOA-S', name: 'South Goa' },
        ],
      },
      {
        code: 'JK',
        name: 'Jammu and Kashmir',
        regions: [
          { code: 'SXR', name: 'Srinagar Region' },
          { code: 'IXJ', name: 'Jammu Region' },
        ],
      },
      {
        code: 'LA',
        name: 'Ladakh',
        regions: [
          { code: 'IXL', name: 'Leh Region' },
          { code: 'KGL', name: 'Kargil Region' },
        ],
      },
      {
        code: 'CH',
        name: 'Chandigarh',
        regions: [{ code: 'IXC', name: 'Chandigarh Region' }],
      },
      {
        code: 'PY',
        name: 'Puducherry',
        regions: [{ code: 'PNY', name: 'Puducherry Region' }],
      },
      {
        code: 'AN',
        name: 'Andaman and Nicobar',
        regions: [{ code: 'IXZ', name: 'Port Blair Region' }],
      },
      {
        code: 'TR',
        name: 'Tripura',
        regions: [{ code: 'IXA', name: 'Agartala Region' }],
      },
      {
        code: 'MN',
        name: 'Manipur',
        regions: [{ code: 'IMF', name: 'Imphal Region' }],
      },
      {
        code: 'ML',
        name: 'Meghalaya',
        regions: [{ code: 'SHL', name: 'Shillong Region' }],
      },
      {
        code: 'MZ',
        name: 'Mizoram',
        regions: [{ code: 'AJL', name: 'Aizawl Region' }],
      },
      {
        code: 'NL',
        name: 'Nagaland',
        regions: [
          { code: 'KOH', name: 'Kohima Region' },
          { code: 'DMU', name: 'Dimapur Region' },
        ],
      },
      {
        code: 'AR',
        name: 'Arunachal Pradesh',
        regions: [{ code: 'ITA', name: 'Itanagar Region' }],
      },
      {
        code: 'SK',
        name: 'Sikkim',
        regions: [{ code: 'GKT', name: 'Gangtok Region' }],
      },
    ],
  },

  // ── United States ────────────────────────────────────────────────────────
  {
    code: 'US',
    name: 'United States',
    description: 'United States of America',
    states: [
      {
        code: 'CA',
        name: 'California',
        regions: [
          { code: 'SFO', name: 'San Francisco Bay Area' },
          { code: 'LAX', name: 'Greater Los Angeles' },
          { code: 'SAN', name: 'San Diego Region' },
          { code: 'SMF', name: 'Sacramento Region' },
        ],
      },
      {
        code: 'NY',
        name: 'New York',
        regions: [
          { code: 'NYC', name: 'New York City' },
          { code: 'BUF', name: 'Buffalo-Niagara' },
          { code: 'ALB', name: 'Albany Capital Region' },
        ],
      },
      {
        code: 'TX',
        name: 'Texas',
        regions: [
          { code: 'AUS', name: 'Austin Metro' },
          { code: 'HOU', name: 'Greater Houston' },
          { code: 'DFW', name: 'Dallas-Fort Worth' },
          { code: 'SAT', name: 'San Antonio Region' },
        ],
      },
      {
        code: 'FL',
        name: 'Florida',
        regions: [
          { code: 'MIA', name: 'Miami-Fort Lauderdale' },
          { code: 'MCO', name: 'Greater Orlando' },
          { code: 'TPA', name: 'Tampa Bay' },
          { code: 'JAX', name: 'Jacksonville Region' },
        ],
      },
      {
        code: 'WA',
        name: 'Washington',
        regions: [
          { code: 'SEA', name: 'Greater Seattle' },
          { code: 'GEG', name: 'Spokane Region' },
        ],
      },
      {
        code: 'IL',
        name: 'Illinois',
        regions: [{ code: 'ORD', name: 'Greater Chicago' }],
      },
      {
        code: 'MA',
        name: 'Massachusetts',
        regions: [{ code: 'BOS', name: 'Greater Boston' }],
      },
      {
        code: 'GA',
        name: 'Georgia',
        regions: [{ code: 'ATL', name: 'Metro Atlanta' }],
      },
    ],
  },

  // ── United Arab Emirates ──────────────────────────────────────────────────
  {
    code: 'AE',
    name: 'United Arab Emirates',
    description: 'United Arab Emirates',
    states: [
      {
        code: 'DU',
        name: 'Dubai',
        regions: [
          { code: 'DXB-DT', name: 'Downtown & Business Bay' },
          { code: 'DXB-MR', name: 'Dubai Marina & JBR' },
          { code: 'DXB-DR', name: 'Deira & Old Dubai' },
          { code: 'DXB-JM', name: 'Jumeirah Region' },
        ],
      },
      {
        code: 'AZ',
        name: 'Abu Dhabi',
        regions: [
          { code: 'AUH-CT', name: 'Abu Dhabi City' },
          { code: 'AAN', name: 'Al Ain Region' },
          { code: 'DHF', name: 'Al Dhafra Region' },
        ],
      },
      {
        code: 'SH',
        name: 'Sharjah',
        regions: [
          { code: 'SHJ-CT', name: 'Sharjah City' },
          { code: 'KHF', name: 'Khor Fakkan' },
        ],
      },
      {
        code: 'AJ',
        name: 'Ajman',
        regions: [{ code: 'AJM', name: 'Ajman City' }],
      },
      {
        code: 'RK',
        name: 'Ras Al Khaimah',
        regions: [{ code: 'RAK', name: 'Ras Al Khaimah City' }],
      },
    ],
  },

  // ── United Kingdom ────────────────────────────────────────────────────────
  {
    code: 'GB',
    name: 'United Kingdom',
    description: 'United Kingdom of Great Britain and Northern Ireland',
    states: [
      {
        code: 'ENG',
        name: 'England',
        regions: [
          { code: 'LON', name: 'Greater London' },
          { code: 'MAN', name: 'Greater Manchester' },
          { code: 'BHX', name: 'West Midlands (Birmingham)' },
          { code: 'LBA', name: 'West Yorkshire (Leeds)' },
        ],
      },
      {
        code: 'SCT',
        name: 'Scotland',
        regions: [
          { code: 'EDI', name: 'Edinburgh Region' },
          { code: 'GLA', name: 'Greater Glasgow' },
        ],
      },
      {
        code: 'WLS',
        name: 'Wales',
        regions: [{ code: 'CWL', name: 'Cardiff & South Wales' }],
      },
      {
        code: 'NIR',
        name: 'Northern Ireland',
        regions: [{ code: 'BFS', name: 'Greater Belfast' }],
      },
    ],
  },

  // ── Saudi Arabia ──────────────────────────────────────────────────────────
  {
    code: 'SA',
    name: 'Saudi Arabia',
    description: 'Kingdom of Saudi Arabia',
    states: [
      {
        code: '01',
        name: 'Riyadh Region',
        regions: [
          { code: 'RUH', name: 'Riyadh City' },
          { code: 'AKH', name: 'Al Kharj' },
        ],
      },
      {
        code: '02',
        name: 'Makkah Region',
        regions: [
          { code: 'JED', name: 'Jeddah Metro' },
          { code: 'MAK', name: 'Makkah City' },
          { code: 'TIF', name: 'Taif Region' },
        ],
      },
      {
        code: '04',
        name: 'Eastern Province',
        regions: [
          { code: 'DMM', name: 'Dammam Metro' },
          { code: 'KHB', name: 'Al Khobar' },
          { code: 'JBL', name: 'Jubail' },
        ],
      },
      {
        code: '03',
        name: 'Madinah Region',
        regions: [
          { code: 'MED', name: 'Madinah City' },
          { code: 'YNB', name: 'Yanbu' },
        ],
      },
    ],
  },

  // ── Canada ────────────────────────────────────────────────────────────────
  {
    code: 'CA',
    name: 'Canada',
    description: 'Canada',
    states: [
      {
        code: 'ON',
        name: 'Ontario',
        regions: [
          { code: 'YYZ', name: 'Greater Toronto Area' },
          { code: 'YOW', name: 'Ottawa Capital' },
          { code: 'YHM', name: 'Hamilton-Niagara' },
        ],
      },
      {
        code: 'BC',
        name: 'British Columbia',
        regions: [
          { code: 'YVR', name: 'Greater Vancouver' },
          { code: 'YYJ', name: 'Victoria Region' },
        ],
      },
      {
        code: 'QC',
        name: 'Quebec',
        regions: [
          { code: 'YUL', name: 'Greater Montreal' },
          { code: 'YQB', name: 'Quebec City' },
        ],
      },
      {
        code: 'AB',
        name: 'Alberta',
        regions: [
          { code: 'YYC', name: 'Calgary Region' },
          { code: 'YEG', name: 'Edmonton Region' },
        ],
      },
    ],
  },

  // ── Australia ─────────────────────────────────────────────────────────────
  {
    code: 'AU',
    name: 'Australia',
    description: 'Commonwealth of Australia',
    states: [
      {
        code: 'NSW',
        name: 'New South Wales',
        regions: [
          { code: 'SYD', name: 'Greater Sydney' },
          { code: 'NTL', name: 'Newcastle Region' },
        ],
      },
      {
        code: 'VIC',
        name: 'Victoria',
        regions: [
          { code: 'MEL', name: 'Greater Melbourne' },
          { code: 'GEX', name: 'Geelong Region' },
        ],
      },
      {
        code: 'QLD',
        name: 'Queensland',
        regions: [
          { code: 'BNE', name: 'Greater Brisbane' },
          { code: 'OOL', name: 'Gold Coast' },
        ],
      },
      {
        code: 'WA',
        name: 'Western Australia',
        regions: [{ code: 'PER', name: 'Greater Perth' }],
      },
    ],
  },

  // ── Singapore ─────────────────────────────────────────────────────────────
  {
    code: 'SG',
    name: 'Singapore',
    description: 'Republic of Singapore',
    states: [
      {
        code: 'CR',
        name: 'Central Region',
        regions: [
          { code: 'SIN-DT', name: 'Downtown Core' },
          { code: 'SIN-ORC', name: 'Orchard / Novena' },
        ],
      },
      {
        code: 'ER',
        name: 'East Region',
        regions: [
          { code: 'SIN-TAM', name: 'Tampines Region' },
          { code: 'SIN-CHA', name: 'Changi / Bedok' },
        ],
      },
      {
        code: 'WR',
        name: 'West Region',
        regions: [{ code: 'SIN-JUR', name: 'Jurong Region' }],
      },
    ],
  },

  // ── Germany ───────────────────────────────────────────────────────────────
  {
    code: 'DE',
    name: 'Germany',
    description: 'Federal Republic of Germany',
    states: [
      {
        code: 'BY',
        name: 'Bavaria',
        regions: [
          { code: 'MUC', name: 'Munich Region' },
          { code: 'NUE', name: 'Nuremberg Region' },
        ],
      },
      {
        code: 'BE',
        name: 'Berlin',
        regions: [{ code: 'BER', name: 'Berlin Metro' }],
      },
      {
        code: 'NW',
        name: 'North Rhine-Westphalia',
        regions: [
          { code: 'CGN', name: 'Cologne Region' },
          { code: 'DUS', name: 'Düsseldorf Region' },
        ],
      },
    ],
  },

  // ── France ────────────────────────────────────────────────────────────────
  {
    code: 'FR',
    name: 'France',
    description: 'French Republic',
    states: [
      {
        code: 'IDF',
        name: 'Île-de-France',
        regions: [{ code: 'PAR', name: 'Paris Metro' }],
      },
      {
        code: 'ARA',
        name: 'Auvergne-Rhône-Alpes',
        regions: [{ code: 'LYS', name: 'Lyon Region' }],
      },
      {
        code: 'PAC',
        name: "Provence-Alpes-Côte d'Azur",
        regions: [
          { code: 'MRS', name: 'Marseille Region' },
          { code: 'NCE', name: 'Nice Region' },
        ],
      },
    ],
  },

  // ── Japan ─────────────────────────────────────────────────────────────────
  {
    code: 'JP',
    name: 'Japan',
    description: 'Japan',
    states: [
      {
        code: '13',
        name: 'Tokyo Prefecture',
        regions: [
          { code: 'TYO', name: 'Tokyo 23 Wards' },
          { code: 'TMA', name: 'Tama Region' },
        ],
      },
      {
        code: '27',
        name: 'Osaka Prefecture',
        regions: [{ code: 'OSA', name: 'Osaka City' }],
      },
      {
        code: '14',
        name: 'Kanagawa Prefecture',
        regions: [{ code: 'YOK', name: 'Yokohama Region' }],
      },
    ],
  },

  // ── Brazil ────────────────────────────────────────────────────────────────
  {
    code: 'BR',
    name: 'Brazil',
    description: 'Federative Republic of Brazil',
    states: [
      {
        code: 'SP',
        name: 'São Paulo',
        regions: [
          { code: 'SAO', name: 'São Paulo Capital' },
          { code: 'CPQ', name: 'Campinas Region' },
        ],
      },
      {
        code: 'RJ',
        name: 'Rio de Janeiro',
        regions: [{ code: 'RIO', name: 'Rio de Janeiro Capital' }],
      },
    ],
  },
];

async function seedGeography(): Promise<void> {
  console.log('🌍 Seeding Global Geography Reference Data...');
  let totalCountries = 0;
  let totalStates = 0;
  let totalRegions = 0;

  for (const c of GLOBAL_GEOGRAPHY) {
    const country = await prisma.country.upsert({
      where: { code: c.code },
      create: {
        code: c.code,
        name: c.name,
        description: c.description ?? null,
        isActive: true,
      },
      update: {
        name: c.name,
        description: c.description ?? null,
        isActive: true,
      },
    });
    totalCountries++;

    for (const s of c.states) {
      const state = await prisma.state.upsert({
        where: {
          countryId_code: {
            countryId: country.id,
            code: s.code,
          },
        },
        create: {
          countryId: country.id,
          code: s.code,
          name: s.name,
          description: s.description ?? null,
          isActive: true,
        },
        update: {
          name: s.name,
          description: s.description ?? null,
          isActive: true,
        },
      });
      totalStates++;

      for (const r of s.regions) {
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
    `✅ Global Geography Seeded Successfully: ${totalCountries} countries, ${totalStates} states/provinces, ${totalRegions} regions.`,
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

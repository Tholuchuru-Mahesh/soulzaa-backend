/**
 * Default seeded reference data for room categories + languages. Applied once
 * (idempotently, when the tables are empty) by RoomReferenceSeeder on
 * application bootstrap. Admin-managed CRUD over these lands in the Admin phase.
 */

export interface SeedCategory {
  slug: string;
  name: string;
  sortOrder: number;
}

export interface SeedLanguage {
  code: string;
  name: string;
  nativeName: string;
  sortOrder: number;
}

export const DEFAULT_ROOM_CATEGORIES: SeedCategory[] = [
  { slug: 'music', name: 'Music', sortOrder: 10 },
  { slug: 'chat', name: 'Chat & Chill', sortOrder: 20 },
  { slug: 'gaming', name: 'Gaming', sortOrder: 30 },
  { slug: 'dating', name: 'Dating', sortOrder: 40 },
  { slug: 'comedy', name: 'Comedy', sortOrder: 50 },
  { slug: 'education', name: 'Education', sortOrder: 60 },
  { slug: 'news', name: 'News & Talk', sortOrder: 70 },
  { slug: 'sports', name: 'Sports', sortOrder: 80 },
];

export const DEFAULT_ROOM_LANGUAGES: SeedLanguage[] = [
  { code: 'en', name: 'English', nativeName: 'English', sortOrder: 10 },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', sortOrder: 20 },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', sortOrder: 30 },
  { code: 'es', name: 'Spanish', nativeName: 'Español', sortOrder: 40 },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', sortOrder: 50 },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', sortOrder: 60 },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', sortOrder: 70 },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو', sortOrder: 80 },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা', sortOrder: 90 },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', sortOrder: 100 },
];

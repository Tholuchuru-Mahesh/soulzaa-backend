/**
 * Default seeded reference data for video-room themes + backgrounds. Applied once
 * (idempotently, when the tables are empty) by VideoRoomReferenceSeederService on
 * application bootstrap. Admin-managed CRUD over these lands in the Admin phase.
 *
 * Categories + languages are NOT seeded here — video rooms reuse the shared
 * room_categories / room_languages seeded by the audio-rooms RoomReferenceSeeder.
 */

export interface SeedVideoRoomTheme {
  slug: string;
  name: string;
  isPremium: boolean;
  sortOrder: number;
}

export interface SeedVideoRoomBackground {
  slug: string;
  name: string;
  isPremium: boolean;
  sortOrder: number;
}

export const DEFAULT_VIDEO_ROOM_THEMES: SeedVideoRoomTheme[] = [
  { slug: 'classic', name: 'Classic', isPremium: false, sortOrder: 10 },
  { slug: 'midnight', name: 'Midnight', isPremium: false, sortOrder: 20 },
  { slug: 'aurora', name: 'Aurora', isPremium: false, sortOrder: 30 },
  { slug: 'neon', name: 'Neon', isPremium: true, sortOrder: 40 },
  { slug: 'gold', name: 'Gold', isPremium: true, sortOrder: 50 },
];

export const DEFAULT_VIDEO_ROOM_BACKGROUNDS: SeedVideoRoomBackground[] = [
  { slug: 'studio', name: 'Studio', isPremium: false, sortOrder: 10 },
  { slug: 'lounge', name: 'Lounge', isPremium: false, sortOrder: 20 },
  { slug: 'city-night', name: 'City Night', isPremium: false, sortOrder: 30 },
  { slug: 'galaxy', name: 'Galaxy', isPremium: true, sortOrder: 40 },
  { slug: 'beach', name: 'Beach', isPremium: true, sortOrder: 50 },
];

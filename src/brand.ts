/** Approved by Yuri on 2026-10-19. Do not replace with another cloud variant. */
export const brand = {
  name: 'WhiteMood',
  cloudMaster: '/brand/whitemood-mascot-soft.png',
  cloudSources: [160, 360, 720, 1080, 1484].map(width => `/brand/whitemood-mascot-soft-${width}.webp ${width}w`).join(', '),
  masterSha256: '0978f95c5da9674414004ee4dd4ae644134fbb58d64b8d27901170302edb78cf',
  mascotSha256: 'c4f82db9953f58a63de4abf7bc43e070470b57fb6253946ea5c826a4315612f4',
  sky: '#d2e7fd',
} as const;

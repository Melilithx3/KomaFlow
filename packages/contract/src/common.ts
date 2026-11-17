import { z } from 'zod';

/** Maximum page side in pixels (docs/01-data-model.md §6). */
export const MAX_SIDE_PX = 30_000;

export const Id = z.uuid();
export const UuidV7 = z.uuidv7();
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 lower-case hex');
export const IsoDateTime = z.iso.datetime();

const Px = z.number().int();
export const Box = z.strictObject({
  x: Px.min(0),
  y: Px.min(0),
  w: Px.min(1),
  h: Px.min(1),
});
export type Box = z.infer<typeof Box>;

/** Box rotation around its centre, whole degrees, clockwise on screen (ADR 0011). */
export const Rotation = z.number().int().min(-180).max(180);

export const OBJECT_TYPES = ['bubble', 'sfx', 'onomatopoeia', 'text'] as const;
export const ObjectType = z.enum(OBJECT_TYPES);
export type ObjectType = z.infer<typeof ObjectType>;

export const TRANSLATION_STATES = ['empty', 'translated', 'skipped', 'unreadable'] as const;
export const TranslationState = z.enum(TRANSLATION_STATES);
export type TranslationState = z.infer<typeof TranslationState>;

export const ReadingDirection = z.enum(['rtl', 'ltr']);
export type ReadingDirection = z.infer<typeof ReadingDirection>;

export const ClientKind = z.enum(['web', 'desktop']);
export type ClientKind = z.infer<typeof ClientKind>;

export const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const ImageMime = z.enum(ALLOWED_MIME);
export type ImageMime = z.infer<typeof ImageMime>;

/** Text field limits (docs/02-api.md §6). */
export const LIMITS = {
  translation: 5000,
  source_text: 5000,
  comment: 2000,
  blobsCheck: 500,
} as const;

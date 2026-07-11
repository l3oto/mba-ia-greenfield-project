import { customAlphabet } from 'nanoid';

export const PUBLIC_ID_LENGTH = 11;

const PUBLIC_ID_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';

/**
 * YouTube-like URL-safe identifier: 11 chars over a 64-symbol alphabet
 * (64^11 ≈ 7.3e19 combinations). Uniqueness is guaranteed in depth by the
 * unique index on videos.public_id plus a single insert retry.
 */
export const generatePublicId = customAlphabet(
  PUBLIC_ID_ALPHABET,
  PUBLIC_ID_LENGTH,
);

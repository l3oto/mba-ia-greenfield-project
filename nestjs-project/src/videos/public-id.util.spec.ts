import { generatePublicId, PUBLIC_ID_LENGTH } from './public-id.util';

describe('generatePublicId', () => {
  it('should generate ids with 11 url-safe characters', () => {
    const id = generatePublicId();

    expect(id).toHaveLength(PUBLIC_ID_LENGTH);
    expect(id).toMatch(/^[0-9A-Za-z_-]{11}$/);
  });

  it('should generate distinct ids on consecutive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generatePublicId()));

    expect(ids.size).toBe(100);
  });
});

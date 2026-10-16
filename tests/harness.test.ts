import { describe, expect, it } from 'vitest';
import { fixtureNames, readFixture } from './fixtures';

describe('test harness', () => {
  it('discovers fixtures', () => {
    expect(fixtureNames().length).toBeGreaterThanOrEqual(10);
  });

  it('fixtures are valid utf-8 text', () => {
    for (const name of fixtureNames()) {
      expect(typeof readFixture(name)).toBe('string');
    }
  });
});

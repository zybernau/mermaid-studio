import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE_DIR = join(process.cwd(), 'fixtures');

export function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.mmd'))
    .sort();
}

export function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

export function allFixtures(): Array<{ name: string; source: string }> {
  return fixtureNames().map((name) => ({ name, source: readFixture(name) }));
}

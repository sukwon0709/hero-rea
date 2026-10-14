// Tests that need the original game files read them from HERO_GAME_DIR (never committed).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const GAME_DIR = process.env.HERO_GAME_DIR ?? '';
export const hasGame = GAME_DIR !== '' && existsSync(join(GAME_DIR, 'MAIN.EXE'));

export function gameFile(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(GAME_DIR, name)));
}

// The simulator's code revision, for results kept across a stop (cli.ts evolve, gen-N.json).

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * A hash of the sources a campaign runs: src/sim, src/native, src/engine and src/formats under
 * `src` (tests left out). A candidate played before a stop is kept only when the code is the same:
 * gen 425's best-plan candidate (the one candidate that reaches the wall), played under the code
 * before the 양양 gate plan, was kept through five restarts on newer code, so 양양 was never played
 * with the plan made for it.
 */
export function codeRevision(src: string): string {
  const h = createHash('sha1');
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      if (!n.includes('.')) walk(p);
      else if (n.endsWith('.ts') && !n.endsWith('.test.ts')) {
        h.update(relative(src, p));
        h.update(readFileSync(p));
      }
    }
  };
  for (const d of ['sim', 'native', 'engine', 'formats']) walk(join(src, d));
  return h.digest('hex').slice(0, 12);
}

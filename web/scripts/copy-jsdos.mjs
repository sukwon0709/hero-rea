// Copies the parts of js-dos we need into public/js-dos so Vite serves them as static files.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'js-dos', 'dist');
const dst = join(root, 'public', 'js-dos');
mkdirSync(join(dst, 'emulators'), { recursive: true });
for (const f of ['js-dos.js', 'js-dos.css']) cpSync(join(src, f), join(dst, f));
for (const f of ['emulators.js', 'wdosbox.js', 'wdosbox.wasm', 'wlibzip.js', 'wlibzip.wasm']) {
  cpSync(join(src, 'emulators', f), join(dst, 'emulators', f));
}
console.log('js-dos copied to public/js-dos');

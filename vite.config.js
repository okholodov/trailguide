import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function listFiles(dir, root = dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p, root) : [relative(root, p).replaceAll('\\', '/')];
  });
}

// Emits sw.js with a precache list of every built file, so the whole app works offline.
function serviceWorker() {
  return {
    name: 'trailguide-sw',
    apply: 'build',
    generateBundle(_, bundle) {
      const hash = createHash('sha1');
      const built = Object.entries(bundle)
        .filter(([f]) => !f.endsWith('.map'))
        .map(([f, item]) => {
          hash.update(f).update(item.type === 'chunk' ? item.code : item.source);
          return f;
        });
      const pub = listFiles('public');
      for (const f of pub) hash.update(f).update(readFileSync(join('public', f)));
      const precache = ['./', ...built.filter((f) => f !== 'index.html'), ...pub];
      const source = readFileSync('src/sw-template.js', 'utf8')
        .replace('__PRECACHE__', JSON.stringify(precache))
        .replace('__VERSION__', hash.digest('hex').slice(0, 10));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [serviceWorker()],
  build: { chunkSizeWarningLimit: 1300 }, // MapLibre GL is ~1 MB; cached once for offline use
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')) },
});

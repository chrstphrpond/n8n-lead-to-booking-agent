// Loads the pure-logic modules in this folder two ways:
//   1. moduleSource(files): concatenated source that build-workflow.mjs injects into n8n Code nodes
//   2. loadModules(files):  the same source evaluated in Node, returning every top-level
//      function/const, so unit tests and scripts exercise exactly what n8n runs.
// Convention: top-level declarations start at column 0; names are unique across all modules.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const MODULE_FILES = [
  'timeutil.js', 'signature.js', 'normalize.js', 'anthropic.js', 'guardrails.js', 'rules.js', 'routing.js',
  'slots.js', 'messages.js', 'requests.js', 'idempotency.js', 'approval.js', 'ctx.js',
];

export function moduleSource(files) {
  return files.map(file => `// ---- ${file} ----\n${readFileSync(join(here, file), 'utf8').trim()}`).join('\n\n');
}

export function loadModules(files = MODULE_FILES) {
  const source = moduleSource(files);
  const names = [...source.matchAll(/^(?:async\s+)?function\s+(\w+)|^const\s+(\w+)\s*=/gm)].map(m => m[1] ?? m[2]);
  const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
  if (duplicates.length) throw new Error(`Duplicate top-level names across modules: ${[...new Set(duplicates)].join(', ')}`);
  return new Function('require', `${source}\nreturn { ${names.join(', ')} };`)(require);
}

export function moduleNames(file) {
  const source = readFileSync(join(here, file), 'utf8');
  return [...source.matchAll(/^(?:async\s+)?function\s+(\w+)|^const\s+(\w+)\s*=/gm)].map(m => m[1] ?? m[2]);
}

// Returns the minimal set of modules a Code node needs: the requested ones plus any module whose
// top-level names are referenced by the node body or by an already-selected module.
export function resolveModules(requested, bodyText) {
  const selected = new Set(requested);
  let changed = true;
  while (changed) {
    changed = false;
    const text = `${bodyText}\n${moduleSource([...selected])}`;
    for (const file of MODULE_FILES) {
      if (selected.has(file)) continue;
      if (moduleNames(file).some(name => new RegExp(`\\b${name}\\b`).test(text))) { selected.add(file); changed = true; }
    }
  }
  return MODULE_FILES.filter(file => selected.has(file));
}

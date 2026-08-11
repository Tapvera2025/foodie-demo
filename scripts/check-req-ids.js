#!/usr/bin/env node
/**
 * Every requirement ID cited in a code comment must exist in the specification.
 *
 * Requirements get renumbered. A comment claiming to implement PAY-nn when that
 * ID no longer exists is worse than no comment, because it looks like
 * traceability. This turns that drift into a CI failure.
 *
 * (Written as PAY-nn rather than a real ID on purpose — this file is scanned
 * too, and the check should not fail on its own documentation.)
 *
 * Referenced by .github/workflows/ci.yml (job: static).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const SPEC = JSON.parse(readFileSync(join(ROOT, 'docs/requirements.json'), 'utf8'));
const VALID = new Set(SPEC.ids);

// Matches IDs like PAY-01, KDS-HB-02, CUS-CHECK-04, A11Y-15.
const ID_RE = /\b([A-Z][A-Z0-9]{1,6}(?:-[A-Z]{2,6})*-\d{2})\b/g;

const SCAN_DIRS = ['src', 'tests', 'scripts'];
const SCAN_EXT = new Set(['.ts', '.js', '.mjs', '.sql']);

/** IDs that look like requirement IDs but are not. Extend deliberately. */
const IGNORE = new Set(['UTF-8', 'ES-20', 'ISO-86', 'SHA-25', 'RFC-33']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist' || e === 'coverage') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SCAN_EXT.has(extname(p))) out.push(p);
  }
  return out;
}

const problems = [];
let cited = 0;

for (const file of SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)))) {
  const text = readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(ID_RE)) {
      const id = m[1];
      if (IGNORE.has(id)) continue;
      cited++;
      if (!VALID.has(id)) {
        problems.push(`${file.replace(ROOT + '/', '')}:${i + 1}  unknown requirement id "${id}"`);
      }
    }
  });
}

if (problems.length > 0) {
  console.error(`\nUnknown requirement IDs referenced in code (${problems.length}):\n`);
  for (const p of problems) console.error('  ' + p);
  console.error(
    `\n${VALID.size} valid IDs are listed in docs/requirements.json.` +
      `\nIf a requirement was renumbered, update the comment. If it is genuinely new,` +
      `\nadd it to the PRD first — code should not invent requirement IDs.\n`,
  );
  process.exit(1);
}

console.log(
  `check-req-ids: ${cited} citations checked against ${VALID.size} known IDs — all valid`,
);

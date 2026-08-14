#!/usr/bin/env node
// Checks that every language file in data/i18n/ has the same key set as
// en.json (the source of truth — every new string is added there first,
// per CLAUDE.md's Localization section). Flags keys en.json has that a
// language is missing (untranslated), and keys a language has that en.json
// doesn't (stale, e.g. left behind after a key was renamed/removed).
//
//   node scripts/check-i18n.js
//
// Exit code 0 = every language matches en.json's key set, 1 = at least one
// language has missing or stale keys.
const fs = require('fs');
const path = require('path');

const I18N_DIR = path.join(__dirname, '..', 'data', 'i18n');
const EN_PATH = path.join(I18N_DIR, 'en.json');

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const en = loadJson(EN_PATH);
const enKeys = new Set(Object.keys(en));

const files = fs.readdirSync(I18N_DIR).filter(f => f.endsWith('.json') && f !== 'en.json' && f !== 'manifest.json');

let hadProblem = false;

for (const file of files) {
  const lang = loadJson(path.join(I18N_DIR, file));
  const langKeys = new Set(Object.keys(lang));

  const missing = [...enKeys].filter(k => !langKeys.has(k));
  const stale   = [...langKeys].filter(k => !enKeys.has(k));

  if (!missing.length && !stale.length) {
    console.log(`${file}: OK (${langKeys.size} keys, matches en.json)`);
    continue;
  }

  hadProblem = true;
  console.log(`${file}: MISMATCH`);
  if (missing.length) {
    console.log(`  missing ${missing.length} key(s) (present in en.json, not in ${file}):`);
    missing.forEach(k => console.log(`    ${k}`));
  }
  if (stale.length) {
    console.log(`  stale ${stale.length} key(s) (in ${file}, not in en.json — rename/remove followup?):`);
    stale.forEach(k => console.log(`    ${k}`));
  }
}

if (!files.length) {
  console.log('No other language files found in data/i18n/ — nothing to check against en.json.');
}

process.exit(hadProblem ? 1 : 0);

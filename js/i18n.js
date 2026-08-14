// ── I18n ───────────────────────────────────────────────────────────────────
// Loads a flat key->string translation file (data/i18n/<lang>.json) and
// exposes t(key, vars) for lookups, with {placeholder} interpolation for
// strings that embed a live value (a voltage, a component name, a rating).
//
// Fetched the same way component/circuit definitions already are (see
// storage.js's MANIFEST_PATH/COMP_BASE pattern) — this app has no build
// step and already assumes an HTTP static host, not file://, so fetch is
// the right mechanism rather than something more exotic. Loaded and
// awaited FIRST in app.js's boot sequence, before ComponentRegistry.load(),
// so every other module can assume translations are ready by the time it
// runs — same "await before anything renders" shape the existing
// ComponentRegistry.load() already establishes.
//
// Key scheme: keys mirror the STRUCTURE of what they label, mechanically
// derived rather than hand-invented, so it's auditable that nothing was
// missed and there's never a naming decision to make up per-string:
//   - Component JSON:  component.<componentId>.<propKey>.label / .hint
//                       component.<componentId>.label / .description
//                       component.<componentId>.failure.<modeKey>
//   - App chrome (buttons, menus, status messages): app.<area>.<name>
//
// Interpolation is mustache-lite: {name} in the stored string is replaced
// with vars.name. Deliberately NOT string concatenation of translated
// fragments — that breaks for languages whose word order differs from
// English, which is the standard reason every real i18n system (gettext,
// i18next, React-intl) interpolates INTO a translated template instead.
const I18n = (() => {
  const MANIFEST_PATH = './data/i18n/manifest.json';
  const BASE          = './data/i18n/';
  const FALLBACK_LANG = 'en';

  let _strings = {};       // flat key -> template string, for the ACTIVE language
  let _fallbackStrings = {}; // English, kept loaded separately so a missing key in
                             // a non-English language degrades to English rather
                             // than showing the raw key to the user
  let _lang = FALLBACK_LANG;
  let _loaded = false;

  async function fetchLang(langCode) {
    try {
      const res = await fetch(BASE + langCode + '.json');
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.warn(`[I18n] Failed to load ${langCode}.json:`, e.message);
      return null;
    }
  }

  async function load(langCode) {
    _fallbackStrings = (await fetchLang(FALLBACK_LANG)) || {};
    if (!langCode || langCode === FALLBACK_LANG) {
      _strings = _fallbackStrings;
      _lang = FALLBACK_LANG;
    } else {
      const requested = await fetchLang(langCode);
      if (requested) { _strings = requested; _lang = langCode; }
      else { _strings = _fallbackStrings; _lang = FALLBACK_LANG; } // requested language failed to load — fall back rather than break the whole app
    }
    _loaded = true;
  }

  // Returns the list of {code, label} the language menu can offer, read
  // from data/i18n/manifest.json (same manifest-lists-what-exists pattern
  // as data/components/manifest.json and vendor/circuits/manifest.json).
  async function listLanguages() {
    try {
      const res = await fetch(MANIFEST_PATH);
      if (!res.ok) return [{ code: 'en', label: 'English' }];
      return await res.json();
    } catch (e) {
      return [{ code: 'en', label: 'English' }];
    }
  }

  function interpolate(template, vars) {
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
  }

  // t(key, vars) — the lookup every call site uses. Missing-key behavior is
  // deliberately LOUD in the console (once per key, not spammed every call)
  // rather than silently showing nothing or throwing, matching this
  // codebase's established "warn by name rather than fail silently"
  // convention (see CLAUDE.md's coupling-cap fallback, acLoadResistance,
  // etc.) — a missing translation is exactly the kind of thing that's easy
  // to ship unnoticed otherwise.
  const _warnedMissing = new Set();
  function t(key, vars) {
    const template = _strings[key] ?? _fallbackStrings[key];
    if (template == null) {
      if (!_warnedMissing.has(key)) {
        _warnedMissing.add(key);
        console.warn(`[I18n] Missing translation key: "${key}"`);
      }
      return key; // visibly wrong (shows the raw key) rather than invisibly wrong (blank text)
    }
    return interpolate(template, vars);
  }

  function currentLanguage() { return _lang; }
  function isLoaded() { return _loaded; }

  // Applies translations to index.html's static markup — menus, toolbar
  // tooltips, help text, etc. — which is plain HTML rather than JS-rendered,
  // so it can't go through t() at the call site the way everything else
  // does. Convention: data-i18n-key sets textContent (element bodies mix
  // static icons with translatable text, so this targets a wrapping element
  // that ONLY contains icon(s) + text nodes, and the text node's siblings —
  // <i>/<span class="shortcut"> — are preserved by only touching the
  // element's OWN trailing text node, not its full innerHTML/textContent).
  // data-i18n-attr="title:key,placeholder:key2" sets arbitrary attributes.
  // Called once from app.js right after I18n.load(), before anything reads
  // this markup.
  function applyStaticMarkup(root = document) {
    // data-i18n-html: the translated string itself contains markup (e.g. a
    // <strong> emphasis inside a help paragraph) — sets innerHTML wholesale,
    // so this is ONLY safe on keys whose value is authored HTML, never on
    // anything that embeds live/user data via {vars}.
    root.querySelectorAll('[data-i18n-html]').forEach(el => {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });

    root.querySelectorAll('[data-i18n-key]').forEach(el => {
      const key = el.getAttribute('data-i18n-key');
      const text = t(key);
      // Replace only the last text node so any leading <i class="fa-..."> icon
      // and trailing <span class="shortcut"> stay intact.
      let target = null;
      for (let i = el.childNodes.length - 1; i >= 0; i--) {
        if (el.childNodes[i].nodeType === Node.TEXT_NODE) { target = el.childNodes[i]; break; }
      }
      if (target) target.textContent = text;
      else el.appendChild(document.createTextNode(text));
    });

    root.querySelectorAll('[data-i18n-attr]').forEach(el => {
      const pairs = el.getAttribute('data-i18n-attr').split(',');
      for (const pair of pairs) {
        const [attr, key] = pair.split(':').map(s => s.trim());
        if (attr && key) el.setAttribute(attr, t(key));
      }
    });
  }

  return { load, t, listLanguages, currentLanguage, isLoaded, applyStaticMarkup };
})();

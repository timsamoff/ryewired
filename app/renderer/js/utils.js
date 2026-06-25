// ── Utility helpers ───────────────────────────────────────────────────────────

const Utils = {
  /** Generate a short unique ID */
  uid(prefix = 'C') {
    return `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  },

  /** Clamp a value between min and max */
  clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  },

  /** Linear interpolation */
  lerp(a, b, t) {
    return a + (b - a) * t;
  },

  /** Map value from one range to another */
  mapRange(v, inMin, inMax, outMin, outMax) {
    return outMin + ((v - inMin) / (inMax - inMin)) * (outMax - outMin);
  },

  /** Format a resistance value nicely */
  formatResistance(ohms) {
    if (ohms >= 1_000_000) return `${(ohms / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}MΩ`;
    if (ohms >= 1_000)     return `${(ohms / 1_000).toFixed(2).replace(/\.?0+$/, '')}kΩ`;
    return `${ohms}Ω`;
  },

  /** Format a capacitance value nicely */
  formatCapacitance(farads) {
    if (farads >= 1)          return `${farads.toFixed(2)}F`;
    if (farads >= 0.001)      return `${(farads * 1000).toFixed(2)}mF`;
    if (farads >= 0.000001)   return `${(farads * 1_000_000).toFixed(2)}µF`;
    if (farads >= 0.000000001) return `${(farads * 1_000_000_000).toFixed(2)}nF`;
    return `${(farads * 1_000_000_000_000).toFixed(2)}pF`;
  },

  /** Deep clone a plain object */
  clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  },

  /** Debounce */
  debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }
};

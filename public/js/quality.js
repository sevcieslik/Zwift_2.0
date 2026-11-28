// Graphics quality presets (saved per browser). Lower settings for laptops / integrated graphics.
export const PRESETS = {
  low: { label: 'Niska', pixelRatio: 1, shadows: 0, trees: 2500, cards: 24, farTrees: 0, lcRes: 768 },
  medium: { label: 'Średnia', pixelRatio: 1.25, shadows: 1024, trees: 6000, cards: 40, farTrees: 15000, lcRes: 1024 },
  high: { label: 'Wysoka', pixelRatio: 2, shadows: 2048, trees: 14000, cards: 64, farTrees: 40000, lcRes: 1024 },
};
let level = 'medium';
try { const v = localStorage.getItem('gpxride.quality'); if (PRESETS[v]) level = v; } catch { /* default */ }
export const QUALITY = { ...PRESETS[level], level };
export function setQuality(l) {
  if (!PRESETS[l]) return;
  Object.assign(QUALITY, PRESETS[l], { level: l });
  try { localStorage.setItem('gpxride.quality', l); } catch { /* ignore */ }
}

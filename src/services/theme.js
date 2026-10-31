// Barevné palety webu (světlý a tmavý režim se volí zvlášť). Paleta = odstín; ostatní barvy se dopočítají.
export const PRESETS = [
  { id: 'ruzova', label: 'Růžová', h: 340, s: 22, orig: true },
  { id: 'koralova', label: 'Korálová', h: 12, s: 38 },
  { id: 'zlata', label: 'Zlatá', h: 38, s: 42 },
  { id: 'zelena', label: 'Zelená', h: 150, s: 28 },
  { id: 'tyrkys', label: 'Tyrkysová', h: 184, s: 36 },
  { id: 'modra', label: 'Modrá', h: 214, s: 34 },
  { id: 'lila', label: 'Lila', h: 270, s: 26 },
  { id: 'grafit', label: 'Grafit', h: 0, s: 4 },
];
export const PRESET_IDS = PRESETS.map((p) => p.id);
const hsl = (h, s, l) => `hsl(${h} ${s}% ${l}%)`;

export function paletteVars(p, mode) {
  if (p.orig) {
    return mode === 'dark'
      ? { mauve: '#9a6174', 'mauve-d': '#d9aebd', rose: '#5a3a46', blush: '#261d21', tint: '#221a1e', tint2: '#1e171b' }
      : { mauve: '#8c5a68', 'mauve-d': '#6d4252', rose: '#e6c4c0', blush: '#f3e3df', tint: '#fbf1f3', tint2: '#f6eef0' };
  }
  const { h, s } = p;
  return mode === 'dark'
    ? { mauve: hsl(h, s + 4, 46), 'mauve-d': hsl(h, Math.min(s + 10, 50), 78), rose: hsl(h, Math.round(s * 0.7), 28), blush: hsl(h, Math.round(s * 0.5), 13), tint: hsl(h, Math.round(s * 0.5), 11.5), tint2: hsl(h, Math.round(s * 0.5), 10.5) }
    : { mauve: hsl(h, s + 4, 38), 'mauve-d': hsl(h, s + 6, 28), rose: hsl(h, Math.round(s * 1.4), 83), blush: hsl(h, Math.round(s * 1.4), 91), tint: hsl(h, Math.round(s * 1.6), 96), tint2: hsl(h, Math.round(s * 1.2), 95) };
}
const decl = (v) => Object.entries(v).map(([k, x]) => `--${k}:${x}`).join(';');

export function themeCss(settings) {
  const find = (id) => PRESETS.find((p) => p.id === id) || PRESETS[0];
  const l = find(settings.theme_light); const d = find(settings.theme_dark);
  return `:root{${decl(paletteVars(l, 'light'))}}\n:root[data-theme=dark]{${decl(paletteVars(d, 'dark'))}}\n`;
}

export const presetList = () => PRESETS.map((p) => ({ id: p.id, label: p.label, light: paletteVars(p, 'light').mauve, dark: paletteVars(p, 'dark').mauve }));

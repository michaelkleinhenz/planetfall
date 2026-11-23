// Small line-art emblems for each game (same 24-unit grid and stroke as the
// toolbar icons). Original artwork, not the games' box art.

export const EMBLEMS = {
  planetfall: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12.5" r="5.2"/><ellipse cx="12" cy="12.5" rx="9.6" ry="2.6" transform="rotate(-14 12 12.5)"/></svg>',
  zork1: '<svg viewBox="0 0 24 24"><path d="M3.5 11.5 12 4.5l8.5 7"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/><path d="M16 6.5V4.5h2V8"/></svg>',
};

export const emblem = (id) => EMBLEMS[id] || EMBLEMS.planetfall;

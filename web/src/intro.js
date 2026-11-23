// The title sequence shown when a new game starts: the box cover flips in as a
// 3D card that follows the pointer and catches the light, over a blurred,
// drifting backdrop made from the cover itself, with sparkles in the cover's
// own colours. The title is set letter by letter, then the blurb, then a
// "Begin" button. Beginning sends the card flying toward the player while the
// story fades in underneath.

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** A few vivid colours from the image (falls back to warm golds). */
function paletteOf(img) {
  const fallback = ['#f2c14e', '#f29e4c', '#fff3c4'];
  try {
    const c = document.createElement('canvas');
    c.width = 24; c.height = 32;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const cols = [];
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
      const max = Math.max(r, g, b); const min = Math.min(r, g, b);
      const sat = max ? (max - min) / max : 0;
      cols.push({ r, g, b, score: sat * 0.7 + (max / 255) * 0.6 });
    }
    cols.sort((a, b) => b.score - a.score);
    // The most vivid colours that differ from each other.
    const picked = [];
    for (const c of cols) {
      if (picked.every((p) => Math.abs(p.r - c.r) + Math.abs(p.g - c.g) + Math.abs(p.b - c.b) > 90)) picked.push(c);
      if (picked.length === 3) break;
    }
    if (!picked.length) return fallback;
    // Lift them so they glow on a dark backdrop.
    return picked.map(({ r, g, b }) => {
      const k = 255 / Math.max(r, g, b, 1);
      const lift = (v) => Math.round(Math.min(255, v * Math.min(k, 1.6) * 0.85 + 40));
      return `rgb(${lift(r)}, ${lift(g)}, ${lift(b)})`;
    });
  } catch {
    return fallback;
  }
}

/** Sparkles drifting upward, twinkling, in the palette's colours. */
function sparkles(canvas, palette) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, devicePixelRatio || 1);
  let w = 0; let h = 0; let raf = 0; let burst = 0;
  const resize = () => {
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  addEventListener('resize', resize);
  const make = (y) => ({
    x: Math.random() * w, y: y ?? Math.random() * h, r: 0.6 + Math.random() * 1.9,
    vy: 0.15 + Math.random() * 0.55, vx: (Math.random() - 0.5) * 0.25,
    phase: Math.random() * Math.PI * 2, speed: 0.02 + Math.random() * 0.05,
    color: palette[Math.floor(Math.random() * palette.length)], star: Math.random() < 0.18,
  });
  const n = Math.round(Math.min(110, (w * h) / 9000));
  const parts = Array.from({ length: n }, () => make());
  const star = (x, y, r) => {
    ctx.beginPath();
    ctx.moveTo(x, y - r * 3); ctx.lineTo(x + r * 0.6, y - r * 0.6); ctx.lineTo(x + r * 3, y);
    ctx.lineTo(x + r * 0.6, y + r * 0.6); ctx.lineTo(x, y + r * 3); ctx.lineTo(x - r * 0.6, y + r * 0.6);
    ctx.lineTo(x - r * 3, y); ctx.lineTo(x - r * 0.6, y - r * 0.6); ctx.closePath(); ctx.fill();
  };
  const frame = () => {
    ctx.clearRect(0, 0, w, h);
    const boost = 1 + burst * 6;
    for (const p of parts) {
      p.y -= p.vy * boost; p.x += p.vx * boost; p.phase += p.speed;
      if (p.y < -10) Object.assign(p, make(h + 10));
      const a = 0.25 + 0.75 * Math.abs(Math.sin(p.phase));
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color; ctx.shadowBlur = 8;
      if (p.star) star(p.x, p.y, p.r * 0.9);
      else { ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    burst *= 0.96;
    raf = requestAnimationFrame(frame);
  };
  frame();
  return {
    burst() { burst = 1; },
    stop() { cancelAnimationFrame(raf); removeEventListener('resize', resize); },
  };
}

/**
 * Show the title sequence for a game. Resolves when the player begins.
 * `t(key)` translates; `lang` picks the blurb.
 */
export function playIntro(meta, { t, lang = 'en' }) {
  return new Promise((resolve) => {
    if (!meta?.cover) { resolve(); return; }
    const calm = reducedMotion();
    const root = el('div', 'intro');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', meta.title);
    const bg = el('div', 'intro-bg');
    bg.style.backgroundImage = `url("${meta.cover}")`;
    const canvas = el('canvas', 'intro-sparks');
    const stage = el('div', 'intro-stage');

    const tilt = el('div', 'intro-tilt');
    const card = el('div', 'intro-card');
    const img = el('img', 'intro-img');
    img.src = meta.cover;
    img.alt = `${meta.title} — cover`;
    const glare = el('div', 'intro-glare');
    const sheen = el('div', 'intro-sheen');
    card.append(img, sheen, glare);
    tilt.append(card, el('div', 'intro-shadow'));

    const text = el('div', 'intro-text');
    const kicker = el('p', 'intro-kicker', `Infocom · ${meta.year}`);
    const title = el('h1', 'intro-title');
    [...meta.title].forEach((ch, i) => {
      const s = el('span', ch === ' ' ? 'sp' : '', ch === ' ' ? ' ' : ch);
      s.style.setProperty('--i', i);
      title.append(s);
    });
    const by = el('p', 'intro-by', meta.author);
    const blurb = el('p', 'intro-blurb', meta.blurb?.[lang] ?? meta.blurb?.en ?? '');
    const begin = el('button', 'intro-begin');
    begin.type = 'button';
    begin.append(el('span', 'intro-begin-label', t('introBegin')), el('kbd', '', '↵'));
    const skip = el('p', 'intro-hint', t('introHint'));
    text.append(kicker, title, by, blurb, begin, skip);
    text.style.setProperty('--letters', meta.title.length);
    stage.append(tilt, text);
    root.append(bg, canvas, stage);
    document.body.append(root);
    document.body.classList.add('intro-open');

    let fx = null;
    const ready = () => {
      root.style.setProperty('--glow-1', 'rgb(242 193 78)');
      const pal = paletteOf(img);
      pal.forEach((c, i) => root.style.setProperty(`--glow-${i + 1}`, c));
      if (!calm) fx = sparkles(canvas, pal);
      requestAnimationFrame(() => root.classList.add('in'));
    };
    if (img.complete && img.naturalWidth) ready();
    else { img.addEventListener('load', ready, { once: true }); img.addEventListener('error', ready, { once: true }); }

    // The card follows the pointer; the glare moves to where the light falls.
    const onMove = (e) => {
      if (calm || done) return;
      const r = card.getBoundingClientRect();
      const x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      const y = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
      tilt.style.setProperty('--rx', `${(-y * 9).toFixed(2)}deg`);
      tilt.style.setProperty('--ry', `${(x * 12).toFixed(2)}deg`);
      card.style.setProperty('--gx', `${((x + 1) * 50).toFixed(1)}%`);
      card.style.setProperty('--gy', `${((y + 1) * 50).toFixed(1)}%`);
    };
    root.addEventListener('pointermove', onMove);

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      fx?.burst();
      root.classList.add('out');
      document.body.classList.add('intro-leaving');
      removeEventListener('keydown', onKey, true);
      const end = () => {
        fx?.stop();
        root.remove();
        document.body.classList.remove('intro-open', 'intro-leaving');
        resolve();
      };
      setTimeout(end, calm ? 250 : 1100);
    };
    const onKey = (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); }
    };
    addEventListener('keydown', onKey, true);
    begin.addEventListener('click', finish);
    card.addEventListener('click', finish);
    setTimeout(() => begin.focus({ preventScroll: true }), 50);
  });
}

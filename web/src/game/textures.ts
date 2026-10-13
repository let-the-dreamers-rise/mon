import * as THREE from 'three';

let seed = 7;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
}

function stain(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number) {
  const grad = g.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, color.replace('A', String(alpha)));
  grad.addColorStop(0.6, color.replace('A', String(alpha * 0.4)));
  grad.addColorStop(1, color.replace('A', '0'));
  g.fillStyle = grad;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

function noise(g: CanvasRenderingContext2D, w: number, h: number, amount: number) {
  const img = g.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * amount;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

function tex(c: HTMLCanvasElement, repeatX = 1, repeatY = 1, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Mono-yellow office wallpaper: faded chevron stripes, water damage, grime at the skirting. */
export function wallpaper() {
  const [c, g] = canvas(512, 512);
  g.fillStyle = '#a99a5c';
  g.fillRect(0, 0, 512, 512);
  // chevron pattern
  g.strokeStyle = 'rgba(80,70,30,0.18)';
  g.lineWidth = 3;
  for (let x = -32; x < 544; x += 32) {
    for (let y = 0; y < 512; y += 24) {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + 16, y + 12);
      g.lineTo(x + 32, y);
      g.stroke();
    }
  }
  g.fillStyle = 'rgba(255,240,170,0.06)';
  for (let x = 0; x < 512; x += 64) g.fillRect(x, 0, 6, 512);
  noise(g, 512, 512, 22);
  for (let i = 0; i < 7; i++) stain(g, rnd() * 512, rnd() * 512, 30 + rnd() * 90, 'rgba(70,52,18,A)', 0.35);
  // drip marks
  for (let i = 0; i < 10; i++) {
    const x = rnd() * 512;
    const grad = g.createLinearGradient(x, 0, x, 512);
    grad.addColorStop(0, 'rgba(60,45,15,0.0)');
    grad.addColorStop(0.3, 'rgba(60,45,15,0.25)');
    grad.addColorStop(1, 'rgba(60,45,15,0.05)');
    g.fillStyle = grad;
    g.fillRect(x, 0, 2 + rnd() * 3, 300 + rnd() * 212);
  }
  // grime at the bottom
  const grime = g.createLinearGradient(0, 400, 0, 512);
  grime.addColorStop(0, 'rgba(30,22,8,0)');
  grime.addColorStop(1, 'rgba(30,22,8,0.55)');
  g.fillStyle = grime;
  g.fillRect(0, 400, 512, 112);
  // skirting board
  g.fillStyle = '#5c5032';
  g.fillRect(0, 492, 512, 20);
  return tex(c);
}

/** Damp low-pile carpet with dark wet patches. */
export function carpet() {
  const [c, g] = canvas(512, 512);
  g.fillStyle = '#7d6e48';
  g.fillRect(0, 0, 512, 512);
  noise(g, 512, 512, 46);
  for (let i = 0; i < 14; i++) stain(g, rnd() * 512, rnd() * 512, 20 + rnd() * 80, 'rgba(35,26,10,A)', 0.4);
  for (let i = 0; i < 5; i++) stain(g, rnd() * 512, rnd() * 512, 40 + rnd() * 60, 'rgba(20,20,12,A)', 0.35);
  return tex(c, 20, 20);
}

/** Drop-ceiling tiles. */
export function ceiling() {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#cfc6a6';
  g.fillRect(0, 0, 256, 256);
  noise(g, 256, 256, 26);
  g.strokeStyle = '#8f876b';
  g.lineWidth = 6;
  g.strokeRect(0, 0, 256, 256);
  for (let i = 0; i < 3; i++) stain(g, rnd() * 256, rnd() * 256, 20 + rnd() * 50, 'rgba(110,80,30,A)', 0.4);
  return tex(c, 32, 32);
}

/** Roughness map for walls/floor so the flashlight hotspot reads as real material. */
export function roughness(repeat: number) {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#d0d0d0';
  g.fillRect(0, 0, 256, 256);
  noise(g, 256, 256, 70);
  for (let i = 0; i < 6; i++) stain(g, rnd() * 256, rnd() * 256, 20 + rnd() * 40, 'rgba(60,60,60,A)', 0.6);
  return tex(c, repeat, repeat, false);
}

/** Flashlight cookie: an uneven hotspot with rings, like a cheap torch. */
export function flashlightCookie() {
  const [c, g] = canvas(256, 256);
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.18, '#f4f0e6');
  grad.addColorStop(0.24, '#cfcac0');
  grad.addColorStop(0.3, '#e8e4da');
  grad.addColorStop(0.62, '#6b6860');
  grad.addColorStop(1, '#000000');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  noise(g, 256, 256, 18);
  return tex(c, 1, 1, false);
}

/** Text label texture (name tags, signs). */
export function label(text: string, opts: { w?: number; h?: number; bg?: string; fg?: string; font?: string } = {}) {
  const w = opts.w ?? 256;
  const h = opts.h ?? 64;
  const [c, g] = canvas(w, h);
  g.fillStyle = opts.bg ?? '#e8e2cf';
  g.fillRect(0, 0, w, h);
  g.fillStyle = opts.fg ?? '#1a1712';
  g.font = opts.font ?? 'bold 34px "Courier New", monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text.toUpperCase(), w / 2, h / 2 + 2);
  noise(g, w, h, 20);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** a lit window seen from the street at night: frame, mullions, half-drawn blinds, a curtain edge */
export function litWindow() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 80;
  const g = c.getContext('2d')!;
  const glow = g.createRadialGradient(36, 46, 4, 32, 40, 48);
  glow.addColorStop(0, '#ffffff');
  glow.addColorStop(0.6, '#b9b0a0');
  glow.addColorStop(1, '#5a5148');
  g.fillStyle = glow;
  g.fillRect(0, 0, 64, 80);
  // blinds: pulled down a third of the way
  g.fillStyle = 'rgba(30,24,18,0.55)';
  for (let y = 4; y < 30; y += 3) g.fillRect(4, y, 56, 1.6);
  // a curtain hanging at the left
  g.fillStyle = 'rgba(20,14,10,0.85)';
  g.beginPath();
  g.moveTo(4, 4);
  g.bezierCurveTo(18, 30, 10, 55, 16, 76);
  g.lineTo(4, 76);
  g.fill();
  // frame and mullions
  g.strokeStyle = '#0b0a09';
  g.lineWidth = 5;
  g.strokeRect(2, 2, 60, 76);
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(32, 2);
  g.lineTo(32, 78);
  g.moveTo(2, 42);
  g.lineTo(62, 42);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

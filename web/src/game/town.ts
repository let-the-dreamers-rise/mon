import * as THREE from 'three';
import { formatEther } from 'viem';
import { ITEMS, SHOP_RADIUS_CM } from '../config';
import map from '../map.json';
import { objective, unpack, type UsedEvent } from '../chain/night';
import type { Game } from './game';
import { CELL, isIndoor, placeAt, tileAt } from './world';

const $ = (id: string) => document.getElementById(id)!;
const GRID = 64;

/** Halden's systems on top of the core night: shops, pockets, items, the map, weather transitions. */
export class Town {
  selected = 0;
  shopOpen = -1;
  private indoors = false;
  private adrenalineUntil = 0;
  private pillsUntil = 0;
  private photo: { at: number; body: number; developed: boolean } | null = null;
  snapPending = false;
  private outdoorFog = new THREE.Color(0x06080b);
  private indoorFog = new THREE.Color(0x0b0a06);
  private lastItemsKey = '';
  private buying = false;

  constructor(private g: Game) {
    addEventListener('keydown', (e) => this.key(e));
    this.drawMapBase();
  }

  get speedScale() {
    return performance.now() < this.adrenalineUntil ? 1.15 : 1;
  }
  get infiniteStamina() {
    return performance.now() < this.adrenalineUntil;
  }
  get visionsSuppressed() {
    return performance.now() < this.pillsUntil;
  }

  private key(e: KeyboardEvent) {
    const g = this.g;
    if (g.mode !== 'play' || !g.night) return;
    if (e.code === 'Tab') {
      e.preventDefault();
      this.selected = (this.selected + 1) % ITEMS.length;
      this.renderItems(true);
    } else if (e.code === 'KeyQ' && !e.repeat) this.useSelected();
    else if (e.code === 'KeyE' && !e.repeat) {
      if (this.shopOpen >= 0) this.closeShop();
      else {
        const s = this.nearShop();
        if (s >= 0) this.openShop(s);
      }
    } else if (e.code === 'Escape' && this.shopOpen >= 0) this.closeShop();
    else if (e.code === 'KeyM' && !e.repeat) {
      const m = $('townmap');
      m.classList.toggle('hidden');
      if (!m.classList.contains('hidden')) this.drawMap();
    }
  }

  // ------------------------------------------------------------------ per frame
  update(now: number, dt: number) {
    const g = this.g;
    const p = g.player.position;
    // weather & fog: the street is cold and wet, the buildings are close and yellow
    const inside = isIndoor(p.x, p.z);
    if (inside !== this.indoors) {
      this.indoors = inside;
      g.audio.setOutdoors(!inside);
    }
    const fog = g.scene.fog as THREE.FogExp2;
    fog.color.lerp(inside ? this.indoorFog : this.outdoorFog, Math.min(1, dt * 2));
    fog.density += ((inside ? 0.085 : 0.055) - fog.density) * Math.min(1, dt * 2);
    $('place').textContent = placeAt(p.x, p.z);

    // prompts
    let prompt = '';
    const shop = this.nearShop();
    if (shop >= 0 && this.shopOpen < 0) prompt = `E — ${map.shops[shop].name} TERMINAL`;
    const fuseIdx = this.nearFuse();
    if (fuseIdx >= 0 && !((g.night?.header?.fuses ?? 0) & (1 << fuseIdx))) prompt = 'FUSE BOX — HOLD STILL A MOMENT';
    if (this.near(objective(3), 4) && !g.night?.header?.exitOpenBlock) prompt = 'THE GATE HAS NO POWER. FIND THE THREE FUSES.';
    $('prompt').textContent = prompt;
    $('prompt').classList.toggle('hidden', !prompt || g.mode !== 'play');
    if (this.shopOpen >= 0 && shop !== this.shopOpen) this.closeShop();
    this.renderItems(false);

    // polaroid develops
    if (this.photo && !this.photo.developed && now - this.photo.at > 300) {
      this.photo.developed = true;
      $('photo').classList.add('developed');
    }
  }

  private near(packed: number, metres: number) {
    const o = unpack(packed);
    const p = this.g.player.position;
    return Math.hypot(o.x / 100 - p.x, o.y / 100 - p.z) < metres;
  }

  nearShop(): number {
    for (let s = 0; s < 3; s++) if (this.near(objective(4 + s), (SHOP_RADIUS_CM - 40) / 100)) return s;
    return -1;
  }

  private nearFuse(): number {
    for (let f = 0; f < 3; f++) if (this.near(objective(f), 2)) return f;
    return -1;
  }

  // ------------------------------------------------------------------ pockets
  private myPockets(): number[] {
    const g = this.g;
    const body = g.pilot?.body ?? -1;
    return (body >= 0 && g.night?.pockets[body]) || [0, 0, 0, 0, 0, 0];
  }

  private renderItems(force: boolean) {
    const counts = this.myPockets();
    const key = counts.join(',') + ':' + this.selected;
    if (!force && key === this.lastItemsKey) return;
    this.lastItemsKey = key;
    $('items').innerHTML = ITEMS.map(
      (it, i) => `<div class="slot${counts[i] ? ' has' : ''}${i === this.selected ? ' sel' : ''}"><b>${counts[i]}</b>${it.name.toUpperCase()}</div>`,
    ).join('');
  }

  // ------------------------------------------------------------------ shops
  private openShop(s: number) {
    this.shopOpen = s;
    document.exitPointerLock?.();
    $('shop').classList.remove('hidden');
    $('shop-title').textContent = map.shops[s].name;
    const list = $('shop-items');
    list.innerHTML = '';
    for (const it of ITEMS.filter((i) => i.shop === s)) {
      const b = document.createElement('button');
      b.innerHTML = `<span>${it.name.toUpperCase()}<small>${it.desc}</small></span><span>${formatEther(it.price)} MON</span>`;
      b.onclick = () => void this.buy(it.id);
      list.appendChild(b);
    }
    void this.g.audio.play('ui_click.mp3', 0.5);
  }

  closeShop() {
    this.shopOpen = -1;
    $('shop').classList.add('hidden');
    this.g.player.lock();
  }

  private async buy(item: number) {
    const g = this.g;
    const n = g.night;
    const body = g.pilot?.body ?? -1;
    if (!n || body < 0 || this.buying) return;
    const it = ITEMS[item];
    const idx = n.findAtCounter(body, it.shop, SHOP_RADIUS_CM);
    if (idx === null) {
      g.hud.subtitle('the terminal is still reading your position… (one moment)');
      return;
    }
    const e = n.epochAt(n.blockOfIndex(idx));
    if (!e) return;
    this.buying = true;
    const hash = await g.wallet.call('buy', [n.id, g.mySoul, e.index, body, idx, item], { value: it.price });
    this.buying = false;
    if (hash) {
      g.hud.subtitle(`${it.name.toLowerCase()} → this body's pockets`);
      void g.audio.play('ui_click.mp3', 0.7);
      setTimeout(() => void n.pollPockets(), 1200);
    }
  }

  // ------------------------------------------------------------------ items
  private useSelected() {
    const g = this.g;
    const n = g.night;
    const body = g.pilot?.body ?? -1;
    if (!n || body < 0) return;
    const item = this.selected;
    if (!this.myPockets()[item]) {
      g.hud.subtitle(`no ${ITEMS[item].name.toLowerCase()} in these pockets`);
      return;
    }
    void g.wallet.call('use', [n.id, g.mySoul, body, item]);
    // optimistic: apply locally right away, everyone else sees it via the Used event
    n.pockets[body][item] -= 1;
    this.applyLocal(item);
  }

  private applyLocal(item: number) {
    const g = this.g;
    const now = performance.now();
    const at = new THREE.Vector3(g.player.position.x, 0, g.player.position.z);
    if (item === 0) {
      g.player.battery = 1;
      void g.audio.play('flashlight_click.mp3', 0.8);
    } else if (item === 1) {
      g.world.flare(at, now);
      void g.audio.play('fuse_pickup.mp3', 0.6, 1.4);
    } else if (item === 2) {
      void g.audio.lullaby(at.clone().setY(1));
    } else if (item === 3) {
      g.psych.sanity = Math.min(1, g.psych.sanity + 0.4);
      this.pillsUntil = now + 30000;
      g.psych.clearPhantoms();
    } else if (item === 4) {
      this.adrenalineUntil = now + 12000;
      g.player.stamina = 1;
      g.player.shake = 0.6;
    } else if (item === 5) {
      this.takePhoto();
    }
  }

  /** someone else used an item: flares and music boxes and camera flashes are public */
  onUsed(u: UsedEvent) {
    const g = this.g;
    const myBody = g.pilot?.body ?? -1;
    if (u.body === myBody && g.mode === 'play') return; // already applied locally
    const o = unpack(u.pos);
    const at = new THREE.Vector3(o.x / 100, 0, o.y / 100);
    if (u.item === 1) g.world.flare(at, performance.now());
    else if (u.item === 2) void g.audio.lullaby(at.clone().setY(1));
    else if (u.item === 5) {
      g.world.flashAt(at.clone().setY(1.6));
      g.audio.shutter();
    }
  }

  // ------------------------------------------------------------------ the polaroid: the truth costs money and five seconds
  private takePhoto() {
    const g = this.g;
    const n = g.night!;
    g.audio.shutter();
    g.world.flashAt(g.player.yawObj.position.clone());
    g.fx.staticBurst = 0.25;
    // find the figure nearest the centre of the lens
    const cam = g.player.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    const eye = cam.getWorldPosition(new THREE.Vector3());
    let best = -1, bestDot = 0.96;
    g.figures.forEach((f, b) => {
      if (!f.root.visible) return;
      const to = f.root.position.clone().setY(1.5).sub(eye);
      const d = to.length();
      if (d > 18) return;
      const dot = to.normalize().dot(fwd);
      if (dot > bestDot) {
        bestDot = dot;
        best = b;
      }
    });
    this.snapPending = true;
    this.photo = { at: performance.now(), body: best, developed: false };
    $('photo').classList.remove('hidden', 'developed');
    const cap = $('photo-cap');
    cap.classList.remove('hollow');
    if (best < 0) {
      cap.textContent = 'nothing. there was nothing there.';
    } else {
      const est = n.estBlock();
      const soul = n.soulInBody(best, est);
      const owner = n.souls[best]?.name ?? '??';
      const inside = n.souls[soul]?.name ?? '??';
      if (n.isHollowAt(soul, est)) {
        cap.textContent = `${owner}… IT IS NOT ${inside}. IT'S HOLLOW.`;
        cap.classList.add('hollow');
      } else cap.textContent = soul === best ? `${owner}. really ${owner}.` : `${inside}, wearing ${owner}`;
    }
    setTimeout(() => $('photo').classList.add('hidden'), 14000);
  }

  /** called right after a frame is rendered, so the canvas still holds the image */
  capture(canvas: HTMLCanvasElement) {
    if (!this.snapPending) return;
    this.snapPending = false;
    const ctx = ($('photo-canvas') as HTMLCanvasElement).getContext('2d')!;
    const w = canvas.width, h = canvas.height;
    const sw = Math.min(w, (h * 4) / 3);
    ctx.drawImage(canvas, (w - sw) / 2, 0, sw, h, 0, 0, 320, 240);
  }

  // ------------------------------------------------------------------ the map
  private base: HTMLCanvasElement | null = null;
  private drawMapBase() {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const x = c.getContext('2d')!;
    x.fillStyle = '#d8ceb0';
    x.fillRect(0, 0, 512, 512);
    const s = 512 / GRID;
    const colors: Record<string, string> = { '#': '#5a5040', W: '#3a3024', T: '#4a5a3a', '~': '#2a3a48', F: '#2a2418', p: '#9aa880', '.': '#cfc4a4', ',': '#bfb494', a: '#b0a484', G: '#a02010' };
    for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
      const t = tileAt(gx, gy);
      x.fillStyle = colors[t] ?? '#c8bc9a';
      x.fillRect(gx * s, gy * s, s + 0.5, s + 0.5);
    }
    x.fillStyle = '#1a140c';
    x.font = 'bold 14px "Courier New", monospace';
    x.textAlign = 'center';
    for (const l of map.landmarks) {
      const [x0, y0, x1, y1] = l.rect;
      x.fillText(l.name, ((x0 + x1 + 1) / 2) * s, ((y0 + y1 + 1) / 2) * s);
    }
    for (const sh of map.shops) x.fillText(sh.name.replace('ST. AGNES ', ''), ((sh.rect[0] + sh.rect[2] + 1) / 2) * s, (sh.rect[1] - 0.4) * s);
    x.fillText('BRIDGE ►', 55 * s, 29 * s);
    x.fillText('PARK', 46 * s, 50 * s);
    this.base = c;
  }

  private drawMap() {
    const ctx = ($('map-canvas') as HTMLCanvasElement).getContext('2d')!;
    if (this.base) ctx.drawImage(this.base, 0, 0);
    const s = 512 / GRID;
    const p = this.g.player.position;
    ctx.strokeStyle = '#c0180c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc((p.x / CELL) * s, (p.z / CELL) * s, 7, 0, Math.PI * 2);
    ctx.stroke();
    // fuses already in
    const fuses = this.g.night?.header?.fuses ?? 0;
    map.fuseCells.forEach(([fx, fy], i) => {
      ctx.fillStyle = fuses & (1 << i) ? '#2a8a3a' : '#a02010';
      ctx.fillRect(fx * s - 3, fy * s - 3, 6, 6);
    });
  }
}

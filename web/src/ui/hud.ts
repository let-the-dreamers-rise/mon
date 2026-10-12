import { NET, NIGHT_BLOCKS, type Hex } from '../config';
import type { NightState, Pilot } from '../chain/night';
import type { Mode } from '../game/game';
import type { Player } from '../game/player';
import type { Psych } from '../game/psych';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface HudState {
  now: number;
  est: number;
  night: NightState;
  mode: Mode;
  myBody: number;
  soul: number;
  hollow: boolean;
  player: Player;
  psych: Psych;
  pilot: Pilot | null;
  watchBody: number;
  watchers: number;
}

/** The bodycam overlay. Plain DOM, updated a few times a second. */
export class Hud {
  private root = $('hud');
  private scrambleUntil = 0;
  private lastUpdate = 0;
  private subsTimer = 0;
  private lost = false;
  private feedEl = $('feed');
  private txEl = $('txfeed');
  private recBlink = false;

  show(mode: Mode) {
    this.root.classList.remove('hidden');
    this.root.dataset.mode = mode;
    $('watchpanel').classList.toggle('hidden', mode !== 'watch');
    $('controls').classList.toggle('hidden', mode !== 'play');
  }

  hide() {
    this.root.classList.add('hidden');
  }

  block(b: number) {
    this.recBlink = !this.recBlink;
    $('rec').classList.toggle('dim', this.recBlink);
    $('blocknum').textContent = `BLOCK #${b.toLocaleString('en-US')}`;
  }

  scrambleCam(ms: number) {
    this.scrambleUntil = performance.now() + ms;
  }

  center(title: string, sub = '') {
    const el = $('center');
    el.classList.toggle('hidden', !title);
    $('center-title').textContent = title;
    $('center-sub').textContent = sub;
  }

  subtitle(text: string) {
    const el = $('subs');
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(this.subsTimer);
    this.subsTimer = window.setTimeout(() => el.classList.remove('on'), 3200);
  }

  flash(text: string) {
    if (text) this.subtitle(text);
  }

  feed(text: string) {
    const li = document.createElement('div');
    li.className = 'feed-item';
    li.textContent = text;
    this.feedEl.prepend(li);
    setTimeout(() => li.classList.add('fade'), 6000);
    setTimeout(() => li.remove(), 8000);
    while (this.feedEl.children.length > 5) this.feedEl.lastChild?.remove();
  }

  tx(hash: Hex, fn: string) {
    const a = document.createElement(NET.explorer ? 'a' : 'span') as HTMLAnchorElement;
    a.className = 'tx';
    a.textContent = `${fn} ${hash.slice(0, 8)}…`;
    if (NET.explorer) {
      a.href = `${NET.explorer}/tx/${hash}`;
      a.target = '_blank';
      a.rel = 'noopener';
    }
    this.txEl.prepend(a);
    while (this.txEl.children.length > 6) this.txEl.lastChild?.remove();
  }

  originalLost() {
    this.lost = true;
  }

  update(s: HudState) {
    if (s.now - this.lastUpdate < 90) return;
    this.lastUpdate = s.now;
    const n = s.night;
    const h = n.header;
    if (!h) return;

    // camera label: scrambled after a swap — you have to look at your hands to know
    const camBody = s.mode === 'watch' ? s.watchBody : s.myBody;
    const scrambling = s.now < this.scrambleUntil;
    $('cam').textContent = scrambling ? `CAM ${glyphs(2)}` : camBody >= 0 ? `CAM ${String(camBody + 1).padStart(2, '0')}` : 'CAM --';
    $('cam').classList.toggle('glitch', scrambling);

    // clock since lights out
    const secs = Math.max(0, ((s.est - h.startBlock) * n.msPerBlock) / 1000);
    const left = Math.max(0, ((h.startBlock + NIGHT_BLOCKS - s.est) * n.msPerBlock) / 1000);
    $('clock').textContent = h.startBlock ? `${fmt(secs)}  ·  DAWN IN ${fmt(left)}` : 'WAITING';

    // objective
    const fuses = countBits(h.fuses);
    let objective = h.exitOpenBlock ? 'THE EXIT HAS POWER — GET OUT' : `FIND THE FUSES  ${fuses}/3`;
    if (s.hollow) objective = 'TOUCH THE LIVING. THEY CANNOT TELL.';
    if (s.mode === 'watch') objective = `WATCHING CAM ${String(s.watchBody + 1).padStart(2, '0')} · ${h.living} LIVING`;
    $('objective').textContent = objective;
    $('objective').classList.toggle('hollow', s.hollow);

    $('watchers').textContent = `${s.watchers} WATCHING`;
    $('living').textContent = `${h.living} LIVING`;

    // battery + stamina
    const bars = Math.ceil(s.player.battery * 5);
    $('battery').textContent = '▮'.repeat(bars) + '▯'.repeat(5 - bars);
    $('battery').classList.toggle('low', s.player.battery < 0.2);
    ($('stamina') as HTMLElement).style.width = `${Math.round(s.player.stamina * 100)}%`;

    // latency: proof that every step is a Monad transaction
    if (s.pilot) {
      $('latency').textContent = s.pilot.lastConfirmLatencyMs
        ? `${s.pilot.sentSamples} STEPS ONCHAIN · ${Math.round(s.pilot.lastConfirmLatencyMs)}ms`
        : `${s.pilot.sentSamples} STEPS ONCHAIN`;
    }

    // wrist: only when you look down at your own hands
    const wrist = $('wrist');
    const lookingDown = s.mode === 'play' && s.player.pitch < -0.55;
    wrist.classList.toggle('on', lookingDown);
    if (lookingDown && s.myBody >= 0) {
      const owner = n.souls[s.myBody]?.name ?? '??????';
      $('wrist-id').textContent = s.myBody === s.soul ? `ID · ${owner} (YOU)` : `ID · ${owner}`;
      $('wrist-id').classList.toggle('notyou', s.myBody !== s.soul);
      // your original body's vitals
      if (s.soul >= 0) {
        if (this.lost) {
          $('wrist-vitals').textContent = 'YOUR BODY · SIGNAL LOST';
          $('wrist-vitals').classList.add('lost');
        } else if (s.myBody === s.soul) {
          $('wrist-vitals').textContent = `YOUR BODY · ♥ ${Math.round(70 + s.psych.fear * 80)} BPM`;
        } else {
          const rp = n.renderPosition(s.soul, n.indexAtBlock(s.est) - 1);
          const dx = rp.x / 100 - s.player.position.x;
          const dz = rp.y / 100 - s.player.position.z;
          const dist = Math.hypot(dx, dz);
          const speed = Math.hypot(rp.vx, rp.vy) / 100 / 0.6;
          const bpm = Math.round(68 + speed * 28 + Math.sin(s.now / 700) * 3);
          $('wrist-vitals').textContent = `YOUR BODY · ♥ ${bpm} BPM · ${Math.round(dist)}m ${compass(dx, dz)} · SOMEONE IS WEARING IT`;
        }
      }
    }
  }
}

const GLYPHS = '█▓▒░#@%&?';
function glyphs(k: number) {
  let s = '';
  for (let i = 0; i < k; i++) s += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
  return s;
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function compass(dx: number, dz: number) {
  const a = (Math.atan2(dx, -dz) * 180) / Math.PI;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((a + 360) % 360) / 45) % 8];
}

function countBits(v: number) {
  let c = 0;
  while (v) {
    c += v & 1;
    v >>= 1;
  }
  return c;
}

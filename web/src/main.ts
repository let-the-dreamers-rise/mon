import { formatEther, parseEther } from 'viem';
import { FEATURED_NIGHT, IS_LOCAL, MON_PER_MINUTE, NET, NIGHT_BLOCKS, TORMENTS, type Hex } from './config';
import { hollowAbi } from './chain/abi';
import { NightState, encodeName, short } from './chain/night';
import { ReplayNight } from './chain/replay';
import { Burner, connectInjected, explainError, fundFromInjected, injectedAddress, publicClient } from './chain/wallet';
import { Game } from './game/game';
import { Psych } from './game/psych';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (id: string) => ['title', 'lobby', 'end'].forEach((s) => $(s).classList.toggle('hidden', s !== id));

const wallet = new Burner();
const game = new Game($('view') as HTMLCanvasElement, wallet);
if (import.meta.env.DEV) (window as unknown as { __hollow: Game }).__hollow = game;
let mode: 'play' | 'watch' = 'play';
let selected: bigint | null = null;
let entered = false;

function toast(msg: string, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  setTimeout(() => t.classList.remove('on'), ms);
}

wallet.onError = (fn, err) => {
  const msg = explainError(err);
  if (/insufficient funds/i.test(msg)) toast('Out of MON for gas — top up the session wallet.');
  else if (!['record', 'turn', 'collectFuse', 'escape', 'sync'].includes(fn)) toast(`${fn} failed: ${msg.slice(0, 120)}`);
};

// ------------------------------------------------------------------ title
$('addr').textContent = wallet.address;
const savedName = (() => {
  try {
    return localStorage.getItem('hollow.name') ?? '';
  } catch {
    return '';
  }
})();
($('name') as HTMLInputElement).value = savedName;

async function refreshBalance() {
  try {
    const bal = await wallet.balanceText();
    $('bal').textContent = bal;
    const minutes = Number(bal) / MON_PER_MINUTE;
    $('playtime').textContent = minutes >= 1 ? `≈ ${Math.floor(minutes)} min of walking` : Number(bal) > 0 ? 'under a minute of walking' : '';
  } catch {
    $('bal').textContent = '?';
  }
}
void refreshBalance();
setInterval(refreshBalance, 8000);

$('copy').onclick = async () => {
  await navigator.clipboard?.writeText(wallet.address);
  toast('session address copied');
};
$('fund').onclick = async () => {
  try {
    await fundFromInjected(wallet.address, parseEther('1'));
    toast('top-up sent — it lands in about a second on Monad');
    setTimeout(refreshBalance, 2500);
  } catch (e) {
    toast(String((e as Error).message ?? e).slice(0, 140));
  }
};

$('sweep').onclick = async () => {
  try {
    const to = await connectInjected();
    if (!confirm(`Send everything in this session wallet to ${to}?`)) return;
    const hash = await wallet.sweep(to);
    toast(hash ? 'withdrawn to your wallet' : 'nothing to withdraw');
    setTimeout(refreshBalance, 2500);
  } catch (e) {
    toast(String((e as Error).message ?? e).slice(0, 140));
  }
};

async function saveName() {
  const name = ($('name') as HTMLInputElement).value.trim();
  if (!name) return;
  try {
    localStorage.setItem('hollow.name', name);
  } catch {
    /* ignore */
  }
  const current = (await publicClient.readContract({ address: NET.hollow, abi: hollowAbi, functionName: 'names', args: [wallet.address] })) as Hex;
  if (current !== encodeName(name)) void wallet.call('setName', [encodeName(name)]);
}

$('btn-play').onclick = async () => {
  mode = 'play';
  await game.audio.start();
  void game.audio.play('ui_click.mp3', 0.5);
  void saveName();
  await openLobby();
};
$('btn-watch').onclick = async () => {
  mode = 'watch';
  await game.audio.start();
  await openLobby();
};
$('btn-back').onclick = () => show('title');
$('btn-footage').onclick = async () => {
  await game.audio.start();
  void game.audio.play('ui_click.mp3', 0.5);
  let id = FEATURED_NIGHT;
  if (!id) {
    // the most recent night that is over
    const count = (await publicClient.readContract({ address: NET.hollow, abi: hollowAbi, functionName: 'nightCount' })) as bigint;
    const block = await publicClient.getBlockNumber();
    for (let i = count; i > 0n; i--) {
      const n = (await publicClient.readContract({ address: NET.hollow, abi: hollowAbi, functionName: 'nights', args: [i] })) as { startBlock: bigint; endBlock: bigint };
      if (n.startBlock && (n.endBlock || block >= n.startBlock + BigInt(NIGHT_BLOCKS))) {
        id = i;
        break;
      }
    }
  }
  if (id) void enterReplay(id);
  else toast('no finished night to recover yet');
};

// ------------------------------------------------------------------ lobby
let lobbyTimer = 0;
async function openLobby() {
  show('lobby');
  $('lobby-title').textContent = mode === 'play' ? 'CHOOSE A NIGHT' : 'CHOOSE A NIGHT TO WATCH';
  $('btn-create').classList.toggle('hidden', mode === 'watch');
  await renderNights();
  clearInterval(lobbyTimer);
  lobbyTimer = window.setInterval(renderNights, 1500);
}

async function renderNights() {
  if (entered) return;
  let count = 0n;
  try {
    count = (await publicClient.readContract({ address: NET.hollow, abi: hollowAbi, functionName: 'nightCount' })) as bigint;
  } catch (e) {
    $('nights').innerHTML = `<div class="hint">Can't reach the Hollow contract on ${NET.name} (${short(NET.hollow)}).</div>`;
    return;
  }
  const block = await publicClient.getBlockNumber();
  const ids: bigint[] = [];
  for (let i = count; i > 0n && ids.length < 6; i--) ids.push(i);
  const rows = await Promise.all(
    ids.map(async (id) => {
      const n = (await publicClient.readContract({ address: NET.hollow, abi: hollowAbi, functionName: 'nights', args: [id] })) as {
        host: Hex; lobbyEnd: bigint; nSouls: number; living: number; startBlock: bigint; endBlock: bigint;
      };
      const { host, lobbyEnd, nSouls, living, startBlock, endBlock } = n;
      let status = 'open lobby';
      if (Number(startBlock)) {
        const over = Number(endBlock) || block >= startBlock + BigInt(NIGHT_BLOCKS);
        status = over ? 'over · replay' : block < startBlock ? 'starting…' : `in progress · ${living} living`;
      } else if (block >= lobbyEnd) status = 'lobby expired (anyone can start)';
      return { id, host, nSouls: Number(nSouls), status };
    }),
  );
  $('nights').innerHTML = rows.length ? '' : '<div class="hint">No nights yet. Open the first one.</div>';
  for (const r of rows) {
    const el = document.createElement('div');
    el.className = 'night' + (selected === r.id ? ' sel' : '');
    el.innerHTML = `<span>NIGHT ${r.id} · ${r.nSouls}/8 souls</span><span class="st">${r.status}</span>`;
    el.onclick = () => {
      selected = r.id;
      void renderNights();
    };
    $('nights').appendChild(el);
  }
  if (selected === null && rows.length) selected = rows[0].id;
  if (selected !== null) await renderDetail(selected);
}

async function renderDetail(id: bigint) {
  const ns = new NightState(id);
  await ns.poll();
  const h = ns.header!;
  const me = ns.soulIndexOf(wallet.address);
  $('night-detail').classList.remove('hidden');
  $('nd-title').textContent = `NIGHT ${id} · host ${short(h.host)}`;
  $('nd-souls').innerHTML = ns.souls.map((s, i) => `<div class="soul${i === me ? ' me' : ''}">${i + 1}. ${escapeHtml(s.name)}</div>`).join('') || '<div class="hint">no souls yet</div>';
  const phase = ns.phase();
  const isHost = h.host.toLowerCase() === wallet.address.toLowerCase();
  $('btn-join').classList.toggle('hidden', mode === 'watch' || me >= 0 || phase !== 'lobby' || h.nSouls >= 8);
  $('btn-start').classList.toggle('hidden', mode === 'watch' || phase !== 'lobby' || (!isHost && ns.chainBlock < h.lobbyEnd) || h.nSouls === 0);
  const canEnter = mode === 'watch' ? phase === 'night' || phase === 'countdown' : me >= 0 && phase !== 'lobby' && phase !== 'over';
  $('btn-enter').classList.toggle('hidden', !canEnter);
  $('btn-replay').classList.toggle('hidden', phase !== 'over' || !h.startBlock);
  $('btn-replay').onclick = () => void enterReplay(id);
  $('nd-hint').textContent =
    mode === 'watch'
      ? phase === 'night'
        ? 'Watch any bodycam. Pay MON to torment them — every fee goes to the survivors.'
        : 'Wait for the night to begin.'
      : phase === 'lobby'
        ? me >= 0
          ? isHost
            ? 'You are the host. Start when the souls are in (bots can fill empty seats).'
            : 'Waiting for the host to start.'
          : 'Join, then wait for the lights to go out.'
        : phase === 'over'
          ? 'This night is over. Every step of it is still on chain: watch the footage rebuilt from Monad blocks.'
          : me >= 0
            ? 'Your night has begun. Enter.'
            : 'Too late to join this night.';
  $('btn-join').onclick = async () => {
    try {
      await wallet.callAndWait('join', [id]);
      toast('you are in. don\'t trust anyone.');
      void renderNights();
    } catch (e) {
      toast(String((e as Error).message).slice(0, 140));
    }
  };
  $('btn-start').onclick = async () => {
    try {
      await wallet.callAndWait('start', [id]);
      toast('the lights go out in 6 seconds');
      void enter(id);
    } catch (e) {
      toast(String((e as Error).message).slice(0, 140));
    }
  };
  $('btn-enter').onclick = () => void enter(id);
  if (me >= 0 && (phase === 'countdown' || phase === 'night') && mode === 'play' && !entered) void enter(id);
}

$('btn-create').onclick = async () => {
  try {
    const receipt = await wallet.callAndWait('createNight', []);
    const count = (await publicClient.readContract({ address: NET.hollow, abi: hollowAbi, functionName: 'nightCount' })) as bigint;
    selected = count;
    toast(`night ${count} is open (${receipt.transactionHash.slice(0, 10)}…)`);
    await wallet.callAndWait('join', [count]);
    void renderNights();
  } catch (e) {
    toast(String((e as Error).message).slice(0, 140));
  }
};

/** Rebuild a finished night from the chain and play it back through its bodycams. */
async function enterReplay(id: bigint) {
  if (entered) return;
  entered = true;
  clearInterval(lobbyTimer);
  show('none');
  toast(`recovering night ${id} from ${NET.name}…`, 6000);
  try {
    await game.audio.start();
    const rn = await ReplayNight.load(id, (msg) => toast(`night ${id}: ${msg}…`, 4000));
    const speed = Number(new URLSearchParams(location.search).get('speed') ?? 1);
    if (speed > 0) rn.speed = speed;
    await game.enter(rn, 'replay', -1);
    rn.play();
    (window as unknown as { __replayReady?: boolean }).__replayReady = true;
  } catch (e) {
    toast(String((e as Error).message ?? e).slice(0, 160), 8000);
    entered = false;
    show('title');
  }
}

async function enter(id: bigint) {
  if (entered) return;
  entered = true;
  clearInterval(lobbyTimer);
  show('none');
  const ns = new NightState(id);
  await ns.poll();
  const soul = mode === 'play' ? ns.soulIndexOf(wallet.address) : -1;
  await game.enter(ns, mode, soul);
  if (mode === 'play') {
    $('view').onclick = () => game.player.lock();
    game.player.lock();
    // the fourth wall: it already knows who you are
    void Psych.intro((await injectedAddress()) ?? null).then((line) => {
      setTimeout(() => game.hud.subtitle(line), 2500);
      setTimeout(() => game.audio.speak(line.split('…')[1] ?? line, { volume: 0.4 }), 2600);
    });
  } else {
    buildWatchPanel(ns);
  }
}

function buildWatchPanel(ns: NightState) {
  const cams = $('cams');
  const renderCams = () => {
    cams.innerHTML = '';
    for (let b = 0; b < (ns.header?.nSouls ?? 0); b++) {
      const btn = document.createElement('button');
      btn.textContent = `CAM ${String(b + 1).padStart(2, '0')}`;
      btn.className = b === game.watching ? 'sel' : '';
      btn.disabled = ns.bodyGone(b);
      btn.onclick = () => {
        game.setWatch(b);
        renderCams();
      };
      cams.appendChild(btn);
    }
  };
  renderCams();
  setInterval(renderCams, 2000);
  const tor = $('torments');
  tor.innerHTML = '';
  for (const t of TORMENTS) {
    const btn = document.createElement('button');
    btn.textContent = `${t.icon} ${t.label} · ${formatEther(t.price)} MON`;
    btn.onclick = () => {
      game.torment(t.kind, t.price);
      toast(`${t.label.toLowerCase()} → CAM ${String(game.watching + 1).padStart(2, '0')}`);
    };
    tor.appendChild(btn);
  }
  addEventListener('keydown', (e) => {
    if (e.code === 'ArrowRight') game.cycleWatch(1);
    if (e.code === 'ArrowLeft') game.cycleWatch(-1);
  });
}

game.onOver = ({ escaped, hollow, txs, night }) => {
  show('end');
  game.hud.hide();
  $('end-title').textContent =
    game.mode === 'replay' ? 'END OF RECOVERED FOOTAGE' : escaped ? 'YOU GOT OUT' : hollow ? 'YOU ARE HOLLOW' : mode === 'watch' ? 'DAWN' : 'DAWN NEVER CAME';
  $('end-sub').textContent = escaped
    ? 'Someone else is still wearing your body in there.'
    : hollow
      ? 'Your hands kept walking without you. They still are.'
      : `${night.header?.escapedCount ?? 0} escaped. Everything that happened tonight is onchain, forever.`;
  const rec = txs.filter((t) => t.fn !== 'setName');
  $('end-txs').innerHTML =
    `<div>${rec.length} transactions · night ${night.id} · ${NET.name}</div>` +
    rec
      .slice(-40)
      .reverse()
      .map((t) => (NET.explorer ? `<a href="${NET.explorer}/tx/${t.hash}" target="_blank" rel="noopener">${t.fn} ${t.hash}</a>` : `<span>${t.fn} ${t.hash}</span>`))
      .join('');
  // every night stays on chain: anyone can watch it again from a link
  $('btn-share').onclick = async () => {
    const url = `${location.origin}${location.pathname}?replay=${night.id}${IS_LOCAL ? '&local=1' : ''}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('link copied: the footage of this night, rebuilt from Monad');
    } catch {
      toast(url, 8000);
    }
  };
  // the winners split the pot: whoever escaped, or, if nobody did, everyone the Hollow wore
  $('btn-claim').classList.add('hidden');
  const soul = game.mySoul;
  if (mode === 'play' && soul >= 0) {
    const check = async () => {
      const amount = (await publicClient
        .readContract({ address: NET.hollow, abi: hollowAbi, functionName: 'claimable', args: [BigInt(night.id), soul] })
        .catch(() => 0n)) as bigint;
      if (amount > 0n) {
        $('btn-claim').textContent = `CLAIM ${Number(formatEther(amount)).toFixed(3)} MON`;
        $('btn-claim').classList.remove('hidden');
      }
    };
    void check();
    setTimeout(() => void check(), 4000); // the night may still be closing on chain
  }
  $('btn-claim').onclick = async () => {
    try {
      await wallet.callAndWait('claimPot', [night.id, soul]);
      $('btn-claim').classList.add('hidden');
      toast(escaped ? 'the watchers paid for your survival' : 'nobody got out. the Hollow keeps what was paid.');
    } catch (e) {
      toast(String((e as Error).message).slice(0, 140));
    }
  };
};
$('btn-again').onclick = () => location.replace(location.pathname + (IS_LOCAL ? '?local=1' : ''));

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const replayParam = new URLSearchParams(location.search).get('replay');
if (replayParam && /^\d+$/.test(replayParam)) void enterReplay(BigInt(replayParam));

if (new URLSearchParams(location.search).has('roam')) {
  show('none');
  game.roam();
}

if (IS_LOCAL) toast(`local mode · ${NET.rpcs[0]} · ${short(NET.hollow)}`);

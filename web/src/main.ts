import { formatEther, parseEther } from 'viem';
import { IS_LOCAL, NET, TORMENTS, type Hex } from './config';
import { hollowAbi } from './chain/abi';
import { NightState, encodeName, short } from './chain/night';
import { Burner, fundFromInjected, injectedAddress, publicClient } from './chain/wallet';
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
  const msg = String((err as Error)?.message ?? err);
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
    $('bal').textContent = await wallet.balanceText();
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
    await fundFromInjected(wallet.address, parseEther('0.5'));
    toast('top-up sent — it lands in about a second on Monad');
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
  if (current !== encodeName(name)) void wallet.call('setName', [encodeName(name)], { gas: 60_000n });
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
      const n = (await publicClient.readContract({ address: NET.hollow, abi: hollowAbi, functionName: 'nights', args: [id] })) as readonly unknown[];
      const [host, lobbyEnd, nSouls, living, , , startBlock, , , endBlock] = n as [Hex, bigint, number, number, number, number, bigint, bigint, bigint, bigint];
      let status = 'open lobby';
      if (Number(startBlock)) {
        const over = Number(endBlock) || block >= startBlock + 1600n;
        status = over ? 'over' : block < startBlock ? 'starting…' : `in progress · ${living} living`;
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
          ? 'This night is over.'
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
  $('end-title').textContent = escaped ? 'YOU GOT OUT' : hollow ? 'YOU ARE HOLLOW' : mode === 'watch' ? 'DAWN' : 'DAWN NEVER CAME';
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
  $('btn-claim').classList.toggle('hidden', !escaped);
  $('btn-claim').onclick = async () => {
    try {
      await wallet.callAndWait('claimPot', [night.id]);
      toast('the watchers paid for your survival');
    } catch (e) {
      toast(String((e as Error).message).slice(0, 140));
    }
  };
};
$('btn-again').onclick = () => location.reload();

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

if (IS_LOCAL) toast(`local mode · ${NET.rpcs[0]} · ${short(NET.hollow)}`);

// Camera script for the "alone" segment (roam mode, ?film=1): IT at the end of Main Street, closer
// after you look away, then the hunt; then waking up in a different body. Everything on screen is
// the game's own stalker and wake-up code; this only choreographs the camera and when IT moves, so
// each beat lands on camera. Times are film seconds.
(() => {
  const CELL = 3;
  const g = window.__hollow;
  const s = g.stalker;
  window.__tourIT = true;
  for (const id of ['controls', 'items']) document.getElementById(id)?.classList.add('hidden');
  const EAST = -Math.PI / 2; // three.js yaw that faces +x
  let t0 = null;
  let pos = { x: 12.5 * CELL, z: 31.5 * CELL };
  let yaw = EAST;
  const done = new Set();
  const once = (k, f) => {
    if (!done.has(k)) {
      done.add(k);
      f();
    }
  };
  const ease = (a) => a * a * (3 - 2 * a);
  // the body you wake up in: the short one with the bad knee (PHYSIQUES[2] in web/src/game/player.ts)
  const KNEE = { eye: 1.49, pace: 0.9, limp: 0.85, tremor: 0, lungs: 1, tag: '1.58 m · BAD KNEE', feel: 'Shorter. The left knee does not bend the way yours did.' };
  // the clock starts on the first filmed frame (film.mjs calls __tourGo)
  window.__tourGo = (now) => (t0 = now);
  window.__tour = (now, dt, player) => {
    const t = t0 === null ? 0 : (now - t0) / 1000;
    let vx = 0;
    if (t0 !== null && t < 3.6) vx = 1.3; // a careful walk east down Main Street
    if (t > 9.6 && t < 12.6) vx = -0.32; // backing away (slow enough that the head keeps facing it)
    pos.x += vx * dt;

    // until the hunt, IT only moves when the script says so
    if (t < 9.6) {
      s.unseenFor = 0;
      s.lit = 0;
    }
    if (t0 !== null && t > 0.9) once('appear', () => s.appear(now));
    // look over your shoulder, and back
    if (t > 5.4 && t < 6.2) yaw = EAST + Math.PI * ease((t - 5.4) / 0.8);
    if (t >= 6.2 && t < 7.6) yaw = EAST + Math.PI;
    if (t > 7.0)
      once('closer', () => {
        s.pos.set(pos.x + 11, 0, pos.z + 0.4);
        s.audio.playAt('voice_whisper_04.mp3', s.pos, 0.9, 2);
      });
    if (t >= 7.6 && t < 8.4) yaw = EAST + Math.PI * (1 - ease((t - 7.6) / 0.8));
    if (t >= 8.4) yaw = EAST;
    if (t > 8.45) once('jolt', () => (player.shake = 0.9));
    if (t > 9.6)
      once('hunt', () => {
        s.hunt(now);
        player.flashlightOn = true;
      });
    // the torch dies as it comes
    if (t > 10.3) once('torch', () => (player.flashlightOn = false));

    // after the catch: the chain wakes you up somewhere else, in someone else
    if (t > 15.6)
      once('swap', () => {
        g.fx.swap();
        g.audio.shift();
        g.audio.duck(1.2);
        player.shake = 1.4;
        pos = { x: 42.5 * CELL, z: 22.6 * CELL };
        yaw = 1.9;
        player.flashlightOn = true;
        player.battery = 0.8;
        player.wake(KNEE);
        g.fx.eyelids = 1;
        g.psych.fear = 1;
        g.hud.scrambleCam(2600);
        g.hud.feed('SIGNAL REACQUIRED');
        setTimeout(() => g.hud.subtitle(KNEE.feel), 1500);
      });
    // look around, find the hospital door (north), take the first steps on the bad knee
    if (t > 18.4) yaw = 1.9 * (1 - ease(Math.min(1, (t - 18.4) / 1.8)));
    let vz = 0;
    if (t > 20.0 && t < 23) vz = -0.95;
    pos.z += vz * dt;
    player.yawObj.rotation.y = yaw;
    player.puppet(dt, pos.x, pos.z, vx, vz);
    player.yawObj.rotation.y = yaw;
  };
})();

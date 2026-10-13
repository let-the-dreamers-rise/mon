// Camera path for the town tour (roam mode): Main Street in the rain, into the 24/7 Mart to its
// counter, back out and east toward the avenue. Cells are 3 m; [x, y, pauseSeconds].
(() => {
  const CELL = 3;
  const path = [
    [9, 31, 1],
    [15, 31, 0],
    [16, 31, 0],
    [16, 28.3, 3.5], // the Mart's counter
    [16, 31, 0],
    [17, 31.4, 0],
    [24, 31.4, 0],
  ];
  const speed = 2.1; // m/s, a careful walk
  let seg = 0;
  let pausedFor = 0;
  let pos = null;
  for (const id of ['controls']) document.getElementById(id)?.classList.add('hidden');
  window.__tour = (now, dt, player) => {
    if (!pos) {
      pos = { x: (path[0][0] + 0.5) * CELL, z: (path[0][1] + 0.5) * CELL };
      // start already facing down the first leg
      player.yawObj.rotation.y = Math.atan2(-(path[1][0] - path[0][0]), -(path[1][1] - path[0][1]));
    }
    const here = path[seg];
    const next = path[seg + 1];
    let vx = 0;
    let vz = 0;
    if (pausedFor < here[2]) pausedFor += dt;
    else if (next) {
      const tx = (next[0] + 0.5) * CELL;
      const tz = (next[1] + 0.5) * CELL;
      const dx = tx - pos.x;
      const dz = tz - pos.z;
      const d = Math.hypot(dx, dz);
      const step = speed * dt;
      if (d <= step) {
        pos = { x: tx, z: tz };
        seg++;
        pausedFor = 0;
      } else {
        vx = (dx / d) * speed;
        vz = (dz / d) * speed;
        pos = { x: pos.x + vx * dt, z: pos.z + vz * dt };
      }
    }
    player.puppet(dt, pos.x, pos.z, vx, vz);
  };
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set('cam', 'CAM 01');
  set('blocknum', 'MONAD TESTNET');
  set('clock', '00:00 · DAWN IN 10:00');
  set('objective', 'FIND THE FUSES  0/3');
})();

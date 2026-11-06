/* UnderTheBlock simulation core — the same rules as the A3 toy (cells, passing bays, dock lift, jams),
   plus: random arrivals and lingering when given an rng, fixed destinations per package, event hooks. */
const SETTINGS = {
  CART_W_M: 0.8,
  CART_H_M: 1.2,
  TRENCH_DEPTH_M: 4,
  LIFT_SHAFT_W_M: 1.3,
  DOCK_CAPACITY: 5,
  BUILDING_COUNT: 4,
  OFFICE_FLOORS: 4,

  CELL_COUNT: 17,
  HUB_CELL: 16,
  BUILDING_CELLS: [12, 8, 4, 0],

  TRUNK_STEP_TIME_MIN: 0.15,

  LINGER_PROBABILITY: 0.05,
  LINGER_MIN_MIN: 1,
  LINGER_MAX_MIN: 2.5,

  OUTGOING_RATE_PER_BUILDING_PER_HR: 3,

  DEADLOCK_STALL_MINUTES: 6,

  MAX_DRAWN_QUEUE: 8,
  MAX_MANIFEST_ENTRIES: 8,

  WAVE_PERIOD_MIN: 60,
  SIM_MINUTES_PER_SEC: 2,

  ARRIVAL_RATE_DEFAULT: 16,
  CYCLE_TIME_DEFAULT: 2,

  QUEUE_EASE: 0.25,
  TRENCH_EASE: 0.3,

  DRY_RUN_HORIZON_MIN: 120,
  DRY_RUN_STEP_MIN: 0.05,
};

/* ============================================================
   THE TRENCH TOPOLOGY — cells, choke points, passing-bay placement
   ============================================================ */
const SPECIAL_CELLS = new Set([SETTINGS.HUB_CELL, ...SETTINGS.BUILDING_CELLS]);

function candidatePassingCells() {
  const cands = [];
  for (let i = 0; i < SETTINGS.CELL_COUNT; i++) if (!SPECIAL_CELLS.has(i)) cands.push(i);
  return cands;
}
const PASSING_CANDIDATES = candidatePassingCells();

function trafficLoad(i) {
  return SETTINGS.BUILDING_CELLS.filter((bc) => bc < i).length;
}
function isChokePoint(i) {
  return SPECIAL_CELLS.has(i - 1) || SPECIAL_CELLS.has(i + 1);
}
const PASSING_PRIORITY = PASSING_CANDIDATES.slice().sort((a, b) => {
  const ca = isChokePoint(a), cb = isChokePoint(b);
  if (ca !== cb) return ca ? -1 : 1;
  return trafficLoad(b) - trafficLoad(a) || a - b;
});
const REQUIRED_CHOKE_POINT_COUNT = PASSING_CANDIDATES.filter(isChokePoint).length;

function passingBaySetFor(count, order) {
  const n = Math.max(0, Math.min(Math.round(count), PASSING_CANDIDATES.length));
  return new Set((order || PASSING_PRIORITY).slice(0, n));
}
function cellCapacity(i, pbSet) {
  return pbSet.has(i) ? 2 : 1;
}

function hash01(i) {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}


function defaultPolicy() {
  return { buildingRouting: [0, 1, 2, 3] };
}

/* ============================================================
   THE SIMULATION CORE (unchanged)
   ============================================================ */
function freshLogicalState() {
  return {
    simMinutes: 0,
    arrivalAcc: 0,
    queue: [],
    nextCartId: 0,
    lift: { state: 'idle', timer: 0 },
    pendingHandoff: null,
    cellOccupants: Array.from({ length: SETTINGS.CELL_COUNT }, () => []),
    trunkEntities: [],
    nextEntityId: 0,
    routePtr: 0,
    outgoingAcc: new Array(SETTINGS.BUILDING_COUNT).fill(0),
    trunkMoveAcc: 0,
    completedLift: 0,
    deliveredCount: 0,
    perBuildingDelivered: new Array(SETTINGS.BUILDING_COUNT).fill(0),
    outgoingCollected: 0,
    curbMinutes: 0,
    curbEverOccurred: false,
    curbFailureMinute: null,
    deadlocked: false,
    deadlockMinute: null,
    deadlockEntityIds: null,
    stallMinutes: 0,
    // Little's law bookkeeping (inbound carts only: dock arrival -> delivery at the tenant cell)
    ll: { arrT: new Map(), arrivals: 0, departures: 0, sumW: 0, areaL: 0, inSystem: 0, liftCart: null, maxQueue: 0 },
    dest: new Map(),          // cartId -> tenant index, fixed when the package reaches the dock
    maxInTrench: 0,
  };
}

// arrivals: 'wave' = the one-hour morning wave (A2); 'steady' = a constant rate, for the Little's law check
let arrivalMode = 'wave';

// a delivered inbound cart leaves the system: record its time in system W
function recordDeparture(s, e) {
  const L = s.ll, t0 = L.arrT.get(e.cartId);
  if (t0 === undefined) return;
  L.arrT.delete(e.cartId);
  L.departures++; L.sumW += s.simMinutes - t0; L.inSystem--;
}
// Little's law over the run so far: L = time-average carts in system, lambda = arrivals / T, W = mean time in system
function littleStats(s, cycleTime) {
  const L = s.ll, T = s.simMinutes;
  const lam = T > 0 ? L.arrivals / T : 0;            // carts per minute
  const W = L.departures > 0 ? L.sumW / L.departures : 0;  // minutes
  const Lbar = T > 0 ? L.areaL / T : 0;
  const lamW = lam * W;
  const err = Lbar > 0.01 ? (lamW - Lbar) / Lbar : null;
  const mu = 60 / cycleTime;                          // dock lift, carts per hour
  return { T, lam, lamHr: lam * 60, W, Lbar, lamW, err, inside: L.inSystem, arrivals: L.arrivals,
    departures: L.departures, mu, rho: (lam * 60) / mu, queue: s.queue.length, maxQueue: L.maxQueue };
}

function waveRate(simMinutes, peakRate) {
  if (arrivalMode === 'steady') return peakRate;
  const t = simMinutes % SETTINGS.WAVE_PERIOD_MIN;
  const phase = Math.max(0, Math.sin((Math.PI * t) / SETTINGS.WAVE_PERIOD_MIN));
  return peakRate * phase;
}

function tryMoveEntity(s, e, pbSet, opts) {
  const next = e.cell + e.dir;
  if (next < 0 || next >= SETTINGS.CELL_COUNT) return false;
  const occ = s.cellOccupants[next];
  if (occ.length >= cellCapacity(next, pbSet)) return false;

  s.cellOccupants[e.cell].splice(s.cellOccupants[e.cell].indexOf(e), 1);
  e.cell = next;
  occ.push(e);

  const rng = opts && opts.rng;
  if (pbSet.has(next) && (rng ? rng() : hash01(e.id)) < SETTINGS.LINGER_PROBABILITY) {
    const h2 = rng ? rng() : hash01(e.id * 7 + 3);
    e.lingerUntil = s.simMinutes + SETTINGS.LINGER_MIN_MIN + h2 * (SETTINGS.LINGER_MAX_MIN - SETTINGS.LINGER_MIN_MIN);
  }
  if (e.cell === e.targetCell) {
    occ.splice(occ.indexOf(e), 1);
    e.removed = true;
    if (e.kind === 'inbound') {
      s.deliveredCount++;
      s.perBuildingDelivered[e.buildingIndex]++;
      recordDeparture(s, e);
      if (opts && opts.onDelivered) opts.onDelivered(e.buildingIndex);
      if (opts && opts.onEvent) opts.onEvent('delivered', e.cartId, { cell: e.cell, b: e.buildingIndex });
    } else {
      s.outgoingCollected++;
    }
  }
  return true;
}

// live play only: robots stuck nose to nose beside a passing lane are waved past each other
function untangleHeadOn(s, pbSet, opts) {
  let any = false;
  const arrive = (e) => {
    if (e.cell !== e.targetCell) return;
    const occ = s.cellOccupants[e.cell];
    occ.splice(occ.indexOf(e), 1); e.removed = true;
    if (e.kind === 'inbound') { s.deliveredCount++; s.perBuildingDelivered[e.buildingIndex]++; recordDeparture(s, e); if (opts && opts.onDelivered) opts.onDelivered(e.buildingIndex); if (opts && opts.onEvent) opts.onEvent('delivered', e.cartId, { cell: e.cell, b: e.buildingIndex }); }
    else s.outgoingCollected++;
  };
  for (let pass = 0; pass < 4; pass++) {
    let did = false;
    for (const a of s.trunkEntities) {
      if (a.removed || a.dir !== -1 || a.held || a.cell === a.targetCell) continue;
      const c = a.cell - 1;
      if (c < 0 || !(pbSet.has(c) || pbSet.has(a.cell))) continue;
      const b = s.cellOccupants[c].find((x) => x.dir === 1 && !x.removed && !x.held);
      if (!b) continue;
      const oa = s.cellOccupants[a.cell], ob = s.cellOccupants[c];
      oa.splice(oa.indexOf(a), 1); ob.splice(ob.indexOf(b), 1);
      b.cell = a.cell; a.cell = c; ob.push(a); oa.push(b);
      a.lingerUntil = b.lingerUntil = null;
      arrive(a); arrive(b);
      did = any = true;
    }
    if (!did) break;
  }
  s.trunkEntities = s.trunkEntities.filter((e) => !e.removed);
  return any;
}

function findDeadlockCycle(s, pbSet) {
  const waitsFor = new Map();
  for (const e of s.trunkEntities) {
    if (e.removed || e.lingerUntil !== null || e.held) continue;
    const next = e.cell + e.dir;
    if (next < 0 || next >= SETTINGS.CELL_COUNT) continue;
    const occ = s.cellOccupants[next];
    if (occ.length >= cellCapacity(next, pbSet)) waitsFor.set(e.id, occ.map((o) => o.id));
  }
  const color = new Map();
  function dfs(id, stack) {
    color.set(id, 1); stack.push(id);
    for (const n of waitsFor.get(id) || []) {
      if (n === id) continue;
      if (color.get(n) === 1) return stack.slice(stack.indexOf(n));
      if (!color.get(n)) { const found = dfs(n, stack); if (found) return found; }
    }
    stack.pop(); color.set(id, 2);
    return null;
  }
  for (const id of waitsFor.keys()) if (!color.get(id)) { const c = dfs(id, []); if (c) return c; }
  return null;
}

function doOneTrunkRound(s, pbSet, opts) {
  let anyMove = false, anyHeld = false;
  if (s.untangle) { s.untangle = false; if (untangleHeadOn(s, pbSet, opts)) anyMove = true; }
  for (const e of s.trunkEntities) {
    if (e.removed) continue;
    if (e.held) { anyHeld = true; continue; }   // the player is holding this robot
    if (e.lingerUntil !== null) {
      if (s.simMinutes < e.lingerUntil) continue;
      e.lingerUntil = null;
    }
    if (tryMoveEntity(s, e, pbSet, opts)) anyMove = true;
  }
  s.trunkEntities = s.trunkEntities.filter((e) => !e.removed);

  // live play only: a jam the player has opened up (a new passing lane) clears
  if (s.deadlocked && opts && opts.recover && anyMove && !findDeadlockCycle(s, pbSet)) {
    s.deadlocked = false; s.deadlockMinute = null; s.deadlockEntityIds = null; s.stallMinutes = 0;
  }
  if (!s.deadlocked) {
    const cyc = findDeadlockCycle(s, pbSet);
    if (cyc) { s.deadlocked = true; s.deadlockMinute = s.simMinutes; s.deadlockEntityIds = cyc; }
  }
  if (anyHeld) { /* a held robot is the player's choice, not a stall */ }
  else if (!anyMove && s.trunkEntities.length > 0) {
    s.stallMinutes += SETTINGS.TRUNK_STEP_TIME_MIN;
    if (!s.deadlocked && s.stallMinutes > SETTINGS.DEADLOCK_STALL_MINUTES) {
      s.deadlocked = true; s.deadlockMinute = s.simMinutes; s.deadlockEntityIds = null;
    }
  } else {
    s.stallMinutes = 0;
  }
}

function stepLogical(s, dtMinutes, policy, arrivalRate, cycleTime, passingBayCount, opts) {
  s.ll.areaL += s.ll.inSystem * dtMinutes;   // integrate L(t) dt over this step
  s.simMinutes += dtMinutes;
  const pbSet = passingBaySetFor(passingBayCount, opts && opts.order);

  const ratePerMin = waveRate(s.simMinutes, arrivalRate) / 60;
  const pushArrival = () => {
    const cid = s.nextCartId++;
    s.queue.push(cid);
    s.dest.set(cid, policy.buildingRouting[s.routePtr % policy.buildingRouting.length]); s.routePtr++;
    s.ll.arrT.set(cid, s.simMinutes); s.ll.arrivals++; s.ll.inSystem++;
    if (opts && opts.onEvent) opts.onEvent('dock', cid, { b: s.dest.get(cid) });
  };
  if (opts && opts.rng) {
    let expect = ratePerMin * dtMinutes;               // Poisson arrivals: small steps, at most a few per step
    while (expect > 0) { const p = Math.min(1, expect); if (opts.rng() < p) pushArrival(); expect -= 1; }
  } else {
    s.arrivalAcc += ratePerMin * dtMinutes;
    while (s.arrivalAcc >= 1) { s.arrivalAcc -= 1; pushArrival(); }
  }
  if (s.queue.length > s.ll.maxQueue) s.ll.maxQueue = s.queue.length;

  const curbCount = Math.max(0, s.queue.length - SETTINGS.DOCK_CAPACITY);
  s.curbMinutes += curbCount * dtMinutes;
  if (curbCount > 0 && !s.curbEverOccurred) { s.curbEverOccurred = true; s.curbFailureMinute = s.simMinutes; }

  if (s.lift.state === 'idle' && s.queue.length > 0 && s.pendingHandoff === null) {
    s.ll.liftCart = s.queue.shift(); s.lift.state = 'cycling'; s.lift.timer = 0;
    if (opts && opts.onEvent) opts.onEvent('lift', s.ll.liftCart, {});
  }
  if (s.lift.state === 'cycling') {
    s.lift.timer += dtMinutes;
    if (s.lift.timer / cycleTime >= 1) {
      s.completedLift++;
      const cid = s.ll.liftCart;
      s.pendingHandoff = { targetBuildingIdx: s.dest.has(cid) ? s.dest.get(cid) : 0, cartId: cid };
      s.dest.delete(cid);
      if (opts && opts.onEvent) opts.onEvent('down', cid, {});
      s.lift.state = 'idle'; s.lift.timer = 0;
    }
  }
  if (s.pendingHandoff !== null) {
    const hub = SETTINGS.HUB_CELL;
    if (s.cellOccupants[hub].length < cellCapacity(hub, pbSet)) {
      const e = {
        id: s.nextEntityId++, kind: 'inbound', dir: -1, cell: hub,
        targetCell: SETTINGS.BUILDING_CELLS[s.pendingHandoff.targetBuildingIdx],
        buildingIndex: s.pendingHandoff.targetBuildingIdx, lingerUntil: null, removed: false,
        cartId: s.pendingHandoff.cartId,
      };
      s.cellOccupants[hub].push(e); s.trunkEntities.push(e); s.pendingHandoff = null;
      if (opts && opts.onEvent) opts.onEvent('trench', e.cartId, { b: e.buildingIndex });
    }
  }

  for (let b = 0; b < SETTINGS.BUILDING_COUNT; b++) {
    if (opts && opts.noOutgoing) continue;
    if (opts && opts.mailFrom && !opts.mailFrom.includes(b)) continue;   // known-result check: dock lift on its own, no opposing traffic
    s.outgoingAcc[b] += (SETTINGS.OUTGOING_RATE_PER_BUILDING_PER_HR / 60) * dtMinutes;
    while (s.outgoingAcc[b] >= 1) {
      s.outgoingAcc[b] -= 1;
      const cellIdx = SETTINGS.BUILDING_CELLS[b];
      if (s.cellOccupants[cellIdx].length < cellCapacity(cellIdx, pbSet)) {
        const e = { id: s.nextEntityId++, kind: 'outgoing', dir: 1, cell: cellIdx, targetCell: SETTINGS.HUB_CELL, buildingIndex: b, lingerUntil: null, removed: false };
        s.cellOccupants[cellIdx].push(e); s.trunkEntities.push(e);
      } else {
        s.outgoingAcc[b] += 1;
        break;
      }
    }
  }

  s.trunkMoveAcc += dtMinutes;
  let rounds = 0;
  while (s.trunkMoveAcc >= SETTINGS.TRUNK_STEP_TIME_MIN && rounds < 4000) {
    s.trunkMoveAcc -= SETTINGS.TRUNK_STEP_TIME_MIN;
    doOneTrunkRound(s, pbSet, opts);
    rounds++;
  }
  const inbound = s.trunkEntities.length;
  if (inbound > s.maxInTrench) s.maxInTrench = inbound;
}

/* a package someone ordered: joins the dock queue now, bound for one tenant */
function injectArrival(s, dest, opts) {
  const cid = s.nextCartId++;
  s.queue.push(cid); s.dest.set(cid, dest);
  s.ll.arrT.set(cid, s.simMinutes); s.ll.arrivals++; s.ll.inSystem++;
  if (opts && opts.onEvent) opts.onEvent('dock', cid, { b: dest, ordered: true });
  return cid;
}
/* seeded random numbers, so a future can be replayed */
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }


function setArrivalMode(m) { arrivalMode = m; }

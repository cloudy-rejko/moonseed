'use strict';

// ===== Tunables (edit live with T; saved in this browser) =====
const DEFAULTS = {
  gravity: 400000,     // home planet pull = gravity / distance²; moons scale from it
  thrust: 90,          // engine push in open space
  liftBoost: 1,        // extra push per unit of local gravity, so the engine feels the same near planets
  turnSpeed: 4.5,      // radians per second
  fuelBurn: 8,         // fuel per second at full throttle (tank holds 100)
  landSpeed: 35,       // touch down slower than this to land; faster bounces
  magnet: 50,          // radius that pulls nearby stardust in
};
const TUNING = [
  // key, label, min, max, step
  ['gravity', 'Gravity', 100000, 900000, 10000],
  ['thrust', 'Thrust (open space)', 20, 300, 5],
  ['liftBoost', 'Thrust boost near planets', 0, 3, 0.1],
  ['turnSpeed', 'Turn speed', 1, 10, 0.1],
  ['fuelBurn', 'Fuel burn /s', 0, 30, 0.5],
  ['landSpeed', 'Landing speed', 5, 80, 1],
  ['magnet', 'Stardust magnet', 0, 120, 1],
];
const STORAGE_KEY = 'moonseed.tuning.v2';  // v2: thrust now scales with gravity, old values don't carry over
const cfg = { ...DEFAULTS };
try { Object.assign(cfg, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); } catch (e) { /* storage blocked */ }
function saveCfg() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch (e) { /* storage blocked */ }
}
// Player preferences that aren't physics.
const prefs = { ship: -1, autoZoom: true, orbits: 1, fps: false };
try { Object.assign(prefs, JSON.parse(localStorage.getItem('moonseed.prefs') || '{}')); } catch (e) { /* storage blocked */ }
function savePrefs() {
  try { localStorage.setItem('moonseed.prefs', JSON.stringify(prefs)); } catch (e) { /* storage blocked */ }
}

// ===== World constants =====
const ARENA_R = 480;               // past this a soft spring pulls you back
const SHIP_SCALE = 1.4;
const FOOT = 7 * SHIP_SCALE;       // ship centre to the bottom of its legs
const PICKUP_R = 14;
const LAND_TILT = 45 * Math.PI / 180;
const SNAP_RANGE = 6;              // within this height, slow and roughly upright, the ground gently draws you in
const GENTLE = 0.45;               // gentle-thrust throttle: roughly a hover near a surface
const FUEL_MAX = 100;
const FUEL_REGEN = 1.5;            // per second, always
const LAND_REFUEL = 30;            // per second while landed
const MOTE_FUEL = 3;
const MOTE_FADE = 5;               // comet stardust fades out over this many seconds at the end of its life
const CHAIN_WINDOW = 1.6;          // seconds between pickups to keep a chain going
const MIN_MOTES = 40;
const RING_MOTES = 36;
const MAX_FIREFLIES = 30;
const STEP = 1 / 120;
const TAU = Math.PI * 2;
// Each colour theme has its own music: a scale for pickups and planting (two octaves from its root), a
// four-chord progression for the garden music (chord root in semitones from the root, and minor or not)
// and a tempo. Navy, the first system, is G major pentatonic over G, Em, C, D.
const MUSIC = {
  Navy: { root: 392, scale: [0, 2, 4, 7, 9], chords: [[0, 0], [-3, 1], [-7, 0], [-5, 0]], beat: 0.6 },
  Aurora: { root: 329.63, scale: [0, 2, 4, 6, 9], chords: [[0, 0], [2, 0], [-3, 1], [-5, 0]], beat: 0.7 },        // airy lydian
  Sunset: { root: 440, scale: [0, 3, 5, 7, 10], chords: [[0, 1], [-4, 0], [-9, 0], [-2, 0]], beat: 0.62 },        // A minor
  Synthwave: { root: 329.63, scale: [0, 3, 5, 7, 10], chords: [[0, 1], [-4, 0], [3, 0], [-2, 0]], beat: 0.5 },    // E minor, quicker
  Deep: { root: 293.66, scale: [0, 2, 3, 7, 8], chords: [[0, 1], [-4, 0], [5, 1], [-2, 0]], beat: 0.8 },          // slow, hirajoshi
  Candy: { root: 349.23, scale: [0, 2, 4, 7, 9], chords: [[0, 0], [-3, 1], [-7, 0], [-5, 0]], beat: 0.55 },      // F major
};
let SCALE = [], CHORDS = [], BEAT = 0.6;
function setMusic(themeName) {
  const m = MUSIC[themeName] || MUSIC.Navy, f = semi => m.root * 2 ** (semi / 12);
  SCALE = [...m.scale, ...m.scale.map(v => v + 12), 24].map(f);
  CHORDS = m.chords.map(([semi, minor]) => [0, minor ? 3 : 4, 7].map(i => f(semi + i - 12)));
  BEAT = m.beat;
}
setMusic('Navy');
const SAVE_KEY = 'moonseed.save.v1';

const canvas = document.getElementById('game');
// Phones and tablets (a coarse pointer, no mouse) get the invisible joystick and a pause icon.
const TOUCH = matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
const ctx = canvas.getContext('2d');

// ===== Helpers =====
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
function angleDiff(a, b) { return ((a - b + Math.PI) % TAU + TAU) % TAU - Math.PI; }
// Order doesn't matter in our lists, so swap-remove is fine and fast.
function removeAt(arr, i) { arr[i] = arr[arr.length - 1]; arr.pop(); }
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

// ===== Star systems =====
// Each system has a colour theme: a night-sky background and a few planet colours that go together.
// A body's own colour is used for its outline and stems; the theme's other colours become bloom accents.
// Neon on thin lines and small blooms, dark night-sky backgrounds (never red or green), the first colour
// leads (it goes to the home planet). Chosen with an art-critic pass over rendered variants.
const THEMES = [
  { name: 'Navy', nebula: ['#0a1024', '#020409'], colors: [[63, 224, 255], [255, 79, 216], [255, 216, 74]] },
  { name: 'Aurora', nebula: ['#05141c', '#01050a'], colors: [[77, 255, 160], [58, 215, 255], [255, 110, 199]] },
  { name: 'Sunset', nebula: ['#120c28', '#04030b'], colors: [[255, 138, 61], [255, 79, 139], [255, 210, 63]], extra: ['95,215,255'] },
  { name: 'Synthwave', nebula: ['#140a22', '#040209'], colors: [[255, 63, 180], [46, 230, 255], [167, 123, 255]] },
  { name: 'Deep', nebula: ['#07080e', '#020308'], colors: [[93, 255, 168], [255, 122, 107], [90, 155, 255]] },
  { name: 'Candy', nebula: ['#160b1f', '#050208'], colors: [[192, 139, 255], [125, 255, 208], [255, 154, 213]] },
];
function paint(defs, theme) {
  const cols = [theme.colors[0], ...shuffle(theme.colors.slice(1))];
  let i = 0;
  for (const d of defs) {
    if (d.anchor) continue;
    // with more bodies than theme colours, a repeated colour comes back lighter so names don't clash
    const k = i++, base = cols[k % cols.length], c = k < cols.length ? base : base.map(v => Math.round(mix(v, 255, 0.45)));
    d.color = c;
    d.accents = [...theme.colors.filter(o => o !== c).map(o => o.join(',')), ...(theme.extra || []), '255,250,230'];
  }
}
// Every body is named after a plant genus: the stranger, older and more dangerous-sounding the better
// (cycads, carnivores, poisons, desert oddities, ancient ferns), never the garden-centre favourites.
const NAMES = [
  'Welwitschia', 'Nepenthes', 'Xanthorrhoea', 'Dracaena', 'Rafflesia', 'Encephalartos', 'Equisetum', 'Lycopodium',
  'Selaginella', 'Sarracenia', 'Darlingtonia', 'Tacca', 'Puya', 'Gunnera', 'Ephedra', 'Datura', 'Mandragora',
  'Aconitum', 'Atropa', 'Strychnos', 'Araucaria', 'Wollemia', 'Tillandsia', 'Pachypodium', 'Adansonia', 'Ceiba',
  'Carnegiea', 'Ferocactus', 'Lithops', 'Psilotum', 'Isoetes', 'Cyathea', 'Dicksonia', 'Angiopteris', 'Osmunda',
  'Azolla', 'Utricularia', 'Cephalotus', 'Heliamphora', 'Monotropa', 'Hippomane', 'Dendrocnide', 'Cerbera',
  'Kigelia', 'Arisaema', 'Helicodiceros', 'Lodoicea', 'Sapria', 'Aristolochia', 'Gloriosa', 'Drosophyllum',
  'Cycas', 'Dracophyllum', 'Stapelia', 'Hydnora', 'Myrmecodia', 'Corallorhiza', 'Echium',
];
// Older saves: the first system's bodies get their new names, others a name picked from their old one
// (so the same old name always becomes the same plant).
const OLD_NAMES = { Home: 'Welwitschia', Nymphaea: 'Welwitschia', Rosa: 'Nepenthes', Amber: 'Xanthorrhoea', Calendula: 'Xanthorrhoea' };
function plantName(old) {
  if (old in OLD_NAMES) return OLD_NAMES[old];
  if (NAMES.includes(old)) return old;
  let h = 0;
  for (const ch of old) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return NAMES[h % NAMES.length];
}
const FIRST_SYSTEM = {
  nebula: THEMES[0].nebula, theme: 'Navy', archetype: 'first', ring: 0, centralMass: 1, sunAngle: -2.3,
  defs: [
    { name: 'Welwitschia', R: 72, mass: 1, orbit: 0, start: 0, color: [63, 224, 255], accents: ['255,79,216', '255,216,74', '255,250,230'] },
    { name: 'Nepenthes', R: 16, mass: 0.025, orbit: 230, start: 2.4, color: [255, 79, 216], accents: ['63,224,255', '255,216,74', '255,250,230'] },
    { name: 'Xanthorrhoea', R: 22, mass: 0.04, orbit: 380, start: -0.8, color: [255, 216, 74], accents: ['63,224,255', '255,79,216', '255,250,230'] },
  ],
};

// System layouts. Each returns body definitions (positions on rails) plus a few system-wide settings:
// centralMass (what the stardust and outer moons orbit), innerR (closest stardust orbit), ring, comet timing.
// Bodies with `anchor` are invisible points that others orbit (used for twin moons).
// `omegaMass` / `omegaDist` set the orbit speed for pairs that circle a shared centre.
const moonMass = R => R * R * 0.00009;
const ARCHETYPES = {
  // a home planet with two or three moons, maybe a moonlet
  classic() {
    const homeR = rand(58, 80), defs = [{ R: homeR, mass: rand(0.85, 1.2), orbit: 0 }];
    const count = Math.random() < 0.5 ? 2 : 3, inner = homeR + 100, gap = (420 - inner) / count;
    let hasMoonlet = false;
    for (let i = 0; i < count; i++) {
      const R = rand(12, 24), idx = defs.length;
      defs.push({ R, mass: moonMass(R), orbit: inner + gap * (i + 0.5) + rand(-0.15, 0.15) * gap, start: rand(0, TAU), dir: Math.random() < 0.2 ? -1 : 1 });
      // at most one moonlet, with room to fly in comfortably
      if (!hasMoonlet && R >= 18 && gap > 100 && Math.random() < 0.5) {
        const r = rand(6, 9);
        hasMoonlet = true;
        defs.push({ R: r, mass: moonMass(r), orbit: R + r + rand(30, 38), start: rand(0, TAU), parent: idx });
      }
    }
    return { defs, ring: Math.random() < 0.3 ? homeR + rand(30, 50) : 0 };
  },
  // two big planets circling each other, maybe a small moon far out around both
  twin() {
    const m1 = rand(0.42, 0.52), m2 = rand(0.42, 0.52), M = m1 + m2, d = rand(220, 260), a = rand(0, TAU);
    const defs = [
      { R: rand(42, 52), mass: m1, orbit: d * m2 / M, start: a, omegaMass: M, omegaDist: d },
      { R: rand(40, 50), mass: m2, orbit: d * m1 / M, start: a + Math.PI, omegaMass: M, omegaDist: d },
    ];
    if (Math.random() < 0.7) { const R = rand(14, 20); defs.push({ R, mass: moonMass(R), orbit: rand(395, 420), start: rand(0, TAU) }); }
    return { defs, centralMass: M, innerR: d / 2 + 95 };
  },
  // a pair of moons dancing around each other while they orbit the planet
  twinMoons() {
    const homeR = rand(60, 70), mA = moonMass(rand(14, 16)), mB = moonMass(rand(12, 14)), sep = rand(60, 70), b = rand(0, TAU);
    const defs = [
      { R: homeR, mass: 1, orbit: 0 },
      { R: 16, mass: moonMass(16), orbit: rand(165, 185), start: rand(0, TAU) },
      { anchor: true, R: 0, mass: 0, orbit: rand(320, 340), start: rand(0, TAU) },
    ];
    defs.push(
      { R: Math.sqrt(mA / 0.00009), mass: mA, orbit: sep * mB / (mA + mB), start: b, parent: 2, omegaMass: mA + mB, omegaDist: sep },
      { R: Math.sqrt(mB / 0.00009), mass: mB, orbit: sep * mA / (mA + mB), start: b + Math.PI, parent: 2, omegaMass: mA + mB, omegaDist: sep },
    );
    return { defs };
  },
  // a huge planet with a few tiny, quick moons (one of them going the other way)
  giant() {
    const homeR = rand(92, 104), retro = Math.floor(rand(1, 4));
    const defs = [{ R: homeR, mass: 1.5, orbit: 0 }];
    [rand(170, 190), rand(250, 270), rand(335, 360)].forEach((orbit, i) => {
      const R = rand(9, 12);
      defs.push({ R, mass: moonMass(R), orbit, start: rand(0, TAU), dir: i + 1 === retro ? -1 : 1 });
    });
    return { defs, innerR: homeR + 40 };
  },
  // a small planet and one heavy moon with a deep gravity well to swing around
  heavy() {
    const defs = [
      { R: 55, mass: 0.9, orbit: 0 },
      { R: 12, mass: moonMass(12), orbit: rand(155, 170), start: rand(0, TAU) },
      { R: 33, mass: 0.22, orbit: rand(295, 310), start: rand(0, TAU) },
    ];
    if (Math.random() < 0.5) defs.push({ R: 7, mass: moonMass(7), orbit: 33 + 7 + rand(36, 42), start: rand(0, TAU), parent: 2 });
    return { defs };
  },
  // one moon with two little companions sharing its orbit, 60° ahead and behind
  trojans() {
    const orbit = rand(310, 330), a = rand(0, TAU);
    const defs = [
      { R: 64, mass: 1, orbit: 0 },
      { R: 20, mass: moonMass(20), orbit, start: a },
      // big enough that their gardens read as gardens, not noise
      { R: 13, mass: moonMass(13), orbit, start: a + Math.PI / 3 },
      { R: 13, mass: moonMass(13), orbit, start: a - Math.PI / 3 },
    ];
    return { defs };
  },
  // a black hole in the middle with a glowing disk that slowly swallows stardust; three worlds circle it
  hole() {
    const defs = [{ kind: 'hole', R: 19, mass: 1.3, orbit: 0, tilt: rand(-0.45, 0.45) }];
    [[rand(185, 200), rand(30, 34)], [rand(285, 300), rand(22, 28)], [rand(390, 410), rand(32, 38)]].forEach(([orbit, R]) => {
      defs.push({ R, mass: moonMass(R) * 1.4, orbit, start: rand(0, TAU) });
    });
    return { defs, innerR: 115 };
  },
  // a ringed gas giant with no ground to land on; you garden its three moons instead
  gas() {
    const R = rand(88, 100), defs = [{ kind: 'gas', R, mass: 1.7, orbit: 0, tilt: rand(-0.35, 0.35) }];
    [rand(228, 245), rand(312, 330), rand(400, 420)].forEach((orbit, i) => {
      const r = rand(16, 24);
      defs.push({ R: r, mass: moonMass(r) * 1.3, orbit, start: rand(0, TAU), dir: i === 1 && Math.random() < 0.4 ? -1 : 1 });
    });
    return { defs, innerR: R * 2.1 };
  },
  // a lone planet in a wide stardust ring, one distant moon, and comets that visit often
  ringed() {
    const homeR = rand(66, 74);
    return {
      defs: [{ R: homeR, mass: 1.05, orbit: 0 }, { R: 22, mass: moonMass(22), orbit: rand(375, 395), start: rand(0, TAU) }],
      ring: homeR + rand(40, 55), comet: [20, 35],
    };
  },
};

// What makes a system feel like its own place, beyond its layout and colours: the colour of its sun (and
// sometimes a second one), one far landmark in the sky, how its stardust is laid out, and one slow
// ambient event. Old saves without one get one picked from their system number, so it stays the same.
const SUN_TINTS = ['255,236,200', '255,205,165', '195,222,255', '255,195,222', '255,222,150'];
function pickIdentity(rnd, defs, innerR) {
  const pickR = arr => arr[Math.floor(rnd() * arr.length)];
  const sun = pickR(SUN_TINTS);
  const twin = rnd() < 0.25;
  // a stardust belt needs a free lane between the orbits
  const orbits = defs.filter(d => !d.parent && d.orbit).map(d => d.orbit);
  const lanes = [];
  for (let r = innerR + 30; r <= 410; r += 10) if (orbits.every(o => Math.abs(o - r) > 45)) lanes.push(r);
  let dust = pickR(['streams', 'clouds', 'belt', 'shower']);
  if (dust === 'belt' && !lanes.length) dust = 'clouds';
  return {
    sun, sun2: twin ? rnd() * TAU : null, sun2Tint: twin ? pickR(SUN_TINTS.filter(t => t !== sun)) : null,
    landmark: pickR(['galaxy', 'cluster', 'crescent']), landmarkAt: [rnd(), rnd()],
    dust, beltR: lanes.length ? pickR(lanes) : 0, showerAngle: rnd() * TAU,
    ambient: pickR(['aurora', 'pulsar', 'ice', null]),
    ...pickFeature(rnd, lanes, innerR),
  };
}
// One thing to play with per system: a pollen errand, a solar-wind current to ride, calm clouds that
// settle you into an orbit, or asteroids to bump and crack open. (Pollen is wired up in generateSystem.)
function pickFeature(rnd, lanes, innerR) {
  let feature = ['pollen', 'current', 'calm', 'rocks', null][Math.floor(rnd() * 5)];
  if (feature === 'current' && !lanes.length) feature = 'rocks';
  if (feature === 'current') {
    const span = 1.6 + rnd() * 1.2;
    return { feature, current: { r: lanes[Math.floor(rnd() * lanes.length)], a0: rnd() * TAU, span, w: 24 } };
  }
  if (feature === 'calm') {
    const a = rnd() * TAU, calm = [0, 1].map(k => {
      const rr = innerR + 50 + rnd() * Math.max(10, 380 - innerR - 50), aa = a + k * (Math.PI + (rnd() - 0.5) * 1.6);
      return { x: Math.cos(aa) * rr, y: Math.sin(aa) * rr, r: 55 + rnd() * 20 };
    });
    return { feature, calm };
  }
  return { feature };
}
const FIRST_IDENTITY = { sun: '255,236,200', sun2: null, landmark: 'galaxy', landmarkAt: [0.82, 0.2], dust: 'streams', ambient: null, feature: null };

// New systems pace out the things you haven't met yet: a few candidates are rolled and the one closest to
// "one new gameplay thing (none every third system) and at most one new look" wins, so the surprises keep
// coming until about system 15 instead of all arriving in the first few. Once you've seen everything it's
// plain random again.
function generateSystem(n, prev = {}) {
  if (n === 2) return rollSystem(n, prev);
  const seen = new Set(prefs.seen || []), wantGame = n % 3 === 0 ? 0 : 1;
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < 12; i++) {
    const c = rollSystem(n, prev);
    const unseen = systemTags(c.defs, c.identity).filter(t => !seen.has(t));
    const game = unseen.filter(t => GAMEPLAY_TAGS.includes(t)).length, looks = unseen.length - game;
    const score = -3 * Math.abs(game - wantGame) - 2 * Math.max(0, looks - 1) + (looks === 1 ? 0.5 : 0);
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}
function rollSystem(n, prev = {}) {
  const kind = n === 2 ? 'twin' : pick(Object.keys(ARCHETYPES).filter(k => k !== prev.archetype));
  const theme = pick(THEMES.filter(t => t.name !== prev.theme));
  const sys = ARCHETYPES[kind](), names = shuffle(NAMES.slice());
  let ni = 0;
  for (const d of sys.defs) { if (!d.anchor) d.name = names[ni++]; d.start = d.start ?? 0; }
  // now and then one moon is a crystal: faceted, growing glinting shards instead of plants
  const moons = sys.defs.filter((d, i) => i > 0 && !d.anchor && !d.kind && d.R >= 12 && d.R <= 26);
  if (moons.length && Math.random() < 0.35) pick(moons).kind = 'crystal';
  paint(sys.defs, theme);
  const home = sys.defs[0], identity = pickIdentity(Math.random, sys.defs, sys.innerR ?? home.R + 40);
  // pollen: one garden only grows once you bring it pollen from another garden
  if (identity.feature === 'pollen') {
    const g = sys.defs.filter(d => !d.anchor && (!d.kind || d.kind === 'crystal'));
    if (g.length >= 2) {
      const needer = pick(g.slice(1)), donor = pick(g.filter(d => d !== needer));
      needer.needs = donor.name;
    } else identity.feature = null;
  }
  return {
    defs: sys.defs, nebula: theme.nebula, theme: theme.name, archetype: kind, ring: sys.ring || 0,
    centralMass: sys.centralMass ?? home.mass, innerR: sys.innerR ?? home.R + 40, comet: sys.comet,
    identity,
  };
}

// ===== What's special here =====
// Everything notable about a system, as tags. The arrival card lists them and marks the ones you've
// never met as NEW (remembered in this browser), and new things get a pulsing marker in the world.
const GAMEPLAY_TAGS = ['hole', 'gas', 'crystal', 'pollen', 'current', 'calm', 'rocks', 'shower'];
function systemTags(defs, id) {
  const tags = [];
  for (const k of ['hole', 'gas', 'crystal']) if (defs.some(d => d.kind === k)) tags.push(k);
  if (id.feature === 'pollen' && defs.some(d => d.needs)) tags.push('pollen');
  else if (id.feature && id.feature !== 'pollen') tags.push(id.feature);
  if (id.dust && id.dust !== 'streams') tags.push(id.dust);
  if (id.ambient) tags.push(id.ambient);
  if (id.sun2 !== null && id.sun2 !== undefined) tags.push('twinSun');
  return tags;
}
function describeTag(tag) {
  const named = k => (bodies.find(b => b.kind === k) || {}).name;
  const needer = gardens.find(b => b.needs);
  return {
    hole: `${named('hole')} is a black hole. Its disk swallows stardust; touch it and it flings you out`,
    gas: `${named('gas')} is a gas giant with no ground: dive through its clouds. Its moons are the gardens`,
    crystal: `${named('crystal')} is a crystal moon. Seeds grow into chiming crystals`,
    pollen: needer ? `${needer.name} only grows with pollen from ${needer.needs}. Grow ${needer.needs} a little, then fly its pollen over` : 'A pollen errand',
    current: 'A solar wind blows along the bright band. Fly with it for a free boost',
    calm: 'Calm clouds: fly into the fog to settle into a smooth orbit',
    rocks: 'Asteroids drift here. Bump them; hit one hard and it cracks into stardust',
    shower: 'A meteor shower rains stardust in from one side',
    belt: 'Stardust gathers in a wide belt',
    clouds: 'Stardust drifts in loose clouds',
    aurora: 'Aurora curtains hang in the sky',
    pulsar: 'A far pulsar sweeps a thin blue beam past every 12 seconds',
    ice: 'Specks of ice drift by',
    twinSun: 'Two suns light this system',
  }[tag];
}
let card = null;  // the arrival card: { at (real time), lines }
function showCard() {
  const tags = systemTags(allBodies, system.identity);
  if (!system.newTags) {  // what was new the first time we looked, so pressing I later still shows it
    const seen = new Set(prefs.seen || []);
    system.newTags = tags.filter(t => !seen.has(t));
    prefs.seen = [...new Set([...seen, ...tags])];
    savePrefs();
  }
  const rank = t => (system.newTags.includes(t) ? 0 : 2) + (GAMEPLAY_TAGS.includes(t) ? 0 : 1);
  const lines = tags.slice().sort((a, b) => rank(a) - rank(b)).slice(0, 5)
    .map(t => ({ tag: t, text: describeTag(t), isNew: system.newTags.includes(t) }));
  card = { at: performance.now(), lines };
}
const CARD_TIME = 9;
function cardFade() {
  if (!card) return 0;
  const age = (performance.now() - card.at) / 1000;
  if (age > CARD_TIME + 1) { card = null; return 0; }
  return clamp(Math.min(age * 2, CARD_TIME + 1 - age), 0, 1);
}

// Saves from before themes existed get a theme, with their planets and blooms recoloured to match.
function retheme(saved) {
  const theme = saved.systemNo === 1 ? THEMES[0] : THEMES[1 + (saved.systemNo % (THEMES.length - 1))];
  const defs = saved.bodies.map(d => ({ ...d }));
  const oldColors = defs.map(d => d.color && d.color.join(','));
  paint(defs, theme);
  defs.forEach((d, i) => {
    if (d.anchor || !d.plants) return;
    const own = d.color.join(',');
    d.plants = d.plants.map(p => [p[0], p[1], p[2], p[3] === oldColors[i] ? own : pick(d.accents), p[4], p[5]]);
  });
  return { ...saved, bodies: defs, nebula: theme.nebula, theme: theme.name };
}

let allBodies = [], bodies = [], gardens = [], systemNo = 1, system = null;
// `saved` restores a system from the autosave (body list with angles and plants).
function buildSystem(n, saved = null) {
  systemNo = n;
  const prev = system ? { archetype: system.archetype, theme: system.theme } : {};
  if (saved && !THEMES.some(t => t.name === saved.theme)) saved = retheme(saved);  // older palettes
  const sys = saved ? { ...saved, defs: saved.bodies } : n === 1 ? FIRST_SYSTEM : generateSystem(n, prev);
  allBodies = sys.defs.map(def => ({
    ...def, name: def.anchor ? def.name : plantName(def.name || ''), dir: def.dir || 1, angle: def.angle ?? def.start, bloomed: !!def.bloomed,
    plants: (def.plants || []).map(([a, h, kind, tip, flip, sway]) => ({ a, h, kind, tip, flip, sway, grow: 1 })),
    maxPlants: Math.max(8, Math.round(TAU * def.R / 4)), glow: null,
    // every body turns slowly, so its garden rolls through day and night
    spin: def.spin ?? 0, spinRate: def.spinRate ?? (def.anchor ? 0 : TAU / rand(80, 150) * (Math.random() < 0.8 ? 1 : -1)),
  }));
  // renamed old saves can map two bodies to one plant: give the second one the next free name
  const used = new Set();
  for (const b of allBodies) {
    if (b.anchor) continue;
    let i = NAMES.indexOf(b.name);
    while (used.has(b.name)) b.name = NAMES[++i % NAMES.length];
    used.add(b.name);
  }
  for (const b of allBodies) b.parent = b.parent === undefined || b.parent === null ? null : allBodies[b.parent];
  bodies = allBodies.filter(b => !b.anchor);
  // black holes and gas giants can't be landed on or planted. A black hole pulls hard, but its pull is
  // softened inside its disk.
  for (const b of bodies) { b.barren = b.kind === 'hole' || b.kind === 'gas'; b.softR = b.kind === 'hole' ? b.R * 1.8 : b.R; }
  gardens = bodies.filter(b => !b.barren);
  // a crystal's outline: a few flat faces, the same every visit (seeded by its name)
  for (const b of bodies) {
    if (b.kind !== 'crystal') continue;
    let h = 0;
    for (const ch of b.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = seededRandom(h), n = 7 + Math.floor(rnd() * 3);
    b.poly = Array.from({ length: n }, (_, i) => [(i + 0.2 + rnd() * 0.6) / n * TAU, b.R * (1.04 + rnd() * 0.06)]);
  }
  // A moonlet has to hold on to you against its parent's tidal pull, or you can't stay on it.
  for (const b of bodies) if (b.parent && !b.parent.anchor) b.mass = Math.max(b.mass, 4 * b.parent.mass * ((b.R + FOOT) / b.orbit) ** 3);
  system = {
    nebula: sys.nebula, ring: sys.ring || 0, theme: sys.theme, archetype: sys.archetype,
    centralMass: sys.centralMass ?? bodies[0].mass, innerR: sys.innerR ?? bodies[0].R + 40, comet: sys.comet || [50, 80],
    sunAngle: sys.sunAngle ?? rand(0, TAU),  // direction the distant sun shines from
  };
  system.hole = bodies.find(b => b.kind === 'hole') || null;
  setMusic(system.theme);
  system.identity = sys.identity || (n === 1 ? FIRST_IDENTITY : pickIdentity(seededRandom(n * 7717 + 3), sys.defs, system.innerR));
  if (system.identity.sun2 === undefined) system.identity.sun2 = null;
  // theme-derived colours: background wisps, stardust (tinted with the lead colour), engine exhaust
  const theme = THEMES.find(t => t.name === system.theme) || THEMES[0];
  const tint = (c, w) => c.map(v => Math.round(mix(v, 255, w))).join(',');
  system.palette = theme.colors;
  system.night = [1, 3, 5].map(i => Math.round(Math.min(255, parseInt(system.nebula[0].slice(i, i + 2), 16) * 2.4))).join(',');
  system.dustHalo = tint(theme.colors[0], 0.3);
  system.dustCore = tint(theme.colors[0], 0.75);
  system.exhaust = [tint(theme.colors[1], 0.45), '255,236,205'];
  updateBodies(0);
}

const homeGM = () => cfg.gravity * system.centralMass;
// Positions/velocities "now" are cached on each body every physics step (px, py, pvx, pvy);
// these compute them `ahead` seconds into the future for the trajectory preview.
function bodyPos(b, ahead = 0) {
  if (!ahead) return [b.px, b.py];
  if (!b.orbit) return [0, 0];
  const a = b.angle + b.omega * ahead;
  let x = Math.cos(a) * b.orbit, y = Math.sin(a) * b.orbit;
  if (b.parent) { const [px, py] = bodyPos(b.parent, ahead); x += px; y += py; }
  return [x, y];
}
function bodyVel(b, ahead = 0) {
  if (!ahead) return [b.pvx, b.pvy];
  if (!b.orbit) return [0, 0];
  const a = b.angle + b.omega * ahead, v = b.omega * b.orbit;
  let vx = -Math.sin(a) * v, vy = Math.cos(a) * v;
  if (b.parent) { const [pvx, pvy] = bodyVel(b.parent, ahead); vx += pvx; vy += pvy; }
  return [vx, vy];
}
// Gravity from every body right now, plus the soft boundary (which lets the ship out through the exit lane).
function gravityAt(x, y, isShip = false) {
  let ax = 0, ay = 0;
  for (const b of bodies) {
    const dx = b.px - x, dy = b.py - y, r2 = Math.max(dx * dx + dy * dy, b.softR * b.softR), r = Math.sqrt(r2);
    const a = b.gm / r2;
    ax += dx / r * a; ay += dy / r * a;
  }
  const r = Math.hypot(x, y);
  if (r > ARENA_R && !(isShip && inExitLane(x, y))) {
    const k = (r - ARENA_R) * 1.5;
    ax -= x / r * k; ay -= y / r * k;
  }
  return [ax, ay];
}
// A solar-wind current: a curved river along part of an orbit that carries you (and stardust) forward,
// up to a bit faster than orbit speed, and gently holds you in its channel so you can ride the curve
// without steering. It only ever pushes forward, never brakes you.
// how strongly the current acts at a point: 0 outside, 1 in the middle of the band
function currentK(x, y) {
  const c = system.identity.current;
  if (!c) return 0;
  const r = Math.hypot(x, y), off = Math.abs(r - c.r);
  if (off > c.w) return 0;
  const along = Math.abs(angleDiff(Math.atan2(y, x), c.a0 + c.span / 2));
  if (along > c.span / 2) return 0;
  return (1 - (off / c.w) ** 2) * Math.min(1, (c.span / 2 - along) / 0.3);  // soft at the edges and ends
}
function currentPush(x, y, vx, vy) {
  const k = currentK(x, y);
  if (!k) return null;
  const c = system.identity.current, r = Math.hypot(x, y), tx = -y / r, ty = x / r, nx = x / r, ny = y / r;
  const flow = Math.sqrt(homeGM() / r) * 1.7, a = Math.max(0, (flow - (vx * tx + vy * ty)) * 0.9 * k);
  // the channel: a soft spring toward the band's centre line, with damping so you don't bob
  const ar = (-(r - c.r) * 1.6 - (vx * nx + vy * ny) * 1.2) * k;
  return [tx * a + nx * ar, ty * a + ny * ar];
}
// Calm clouds: inside one, your motion gently settles into a plain circular orbit at that height.
function calmAt(x, y) {
  const cl = system.identity.calm;
  if (!cl) return 0;
  for (const c of cl) {
    const d2 = (x - c.x) ** 2 + (y - c.y) ** 2;
    if (d2 < c.r * c.r) return 1 - d2 / (c.r * c.r);
  }
  return 0;
}
function applyFlows(o, dt, calm) {
  const cp = currentPush(o.x, o.y, o.vx, o.vy);
  if (cp) { o.vx += cp[0] * dt; o.vy += cp[1] * dt; }
  const f = calm ? calmAt(o.x, o.y) : 0;
  if (f) {
    const r = Math.hypot(o.x, o.y), v = Math.sqrt(homeGM() / r), k = 1 - Math.exp(-1.2 * f * dt);
    o.vx += (-o.y / r * v - o.vx) * k; o.vy += (o.x / r * v - o.vy) * k;
  }
}

function bloomOf(b) { return b.plants.length / b.maxPlants; }
function altitudeOver(b, x, y) { return Math.hypot(x - b.px, y - b.py) - b.R - FOOT; }
function nearestSurface(x, y) {
  let best = null, alt = Infinity;
  for (const b of gardens) {
    const d = altitudeOver(b, x, y);
    if (d < alt) { alt = d; best = b; }
  }
  return { b: best, alt };
}

// ===== Ships (cosmetic) =====
// Drawn in a local frame where the nose points to -y and the feet sit at y = 7.
function legs(x0, y0, x1) {
  ctx.moveTo(-x0, y0); ctx.lineTo(-x1, 7); ctx.moveTo(-x1 - 1.5, 7); ctx.lineTo(-x1 + 1.5, 7);
  ctx.moveTo(x0, y0); ctx.lineTo(x1, 7); ctx.moveTo(x1 - 1.5, 7); ctx.lineTo(x1 + 1.5, 7);
}
const SHIPS = [
  {
    name: 'Swallow', glow: '#ff9fd8',
    hull() {
      ctx.moveTo(0, -10); ctx.lineTo(5, 0); ctx.lineTo(7, 6); ctx.lineTo(2.5, 2.5);
      ctx.lineTo(-2.5, 2.5); ctx.lineTo(-7, 6); ctx.lineTo(-5, 0); ctx.closePath();
      legs(2, 2.5, 4);
    },
    detail() { ctx.arc(0, -2.5, 1.5, 0, TAU); },
  },
  {
    name: 'Arrow', glow: '#9fd8ff',
    hull() { ctx.moveTo(0, -9); ctx.lineTo(6, 4); ctx.lineTo(-6, 4); ctx.closePath(); legs(4, 3, 7); },
    detail() { ctx.arc(0, -1.5, 1.6, 0, TAU); },
  },
  {
    name: 'Lantern', glow: '#ffe7a8',  // a little lunar lander: boxy cabin, skirt, long splayed legs, antenna
    hull() {
      ctx.moveTo(-2.5, -9); ctx.lineTo(2.5, -9); ctx.lineTo(5, -6.5); ctx.lineTo(5, -1.5); ctx.lineTo(2.5, 1);
      ctx.lineTo(-2.5, 1); ctx.lineTo(-5, -1.5); ctx.lineTo(-5, -6.5); ctx.closePath();
      ctx.moveTo(-2.5, 1); ctx.lineTo(-3.8, 4.5); ctx.lineTo(3.8, 4.5); ctx.lineTo(2.5, 1);
      ctx.moveTo(0, -9); ctx.lineTo(0, -11.2);
      legs(5, -2, 8);
    },
    detail() { ctx.arc(0, -4.5, 1.8, 0, TAU); ctx.moveTo(1.7, -12.8); ctx.arc(0, -12.8, 1.7, 0, TAU); },
  },
  {
    name: 'Seedpod', glow: '#c4f58a',  // a plump seed with a sprout on top
    hull() {
      ctx.moveTo(0, -10); ctx.bezierCurveTo(5.8, -6.5, 5.6, 0, 3, 3.8); ctx.lineTo(-3, 3.8);
      ctx.bezierCurveTo(-5.6, 0, -5.8, -6.5, 0, -10); ctx.closePath();
      legs(3.6, 2, 6);
    },
    detail() {
      ctx.arc(0, -3.5, 1.6, 0, TAU);
      ctx.moveTo(0, -10); ctx.quadraticCurveTo(1.6, -16, 7.5, -15.2); ctx.quadraticCurveTo(4.5, -10.9, 0, -10);
    },
  },
  {
    name: 'Heron', glow: '#74f0d0',  // tall and slim, little swept fins that become knees for long legs
    hull() {
      ctx.moveTo(0, -13); ctx.lineTo(2, -6); ctx.lineTo(2, 3.5); ctx.lineTo(-2, 3.5); ctx.lineTo(-2, -6); ctx.closePath();
      ctx.moveTo(2, -1); ctx.lineTo(5, 3); ctx.lineTo(2, 2.2);
      ctx.moveTo(-2, -1); ctx.lineTo(-5, 3); ctx.lineTo(-2, 2.2);
      legs(5, 3, 7.5);
    },
    detail() { ctx.arc(0, -7, 1.1, 0, TAU); },
  },
  {
    name: 'Ringlet', glow: '#ffab8c',  // a capsule wearing a planet's ring (back half hidden behind the hull)
    hull() {
      ctx.moveTo(0, -10); ctx.quadraticCurveTo(4.6, -8, 4, -1); ctx.lineTo(3, 4); ctx.lineTo(-3, 4); ctx.lineTo(-4, -1);
      ctx.quadraticCurveTo(-4.6, -8, 0, -10); ctx.closePath();
      ctx.moveTo(6.8, -4.5); ctx.ellipse(0, -4.5, 6.8, 1.8, 0, 0, Math.PI);
      ctx.moveTo(-6.8, -4.5); ctx.ellipse(0, -4.5, 6.8, 1.8, 0, Math.PI, Math.PI + 0.9);
      ctx.moveTo(6.8 * Math.cos(-0.9), -4.5 + 1.8 * Math.sin(-0.9)); ctx.ellipse(0, -4.5, 6.8, 1.8, 0, TAU - 0.9, TAU);
      legs(3, 3.5, 6);
    },
    detail() { ctx.arc(0, -0.5, 1.4, 0, TAU); },
  },
  {
    name: 'Dandelion', glow: '#eef0ff',  // a seed hanging under its fluffy parachute
    hull() {
      for (let i = 0; i <= 8; i++) {
        const a = Math.PI * (1.08 + 0.84 * i / 8);
        ctx.moveTo(0, -5); ctx.lineTo(Math.cos(a) * 7, -5 + Math.sin(a) * 7);
      }
      ctx.moveTo(0, -5); ctx.lineTo(0, -1.5);
      ctx.moveTo(0, -1.5); ctx.quadraticCurveTo(2.6, 0.5, 0, 4.5); ctx.quadraticCurveTo(-2.6, 0.5, 0, -1.5);
      legs(1.6, 2.5, 4.2);
    },
    detail() {
      for (let i = 0; i <= 8; i++) {
        const a = Math.PI * (1.08 + 0.84 * i / 8), x = Math.cos(a) * 7, y = -5 + Math.sin(a) * 7;
        ctx.moveTo(x + 0.9, y); ctx.arc(x, y, 0.9, 0, TAU);
      }
    },
  },
  {
    name: 'Moth', glow: '#cdb6ff',  // slim body, soft rounded wings, two feelers
    hull() {
      ctx.moveTo(0, -10); ctx.lineTo(1.8, -6.5); ctx.lineTo(1.8, 4); ctx.lineTo(-1.8, 4); ctx.lineTo(-1.8, -6.5); ctx.closePath();
      ctx.moveTo(1.8, -4.5); ctx.bezierCurveTo(9.5, -8, 10, 2.5, 1.8, 1.5);
      ctx.moveTo(-1.8, -4.5); ctx.bezierCurveTo(-9.5, -8, -10, 2.5, -1.8, 1.5);
      ctx.moveTo(0.7, -9); ctx.quadraticCurveTo(1.2, -10.8, 2.6, -11.5);
      ctx.moveTo(-0.7, -9); ctx.quadraticCurveTo(-1.2, -10.8, -2.6, -11.5);
      legs(1.8, 3, 4.5);
    },
    detail() { ctx.arc(0, -5, 1.1, 0, TAU); },
  },
];
// The pick is saved by name; older saves kept its place in the original four-ship lineup.
{
  const name = prefs.shipName ?? ['Arrow', 'Notch', 'Swallow', 'Kite'][prefs.ship];
  prefs.ship = Math.max(0, SHIPS.findIndex(d => d.name === name));
}
// Draw the chosen ship at the current transform (already rotated and scaled).
function drawHull(design, throttle, lineWidth) {
  if (throttle > 0.02) {
    const len = 6 + 14 * throttle * rand(0.8, 1.1);
    const flame = ctx.createLinearGradient(0, 5, 0, 5 + len);
    flame.addColorStop(0, `rgba(255,240,200,${0.9 * throttle})`);
    flame.addColorStop(1, 'rgba(255,140,60,0)');
    ctx.fillStyle = flame;
    ctx.beginPath(); ctx.moveTo(-2.6, 5); ctx.lineTo(0, 5 + len); ctx.lineTo(2.6, 5); ctx.fill();
  }
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = '#eef7ff'; ctx.shadowColor = design.glow; ctx.shadowBlur = 14;
  ctx.beginPath(); design.hull(); ctx.stroke();
  ctx.fillStyle = design.glow;
  ctx.beginPath(); design.detail(); ctx.fill();
}

// ===== Sound (synthesized, no files) =====
let actx = null, master = null, fxSend = null, engine = null, noiseBuf = null, muted = false;
// iPhones only let sound start inside a finger lift (touchend) or a click, so this runs on those too, and
// plays a silent blip inside the gesture, which unlocks audio for the rest of the session.
function initAudio() {
  if (actx) {
    if (actx.state !== 'running') actx.resume();
    try { const b = actx.createBufferSource(); b.buffer = actx.createBuffer(1, 1, 22050); b.connect(actx.destination); b.start(0); } catch (e) { /* not ready */ }
    return;
  }
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    master = actx.createGain();
    master.gain.value = 0.8;
    master.connect(actx.destination);

    // a soft echo that every note feeds into
    const delay = actx.createDelay(1), fb = actx.createGain(), wet = actx.createGain();
    delay.delayTime.value = 0.32; fb.gain.value = 0.38; wet.gain.value = 0.4;
    fxSend = actx.createGain();
    fxSend.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(master);

    noiseBuf = actx.createBuffer(1, actx.sampleRate * 2, actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // engine: looping filtered noise whose volume follows the throttle
    const src = actx.createBufferSource(), filter = actx.createBiquadFilter(), gain = actx.createGain();
    src.buffer = noiseBuf; src.loop = true;
    filter.type = 'lowpass'; filter.frequency.value = 200;
    gain.gain.value = 0;
    src.connect(filter); filter.connect(gain); gain.connect(master);
    src.start();
    engine = { filter, gain };
  } catch (e) { actx = null; }
  if (actx) initAudio();  // the silent unlock blip
}
// One soft tone through the echo. `attack` > 0.05 gives a slow swell (for pads).
function voice(freq, vol, dur, attack = 0.01, type = 'sine') {
  if (!actx || muted) return;
  const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master); g.connect(fxSend);
  o.start(t); o.stop(t + dur);
}
function note(freq, vol = 0.1, dur = 1.2) {
  voice(freq, vol, dur);
  voice(freq * 2, vol * 0.15, dur, 0.01, 'triangle');
}
function thud(vol, cutoff = 300, dur = 0.35, sweepTo = 0) {
  if (!actx || muted) return;
  const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain(), t = actx.currentTime;
  src.buffer = noiseBuf; f.type = 'lowpass'; f.frequency.setValueAtTime(cutoff, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t); src.stop(t + dur);
}
const sfx = {
  snap() { if (sfxGap('snap')) thud(0.07, 1400, 0.3, 180); },                // a soft "fwump" as the ground takes hold
  clunk() { if (sfxGap('clunk')) { thud(0.1, 260, 0.25); voice(880, 0.025, 0.12, 0.005, 'triangle'); voice(1320, 0.015, 0.1, 0.005, 'triangle'); } },
};
// a safety net against a sound piling up on itself: each of these plays at most every 0.35 s
const sfxLast = {};
function sfxGap(name) {
  const now = actx ? actx.currentTime : 0;
  if (now - (sfxLast[name] ?? -9) < 0.35) return false;
  sfxLast[name] = now;
  return true;
}
function arpeggio(notes, gap = 0.09, vol = 0.09) {
  notes.forEach((f, i) => setTimeout(() => note(f, vol, 1.6), i * gap * 1000));
}
function updateEngineSound() {
  if (!engine) return;
  const th = muted || paused || title ? 0 : ship.throttle, t = actx.currentTime;
  engine.gain.gain.setTargetAtTime(th * 0.1, t, 0.05);
  engine.filter.frequency.setTargetAtTime(180 + th * 520, t, 0.05);
}

// Background music: every fully bloomed body adds a layer (bass, pad, arpeggio, sparkles).
let beatTimer = 0, beatNo = 0;
function updateMusic(dt) {
  const layers = bodies.reduce((n, b) => n + (b.bloomed ? 1 : 0), 0);
  if (!layers) return;
  beatTimer -= dt;
  if (beatTimer > 0) return;
  beatTimer += BEAT;
  const beat = beatNo++, chord = CHORDS[Math.floor(beat / 8) % CHORDS.length], inBar = beat % 8;
  if (inBar === 0) voice(chord[0] / 2, 0.06, 5, 0.6);
  if (layers >= 2 && inBar === 0) for (const f of chord) voice(f, 0.02, 5.5, 1.5, 'triangle');
  if (layers >= 3 && inBar % 2 === 1) voice(chord[(inBar >> 1) % 3] * 2, 0.025, 1.6);
  if (layers >= 4 && Math.random() < 0.35) voice(pick(SCALE) * 2, 0.015, 1.8);
}

// ===== Input =====
// Mouse and keyboard are both live; whichever was used last steers.
const keys = {};
const mouse = { x: 0, y: 0, down: false, right: false };
let inputMode = TOUCH ? 'touch' : 'keys';
const fullThrust = () => keys.KeyW || keys.ArrowUp || keys.Space || mouse.down;
const gentleThrust = () => keys.KeyS || keys.ArrowDown || mouse.right;

function cycleShip(step) {
  prefs.ship = (prefs.ship + step + SHIPS.length) % SHIPS.length;
  prefs.shipName = SHIPS[prefs.ship].name;
  savePrefs();
}

let restartAsked = -10;
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  initAudio();
  const k = e.code;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) e.preventDefault();
  if (title) {
    // on the title screen left/right choose a ship, anything else starts
    if (k === 'ArrowLeft' || k === 'KeyA') cycleShip(-1);
    else if (k === 'ArrowRight' || k === 'KeyD') cycleShip(1);
    else if (!e.repeat) startGame();
    return;
  }
  keys[k] = true;
  if (e.repeat) return;
  keyAction(k);
});
// What each key does (the pause menu's buttons call this too).
function keyAction(k) {
  if (k === 'KeyR') {
    if (performance.now() - restartAsked < 3000) reset();
    else { restartAsked = performance.now(); say('Press R again to start over (your gardens will be lost)', '#ffcf8a'); }
  }
  else if (k === 'KeyT') togglePanel();
  else if (k === 'KeyN') { muted = !muted; say(muted ? 'Sound off' : 'Sound on'); }
  else if (k === 'KeyH') showHints = !showHints;
  else if (k === 'KeyC') { cycleShip(1); say(`Ship: ${SHIPS[prefs.ship].name}`); }
  else if (k === 'KeyO') { prefs.orbits = (prefs.orbits + 1) % 3; savePrefs(); say(['Orbits hidden', 'Orbits faint', 'Orbits shown'][prefs.orbits]); }
  else if (k === 'KeyF') { prefs.fps = !prefs.fps; savePrefs(); }
  else if (k === 'KeyZ') { prefs.autoZoom = !prefs.autoZoom; savePrefs(); say('Landing zoom ' + (prefs.autoZoom ? 'on' : 'off')); }
  else if (k === 'KeyV') togglePhoto();
  else if (k === 'KeyI') showCard();
  else if (k === 'KeyM') { starMap = !starMap; if (photo) togglePhoto(); paused = starMap; }
  else if ((k === 'KeyP' || k === 'Escape') && (photo || starMap)) { if (photo) togglePhoto(); starMap = false; paused = false; }
  else if (k === 'KeyP' || k === 'Escape') paused = !paused;
}
// ===== Touch =====
// An invisible joystick: putting a thumb down anywhere makes that spot its centre. The direction you drag
// turns the ship; a short drag only aims, dragging further thrusts (further = stronger, up to full); lifting
// the thumb lets you coast. It has no visuals.
const JOY_AIM = 14, JOY_THRUST = 26, JOY_FULL = 85;
const joy = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
function joyVec() { const dx = joy.x - joy.ox, dy = joy.y - joy.oy; return [dx, dy, Math.hypot(dx, dy)]; }
function joyThrottle() { return joy.id === null ? 0 : clamp((joyVec()[2] - JOY_THRUST) / (JOY_FULL - JOY_THRUST), 0, 1); }
// A second thumb, anywhere, brakes: the ship flips on its own and fires against its motion relative to the
// nearest garden, settling into a slow sink when close to a surface, so you drift down gently to land.
// (The keyboard way is to turn upright and tap thrust; that's fiddly with one thumb on a joystick.)
const brake = { id: null, x: 0, y: 0 };
const braking = () => brake.id !== null && !ship.landed;
function brakeControl(s) {
  const { b, alt } = nearestSurface(s.x, s.y);
  const ox = s.x - b.px, oy = s.y - b.py, d = Math.hypot(ox, oy) || 1, nx = ox / d, ny = oy / d;
  const sink = clamp(alt * 0.6, 9, 55);  // the speed to settle down at: brisk up high, easing off near the ground
  const [gx, gy] = gravityAt(s.x, s.y, true);
  // the push the engine should make: cancel the drift (relative to the body) and hold off gravity
  const ax = (-nx * sink - (s.vx - b.pvx)) * 1.6 - gx, ay = (-ny * sink - (s.vy - b.pvy)) * 1.6 - gy;
  const a = Math.hypot(ax, ay), power = cfg.thrust + Math.hypot(gx, gy) * cfg.liftBoost, angle = Math.atan2(ay, ax);
  // fire only once roughly facing the right way: flip first, then burn
  return { angle, throttle: a < 1.5 || Math.abs(angleDiff(angle, s.angle)) > 0.5 ? 0 : clamp(a / power, 0, 1) };
}
const PAUSE_ICON = 44;
const hitPauseIcon = (x, y) => x > W - PAUSE_ICON - 10 && y < PAUSE_ICON + 10;
function pauseIconTap() {
  if (photo) togglePhoto();
  else if (starMap) { starMap = false; paused = false; }
  else paused = !paused;
}
// On the title screen: tapping the arrows by the ship picks a ship, anywhere else starts.
function titleTap(x, y) {
  const py = H * 0.55 + 64, off = x - W / 2;
  if (Math.abs(y - py) < 40 && Math.abs(off) > 25 && Math.abs(off) < 170) cycleShip(off < 0 ? -1 : 1);
  else startGame();
}
canvas.addEventListener('touchstart', e => {
  e.preventDefault();  // no scrolling, zooming or mouse emulation
  initAudio();
  inputMode = 'touch';
  for (const t of e.changedTouches) {
    const x = t.clientX, y = t.clientY;
    if (title) { titleTap(x, y); continue; }
    if (hitPauseIcon(x, y)) { pauseIconTap(); continue; }
    if (starMap) { starMap = false; paused = false; continue; }
    if (photo) { photo.drag = [x, y]; photo.touch = t.identifier; continue; }
    if (paused) { menuTap(x, y); continue; }
    if (joy.id === null) { joy.id = t.identifier; joy.ox = joy.x = x; joy.oy = joy.y = y; }
    else if (brake.id === null) { brake.id = t.identifier; brake.x = x; brake.y = y; }  // a second thumb brakes
  }
}, { passive: false });
canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === joy.id) { joy.x = t.clientX; joy.y = t.clientY; }
    else if (t.identifier === brake.id) { brake.x = t.clientX; brake.y = t.clientY; }
    else if (photo && photo.drag && photo.touch === t.identifier) {
      const z = scale * cam.zoom;
      cam.x -= (t.clientX - photo.drag[0]) / z; cam.y -= (t.clientY - photo.drag[1]) / z;
      photo.drag = [t.clientX, t.clientY];
    }
  }
}, { passive: false });
function touchEnd(e) {
  initAudio();  // a finger lift is when iPhones allow sound to start
  for (const t of e.changedTouches) {
    if (t.identifier === joy.id) joy.id = null;
    if (t.identifier === brake.id) brake.id = null;
    if (photo && photo.touch === t.identifier) photo.drag = null;
  }
}
canvas.addEventListener('touchend', touchEnd);
canvas.addEventListener('touchcancel', touchEnd);

// The pause menu: every key's option as a button (tap, or click with the mouse), letter shown alongside.
let menuRects = [];
function menuItems() {
  const again = performance.now() - restartAsked < 3000;
  return [
    ['P', 'Resume', () => { paused = false; }],
    ['O', `Orbits: ${['hidden', 'faint', 'shown'][prefs.orbits]}`, () => keyAction('KeyO')],
    ['Z', `Landing zoom: ${prefs.autoZoom ? 'on' : 'off'}`, () => keyAction('KeyZ')],
    ['C', `Ship: ${SHIPS[prefs.ship].name}`, () => keyAction('KeyC')],
    ['I', 'System info', () => { paused = false; keyAction('KeyI'); }],
    ['M', 'Star map', () => keyAction('KeyM')],
    ['V', 'Photo mode', () => keyAction('KeyV')],
    ['N', `Sound: ${muted ? 'off' : 'on'}`, () => keyAction('KeyN')],
    ['H', `Hints: ${showHints ? 'on' : 'off'}`, () => keyAction('KeyH')],
    ['F', `FPS counter: ${prefs.fps ? 'on' : 'off'}`, () => keyAction('KeyF')],
    ['R', again ? 'Tap again to start over' : 'Start over', () => { keyAction('KeyR'); if (again) paused = false; }],
  ];
}
function menuTap(x, y) {
  for (const r of menuRects) if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { r.act(); message = null; return; }
}
function drawPauseMenu() {
  const items = menuItems(), pw = Math.min(W - 32, 480), cols = pw >= 340 ? 2 : 1, bh = 44, gap = 8;
  const bw = (pw - gap * (cols - 1)) / cols, rows = 1 + Math.ceil((items.length - 1) / cols);
  const ph = 56 + rows * (bh + gap), x0 = W / 2 - pw / 2, y0 = Math.max(70, H / 2 - ph / 2);
  ctx.save();
  ctx.fillStyle = 'rgba(3,5,13,0.6)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#cfe'; ctx.font = 'bold 22px ui-monospace, Consolas, monospace';
  ctx.fillText('PAUSED', W / 2, y0 + 16);
  menuRects = [];
  items.forEach(([key, label, act], i) => {
    const first = i === 0, row = first ? 0 : 1 + Math.floor((i - 1) / cols), col = first ? 0 : (i - 1) % cols;
    const w = first ? pw : bw, x = x0 + col * (bw + gap), y = y0 + 44 + row * (bh + gap);
    menuRects.push({ x, y, w, h: bh, act });
    ctx.fillStyle = first ? 'rgba(40,60,100,0.9)' : 'rgba(18,26,50,0.88)';
    ctx.strokeStyle = 'rgba(150,180,230,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x, y, w, bh, 8); ctx.fill(); ctx.stroke();
    // the key letter in a little badge, then the label
    ctx.strokeStyle = 'rgba(150,180,230,0.4)';
    ctx.beginPath(); ctx.roundRect(x + 10, y + 11, 22, 22, 4); ctx.stroke();
    ctx.fillStyle = 'rgba(170,195,235,0.8)'; ctx.font = '12px ui-monospace, Consolas, monospace';
    ctx.fillText(key, x + 21, y + 22);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e4efff'; ctx.font = '14px ui-monospace, Consolas, monospace';
    ctx.fillText(label, x + 42, y + 22);
    ctx.textAlign = 'center';
  });
  ctx.restore();
}
function drawPauseIcon() {
  const x = W - PAUSE_ICON - 6, y = 8;
  ctx.save();
  ctx.fillStyle = 'rgba(10,14,30,0.45)';
  ctx.beginPath(); ctx.roundRect(x, y, PAUSE_ICON, PAUSE_ICON, 10); ctx.fill();
  ctx.fillStyle = paused || photo || starMap ? 'rgba(255,255,255,0.85)' : 'rgba(200,215,240,0.6)';
  ctx.fillRect(x + 15, y + 13, 5, 18); ctx.fillRect(x + 24, y + 13, 5, 18);
  ctx.restore();
}
// While the brake thumb is down, a small amber word above the ship says so, where you're looking (a marker
// under the thumb itself was hidden by it). The joystick itself has no visuals.
function drawBrakeMarker() {
  if (brake.id === null || paused || photo) return;
  const s = ship;
  ctx.save();
  ctx.fillStyle = s.landed ? 'rgba(255,224,170,0.55)' : 'rgba(255,214,150,0.9)';
  ctx.font = `${11 * px}px ui-monospace, Consolas, monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(s.landed ? 'landed' : 'braking', s.x, s.y - 30 * px);
  ctx.restore();
}
// Wraps text to a width with the current font.
function wrapText(text, maxW) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    const t = line ? line + ' ' + word : word;
    if (line && ctx.measureText(t).width > maxW) { out.push(line); line = word; } else line = t;
  }
  if (line) out.push(line);
  return out;
}

// Photo mode freezes time and hides the HUD; scroll to zoom toward the cursor, drag to pan.
function togglePhoto() {
  if (photo) { paused = photo.wasPaused; photo = null; return; }
  photo = { at: performance.now(), wasPaused: paused, drag: null };
  starMap = false;
  paused = true;
}
canvas.addEventListener('wheel', e => {
  if (!photo) return;
  e.preventDefault();
  const [wx, wy] = screenToWorld(e.clientX, e.clientY);
  cam.zoom = clamp(cam.zoom * Math.exp(-e.deltaY * 0.0015), 0.6, 8);
  const [nx, ny] = screenToWorld(e.clientX, e.clientY);
  cam.x += wx - nx; cam.y += wy - ny;
}, { passive: false });
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
  mouse.down = mouse.right = false;
  if (!title) paused = true;
  saveGame();
});
addEventListener('beforeunload', () => saveGame());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  for (const k in keys) keys[k] = false;
  mouse.down = mouse.right = false; joy.id = null; brake.id = null;
  if (!title) paused = true;
  saveGame();
});
canvas.addEventListener('mousemove', e => {
  if (photo && photo.drag) {
    const z = scale * cam.zoom;
    cam.x -= (e.clientX - photo.drag[0]) / z; cam.y -= (e.clientY - photo.drag[1]) / z;
    photo.drag = [e.clientX, e.clientY];
  }
  mouse.x = e.clientX; mouse.y = e.clientY; inputMode = 'mouse';
});
canvas.addEventListener('mousedown', e => {
  initAudio();
  mouse.x = e.clientX; mouse.y = e.clientY; inputMode = 'mouse';
  if (title) { if (e.button === 0) startGame(); return; }
  if (photo) { photo.drag = [e.clientX, e.clientY]; return; }
  if (paused && !starMap) { if (e.button === 0) menuTap(e.clientX, e.clientY); return; }
  if (e.button === 0) mouse.down = true;
  if (e.button === 2) mouse.right = true;
});
addEventListener('mouseup', e => {
  if (photo) photo.drag = null;
  if (e.button === 0) mouse.down = false;
  if (e.button === 2) mouse.right = false;
});
canvas.addEventListener('contextmenu', e => e.preventDefault());

// ===== Tuning panel =====
const panel = document.getElementById('tuning');
function buildPanel() {
  panel.innerHTML = '<h3>Tuning <small>(T to close, applies live)</small></h3>';
  for (const [key, label, min, max, step] of TUNING) {
    const row = document.createElement('label');
    row.className = 'row';
    row.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}"><output></output>`;
    const input = row.querySelector('input'), out = row.querySelector('output');
    input.value = cfg[key];
    out.textContent = cfg[key];
    input.addEventListener('input', () => { cfg[key] = +input.value; out.textContent = input.value; saveCfg(); });
    input.addEventListener('change', () => input.blur());  // hand the arrow keys back to the ship
    panel.appendChild(row);
  }
  const btn = document.createElement('button');
  btn.textContent = 'Reset to defaults';
  btn.addEventListener('click', () => { Object.assign(cfg, DEFAULTS); saveCfg(); buildPanel(); });
  panel.appendChild(btn);
}
function togglePanel() {
  if (!panel.classList.contains('open')) buildPanel();
  panel.classList.toggle('open');
}

// ===== Game state =====
let ship, motes, comets, rocks = [], rockTimer = 0, waves = [], allBloomedAt = -99, particles, fireflies, exit = null, message, chain, lastPickup, chainPopup;
let streamTimer, cometTimer, ringTimer, diskTimer = 0, fireflyTimer, saveTimer, allBloomed, warp;
let title = true, paused = false, showHints = true, time = 0;
let photo = null, starMap = false, visited = [];  // photo mode ({ at, wasPaused }), star map open, systems left behind

function say(text, color = '#cfe') { message = { text, color, t: time }; }

function startGame() {
  title = false;
  paused = false;
  say(systemNo === 1 && !bodies.some(b => b.plants.length) ? 'Gather stardust. Land gently to plant it.' : `Welcome back to system ${systemNo}`);
  if (systemNo > 1) showCard();
}

function reset() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* storage blocked */ }
  visited = [];
  enterSystem(1);
  say('Gather stardust. Land gently to plant it.');
}

function enterSystem(n, saved = null) {
  buildSystem(n, saved);
  const la = -Math.PI / 2;  // start parked on top of the home planet
  ship = {
    x: 0, y: 0, vx: 0, vy: 0, angle: la, angVel: 0, throttle: 0, emitAcc: 0,
    fuel: FUEL_MAX, empty: false, seeds: saved ? saved.seeds || 0 : 0,
    landed: gardens[0], landAngle: la, tumble: 0, plantTimer: 0, snapping: false, pollen: null,
    holdSeeds: true,  // starting on a planet doesn't plant your seeds there: take off and land first
  };
  parkShip();
  motes = []; comets = []; particles = []; fireflies = []; rocks = []; rockTimer = 0; waves = []; allBloomedAt = -99; card = null;
  if (system.identity.feature === 'rocks') for (let i = 0; i < 4; i++) spawnRock();
  chain = 0; lastPickup = -10; chainPopup = null;
  streamTimer = 0; cometTimer = Math.min(30, system.comet[0]); ringTimer = 0; fireflyTimer = 0; saveTimer = 5;
  allBloomed = gardens.every(b => b.bloomed);
  // older saves stored a gate position; its direction becomes the exit lane
  const savedExit = saved ? saved.exit ?? (saved.gate ? Math.atan2(saved.gate[1], saved.gate[0]) : null) : null;
  exit = null;
  if (allBloomed) openExit(savedExit ?? undefined);
  warp = null;
  cam.focus = gardens[0];
  for (let i = 0; i < (system.identity.dust === 'belt' ? 7 : 4); i++) spawnStream();
  if (system.ring) for (let i = 0; i < RING_MOTES; i++) spawnRingMote();
}

// ===== Saving =====
function saveGame() {
  if (!ship || warp) return;
  const r = (v, d) => Math.round(v * d) / d;
  const data = {
    systemNo, seeds: ship.seeds, visited, exit: exit ? r(exit.angle, 1000) : null,
    nebula: system.nebula, ring: system.ring, theme: system.theme, archetype: system.archetype,
    centralMass: system.centralMass, innerR: system.innerR, comet: system.comet, sunAngle: system.sunAngle, identity: system.identity,
    bodies: allBodies.map(b => ({
      name: b.name, R: b.R, mass: b.mass, orbit: b.orbit, start: b.start, dir: b.dir,
      anchor: b.anchor || undefined, kind: b.kind, tilt: b.tilt, omegaMass: b.omegaMass, omegaDist: b.omegaDist,
      color: b.color, accents: b.accents, parent: b.parent ? allBodies.indexOf(b.parent) : undefined,
      needs: b.needs, pollinated: b.pollinated || undefined,
      angle: r(b.angle, 1000), bloomed: b.bloomed, spin: r(b.spin % TAU, 1000), spinRate: b.spinRate,
      plants: b.plants.map(p => [r(p.a, 1000), r(p.h, 10), p.kind, p.tip, p.flip, r(p.sway, 100)]),
    })),
  };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (e) { /* storage blocked */ }
}
function loadSave() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { return null; }
}

function clearOfBodies(x, y) {
  return !bodies.some(b => Math.hypot(x - b.px, y - b.py) < b.R + 30);
}

function spawnStream() {
  const id = system.identity;
  if (id.dust === 'clouds') return spawnCloud();
  if (id.dust === 'belt' && Math.random() < 0.75) return spawnBeltArc();
  if (id.dust === 'shower') return spawnShower();
  const r = rand(system.innerR, 450), a0 = rand(0, TAU), n = Math.floor(rand(8, 15));
  const v = Math.sqrt(homeGM() / r) * rand(0.97, 1.03), da = 11 / r;
  // irregular spacing and a little sideways scatter, so a stream doesn't look like a dashed orbit line
  let a = a0;
  for (let k = 0; k < n; k++) {
    a += da * rand(0.5, 1.6);
    const rr = r + rand(-5, 5), x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    if (!clearOfBodies(x, y)) continue;
    motes.push({ x, y, vx: -Math.sin(a) * v, vy: Math.cos(a) * v, born: time, tw: rand(0, TAU), tws: rand(2.5, 5.5), size: rand(0.7, 1.3), gold: false });
  }
}

const dustMote = (x, y, vx, vy, extra) => ({ x, y, vx, vy, born: time, tw: rand(0, TAU), tws: rand(2.5, 5.5), size: rand(0.7, 1.3), gold: false, ...extra });
const circular = (x, y, jitter = 0) => {
  const r = Math.hypot(x, y), v = Math.sqrt(homeGM() / r);
  return [-y / r * v + rand(-jitter, jitter), x / r * v + rand(-jitter, jitter)];
};
// a loose round cloud of stardust drifting on its orbit (it slowly shears out as it goes round)
function spawnCloud() {
  const r = rand(system.innerR + 20, 440), a = rand(0, TAU), cx = Math.cos(a) * r, cy = Math.sin(a) * r;
  if (!clearOfBodies(cx, cy)) return;
  const [vx, vy] = circular(cx, cy), n = Math.floor(rand(12, 19));
  for (let k = 0; k < n; k++) {
    const d = 22 * Math.sqrt(Math.random()), t = rand(0, TAU), x = cx + Math.cos(t) * d, y = cy + Math.sin(t) * d;
    motes.push(dustMote(x, y, vx + rand(-2, 2), vy + rand(-2, 2)));
  }
}
// a clump of a wide stardust belt in a free lane between the orbits
function spawnBeltArc() {
  const a0 = rand(0, TAU), n = Math.floor(rand(12, 19));
  for (let k = 0; k < n; k++) {
    const a = a0 + rand(0, 0.5), rr = system.identity.beltR + rand(-22, 22), x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    if (!clearOfBodies(x, y)) continue;
    const [vx, vy] = circular(x, y);
    motes.push(dustMote(x, y, vx, vy, { size: rand(0.6, 1.2) }));
  }
}
// a meteor shower: stardust raining in from one side of the sky, curving round the planets, then fading
function spawnShower() {
  const n = Math.floor(rand(6, 10)), base = system.identity.showerAngle;
  for (let k = 0; k < n; k++) {
    const a = base + rand(-0.3, 0.3), r = ARENA_R - rand(0, 40), sp = rand(55, 80);
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    motes.push(dustMote(x, y, -Math.cos(a) * sp - Math.sin(base) * 25, -Math.sin(a) * sp + Math.cos(base) * 25,
      { life: rand(16, 22), born: time - rand(0, 1.5), size: rand(0.8, 1.3), tws: rand(5, 8), streak: true }));
  }
}

function spawnRingMote() {
  const r = system.ring + rand(-6, 6), a = rand(0, TAU), v = Math.sqrt(homeGM() / r);
  motes.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, vx: -Math.sin(a) * v, vy: Math.cos(a) * v, born: time, tw: rand(0, TAU), tws: rand(2.5, 5.5), size: rand(0.6, 1.1), gold: false, ring: true });
}

// Stardust circling in a black hole's disk; it slowly spirals in and is swallowed.
function spawnDiskMote(b) {
  const r = b.R * rand(3, 4.6), a = rand(0, TAU), v = Math.sqrt(b.gm / r);
  motes.push({ x: b.px + Math.cos(a) * r, y: b.py + Math.sin(a) * r, vx: b.pvx - Math.sin(a) * v, vy: b.pvy + Math.cos(a) * v, born: time, tw: rand(0, TAU), tws: rand(4, 8), size: rand(0.6, 1.1), gold: false, disk: true });
}

// A comet falls in from the edge on a long ellipse, swings past the planet and leaves a golden trail.
function spawnComet() {
  const a = rand(0, TAU), r = ARENA_R - 15, rp = rand(system.innerR + 10, Math.min(system.innerR + 120, 300));
  const va = Math.sqrt(2 * homeGM() * rp / (r * (r + rp)));  // speed at the far end of that ellipse
  const inward = 35;  // a nudge inward so it arrives in seconds rather than half a minute
  comets.push({
    x: Math.cos(a) * r, y: Math.sin(a) * r,
    vx: -Math.sin(a) * va - Math.cos(a) * inward, vy: Math.cos(a) * va - Math.sin(a) * inward,
    age: 0, travel: 0, dropped: 0, caught: false, fade: 1, leaving: false, spin: rand(0, TAU),
    shape: Array.from({ length: 7 }, () => rand(0.75, 1.15)),  // a lumpy little nucleus
  });
  say('A comet! Follow its golden trail', '#ffe7a0');
  arpeggio([SCALE[10], SCALE[8], SCALE[9], SCALE[7]], 0.12, 0.05);
}

function burst(x, y, n, { vx = 0, vy = 0, dir = 0, spread = TAU, speed = [20, 80], life = [0.3, 0.8], color = '255,255,255', size = 1.3, grav = false, shard = false }) {
  for (let i = 0; i < n; i++) {
    const a = dir + rand(-spread / 2, spread / 2), sp = rand(speed[0], speed[1]), l = rand(life[0], life[1]);
    particles.push({ x, y, vx: vx + Math.cos(a) * sp, vy: vy + Math.sin(a) * sp, life: l, max: l, color, size, grav, shard, bvx: vx, bvy: vy });
  }
  if (particles.length > 1500) particles.splice(0, particles.length - 1500);
}

// ===== Update =====
function update(dt) {
  time += dt;
  updateBodies(dt);
  updateShip(dt);
  updateMotes(dt);
  updateComets(dt);
  updateRocks(dt);
  updateFireflies(dt);
  updateExit(dt);
  updateParticles(dt);
  updateMusic(dt);
  for (let i = waves.length - 1; i >= 0; i--) if (time - waves[i].t0 > waves[i].dur) removeAt(waves, i);
  streamTimer -= dt;
  if (streamTimer <= 0 && motes.length < MIN_MOTES) { spawnStream(); streamTimer = 3; }
  if (system.ring) {
    ringTimer -= dt;
    if (ringTimer <= 0) {
      ringTimer = 0.6;
      if (motes.reduce((n, m) => n + (m.ring ? 1 : 0), 0) < RING_MOTES) spawnRingMote();
    }
  }
  if (system.hole) {
    diskTimer -= dt;
    if (diskTimer <= 0) {
      diskTimer = 0.5;
      if (motes.reduce((n, m) => n + (m.disk ? 1 : 0), 0) < 22) spawnDiskMote(system.hole);
    }
  }
  cometTimer -= dt;
  if (cometTimer <= 0) { spawnComet(); cometTimer = rand(system.comet[0], system.comet[1]); }
  saveTimer -= dt;
  if (saveTimer <= 0) { saveGame(); saveTimer = 5; }
  if (warp) {
    warp.t += dt;
    if (!warp.switched && warp.t >= 1.5) {
      visited.push(snapshotSystem());
      const carried = ship.seeds;  // unused seeds come along to the next system
      enterSystem(systemNo + 1);
      ship.seeds = carried;
      arriveInOrbit();
      warp = { t: 1.5, switched: true };
      showCard();
      saveGame();
    }
    if (warp.t >= 3) warp = null;
  }
}

function updateBodies(dt) {
  // parents come before their moonlets in the list, so their cached positions are already fresh
  for (const b of allBodies) {
    b.gm = cfg.gravity * b.mass;
    if (b.orbit) {
      // what it circles: its parent, or the middle of the system, or (for pairs) their shared centre
      const m = b.omegaMass ?? (b.parent ? b.parent.mass : system.centralMass), d = b.omegaDist ?? b.orbit;
      b.omega = b.dir * Math.sqrt(cfg.gravity * m / d ** 3);
      b.angle += b.omega * dt;
    } else b.omega = 0;
    const a = b.angle, v = b.omega * b.orbit, p = b.parent;
    b.px = (p ? p.px : 0) + Math.cos(a) * b.orbit;
    b.py = (p ? p.py : 0) + Math.sin(a) * b.orbit;
    b.pvx = (p ? p.pvx : 0) - Math.sin(a) * v;
    b.pvy = (p ? p.pvy : 0) + Math.cos(a) * v;
    b.spin += b.spinRate * dt;
    for (const pl of b.plants) {
      if (pl.delay > 0) pl.delay -= dt;  // plants that are still waiting their turn to sprout
      else if (pl.grow < 1) pl.grow = Math.min(1, pl.grow + dt * 1.2);
    }
  }
}

// Velocity of the ground under the ship's feet at world angle `a` (the body moves and turns slowly).
function surfaceVel(b, a) {
  const v = b.spinRate * (b.R + FOOT);
  return [b.pvx - Math.sin(a) * v, b.pvy + Math.cos(a) * v];
}

// Out of the warp you arrive drifting on a calm orbit near the edge of the new system, facing along it,
// clear of every body, so you choose where your seeds go first.
function arriveInOrbit() {
  const s = ship, r = ARENA_R - 30;
  let best = 0, bestGap = -1;
  for (let k = 0; k < 24; k++) {  // the spot furthest from any body
    const a = k / 24 * TAU, x = Math.cos(a) * r, y = Math.sin(a) * r;
    const gap = Math.min(...bodies.map(b => Math.hypot(x - b.px, y - b.py) - b.R));
    if (gap > bestGap) { bestGap = gap; best = a; }
  }
  const v = Math.sqrt(homeGM() / r);
  s.landed = null;
  s.x = Math.cos(best) * r; s.y = Math.sin(best) * r;
  s.vx = -Math.sin(best) * v; s.vy = Math.cos(best) * v;
  s.angle = best + Math.PI / 2;
  s.holdSeeds = false;
  cam.zoom = 1; cam.x = 0; cam.y = 0;
}

function parkShip() {
  const s = ship, b = s.landed;
  s.x = b.px + Math.cos(s.landAngle) * (b.R + FOOT);
  s.y = b.py + Math.sin(s.landAngle) * (b.R + FOOT);
  [s.vx, s.vy] = surfaceVel(b, s.landAngle);
}

function updateShip(dt) {
  const s = ship;

  // steering: ease the spin toward what the player wants, so turns feel smooth.
  // While landed the ship settles upright on its legs (eased, so a tilted touchdown doesn't flip it in one
  // frame) and stays that way until it takes off.
  if (s.landed) {
    s.angVel = 0;
    s.angle += angleDiff(s.landAngle, s.angle) * (1 - Math.exp(-3.5 * dt));
  } else if (s.tumble > 0) {
    s.tumble -= dt;
    s.angVel *= Math.exp(-2 * dt);
  } else {
    let targetSpin = 0;
    const turnKeys = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    if (turnKeys) {
      inputMode = 'keys';
      targetSpin = turnKeys * cfg.turnSpeed;
    } else if (inputMode === 'touch') {
      const [dx, dy, d] = joyVec();
      if (braking()) {
        const bc = brakeControl(s);
        targetSpin = clamp(angleDiff(bc.angle, s.angle) * 8, -cfg.turnSpeed, cfg.turnSpeed);
        s.brakeThrottle = bc.throttle;
      } else if (joy.id !== null && d > JOY_AIM) targetSpin = clamp(angleDiff(Math.atan2(dy, dx), s.angle) * 8, -cfg.turnSpeed, cfg.turnSpeed);
    } else if (inputMode === 'mouse') {
      const [wx, wy] = screenToWorld(mouse.x, mouse.y);
      targetSpin = clamp(angleDiff(Math.atan2(wy - s.y, wx - s.x), s.angle) * 8, -cfg.turnSpeed, cfg.turnSpeed);
    }
    s.angVel += (targetSpin - s.angVel) * Math.min(1, 14 * dt);
  }
  s.angle += s.angVel * dt;

  // throttle eases in and out; an empty tank cuts out until it has recharged a bit
  if (s.fuel <= 0) s.empty = true;
  else if (s.fuel >= 15) s.empty = false;
  const want = s.tumble > 0 || s.empty ? 0 : fullThrust() ? 1 : gentleThrust() ? GENTLE : braking() ? s.brakeThrottle || 0 : joyThrottle();
  s.throttle += (want - s.throttle) * Math.min(1, (want > s.throttle ? 10 : 7) * dt);
  if (s.throttle < 0.002) s.throttle = 0;
  s.fuel = clamp(s.fuel - cfg.fuelBurn * s.throttle * dt + FUEL_REGEN * dt, 0, FUEL_MAX);

  // the engine pushes harder where gravity is stronger, so it feels the same everywhere
  const [gx, gy] = gravityAt(s.x, s.y, true);
  const power = cfg.thrust + Math.hypot(gx, gy) * cfg.liftBoost;
  const dx = Math.cos(s.angle), dy = Math.sin(s.angle);
  const tx = dx * s.throttle * power, ty = dy * s.throttle * power;

  s.emitAcc += s.throttle * 110 * dt;
  while (s.emitAcc >= 1) {
    s.emitAcc -= 1;
    const a = s.angle + Math.PI + rand(-0.25, 0.25), sp = rand(70, 140);
    particles.push({
      x: s.x - dx * 9, y: s.y - dy * 9, vx: s.vx + Math.cos(a) * sp, vy: s.vy + Math.sin(a) * sp,
      life: rand(0.3, 0.6), max: 0.6, color: pick(system.exhaust), size: 1.6, grav: false,
    });
  }

  if (s.landed) {
    const b = s.landed, nx = Math.cos(s.landAngle), ny = Math.sin(s.landAngle);
    const lift = tx * nx + ty * ny, surfaceG = b.gm / (b.R + FOOT) ** 2;
    if (lift <= surfaceG) {
      s.landAngle += b.spinRate * dt;  // ride along as the body turns
      parkShip();
      s.fuel = Math.min(FUEL_MAX, s.fuel + LAND_REFUEL * dt);
      if (s.seeds > 0 && !s.holdSeeds && !b.bloomed && !(b.needs && !b.pollinated)) {  // a garden in full bloom doesn't take more seeds
        s.plantTimer -= dt;
        if (s.plantTimer <= 0) {
          // the first 15 seeds of a landing go in at the usual pace, then each a little quicker (down to
          // twice as fast), so emptying a full load onto a big planet doesn't drag
          s.plantTimer = Math.max(0.06, 0.12 * 0.96 ** Math.max(0, s.plantRun - 15));
          s.plantRun++; s.seeds--; plantSeed(b, s.landAngle);
        }
      }
      return;
    }
    s.landed = null;  // enough thrust away from the ground: lift off
    s.holdSeeds = false;
    s.liftedAt = time; s.airborne = false;  // until you've properly left the ground (see below)
    // taking off from a garden that another one is waiting on, you carry its pollen
    const waiting = gardens.find(o => o.needs === b.name && !o.pollinated);
    if (waiting && !s.pollen && bloomOf(b) >= 0.4) {
      s.pollen = b;
      say(`You carry ${b.name} pollen. ${waiting.name} is waiting for it`, bodyColor(b));
    }
  }

  s.vx += (gx + tx) * dt; s.vy += (gy + ty) * dt;
  applyFlows(s, dt, true);
  cloudDrag(s, dt, true);
  for (const g of gardens) if (g.fullHint === false && altitudeOver(g, s.x, s.y) > 60) g.fullHint = true;
  // a few units clear of every surface counts as properly airborne: landing works normally again
  if (!s.airborne && nearestSurface(s.x, s.y).alt > 4) s.airborne = true;
  const riding = currentK(s.x, s.y) > 0.3;
  if (riding && !s.riding) {
    thud(0.07, 2400, 0.9, 500);  // a soft whoosh
    if (!system.rodeCurrent) { system.rodeCurrent = true; say('Riding the solar wind', '#bfe8ff'); }
  }
  s.riding = riding;
  snapAssist(dt);
  s.x += s.vx * dt; s.y += s.vy * dt;

  for (const b of bodies) {
    const ox = s.x - b.px, oy = s.y - b.py, d = Math.hypot(ox, oy);
    if (d >= b.R + FOOT) continue;
    const nx = ox / d, ny = oy / d, la = Math.atan2(ny, nx), [svx, svy] = surfaceVel(b, la);
    if (b.kind === 'hole') { spitOut(b, nx, ny); break; }
    if (b.kind === 'gas') continue;  // no ground: you fly into its clouds (see cloudDrag)
    let rvx = s.vx - svx, rvy = s.vy - svy;
    const speed = Math.hypot(rvx, rvy);
    const tilt = Math.abs(angleDiff(s.angle, la));
    // just after lifting off (barely enough thrust, sinking back): slide quietly along the surface instead of
    // landing again, which looped land, lift, land several times a second with a clunk each time
    if (!s.airborne && time - (s.liftedAt ?? -9) < 3 && speed <= cfg.landSpeed) {
      s.x = b.px + nx * (b.R + FOOT); s.y = b.py + ny * (b.R + FOOT);
      const vn = rvx * nx + rvy * ny;
      if (vn < 0) { s.vx -= vn * nx; s.vy -= vn * ny; }
      break;
    }
    // slow enough and roughly feet-first lands; touching down on the nose or side bounces off, however slow
    if (s.tumble <= 0 && speed <= cfg.landSpeed && tilt <= LAND_TILT) {
      land(b, la, speed);
      return;
    }
    s.x = b.px + nx * (b.R + FOOT); s.y = b.py + ny * (b.R + FOOT);
    const vn = rvx * nx + rvy * ny;
    if (vn < 0) { rvx -= 1.5 * vn * nx; rvy -= 1.5 * vn * ny; }  // bounce, losing half the impact speed
    rvx *= 0.85; rvy *= 0.85;
    s.vx = svx + rvx; s.vy = svy + rvy;
    bump(speed, b, nx, ny);
    break;
  }
}

// Just above a surface, moving slowly and roughly feet-first, the ground very gently draws the ship in,
// calms its sideways drift and tips it upright. Subtle on big planets, a real help on tiny moonlets.
function snapAssist(dt) {
  const s = ship;
  const { b, alt } = nearestSurface(s.x, s.y);
  let active = false;
  if (s.tumble <= 0 && alt < SNAP_RANGE && time - (s.liftedAt ?? -9) > 1.2) {  // not right after taking off
    const ox = s.x - b.px, oy = s.y - b.py, d = Math.hypot(ox, oy), nx = ox / d, ny = oy / d, la = Math.atan2(ny, nx);
    const [svx, svy] = surfaceVel(b, la), rvx = s.vx - svx, rvy = s.vy - svy;
    if (Math.hypot(rvx, rvy) < cfg.landSpeed && Math.abs(angleDiff(s.angle, la)) < 0.6) {  // only when about feet-first (~35°)
      const k = 1 - Math.max(0, alt) / SNAP_RANGE;
      s.vx += (-nx * 14 - rvx * 1) * k * dt;  // gentle: a soft pull and a little damping, not a grab
      s.vy += (-ny * 14 - rvy * 1) * k * dt;
      s.angle += angleDiff(la, s.angle) * 1.2 * k * dt;
      active = true;
    }
  }
  if (active && !s.snapping) sfx.snap();
  s.snapping = active;
}

function land(b, la, speed) {
  const s = ship;
  s.landed = b; s.landAngle = la; s.angVel = 0; s.plantTimer = 0.3; s.plantRun = 0; s.snapping = false;
  parkShip();
  const [c0, c1, c2] = b.color;
  burst(s.x - Math.cos(la) * FOOT, s.y - Math.sin(la) * FOOT, 6 + speed * 0.6, {
    vx: s.vx, vy: s.vy, dir: la, spread: 2.6, speed: [5, 15 + speed], life: [0.3, 0.8], color: '150,160,190', grav: true,
  });
  sfx.clunk();
  if (b.needs && !b.pollinated) {
    const donor = gardens.find(o => o.name === b.needs);
    if (s.pollen === donor) {
      b.pollinated = true; s.pollen = null;
      burst(s.x, s.y, 40, { speed: [20, 90], life: [0.6, 1.4], color: donor.color.join(',') });
      // delivering the pollen completes the errand: the whole garden springs up around you, plant after
      // plant rolling out over a couple of seconds, and the last one brings the full-bloom moment
      burstIntoBloom(b, la);
      say(`${b.name} is pollinated and bursts into bloom!`, bodyColor(b));
      saveGame();
    } else {
      say(bloomOf(donor) >= 0.4 ? `${b.name} only grows with pollen from ${donor.name}` : `${b.name} needs ${donor.name} pollen. Grow ${donor.name} a little first`, bodyColor(donor));
    }
    return;
  }
  // said once, then only again after you've flown well away from it, and not more than every 20 s
  // (hovering just over the surface used to bring it up on every little touch)
  if (b.bloomed && s.seeds > 0 && b.fullHint !== false && time - (b.fullSaidAt ?? -99) > 20) {
    say(`${b.name} is already in full bloom`, bodyColor(b));
    b.fullSaidAt = time; b.fullHint = false;
  }
  if (speed < cfg.landSpeed * 0.3) {
    burst(s.x, s.y, 16, { vx: s.vx, vy: s.vy, speed: [20, 60], life: [0.4, 0.9], color: `${c0},${c1},${c2}` });
    arpeggio([SCALE[0], SCALE[2], SCALE[4]], 0.07, 0.06);
  }
}

function burstIntoBloom(b, near) {
  const [c0, c1, c2] = b.color, own = `${c0},${c1},${c2}`, local = near - b.spin;
  while (b.plants.length < b.maxPlants - 1) {
    const a = local + rand(-Math.PI, Math.PI), spread = Math.abs(angleDiff(a, local)) / Math.PI;  // nearest first
    b.plants.push({
      a, h: Math.random() < 0.15 ? rand(12, 17) : rand(4, 9), grow: 0, delay: spread * 2 + rand(0, 0.25),
      sway: rand(0, TAU), flip: Math.random() < 0.5 ? -1 : 1, kind: pickKind(0.6 + 0.4 * Math.random()),
      tip: Math.random() < 0.25 ? pick(b.accents) : own,
    });
  }
  arpeggio(SCALE.slice(0, 6), 0.11, 0.07);
  setTimeout(() => { if (!b.bloomed) plantSeed(b, local + b.spin); }, 2200);  // the last plant: the bloom moment
}

function bump(speed, b, nx, ny) {
  const s = ship;
  if (speed < 3) return;
  if (speed > cfg.landSpeed * 1.6) {
    s.tumble = 0.7;
    s.angVel = rand(5, 8) * (Math.random() < 0.5 ? -1 : 1);
    if (s.seeds > 0) say('Bumpy! Some seeds spilled', '#ffcf8a');
    spillSeeds(Math.ceil(s.seeds / 2), nx, ny);
    thud(0.35, 500);
  } else {
    s.tumble = 0.2;
    s.angVel += rand(-3, 3);
    thud(0.12, 300);
  }
}

// Touching a black hole's horizon doesn't end anything: it flings you back out, tumbling, and half your
// seeds fall into its disk, where they circle as stardust you can scoop up again.
function spitOut(b, nx, ny) {
  const s = ship, lost = Math.ceil(s.seeds / 2);
  s.x = b.px + nx * (b.R + FOOT + 1); s.y = b.py + ny * (b.R + FOOT + 1);
  s.vx = b.pvx + nx * 170 - ny * 50; s.vy = b.pvy + ny * 170 + nx * 50;  // out into a wide loop around it
  s.tumble = 0.9; s.angVel = rand(6, 9) * (Math.random() < 0.5 ? -1 : 1);
  s.seeds -= lost;
  for (let i = 0; i < lost; i++) spawnDiskMote(b);
  burst(s.x, s.y, 30, { vx: s.vx * 0.3, vy: s.vy * 0.3, speed: [30, 110], life: [0.4, 1], color: system.dustCore });
  thud(0.3, 220, 0.7, 50);
  say(lost ? 'The black hole spat you out. Some seeds fell into its disk' : 'The black hole spat you out', '#d8c8ff');
}

// A gas giant has no ground: you can dive right through it. Its pull weakens toward the core (it's
// softened over the whole body), and the clouds thicken with depth and slow you down, so a dive is a
// slow fall in, a coast through the middle and a climb out the far side, trailing puffs of cloud.
function cloudDrag(o, dt, isShip) {
  for (const b of bodies) {
    if (b.kind !== 'gas') continue;
    const dx = o.x - b.px, dy = o.y - b.py, r = Math.hypot(dx, dy);
    if (r >= b.R) continue;
    const depth = 1 - r / b.R, k = Math.exp(-(0.15 + 0.5 * depth) * dt);
    o.vx = b.pvx + (o.vx - b.pvx) * k; o.vy = b.pvy + (o.vy - b.pvy) * k;
    if (!isShip) continue;
    if (Math.random() < 30 * dt) {
      const col = Math.random() < 0.7 ? b.color.join(',') : pick(b.accents);
      particles.push({ x: o.x + rand(-6, 6), y: o.y + rand(-6, 6), vx: o.vx * 0.2 + rand(-12, 12), vy: o.vy * 0.2 + rand(-12, 12), life: rand(0.7, 1.4), max: 1.4, color: col, size: rand(2, 3.2), grav: false });
    }
    if (!b.divedAt) { b.divedAt = time; say(`Diving into the clouds of ${b.name}`, bodyColor(b)); thud(0.08, 600, 1.2, 120); }
  }
}

function spillSeeds(n, nx, ny) {
  const s = ship, out = Math.atan2(ny, nx);
  for (let i = 0; i < n; i++) {
    const a = out + rand(-1.2, 1.2), sp = rand(25, 60);
    motes.push({ x: s.x, y: s.y, vx: s.vx + Math.cos(a) * sp, vy: s.vy + Math.sin(a) * sp, born: time, tw: rand(0, TAU), gold: false });
  }
  s.seeds -= n;
}

// Plant kinds: 0 sprout, 1 grass tuft, 2 forked, 3 curl, 4 flower. Flowers get likelier as the garden fills.
// 5 is a rare bamboo clump (an easter egg, see plantSeed).
const BAMBOO = 5;
function pickKind(bloom) {
  const w = [3, 2.5 - bloom * 1.5, 1 + bloom, 1, 0.2 + bloom * 1.6];
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; }
  return 0;
}

function plantSeed(b, near) {
  const [c0, c1, c2] = b.color;
  if (b.plants.length >= b.maxPlants) {
    const p = pick(b.plants);
    if (p.kind !== BAMBOO) p.h = Math.min(p.h + 2, 18);
    p.grow = 0.6;
  } else {
    // Plants grow in clumps with gaps between them: a new plant usually joins a clump near where you
    // landed, or starts a new clump (further out as the garden fills). A clump that's full is left alone.
    const local = near - b.spin, reach = 0.3 + bloomOf(b) * Math.PI, width = 8 / b.R;
    const nearby = b.plants.filter(p => Math.abs(angleDiff(p.a, local)) < reach);
    const host = nearby.length && Math.random() < 0.7 ? pick(nearby) : null;
    const crowded = host && b.plants.filter(p => Math.abs(angleDiff(p.a, host.a)) < width).length > 5;
    const a = host && !crowded ? host.a + rand(-0.6, 0.6) * width : local + rand(-reach, reach);
    // now and then (about 1 seed in 400, at most once per garden, never on crystal) a bamboo clump
    // comes up instead, twice as tall as anything else
    const bamboo = !b.poly && Math.random() < 0.0025 && !b.plants.some(p => p.kind === BAMBOO);
    b.plants.push({
      a, h: bamboo ? rand(34, 38) : Math.random() < 0.15 ? rand(12, 17) : rand(4, 9), grow: 0, sway: rand(0, TAU), flip: Math.random() < 0.5 ? -1 : 1,
      kind: bamboo ? BAMBOO : pickKind(bloomOf(b)), tip: Math.random() < 0.25 ? pick(b.accents) : `${c0},${c1},${c2}`,
    });
    if (bamboo) say(`Bamboo is sprouting on ${b.name}!`, `rgb(${c0},${c1},${c2})`);
  }
  const step = b.plants.length % SCALE.length;
  if (b.kind === 'crystal') voice(SCALE[step] * 2, 0.04, 1.6, 0.005, 'triangle');  // shards chime
  else note(SCALE[step] / 2, 0.07, 1.4);
  burst(b.px + Math.cos(near) * b.R, b.py + Math.sin(near) * b.R, 4, {
    dir: near, spread: 1.2, speed: [10, 30], life: [0.3, 0.7], color: `${c0},${c1},${c2}`,
  });
  if (!b.bloomed && b.plants.length >= b.maxPlants) {
    b.bloomed = true;
    b.fullHint = false; b.fullSaidAt = time;  // no "already in full bloom" until you've left and come back
    say(`${b.name} is in full bloom`, `rgb(${c0},${c1},${c2})`);
    // the moment: two rings of light roll out from the body, petals burst in the theme's colours, and the
    // music swells with a chord under the arpeggio
    waves.push({ body: b, t0: time, dur: 2.6, r0: b.R, r1: b.R + 160, color: `${c0},${c1},${c2}`, w: 2.5 });
    // mostly the planet's own colour, with a sprinkle of the bloom colours already in its garden
    const own = `${c0},${c1},${c2}`, light = [c0, c1, c2].map(v => Math.round(mix(v, 255, 0.4))).join(',');
    const tips = [...new Set(b.plants.map(p => p.tip).filter(t => t !== own))];
    waves.push({ body: b, t0: time + 0.4, dur: 2.4, r0: b.R, r1: b.R + 110, color: light, w: 1.5 });
    const petals = { vx: b.pvx, vy: b.pvy, speed: [30, 120], life: [1, 2.2], size: 3 };
    burst(b.px, b.py, 55, { ...petals, color: own });
    burst(b.px, b.py, 20, { ...petals, color: light });
    for (let k = 0; k < 3 && tips.length; k++) burst(b.px, b.py, 5, { ...petals, color: pick(tips) });
    arpeggio(SCALE.slice(0, 8));
    for (const f of CHORDS[0]) voice(f, 0.03, 4.5, 1.2, 'triangle');
    voice(CHORDS[0][0] / 2, 0.06, 5, 0.9);
    if (!allBloomed && gardens.every(o => o.bloomed)) {
      allBloomed = true;
      allBloomedAt = time;
      openExit();
      setTimeout(() => { say('Everything blooms. Follow the light out of the system.'); arpeggio([...SCALE].reverse(), 0.12); }, 1500);
    }
    saveGame();
  }
}

function updateMotes(dt) {
  const s = ship;
  for (let i = motes.length - 1; i >= 0; i--) {
    const m = motes[i];
    if (m.life && time - m.born > m.life + fadeTime(m)) { removeAt(motes, i); continue; }
    if (m.hang) {
      // comet stardust hangs where it was shed: no gravity, slowly settling, drifting a touch outward
      const r = Math.hypot(m.x, m.y) || 1;
      m.vx = m.vx * Math.exp(-0.4 * dt) + m.x / r * 1.5 * dt;
      m.vy = m.vy * Math.exp(-0.4 * dt) + m.y / r * 1.5 * dt;
    } else {
      const [ax, ay] = gravityAt(m.x, m.y);
      m.vx += ax * dt; m.vy += ay * dt;
      if (system.identity.current) applyFlows(m, dt, false);
      // near a black hole stardust loses a little speed, so it spirals inward and speeds up as it falls
      const h = system.hole;
      if (h && (m.x - h.px) ** 2 + (m.y - h.py) ** 2 < (h.R * 5) ** 2) { const k = Math.exp(-0.08 * dt); m.vx *= k; m.vy *= k; }
    }
    const dx = s.x - m.x, dy = s.y - m.y, d = Math.hypot(dx, dy);
    if (time - m.born > 0.8 && s.tumble <= 0) {
      if (d < PICKUP_R) { collect(i); continue; }
      if (d < cfg.magnet) {
        const pull = 300 * (1 - d / cfg.magnet);
        m.vx += dx / d * pull * dt; m.vy += dy / d * pull * dt;
      }
    }
    m.x += m.vx * dt; m.y += m.vy * dt;
    for (const b of bodies) {
      if (Math.hypot(m.x - b.px, m.y - b.py) < b.R) {
        burst(m.x, m.y, 4, { speed: [5, 20], life: [0.2, 0.5], color: m.gold ? '255,220,140' : '200,240,255' });
        removeAt(motes, i);
        break;
      }
    }
  }
}

function collect(i) {
  const s = ship, m = motes[i];
  removeAt(motes, i);
  chain = time - lastPickup < CHAIN_WINDOW ? chain + 1 : 0;
  lastPickup = time;
  const bonus = chain > 0 && (chain + 1) % 5 === 0;
  s.seeds += (m.gold ? 2 : 1) + (bonus ? 2 : 0);
  s.fuel = Math.min(FUEL_MAX, s.fuel + MOTE_FUEL);
  note(SCALE[chain % SCALE.length] * (m.gold ? 2 : 1), bonus ? 0.13 : 0.09, bonus ? 1.8 : 1.1);
  burst(m.x, m.y, bonus ? 18 : 7, {
    vx: s.vx, vy: s.vy, speed: [15, bonus ? 90 : 45], life: [0.2, 0.6], color: m.gold ? '255,225,150' : '200,240,255',
  });
  if (chain >= 2) chainPopup = { n: chain + 1, t: time, bonus };
}

function updateComets(dt) {
  const s = ship;
  for (let i = comets.length - 1; i >= 0; i--) {
    const c = comets[i];
    const [ax, ay] = gravityAt(c.x, c.y);
    c.vx += ax * dt; c.vy += ay * dt;
    c.x += c.vx * dt; c.y += c.vy * dt;
    c.age += dt;
    const r = Math.hypot(c.x, c.y);

    // shed stardust that stays roughly where the comet passed, drawing a golden arc to follow.
    // (Stardust that kept orbiting bunched up into a cloud at the far end of the orbit.)
    c.travel += Math.hypot(c.vx, c.vy) * dt;
    c.spin += dt * 0.6;
    if (c.travel >= 8 && c.dropped < 110 && !c.leaving) {
      c.travel = 0;
      c.dropped++;
      const v = Math.hypot(c.vx, c.vy) || 1, side = rand(-4, 4);
      motes.push({
        x: c.x, y: c.y, vx: c.vx * 0.12 - c.vy / v * side, vy: c.vy * 0.12 + c.vx / v * side,
        born: time - 0.5, tw: rand(0, TAU), gold: true, life: rand(11, 13), hang: true, comet: c, seq: c.dropped,
      });
    }
    if (!c.caught && Math.hypot(s.x - c.x, s.y - c.y) < 18) {
      c.caught = true;
      s.seeds += 5;
      burst(c.x, c.y, 30, { vx: c.vx, vy: c.vy, speed: [30, 120], life: [0.4, 1], color: '255,230,160' });
      arpeggio([SCALE[5], SCALE[7], SCALE[9], SCALE[10]], 0.06, 0.08);
      say('You caught the comet! +5 seeds', '#ffe7a0');
    }
    // once it has swung past the planet and climbed back out, it slowly fades away
    if (c.age > 10 && r > 420) c.leaving = true;
    if (c.leaving) c.fade -= dt * 0.35;
    const hit = bodies.some(b => Math.hypot(c.x - b.px, c.y - b.py) < b.R);
    if (hit) burst(c.x, c.y, 40, { speed: [20, 100], life: [0.5, 1.2], color: '255,220,150' });
    if (hit || c.fade <= 0) removeAt(comets, i);
  }
}

// Asteroids: little rocks on loose orbits. Bump them and they drift off (real momentum, both ways);
// hit one hard and it cracks open into stardust. They never hurt, and new ones drift in now and then.
function spawnRock() {
  for (let tries = 0; tries < 20; tries++) {
    const r = rand(system.innerR + 30, 430), a = rand(0, TAU), x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (!clearOfBodies(x, y) || Math.hypot(x - ship.x, y - ship.y) < 150) continue;
    const v = Math.sqrt(homeGM() / r) * rand(0.9, 1.08);
    rocks.push({ x, y, vx: -Math.sin(a) * v, vy: Math.cos(a) * v, R: rand(7, 11), born: time, spin: rand(0, TAU), spinRate: rand(-1, 1), shape: Array.from({ length: 8 }, () => rand(0.72, 1.12)) });
    return;
  }
}
function updateRocks(dt) {
  if (system.identity.feature === 'rocks') {
    rockTimer -= dt;
    if (rockTimer <= 0) { rockTimer = 12; if (rocks.length < 4) spawnRock(); }
  }
  const s = ship;
  for (let i = rocks.length - 1; i >= 0; i--) {
    const k = rocks[i];
    const [ax, ay] = gravityAt(k.x, k.y);
    k.vx += ax * dt; k.vy += ay * dt;
    k.x += k.vx * dt; k.y += k.vy * dt;
    k.spin += k.spinRate * dt;
    if (bodies.some(b => Math.hypot(k.x - b.px, k.y - b.py) < b.R + k.R * 0.6)) {
      burst(k.x, k.y, 14, { speed: [10, 40], life: [0.4, 0.9], color: '170,180,210' });
      removeAt(rocks, i);
      continue;
    }
    // bump the ship: an elastic-ish knock, heavier rocks barely budge
    const dx = s.x - k.x, dy = s.y - k.y, d = Math.hypot(dx, dy);
    if (s.landed || d >= k.R + 8 || d === 0) continue;
    const nx = dx / d, ny = dy / d, rel = (s.vx - k.vx) * nx + (s.vy - k.vy) * ny;
    if (rel >= 0) continue;
    const mk = k.R * k.R * 0.03, j = -1.6 * rel / (1 + 1 / mk);
    s.vx += j * nx; s.vy += j * ny;
    k.vx -= j / mk * nx; k.vy -= j / mk * ny;
    s.x = k.x + nx * (k.R + 8); s.y = k.y + ny * (k.R + 8);
    if (-rel > 45) crackRock(i);
    else { thud(0.1, 600, 0.2); s.tumble = Math.max(s.tumble, 0.15); }
  }
}
function crackRock(i) {
  const k = rocks[i], n = 4 + Math.round(k.R * 0.6);
  removeAt(rocks, i);
  for (let j = 0; j < n; j++) {
    const a = rand(0, TAU), sp = rand(12, 35);
    motes.push(dustMote(k.x, k.y, k.vx + Math.cos(a) * sp, k.vy + Math.sin(a) * sp, { born: time - 0.5 }));
  }
  burst(k.x, k.y, 22, { vx: k.vx, vy: k.vy, speed: [15, 70], life: [0.4, 1], color: '185,195,225' });
  burst(k.x, k.y, 9, { vx: k.vx, vy: k.vy, speed: [40, 110], life: [0.5, 1.1], color: '215,222,245', shard: true });
  thud(0.2, 900, 0.35);
  arpeggio([SCALE[4], SCALE[6], SCALE[8]], 0.05, 0.06);
  if (!system.crackedOnce) { system.crackedOnce = true; say('It cracked open into stardust', '#cfd8ff'); }
}

// Fireflies drift up from gardens in full bloom; fly close and a few will tag along for a while.
function updateFireflies(dt) {
  const s = ship;
  fireflyTimer -= dt;
  if (fireflyTimer <= 0 && fireflies.length < MAX_FIREFLIES) {
    fireflyTimer = rand(0.4, 1.2);
    const b = pick(bodies.filter(o => o.bloomed && o.plants.length));
    if (b) {
      const p = pick(b.plants), life = rand(9, 15);
      fireflies.push({
        body: b, x: b.px + Math.cos(p.a + b.spin) * (b.R + 3), y: b.py + Math.sin(p.a + b.spin) * (b.R + 3),
        vx: 0, vy: 0, life, max: life, follow: false, ph: rand(0, TAU), color: pick(b.accents),
      });
    }
  }
  for (let i = fireflies.length - 1; i >= 0; i--) {
    const f = fireflies[i];
    f.life -= dt;
    if (f.life <= 0) { removeAt(fireflies, i); continue; }
    if (f.follow) {
      const a = time * 1.2 + f.ph, r = 24 + 6 * Math.sin(time * 2 + f.ph);
      const k = Math.min(1, 2.5 * dt);
      f.x += (s.x + Math.cos(a) * r - f.x) * k + s.vx * dt;
      f.y += (s.y + Math.sin(a) * r - f.y) * k + s.vy * dt;
    } else {
      // rise and wander, carried along by the moon it came from
      const b = f.body, ox = f.x - b.px, oy = f.y - b.py, d = Math.hypot(ox, oy) || 1;
      f.vx += (ox / d * 5 + rand(-25, 25)) * dt;
      f.vy += (oy / d * 5 + rand(-25, 25)) * dt;
      f.vx *= Math.exp(-1.5 * dt); f.vy *= Math.exp(-1.5 * dt);
      f.x += (f.vx + b.pvx) * dt; f.y += (f.vy + b.pvy) * dt;
      if (Math.hypot(s.x - f.x, s.y - f.y) < 45) f.follow = true;
    }
  }
}

// Once everything blooms, a lane of light opens toward the edge in one direction. Inside the lane the
// soft boundary lets the ship go, a gentle tailwind helps near the edge, and flying out warps you onward.
const EXIT_HALF = 0.3;  // half-width of the lane, in radians
function inExitLane(x, y) { return !!exit && Math.abs(angleDiff(Math.atan2(y, x), exit.angle)) < EXIT_HALF; }
function openExit(angle = rand(0, TAU)) { exit = { angle, born: time }; }

function updateExit(dt) {
  if (!exit || warp) return;
  const s = ship, r = Math.hypot(s.x, s.y), ux = Math.cos(exit.angle), uy = Math.sin(exit.angle);
  const inLane = inExitLane(s.x, s.y);
  // in the outer part of the lane the light takes hold: it draws you to its middle, calms your sideways
  // drift and accelerates you outward, harder the further out you are, until you're shot out of the system
  const grab = ARENA_R - 200;
  if (!s.landed && inLane && r > grab) {
    const depth = clamp((r - grab) / 160, 0, 1), tx = -uy, ty = ux;
    const side = s.x * tx + s.y * ty, vside = s.vx * tx + s.vy * ty, out = 30 + 220 * depth * depth;
    // a firm, well-damped pull to the lane's centre line, and the ship turns to face straight out, so it
    // leaves the system centred and flying straight
    const hold = Math.sqrt(depth);  // takes hold quickly once you're in
    s.vx += (ux * out - tx * (side * 9 + vside * 6) * hold) * dt;
    s.vy += (uy * out - ty * (side * 9 + vside * 6) * hold) * dt;
    s.angle += angleDiff(exit.angle, s.angle) * (1 - Math.exp(-5 * depth * dt));
    s.angVel *= Math.exp(-6 * depth * dt);
    if (!exit.caught) {
      exit.caught = true;
      thud(0.1, 3000, 1.6, 300);  // a rising whoosh
      arpeggio([SCALE[0], SCALE[4], SCALE[7], SCALE[10]], 0.08, 0.06);
      say('The light takes hold of you', '#d8ceff');
    }
  }
  if (Math.random() < dt * 30) {
    const a = exit.angle + rand(-0.8, 0.8) * EXIT_HALF, rr = rand(ARENA_R - 160, ARENA_R + 60);
    burst(Math.cos(a) * rr, Math.sin(a) * rr, 1, { dir: a, spread: 0.05, speed: [40, 90], life: [0.8, 1.6], color: '215,205,255' });
  }
  if (inLane && r > ARENA_R + 50) {
    warp = { t: 0, switched: false };
    exit = null;
    arpeggio([...SCALE].reverse(), 0.06, 0.07);
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.grav) {
      const [ax, ay] = gravityAt(p.x, p.y);
      p.vx += ax * dt; p.vy += ay * dt;
    }
    p.vx *= 1 - dt * 0.8; p.vy *= 1 - dt * 0.8;
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.life <= 0) removeAt(particles, i);
  }
}

// Step a copy of the ship forward (moons moving too) to draw where it's drifting: up to one lap or 30 s.
// Each body's offset from its parent is rotated a tiny bit per step (no trig in the loop), which keeps this cheap.
const predictPos = [], predOx = [], predOy = [], predC = [], predS = [], predParent = [];
function predict() {
  const s = ship, pts = [], dt = 1 / 30, n = allBodies.length;
  for (let k = 0; k < n; k++) {
    const b = allBodies[k];
    predOx[k] = Math.cos(b.angle) * b.orbit; predOy[k] = Math.sin(b.angle) * b.orbit;
    predC[k] = Math.cos(b.omega * dt); predS[k] = Math.sin(b.omega * dt);
    predParent[k] = b.parent ? allBodies.indexOf(b.parent) : -1;
  }
  let x = s.x, y = s.y, vx = s.vx, vy = s.vy, swept = 0, prevA = Math.atan2(y, x);
  for (let i = 0; i < 900; i++) {
    // where every body is at this moment (parents come first in the list)
    for (let k = 0; k < n; k++) {
      const p = predParent[k];
      predictPos[2 * k] = (p >= 0 ? predictPos[2 * p] : 0) + predOx[k];
      predictPos[2 * k + 1] = (p >= 0 ? predictPos[2 * p + 1] : 0) + predOy[k];
      const ox = predOx[k];
      predOx[k] = ox * predC[k] - predOy[k] * predS[k];
      predOy[k] = ox * predS[k] + predOy[k] * predC[k];
    }
    let ax = 0, ay = 0;
    for (let k = 0; k < n; k++) {
      const b = allBodies[k];
      if (b.anchor) continue;
      const ddx = predictPos[2 * k] - x, ddy = predictPos[2 * k + 1] - y;
      const r2 = Math.max(ddx * ddx + ddy * ddy, b.softR * b.softR), r = Math.sqrt(r2), a = b.gm / r2;
      ax += ddx / r * a; ay += ddy / r * a;
    }
    const rr = Math.hypot(x, y);
    if (rr > ARENA_R && !inExitLane(x, y)) { const kk = (rr - ARENA_R) * 1.5; ax -= x / rr * kk; ay -= y / rr * kk; }
    vx += ax * dt; vy += ay * dt;
    const cp = currentPush(x, y, vx, vy);
    if (cp) { vx += cp[0] * dt; vy += cp[1] * dt; }
    const f = calmAt(x, y);
    if (f) {
      const r = Math.hypot(x, y), v = Math.sqrt(homeGM() / r), k = 1 - Math.exp(-1.2 * f * dt);
      vx += (-y / r * v - vx) * k; vy += (x / r * v - vy) * k;
    }
    x += vx * dt; y += vy * dt;
    for (let k = 0; k < n; k++) {
      const b = allBodies[k];
      if (b.kind === 'gas') {
        const r = Math.hypot(x - predictPos[2 * k], y - predictPos[2 * k + 1]);
        if (r < b.R) { const kk = Math.exp(-(0.15 + 0.5 * (1 - r / b.R)) * dt); vx *= kk; vy *= kk; }
        continue;
      }
      if (!b.anchor && Math.hypot(x - predictPos[2 * k], y - predictPos[2 * k + 1]) < b.R + FOOT) {
        const [bvx, bvy] = bodyVel(b, i * dt);
        return { pts, impact: { x, y, speed: Math.hypot(vx - bvx, vy - bvy), barren: b.barren } };
      }
    }
    const ang = Math.atan2(y, x);
    swept += Math.abs(angleDiff(ang, prevA));
    prevA = ang;
    if (swept > TAU) break;
    if (i % 2 === 0) pts.push(x, y);
  }
  return { pts, impact: null };
}

// ===== Camera =====
// Zooms in gently when you're low and slow over a surface, so landings are easier to judge.
// It sticks with one body (the one you're landed on or approaching) and only switches when another
// is clearly closer, so a moon sweeping past doesn't yank the view around.
const cam = { x: 0, y: 0, zoom: 1, focus: null };
function updateCamera(dt) {
  let tz = 1, tx = 0, ty = 0;
  const s = ship;
  // once everything blooms, the view drifts slowly all the way out so the lane out of the system shows
  const showLane = allBloomed && !!exit;
  if (prefs.autoZoom && !warp && !showLane) {
    let focus = s.landed || cam.focus || gardens[0];
    if (!s.landed) {
      const near = nearestSurface(s.x, s.y);
      if (near.b !== focus && near.alt < altitudeOver(focus, s.x, s.y) * 0.5 - 20) focus = near.b;
    }
    cam.focus = focus;
    const alt = s.landed ? 0 : altitudeOver(focus, s.x, s.y);
    const rel = Math.hypot(s.vx - focus.pvx, s.vy - focus.pvy);
    const low = smooth(clamp(1 - alt / 140, 0, 1));
    const slow = smooth(clamp(1 - (rel - 40) / 60, 0, 1));
    const t = low * slow;
    tz = 1 + 0.5 * t;  // up to 1.5x (1.8x felt a bit too close)
    tx = mix(0, s.x + (focus.px - s.x) * 0.3, t);
    ty = mix(0, s.y + (focus.py - s.y) * 0.3, t);
  }
  const k = 1 - Math.exp(-(showLane ? 0.25 : 0.8) * dt);
  cam.zoom += (tz - cam.zoom) * k;
  cam.x += (tx - cam.x) * k;
  cam.y += (ty - cam.y) * k;
}

// ===== Rendering =====
let dpr = 1, W = 0, H = 0, scale = 1, px = 1, twinkles = [], lowRes = false, lowFps = 0;
let bgCache = null, bgKey = '';

function resize() {
  // sharper than 1.5x costs a lot of drawing for little gain on a laptop; phone screens are small and dense,
  // so they get 2x unless the frame rate suffers (see frame)
  dpr = Math.min(window.devicePixelRatio || 1, TOUCH && !lowRes ? 2 : 1.5);
  W = innerWidth; H = innerHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';  // (100vh is taller than the visible page on phones)
  scale = Math.min(W, H) / (ARENA_R * 2 * 1.04);
  // middle layer: twinkling stars; near layer: a few slightly bigger ones that drift faster
  twinkles = [
    ...Array.from({ length: 50 }, () => ({ x: rand(0, W), y: rand(0, H), b: Math.random(), tw: rand(0.3, 1.5), ph: rand(0, TAU), depth: 0.06, size: 1.3 })),
    ...Array.from({ length: 30 }, () => ({ x: rand(0, W), y: rand(0, H), b: Math.random() * 0.6, tw: rand(0.2, 0.8), ph: rand(0, TAU), depth: 0.16, size: 1.8 })),
  ];
  bgKey = '';
}
addEventListener('resize', resize);

// The nebula gradient and the still stars are drawn once into an offscreen canvas and reused.
function drawBackground() {
  if (!W || !H) return;  // hidden or minimised window
  const key = `${W}x${H}x${dpr}:${system.nebula}:${system.sunAngle}:${systemNo}`;
  if (key !== bgKey) {
    bgKey = key;
    bgCache = document.createElement('canvas');
    bgCache.width = W * dpr; bgCache.height = H * dpr;
    const g = bgCache.getContext('2d');
    g.scale(dpr, dpr);
    const grad = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    grad.addColorStop(0, system.nebula[0]);
    grad.addColorStop(1, system.nebula[1]);
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    // a faint warm glow from the distant sun, just off screen
    const M = Math.max(W, H), id = system.identity;
    const sunGlow = (angle, tint, a) => {
      const sunX = W / 2 + Math.cos(angle) * M * 0.75, sunY = H / 2 + Math.sin(angle) * M * 0.75;
      const sun = g.createRadialGradient(sunX, sunY, 0, sunX, sunY, M * 0.65);
      sun.addColorStop(0, `rgba(${tint},${a})`);
      sun.addColorStop(1, `rgba(${tint},0)`);
      g.fillStyle = sun;
      g.fillRect(0, 0, W, H);
    };
    sunGlow(system.sunAngle, id.sun, 0.12);
    if (id.sun2 !== null) sunGlow(id.sun2, id.sun2Tint, 0.08);
    // very faint nebula wisps, placed the same way every time for this system. They're a brighter version
    // of the background's own hue with just a touch of the theme colour, so they change brightness, not hue.
    const rnd = seededRandom(systemNo * 7919 + Math.round(system.sunAngle * 1000));
    const bgRgb = [1, 3, 5].map(i => parseInt(system.nebula[0].slice(i, i + 2), 16));
    for (let i = 0; i < 6; i++) {
      const lead = system.palette[i % system.palette.length], wr = M * (0.18 + rnd() * 0.22);
      const [r, gg, bb] = bgRgb.map((v, k) => Math.round(mix(Math.min(255, v * 3.2), lead[k], 0.2)));
      g.save();
      g.translate(rnd() * W, rnd() * H);
      g.rotate(rnd() * Math.PI);
      g.scale(1.8, 0.6);
      const wisp = g.createRadialGradient(0, 0, 0, 0, 0, wr);
      wisp.addColorStop(0, `rgba(${r},${gg},${bb},${0.05 + rnd() * 0.04})`);
      wisp.addColorStop(1, `rgba(${r},${gg},${bb},0)`);
      g.fillStyle = wisp;
      g.beginPath(); g.arc(0, 0, wr, 0, TAU); g.fill();
      g.restore();
    }
    // the most distant stars are part of the cached background
    for (let i = 0; i < 180; i++) {
      g.fillStyle = `rgba(210,220,255,${rand(0.1, 0.45)})`;
      g.fillRect(rand(0, W), rand(0, H), 1, 1);
    }
    drawLandmark(g, M, rnd);
  }
  ctx.drawImage(bgCache, 0, 0, W, H);
  // two nearer layers drift slowly at different speeds (and with the camera), for depth
  ctx.fillStyle = 'rgb(220,228,255)';
  for (const st of twinkles) {
    const ox = -cam.x * scale * st.depth - time * st.depth * 25, oy = -cam.y * scale * st.depth - time * st.depth * 10;
    ctx.globalAlpha = clamp(0.2 + st.b * 0.4 + 0.25 * Math.sin(time * st.tw + st.ph), 0, 1) * (st.depth > 0.1 ? 0.7 : 1);
    ctx.fillRect(((st.x + ox) % W + W) % W, ((st.y + oy) % H + H) % H, st.size, st.size);
  }
  ctx.globalAlpha = 1;
}

// One far feature in this system's sky, baked into the background: a spiral galaxy, a star cluster, or
// a huge far planet showing only its sunlit crescent at the edge. Kept off the middle, where the play is.
function drawLandmark(g, M, rnd) {
  const id = system.identity, [ux, uy] = id.landmarkAt || [0.8, 0.2];
  const x = W * (ux < 0.5 ? 0.06 + ux * 0.4 : 0.74 + (ux - 0.5) * 0.4), y = H * (0.1 + uy * 0.8);
  const [lr, lg, lb] = system.palette[(systemNo + 1) % system.palette.length];
  const tint = a => `rgba(${Math.round(mix(lr, 255, 0.55))},${Math.round(mix(lg, 255, 0.55))},${Math.round(mix(lb, 255, 0.55))},${a})`;
  g.save();
  g.translate(x, y);
  if (id.landmark === 'galaxy') {
    const size = M * 0.09;
    g.rotate(rnd() * TAU);
    g.scale(1, 0.45 + rnd() * 0.3);
    const core = g.createRadialGradient(0, 0, 0, 0, 0, size * 0.32);
    core.addColorStop(0, tint(0.2)); core.addColorStop(1, tint(0));
    g.fillStyle = core;
    g.beginPath(); g.arc(0, 0, size * 0.32, 0, TAU); g.fill();
    g.fillStyle = tint(0.6);
    g.fillRect(-1, -1, 2, 2);  // a crisp bright nucleus
    // two arms of faint dots along a log spiral
    for (let arm = 0; arm < 2; arm++) {
      for (let i = 0; i < 420; i++) {
        const t = i / 420, th = arm * Math.PI + t * 3.4, r = size * 0.12 * Math.exp(t * 2.1);
        const jx = (rnd() - 0.5) * size * 0.08 * (0.4 + t), jy = (rnd() - 0.5) * size * 0.08 * (0.4 + t);
        g.fillStyle = rnd() < 0.04 ? 'rgba(235,240,255,0.7)' : tint(0.1 + 0.3 * (1 - t) * rnd());
        g.fillRect(Math.cos(th) * r + jx, Math.sin(th) * r + jy, 1, 1);
      }
    }
  } else if (id.landmark === 'cluster') {
    const size = M * 0.05;
    const glow = g.createRadialGradient(0, 0, 0, 0, 0, size * 1.6);
    glow.addColorStop(0, tint(0.1)); glow.addColorStop(1, tint(0));
    g.fillStyle = glow;
    g.beginPath(); g.arc(0, 0, size * 1.6, 0, TAU); g.fill();
    for (let i = 0; i < 160; i++) {
      const d = size * Math.abs(rnd() + rnd() + rnd() - 1.5) * 1.1, a = rnd() * TAU;
      g.fillStyle = i % 9 ? `rgba(225,232,255,${0.15 + rnd() * 0.45})` : tint(0.7);
      const sz = rnd() < 0.08 ? 2 : 1.2;
      g.fillRect(Math.cos(a) * d, Math.sin(a) * d, sz, sz);
    }
  } else if (id.landmark === 'crescent') {
    // a huge far planet hanging off the edge of the screen, only its sunlit crescent showing
    g.restore(); g.save();
    const R = M * 0.42, side = Math.cos(system.sunAngle) > 0 ? -1 : 1,  // opposite the sun, so its lit side faces us
      cx = W / 2 + side * (W / 2 + R * 0.82), cy = H * (0.25 + uy * 0.5);
    const lx = Math.cos(system.sunAngle), ly = Math.sin(system.sunAngle);
    g.fillStyle = system.nebula[1];
    g.globalAlpha = 0.55;
    g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill();
    g.globalAlpha = 1;
    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.clip();
    const lit = g.createRadialGradient(cx + lx * R * 1.1, cy + ly * R * 1.1, R * 0.3, cx + lx * R * 0.6, cy + ly * R * 0.6, R * 1.2);
    const grey = a => `rgba(${[lr, lg, lb].map(v => Math.round(mix(v, 255, 0.3))).join(',')},${a})`;
    lit.addColorStop(0, grey(0.06)); lit.addColorStop(1, grey(0));
    g.fillStyle = lit;
    g.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    g.restore();
    // only a thin sunlit crescent on its edge catches the eye
    const sa = Math.atan2(ly, lx);
    g.lineCap = 'round';
    for (const [lw, a] of [[26, 0.025], [12, 0.04]]) {  // a soft atmosphere hugging the lit limb
      g.strokeStyle = grey(a); g.lineWidth = lw;
      g.beginPath(); g.arc(cx, cy, R + lw / 2, sa - 1.1, sa + 1.1); g.stroke();
    }
    for (const [w, a] of [[1.2, 0.18], [0.75, 0.14], [0.35, 0.1]]) {
      g.strokeStyle = grey(a);
      g.lineWidth = 1.5;
      g.beginPath(); g.arc(cx, cy, R - (1.2 - w) * 4, sa - w, sa + w); g.stroke();
    }
  }
  g.restore();
}

// Slow ambient events, drawn in screen space just over the sky: aurora curtains, a far pulsar's beam
// sweeping past every 12 seconds, or specks of ice drifting by close to the camera.
let iceSpecks = [];
function drawAmbient() {
  const kind = system.identity.ambient;
  if (!kind) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  if (kind === 'aurora') {
    // three separate drapes hanging below the HUD, each fading in at the top and sides and swaying slowly;
    // drawn as narrow touching slices so the bottom edge can ripple
    const top = Math.max(105, H * 0.13);
    for (let c = 0; c < 3; c++) {
      const [r, g, b] = system.palette[c % system.palette.length];
      const cx = W * (0.22 + c * 0.3) + Math.sin(time * 0.05 + c * 2) * W * 0.04, half = W * (0.13 + 0.03 * c);
      const y0 = top + c * 14, len = H * (0.15 + 0.03 * ((c + 1) % 3));
      const grad = ctx.createLinearGradient(0, y0, 0, y0 + len);
      grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
      grad.addColorStop(0.35, `rgba(${r},${g},${b},0.09)`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      for (let x = Math.floor(cx - half); x < cx + half; x += 4) {
        if (x < -4 || x > W) continue;  // off screen
        const t = clamp((x - (cx - half)) / (2 * half), 0, 1), env = Math.sin(Math.PI * t) ** 1.5;  // (a negative base gave NaN)
        const alpha = env * (0.75 + 0.25 * Math.sin(time * 0.2 + c * 2));
        // skip the near-invisible slices at a drape's edges: on iPad Safari a vanishingly small alpha with
        // 'lighter' could flash as a bright white vertical line
        if (!(alpha > 0.01)) continue;
        const dy = Math.sin(x * 0.01 + time * 0.3 + c) * 10, stretch = 1 + 0.15 * Math.sin(x * 0.012 - time * 0.4 + c * 3);
        ctx.globalAlpha = alpha;
        ctx.fillRect(x, y0 + dy, 4, len * stretch);
      }
    }
    ctx.globalAlpha = 1;
  } else if (kind === 'pulsar') {
    const [ux, uy] = system.identity.landmarkAt || [0.8, 0.2];
    // on the side away from where a far crescent planet would hang
    const ox = Math.cos(system.sunAngle) > 0 ? W * 0.93 : W * 0.07, oy = H * (0.82 - uy * 0.55);
    const flash = Math.max(0, Math.sin(time * 6)) ** 4, phase = time % 12;
    ctx.fillStyle = `rgba(220,235,255,${0.6 + 0.4 * flash})`;
    ctx.beginPath(); ctx.arc(ox, oy, 2, 0, TAU); ctx.fill();
    ctx.strokeStyle = `rgba(220,235,255,${0.25 + 0.5 * flash})`;  // it blinks: a little four-pointed flare
    ctx.lineWidth = 1;
    const fl = 5 + 7 * flash;
    ctx.beginPath(); ctx.moveTo(ox - fl, oy); ctx.lineTo(ox + fl, oy); ctx.moveTo(ox, oy - fl); ctx.lineTo(ox, oy + fl); ctx.stroke();
    if (phase < 3.5) {
      // sweeps across the screen from the pulsar's corner, fading in and out
      const toward = Math.atan2(H / 2 - oy, W / 2 - ox), th = toward - 0.6 + phase / 3.5 * 1.2, env = Math.sin(Math.PI * phase / 3.5);
      const L = Math.hypot(W, H) * 1.2;
      for (const [w, a] of [[0.012, 0.02], [0.004, 0.07]]) {  // a thin, cool beam with a faint edge
        const grad = ctx.createLinearGradient(ox, oy, ox + Math.cos(th) * L, oy + Math.sin(th) * L);
        grad.addColorStop(0, `rgba(140,185,255,${a * env})`);
        grad.addColorStop(1, 'rgba(140,185,255,0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.moveTo(ox, oy);
        ctx.arc(ox, oy, L, th - w, th + w);
        ctx.closePath(); ctx.fill();
      }
    }
  } else if (kind === 'ice') {
    // a few slow six-pointed ice crystals drifting past close to the camera, glinting now and then
    if (iceSpecks.length !== 6) iceSpecks = Array.from({ length: 6 }, () => ({ x: rand(0, 1), y: rand(0, 1), s: rand(0.7, 1.3), ph: rand(0, TAU), v: rand(0.5, 1.2) }));
    ctx.lineWidth = 1.2;
    for (const p of iceSpecks) {
      const x = ((p.x * W + time * 7 * p.v - cam.x * scale * 0.4) % W + W) % W;
      const y = ((p.y * H + time * 3 * p.v - cam.y * scale * 0.4) % H + H) % H;
      const a = time * 0.4 * p.v + p.ph, d = 8 * p.s, glint = Math.max(0, Math.sin(time * 0.7 * p.v + p.ph * 3)) ** 12;
      ctx.strokeStyle = `rgba(215,236,255,${0.3 + 0.6 * glint})`;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {  // six arms, each with a little pair of side branches
        const b = a + k * Math.PI / 3, cx = Math.cos(b), cy = Math.sin(b);
        ctx.moveTo(x, y); ctx.lineTo(x + cx * d, y + cy * d);
        const bx = x + cx * d * 0.55, by = y + cy * d * 0.55;
        for (const sd of [-0.7, 0.7]) { ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(b + sd) * d * 0.3, by + Math.sin(b + sd) * d * 0.3); }
      }
      ctx.stroke();
      if (glint > 0.2) {
        ctx.fillStyle = `rgba(240,248,255,${glint * 0.8})`;
        ctx.beginPath(); ctx.arc(x, y, 1.5 + glint * 1.5, 0, TAU); ctx.fill();
      }
    }
  }
  ctx.restore();
}

// Small deterministic random generator (mulberry32), so a system's background looks the same each visit.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function screenToWorld(sx, sy) {
  const z = scale * cam.zoom;
  return [(sx - W / 2) / z + cam.x, (sy - H / 2) / z + cam.y];
}

function bodyColor(b, alpha = 1) {
  // softened when bare, warming to the body's full colour as the garden fills
  const t = 0.5 + 0.5 * bloomOf(b);
  const [r, g, bl] = b.color;
  return `rgba(${Math.round(mix(110, r, t))},${Math.round(mix(120, g, t))},${Math.round(mix(145, bl, t))},${alpha})`;
}

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBackground();
  if (W && H) drawAmbient();
  if (allBloomed && W) {
    const k = clamp((time - allBloomedAt) / 3, 0, 1), [r, g, b] = system.palette[0];
    const sky = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    sky.addColorStop(0, `rgba(${r},${g},${b},${0.06 * k})`);
    sky.addColorStop(1, `rgba(${r},${g},${b},${0.015 * k})`);
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H); ctx.restore();
  }

  px = 1 / (scale * cam.zoom);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(scale * cam.zoom, scale * cam.zoom);
  ctx.translate(-cam.x, -cam.y);
  drawOrbits();
  drawFlows();
  if (!title && !photo) drawTrajectory();
  drawExit();
  for (const b of bodies) drawBody(b);
  drawWaves();
  drawPollenHints();
  drawRocks();
  if (!photo) drawHighlights();
  drawComets();
  drawMotes();
  drawFireflies();
  drawParticles();
  drawShip();
  drawBrakeMarker();
  drawExitPointer();
  if (!photo) { drawLandingReadout(); drawChainPopup(); }
  ctx.restore();

  if (title) drawTitle();
  else if (starMap) drawStarMap();
  else if (photo) drawPhotoHint();
  else drawHUD();
  if (TOUCH && !title) drawPauseIcon();
  if (warp) {
    const a = warp.t < 1.5 ? warp.t / 1.5 : 1 - (warp.t - 1.5) / 1.5;
    ctx.fillStyle = `rgba(220,235,255,${clamp(a, 0, 1)})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawOrbits() {
  if (prefs.orbits) {
    ctx.save();
    ctx.lineWidth = 1 * px;
    // clearest near the ship, fading with distance so the rings don't compete with the play
    const a = prefs.orbits === 1 ? 0.18 : 0.45, rgb = prefs.orbits === 1 ? '150,170,255' : '170,190,255';
    const fade = ctx.createRadialGradient(ship.x, ship.y, 0, ship.x, ship.y, 260);
    fade.addColorStop(0, `rgba(${rgb},${a})`);
    fade.addColorStop(1, `rgba(${rgb},${a * 0.22})`);
    ctx.strokeStyle = fade;
    ctx.setLineDash(prefs.orbits === 1 ? [2 * px, 9 * px] : [5 * px, 5 * px]);
    // includes the invisible centre that twin moons circle, so you can see where the pair is heading
    for (const b of allBodies) {
      if (!b.orbit) continue;
      const cx = b.parent ? b.parent.px : 0, cy = b.parent ? b.parent.py : 0;
      ctx.beginPath(); ctx.arc(cx, cy, b.orbit, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }
  if (system.ring) {
    const [r, g, bl] = bodies[0].color;
    ctx.save();
    ctx.strokeStyle = `rgba(${r},${g},${bl},0.05)`;
    ctx.lineWidth = 14;
    ctx.beginPath(); ctx.arc(0, 0, system.ring, 0, TAU); ctx.stroke();
    ctx.restore();
  }
}

// The current: a faint band along its stretch of orbit with streaks flowing forward through it.
// Calm clouds: soft breathing patches of fog.
function drawFlows() {
  const id = system.identity, pal = system.palette;
  if (id.current) {
    const c = id.current, [r, g, b] = pal[1 % pal.length];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = c.w * 2;
    for (let i = 0; i < 16; i++) {
      const t0 = i / 16, t1 = (i + 1) / 16;
      ctx.strokeStyle = `rgba(${r},${g},${b},${0.045 * Math.sin(Math.PI * (t0 + t1) / 2)})`;
      ctx.beginPath(); ctx.arc(0, 0, c.r, c.a0 + c.span * t0, c.a0 + c.span * t1); ctx.stroke();
    }
    ctx.lineWidth = 1.1 * px;
    ctx.setLineDash([9, 30]);
    for (const k of [-0.35, 0.35]) {  // two quiet lanes of streaks (four bold ones were too much)
      ctx.lineDashOffset = -time * (42 + k * 8);
      ctx.strokeStyle = `rgba(${r},${g},${b},0.3)`;
      ctx.beginPath(); ctx.arc(0, 0, c.r + k * c.w, c.a0 + 0.15, c.a0 + c.span - 0.15); ctx.stroke();
    }
    ctx.restore();
  }
  if (id.calm) {
    const [r, g, b] = pal[2 % pal.length];
    ctx.save();
    for (const [i, c] of id.calm.entries()) drawCalmCloud(c, i, r, g, b);
    ctx.restore();
  }
}

// One calm cloud: a few soft breathing fog blobs (overlapping, so the edge is irregular, never a circle
// that reads as a planet), two or three short swirl arcs well inside it, and faint streaks circling
// slowly, densest in the middle, in the fog's own colour (no glow, so they don't look like stardust).
// The circling shows what the cloud does: it settles you into an orbit.
function drawCalmCloud(c, i, r, g, b) {
  for (let k = 0; k < 3; k++) {
    const ox = Math.cos(time * 0.13 + k * 2.1 + i) * c.r * 0.22, oy = Math.sin(time * 0.11 + k * 1.7 + i) * c.r * 0.22;
    const rr = c.r * (0.75 + 0.06 * Math.sin(time * 0.4 + k));
    const fog = ctx.createRadialGradient(c.x + ox, c.y + oy, 0, c.x + ox, c.y + oy, rr);
    fog.addColorStop(0, `rgba(${r},${g},${b},0.08)`);
    fog.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = fog;
    ctx.beginPath(); ctx.arc(c.x + ox, c.y + oy, rr, 0, TAU); ctx.fill();
  }
  ctx.lineCap = 'round';
  ctx.lineWidth = 1.2 * px;
  ctx.strokeStyle = `rgba(${r},${g},${b},0.16)`;
  for (const [k, rad, len, sp] of [[0, 0.25, 1.9, 0.35], [1, 0.4, 1.3, 0.27], [2, 0.55, 1.05, 0.2]]) {
    const a0 = time * sp + k * 2.3 + i;
    ctx.beginPath(); ctx.arc(c.x, c.y, c.r * rad, a0, a0 + len); ctx.stroke();
  }
  ctx.strokeStyle = `rgba(${Math.round(mix(r, 255, 0.2))},${Math.round(mix(g, 255, 0.2))},${Math.round(mix(b, 255, 0.2))},0.3)`;
  ctx.lineWidth = 1 * px;
  ctx.beginPath();
  const rnd = seededRandom(9001 + i * 31);
  for (let k = 0; k < 25; k++) {
    const d = c.r * (0.08 + 0.72 * rnd()), a = rnd() * TAU + time * 0.5 * Math.sqrt(c.r / d) * 0.4, len = 5 * px / d;
    ctx.moveTo(c.x + Math.cos(a) * d, c.y + Math.sin(a) * d);
    ctx.arc(c.x, c.y, d, a, a + len);
  }
  ctx.stroke();
}

// Expanding rings of light: a garden coming into full bloom, an asteroid cracking open.
function drawWaves() {
  if (!waves.length) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const w of waves) {
    const t = (time - w.t0) / w.dur;
    if (t < 0 || t > 1) continue;
    const e = 1 - (1 - t) ** 3, x = w.body ? w.body.px : w.x, y = w.body ? w.body.py : w.y, r = mix(w.r0, w.r1, e);
    const a = 0.8 * (1 - t) ** 1.5, lw = mix(3, 0.5, e) * w.w / 2.5 * px;
    ctx.strokeStyle = `rgba(${w.color},${a * 0.18})`;
    ctx.lineWidth = lw * 6;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
    ctx.strokeStyle = `rgba(${w.color},${a})`;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
  ctx.restore();
}

// A garden waiting for pollen wears a slowly turning dashed ring in the colour of the garden it needs.
function drawPollenHints() {
  const s = ship, target = s.pollen && gardens.find(o => o.needs === s.pollen.name && !o.pollinated);
  if (target && !s.landed) {
    const dx = target.px - s.x, dy = target.py - s.y, d = Math.hypot(dx, dy);
    if (d > target.R + 30) {
      const ux = dx / d, uy = dy / d, g = ctx.createLinearGradient(s.x, s.y, target.px, target.py);
      g.addColorStop(0, bodyColor(s.pollen, 0));
      g.addColorStop(0.12, bodyColor(s.pollen, 0.55));
      g.addColorStop(1, bodyColor(s.pollen, 0.25));
      ctx.save();
      ctx.strokeStyle = g;
      ctx.lineWidth = 2 * px;
      ctx.lineCap = 'round';
      ctx.setLineDash([1 * px, 9 * px]);
      ctx.lineDashOffset = -time * 20 * px;
      ctx.beginPath(); ctx.moveTo(s.x + ux * 16, s.y + uy * 16); ctx.lineTo(target.px - ux * (target.R + 12), target.py - uy * (target.R + 12)); ctx.stroke();
      ctx.restore();
    }
  }
  for (const b of gardens) {
    if (!b.needs || b.pollinated) continue;
    const donor = gardens.find(o => o.name === b.needs);
    if (!donor) continue;
    ctx.save();
    ctx.strokeStyle = bodyColor(donor, 0.5);
    ctx.lineWidth = 1.4 * px;
    ctx.setLineDash([4, 7]);
    ctx.lineDashOffset = -time * 6;
    ctx.beginPath(); ctx.arc(b.px, b.py, b.R + 9, 0, TAU); ctx.stroke();
    ctx.restore();
  }
}

// Asteroids in the same line-art as the comet: an outlined lumpy rock, lit on the sun's side.
function drawRocks() {
  if (!rocks.length) return;
  const sx = Math.cos(system.sunAngle), sy = Math.sin(system.sunAngle);
  for (const k of rocks) {
    const n = k.shape.length, appear = clamp((time - k.born) / 2, 0, 1);
    ctx.save();
    ctx.translate(k.x, k.y);
    ctx.globalAlpha = appear;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = k.spin + i / n * TAU, r = k.R * k.shape[i % n];
      i ? ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r) : ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    const lit = ctx.createLinearGradient(sx * k.R, sy * k.R, -sx * k.R, -sy * k.R);
    lit.addColorStop(0, 'rgba(120,130,165,0.55)');
    lit.addColorStop(1, 'rgba(10,12,22,0.9)');
    ctx.fillStyle = lit;
    ctx.fill();
    ctx.strokeStyle = 'rgba(185,195,225,0.85)';
    ctx.lineWidth = 1.3 * px;
    ctx.stroke();
    ctx.restore();
  }
}

// Soft glow around a body, pre-rendered and only redrawn when its bloom changes noticeably.
function glowSprite(b) {
  const key = Math.round(bloomOf(b) * 20);
  if (b.glow && b.glowKey === key) return b.glow;
  const bloom = bloomOf(b), c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d'), inner = 0.8 / (1.35 + bloom * 0.15);
  const grad = g.createRadialGradient(64, 64, 64 * inner, 64, 64, 64);
  grad.addColorStop(0, bodyColor(b, 0.04 + bloom * 0.06));  // kept faint so neon halos don't flood the sky
  grad.addColorStop(1, bodyColor(b, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  b.glow = c; b.glowKey = key;
  return c;
}

// All plants on a body are drawn as one batched path (plus one fill per bloom colour) rather
// than one by one, which keeps big gardens cheap. Coordinates are relative to the body centre.
let pc = 0, ps = 0, pox = 0, poy = 0;           // current plant's rotation and base point
const PX = (lx, ly) => pox + lx * pc - ly * ps;
const PY = (lx, ly) => poy + lx * ps + ly * pc;
let ctx_ = null;  // the context drawGarden is drawing into (shard() uses it)
// In a small window (or zoomed out) plants are drawn taller, so a garden stays readable on screen.
const gardenBoost = () => clamp(0.95 / (scale * cam.zoom), 1, 1.7);
function drawGarden(b, ctx) {
  ctx_ = ctx;
  const [c0, c1, c2] = b.color, hs = (0.6 + 0.4 * Math.min(1, b.R / 60)) * gardenBoost();
  const buds = new Map();
  // At night (the side facing away from the sun) buds close up but glow a little wider.
  let day = 1;
  const bud = (p, lx, ly, r, col = p.tip) => {
    let list = buds.get(col);
    if (!list) buds.set(col, list = []);
    list.push(PX(lx, ly), PY(lx, ly), r * (0.55 + 0.45 * day), 2.2 + 1.4 * (1 - day));
  };
  ctx.beginPath();
  for (const p of b.plants) {
    const wa = p.a + b.spin;  // where on the body the plant is right now
    day = smooth(clamp((Math.cos(wa - system.sunAngle) + 0.25) / 0.5, 0, 1));
    const h = p.h * p.grow * hs, f = p.flip, th = wa + Math.PI / 2 + Math.sin(time * 1.3 + p.sway) * 0.12;
    pc = Math.cos(th); ps = Math.sin(th);
    const base = b.poly ? polyRadius(b, p.a) : b.R;
    pox = Math.cos(wa) * base; poy = Math.sin(wa) * base;
    if (b.poly) { shard(p, h * 1.25, day, bud); continue; }
    const showBud = p.grow > 0.5, petal = 2.4 * (0.4 + 0.6 * day);
    switch (p.kind) {
      case 1:  // grass tuft
        ctx.moveTo(pox, poy); ctx.quadraticCurveTo(PX(-h * 0.1, -h * 0.4), PY(-h * 0.1, -h * 0.4), PX(-h * 0.3, -h * 0.7), PY(-h * 0.3, -h * 0.7));
        ctx.moveTo(pox, poy); ctx.quadraticCurveTo(PX(h * 0.05, -h * 0.5), PY(h * 0.05, -h * 0.5), PX(0, -h * 0.95), PY(0, -h * 0.95));
        ctx.moveTo(pox, poy); ctx.quadraticCurveTo(PX(h * 0.15, -h * 0.4), PY(h * 0.15, -h * 0.4), PX(h * 0.3, -h * 0.75), PY(h * 0.3, -h * 0.75));
        if (showBud && p.sway % 1 < 0.5) bud(p, 0, -h * 0.95, 0.7 * p.grow);  // half the tufts get a little seed head
        break;
      case 2:  // forked
        ctx.moveTo(pox, poy); ctx.lineTo(PX(0, -h * 0.55), PY(0, -h * 0.55)); ctx.lineTo(PX(-h * 0.3 * f, -h), PY(-h * 0.3 * f, -h));
        ctx.moveTo(PX(0, -h * 0.55), PY(0, -h * 0.55)); ctx.lineTo(PX(h * 0.25 * f, -h * 0.85), PY(h * 0.25 * f, -h * 0.85));
        if (showBud) { bud(p, -h * 0.3 * f, -h, 1.1 * p.grow); bud(p, h * 0.25 * f, -h * 0.85, p.grow); }
        break;
      case 3:  // curl
        ctx.moveTo(pox, poy); ctx.quadraticCurveTo(PX(h * 0.6 * f, -h * 0.5), PY(h * 0.6 * f, -h * 0.5), PX(0, -h), PY(0, -h));
        ctx.moveTo(PX(h * 0.2 * f, -h * 0.45), PY(h * 0.2 * f, -h * 0.45)); ctx.lineTo(PX(h * 0.45 * f, -h * 0.55), PY(h * 0.45 * f, -h * 0.55));
        if (showBud) bud(p, 0, -h, 1.2 * p.grow);
        break;
      case 4:  // flower
        ctx.moveTo(pox, poy); ctx.lineTo(PX(0, -h), PY(0, -h));
        if (showBud) {
          for (let k = 0; k < 5; k++) {
            const a = k / 5 * TAU + p.sway;
            bud(p, Math.cos(a) * petal, -h + Math.sin(a) * petal, 1.5 * p.grow);
          }
          bud(p, 0, -h, 1.2, '255,250,225');
        }
        break;
      case BAMBOO:
        drawBamboo(h, f);
        break;
      default:  // sprout
        ctx.moveTo(pox, poy); ctx.lineTo(PX(0, -h), PY(0, -h));
        // about half the sprouts carry a full bud, the rest a tiny tip
        if (showBud) bud(p, 0, -h, (p.sway % 1 < 0.5 ? 1.3 : 0.6) * p.grow);
    }
  }
  if (b.poly) {  // crystal shards are filled, translucent
    ctx.fillStyle = `rgba(${c0},${c1},${c2},0.3)`;
    ctx.fill();
  }
  // a wide faint stroke for the glow, then the crisp stems on top
  ctx.strokeStyle = `rgba(${c0},${c1},${c2},0.16)`;
  ctx.lineWidth = 3.2 * px;
  ctx.stroke();
  // crisp stems with a slightly whitened core, so neighbouring neon colours differ in brightness too
  ctx.strokeStyle = `rgba(${Math.round(mix(c0, 255, 0.25))},${Math.round(mix(c1, 255, 0.25))},${Math.round(mix(c2, 255, 0.25))},0.85)`;
  ctx.lineWidth = 1.1 * px;
  ctx.stroke();
  for (const [col, list] of buds) {
    ctx.fillStyle = `rgba(${col},0.22)`;
    ctx.beginPath();
    for (let i = 0; i < list.length; i += 4) {
      const hr = list[i + 2] * list[i + 3];
      ctx.moveTo(list[i] + hr, list[i + 1]); ctx.arc(list[i], list[i + 1], hr, 0, TAU);
    }
    ctx.fill();
    ctx.fillStyle = `rgb(${col})`;
    ctx.beginPath();
    for (let i = 0; i < list.length; i += 4) { ctx.moveTo(list[i] + list[i + 2], list[i + 1]); ctx.arc(list[i], list[i + 1], list[i + 2], 0, TAU); }
    ctx.fill();
  }
}

// The rare bamboo clump (the player's pick of six styles): four hollow segmented culms, drawn as two thin
// lines with a small gap at each joint, and a few narrow leaves hanging from the upper joints. Line art,
// in the plant's local frame (h tall, f = side), into the garden's batched path.
function drawBamboo(h, f) {
  const line = (x0, y0, x1, y1) => { ctx_.moveTo(PX(x0, y0), PY(x0, y0)); ctx_.lineTo(PX(x1, y1), PY(x1, y1)); };
  // a narrow lance leaf from (x, y) at angle a (0 = along +x, positive = downward), length L, tip drooping a little
  const leaf = (x, y, a, L) => {
    const dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx, w = L * 0.13;
    const tx = x + dx * L, ty = y + dy * L + L * 0.06, mx = x + dx * L * 0.45, my = y + dy * L * 0.45;
    ctx_.moveTo(PX(x, y), PY(x, y));
    ctx_.quadraticCurveTo(PX(mx + nx * w, my + ny * w), PY(mx + nx * w, my + ny * w), PX(tx, ty), PY(tx, ty));
    ctx_.quadraticCurveTo(PX(mx - nx * w, my - ny * w), PY(mx - nx * w, my - ny * w), PX(x, y), PY(x, y));
  };
  h *= 1.12;
  [[-3, 0.8, -0.03], [-0.9, 1, 0], [1.3, 0.88, 0.025], [3.3, 0.62, 0.05]].forEach(([dx, hf, lean], c) => {
    const hk = h * hf, n = 7, w = 0.65, gap = 0.03, X = t => dx * f + lean * f * hk * t, Y = t => -hk * t;
    for (let i = 0; i < n; i++) {
      const t0 = i / n + (i ? gap / 2 : 0), t1 = (i + 1) / n - gap / 2;
      line(X(t0) - w, Y(t0), X(t1) - w, Y(t1)); line(X(t0) + w, Y(t0), X(t1) + w, Y(t1));
    }
    line(X(1) - w, Y(1), X(1) + w, Y(1));  // a closed top
    // leaves: two at the top joint, two a joint lower on the other side, one further down on the taller culms
    const side = c % 2 ? 1 : -1, at = (t, a, l, sd) => leaf(X(t), Y(t), sd > 0 ? a : Math.PI - a, h * l);
    at(1, 0.3, 0.27, side); at(1, 0.75, 0.22, side);
    at((n - 1) / n, 0.4, 0.25, -side); at((n - 1) / n, 0.8, 0.2, -side);
    if (hf > 0.75) at((n - 3) / n, 0.55, 0.22, side);
  });
}

// On a crystal moon seeds grow into shards: thin pointed crystals (clusters of three where a flower would
// be), with a glint at the tip that twinkles. Drawn into the same batched path as plants.
function shard(p, h, day, bud) {
  const one = (dx, hh, lean) => {
    const w = hh * 0.2, tx = dx + lean * hh;
    // a six-sided prism seen side on: straight sides, then a pointed tip
    ctx_.moveTo(PX(dx - w, 0), PY(dx - w, 0));
    ctx_.lineTo(PX(dx - w + lean * hh * 0.7, -hh * 0.7), PY(dx - w + lean * hh * 0.7, -hh * 0.7));
    ctx_.lineTo(PX(tx, -hh), PY(tx, -hh));
    ctx_.lineTo(PX(dx + w + lean * hh * 0.7, -hh * 0.7), PY(dx + w + lean * hh * 0.7, -hh * 0.7));
    ctx_.lineTo(PX(dx + w, 0), PY(dx + w, 0));
    ctx_.closePath();
    if (p.grow > 0.5) bud(p, tx, -hh, 0.6 * Math.max(0, Math.sin(time * 2.2 + p.sway * 3)) * p.grow);
  };
  if (p.kind === 4) { one(0, h, 0); one(-h * 0.22, h * 0.6, -0.3); one(h * 0.22, h * 0.7, 0.3); }
  else one(0, h * (p.kind === 1 ? 0.6 : 1), 0.15 * p.flip * (p.kind % 2));
}
// distance from a crystal's centre to its surface at local angle a (along the straight face there)
function polyRadius(b, a) {
  const P = b.poly, n = P.length;
  a = ((a % TAU) + TAU) % TAU;
  let i = n - 1;
  for (let k = 0; k < n; k++) if (P[k][0] > a) { i = (k + n - 1) % n; break; }
  const [a0, r0] = P[i], [a1, r1] = P[(i + 1) % n];
  const x0 = Math.cos(a0) * r0, y0 = Math.sin(a0) * r0, x1 = Math.cos(a1) * r1, y1 = Math.sin(a1) * r1;
  const dx = Math.cos(a), dy = Math.sin(a), ex = x1 - x0, ey = y1 - y0;
  return (x0 * ey - y0 * ex) / (dx * ey - dy * ex);  // where the ray at angle a meets that face
}

// Each garden is drawn into its own small offscreen canvas and only redrawn every few frames
// (the sway is slow enough that nobody can tell), or right away when the zoom or plant count changes.
let frameNo = 0;
function drawGardenCached(b) {
  const z = scale * cam.zoom * dpr, ext = b.R + (b.plants.some(p => p.kind === BAMBOO) ? 44 : 24) * gardenBoost(), size = Math.ceil(ext * 2 * z);
  if (size < 2) return;
  let gc = b.gardenCache;
  if (!gc || gc.canvas.width !== size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    gc = b.gardenCache = { canvas: c, g: c.getContext('2d'), frame: -99 };
  }
  if (frameNo - gc.frame >= 3 || gc.z !== z || gc.count !== b.plants.length) {
    gc.g.setTransform(1, 0, 0, 1, 0, 0);
    gc.g.clearRect(0, 0, size, size);
    gc.g.setTransform(z, 0, 0, z, size / 2, size / 2);
    drawGarden(b, gc.g);
    gc.frame = frameNo; gc.z = z; gc.count = b.plants.length;
  }
  ctx.drawImage(gc.canvas, -ext, -ext, 2 * ext, 2 * ext);
}

// Bodies are lit spheres: a colour fill brightest toward the sun and a rim that's a bright crescent on the
// lit side, fading on the night side (a full even rim around a dark middle read as glass marbles).
// Bare bodies start dim with a faint wireframe that fades as their garden fills in. Big garden planets get
// a thin atmosphere; small moons are a little lighter-touch. (Chosen with the art-critic review.)
// A body in full bloom: a soft halo in its own colour that breathes slowly.
function bloomHalo(b) {
  if (!b.bloomed) return;
  const R = b.R, pulse = 0.75 + 0.25 * Math.sin(time * 1.3 + R), out = Math.max(R * 1.4, R + 12);
  const halo = ctx.createRadialGradient(0, 0, R * 0.95, 0, 0, out);
  halo.addColorStop(0, bodyColor(b, 0.32 * pulse));
  halo.addColorStop(1, bodyColor(b, 0));
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(0, 0, out, 0, TAU); ctx.fill();
}

function drawBody(b) {
  if (b.kind === 'hole') return drawHole(b);
  if (b.kind === 'gas') return drawGas(b);
  if (b.kind === 'crystal') return drawCrystal(b);
  const bloom = bloomOf(b), G = b.R * (1.35 + bloom * 0.15), R = b.R, small = R < 25;
  const sx = Math.cos(system.sunAngle), sy = Math.sin(system.sunAngle);
  ctx.save();
  ctx.translate(b.px, b.py);
  ctx.drawImage(glowSprite(b), -G, -G, 2 * G, 2 * G);
  bloomHalo(b);

  if (!small && bloom > 0.05) {  // thin atmosphere band, coming in as the garden fills
    ctx.strokeStyle = bodyColor(b, 0.14 * bloom);
    ctx.lineWidth = R * 0.1;
    ctx.beginPath(); ctx.arc(0, 0, R * 1.05, 0, TAU); ctx.stroke();
  }
  ctx.fillStyle = '#070a14';
  ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
  // the sunlit side is slightly whitened so a dim fill reads warm rather than muddy (dim yellow goes olive)
  const lit = 0.6 * (0.3 + 0.7 * bloom), [cr, cg, cb] = b.color;
  const fill = ctx.createRadialGradient(sx * R * 0.45, sy * R * 0.45, 0, sx * R * 0.2, sy * R * 0.2, R * 1.3);
  fill.addColorStop(0, `rgba(${Math.round(mix(cr, 255, 0.4))},${Math.round(mix(cg, 255, 0.4))},${Math.round(mix(cb, 255, 0.4))},${lit})`);
  fill.addColorStop(1, bodyColor(b, 0.06));
  ctx.fillStyle = fill;
  ctx.fill();
  if (bloom < 1) drawWireframe(b, 0.12 * (1 - bloom));
  drawDayNight(b);
  // crescent rim: full strength on the lit side, about a quarter on the night side
  const rim = ctx.createLinearGradient(sx * R, sy * R, -sx * R, -sy * R);
  rim.addColorStop(0, bodyColor(b, 0.95));
  rim.addColorStop(0.5, bodyColor(b, 0.55));
  rim.addColorStop(1, bodyColor(b, 0.22));
  ctx.strokeStyle = rim;
  ctx.lineWidth = (small ? 1.2 : 1.5) * (b.bloomed ? 1.5 + 0.3 * Math.sin(time * 1.3 + R) : 1) * px;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.stroke();
  if (b.plants.length) drawGardenCached(b);
  ctx.restore();
}

// A black hole: a pure black core with a thin bright photon ring, and a tilted disk of thin lines that
// turn around it (inner ones faster). The far half of the disk is drawn behind the core, the near half
// across it, and the far side is also bent up over the top (and faintly under the bottom) by the lensing.
const DISK_RINGS = [1.6, 1.9, 2.3, 2.75, 3.3, 4, 4.8];
function drawHole(b) {
  const R = b.R, FL = 0.28, [cr, cg, cb] = b.color;
  const hot = w => `${Math.round(mix(cr, 255, w))},${Math.round(mix(cg, 255, w))},${Math.round(mix(cb, 255, w))}`;
  ctx.save();
  ctx.translate(b.px, b.py);
  ctx.rotate(b.tilt || 0);
  // faint glow of the disk
  ctx.save();
  ctx.scale(1, FL * 1.8);
  const glow = ctx.createRadialGradient(0, 0, R, 0, 0, R * 5);
  glow.addColorStop(0, `rgba(${hot(0.3)},0.16)`);
  glow.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(0, 0, R * 5, 0, TAU); ctx.fill();
  ctx.restore();
  // one side of the disk comes toward us and looks brighter (gradients are kept, they never change)
  const cache = b.grads || (b.grads = {});
  const side = (w, a) => {
    const key = w + ':' + a;
    if (cache[key]) return cache[key];
    const g = ctx.createLinearGradient(-R * 4, 0, R * 4, 0);
    g.addColorStop(0, `rgba(${hot(w)},${a})`);
    g.addColorStop(1, `rgba(${hot(w)},${a * 0.3})`);
    return (cache[key] = g);
  };
  const half = front => {
    DISK_RINGS.forEach((k, i) => {
      const r = R * k, t = i / (DISK_RINGS.length - 1), a = 0.8 - t * 0.45, w = 0.4 - t * 0.35;
      const from = front ? 0 : Math.PI, to = front ? Math.PI : TAU;
      ctx.lineWidth = (1.4 - t * 0.5) * px;
      ctx.setLineDash([]);
      ctx.strokeStyle = side(w, a * (front ? 0.5 : 0.35));
      ctx.beginPath(); ctx.ellipse(0, 0, r, r * FL, 0, from, to); ctx.stroke();
      // bright streaks that travel round, faster close in
      ctx.setLineDash([r * 0.35, r * (0.25 + 0.1 * (i % 3))]);
      ctx.lineDashOffset = -time * 60 / Math.sqrt(k) - i * 13;
      ctx.strokeStyle = side(w, a);
      ctx.beginPath(); ctx.ellipse(0, 0, r, r * FL, 0, from, to); ctx.stroke();
    });
    ctx.setLineDash([]);
  };
  half(false);
  // the core, the far side of the disk bent up over its top by the lensing, and the photon ring
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.arc(0, 0, R * 1.02, 0, TAU); ctx.fill();
  ctx.lineWidth = 2 * px;
  ctx.strokeStyle = side(0.5, 0.5);
  ctx.beginPath(); ctx.arc(0, 0, R * 1.2, -Math.PI / 2 - 1.4, -Math.PI / 2 + 1.4); ctx.stroke();
  ctx.lineWidth = 1.3 * px;
  ctx.strokeStyle = `rgba(${hot(0.75)},0.85)`;
  ctx.beginPath(); ctx.arc(0, 0, R * 1.06, 0, TAU); ctx.stroke();
  half(true);
  ctx.restore();
}

// A gas giant: a big lit sphere with soft bands in the theme's colours and a storm that rolls round with
// it, inside a tilted ring of thin lines (the far half hidden behind the planet, the near half across it).
// thin separate lines, brightest inside, with one empty gap (like Cassini's) after the fifth
const GAS_RINGS = [1.3, 1.35, 1.4, 1.45, 1.5, 1.62, 1.67, 1.72, 1.77, 1.82].map((k, i) => [k, 0.6 - i * 0.027]);
function drawGas(b) {
  const R = b.R, FL = 0.24, sx = Math.cos(system.sunAngle), sy = Math.sin(system.sunAngle);
  const [cr, cg, cb] = b.color, ring = b.accents[0];
  ctx.save();
  ctx.translate(b.px, b.py);
  const G = R * 1.3;
  ctx.drawImage(glowSprite(b), -G, -G, 2 * G, 2 * G);
  const half = front => {
    ctx.save();
    ctx.rotate(b.tilt || 0);
    const from = front ? 0 : Math.PI, to = front ? Math.PI : TAU;
    if (front) {  // a dark edge under the near half, so it reads as passing in front of the planet
      ctx.strokeStyle = 'rgba(4,5,14,0.6)';
      ctx.lineWidth = R * 0.7 * FL + 2 * px;
      ctx.beginPath(); ctx.ellipse(0, 0, R * 1.63, R * 1.63 * FL, 0, from, to); ctx.stroke();
    }
    for (const [k, a] of GAS_RINGS) {
      ctx.strokeStyle = `rgba(${ring},${a})`;
      ctx.lineWidth = 1 * px;
      ctx.beginPath(); ctx.ellipse(0, 0, R * k, R * k * FL, 0, from, to); ctx.stroke();
    }
    ctx.restore();
  };
  half(false);
  // the planet itself
  ctx.fillStyle = '#070a14';
  ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
  const fill = ctx.createRadialGradient(sx * R * 0.45, sy * R * 0.45, 0, sx * R * 0.2, sy * R * 0.2, R * 1.3);
  fill.addColorStop(0, `rgba(${Math.round(mix(cr, 255, 0.3))},${Math.round(mix(cg, 255, 0.3))},${Math.round(mix(cb, 255, 0.3))},0.5)`);
  fill.addColorStop(1, `rgba(${system.night},0.15)`);  // the night side fades toward the sky's own hue (not dark brown)
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.rotate(b.tilt || 0);
  // soft bands in the theme's other colours
  for (let i = 0; i < 9; i++) {
    const y = -R + (i + 0.5) * R * 2 / 9, h = R * (0.08 + 0.06 * ((i * 5) % 3));
    ctx.fillStyle = `rgba(${b.accents[i % 2]},${0.06 + 0.04 * (i % 3)})`;
    ctx.fillRect(-R, y - h / 2, 2 * R, h);
  }
  // a storm drifting round in one band, squashed as it turns toward the edge
  const c = Math.cos(b.spin * 1.5);
  if (c > 0) {
    ctx.strokeStyle = `rgba(${ring},${0.35 * c})`;
    ctx.lineWidth = 1.4 * px;
    ctx.beginPath(); ctx.ellipse(Math.sin(b.spin * 1.5) * R * 0.75, R * 0.3, R * 0.14 * c, R * 0.07, 0, 0, TAU); ctx.stroke();
  }
  ctx.restore();
  drawDayNight(b, system.night);
  const rim = ctx.createLinearGradient(sx * R, sy * R, -sx * R, -sy * R);
  rim.addColorStop(0, `rgba(${cr},${cg},${cb},0.9)`);
  rim.addColorStop(0.5, `rgba(${cr},${cg},${cb},0.5)`);
  rim.addColorStop(1, `rgba(${cr},${cg},${cb},0.2)`);
  ctx.strokeStyle = rim;
  ctx.lineWidth = 1.5 * px;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.stroke();
  half(true);
  ctx.restore();
}

// A crystal moon: a faceted outline turning with its garden, lit from the sun's side, a few facet lines
// running to a point offset toward the light, and glints on the sunlit corners.
function drawCrystal(b) {
  const bloom = bloomOf(b), R = b.R, G = R * 1.45, sx = Math.cos(system.sunAngle), sy = Math.sin(system.sunAngle);
  const [cr, cg, cb] = b.color, n = b.poly.length;
  const pts = b.poly.map(([a, r]) => [Math.cos(a + b.spin) * r, Math.sin(a + b.spin) * r]);
  const outline = () => { ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); };
  ctx.save();
  ctx.translate(b.px, b.py);
  ctx.drawImage(glowSprite(b), -G, -G, 2 * G, 2 * G);
  bloomHalo(b);
  outline();
  ctx.fillStyle = '#070a14';
  ctx.fill();
  const lit = 0.65 * (0.35 + 0.65 * bloom);
  const fill = ctx.createLinearGradient(sx * R, sy * R, -sx * R, -sy * R);
  fill.addColorStop(0, `rgba(${Math.round(mix(cr, 255, 0.5))},${Math.round(mix(cg, 255, 0.5))},${Math.round(mix(cb, 255, 0.5))},${lit})`);
  fill.addColorStop(0.55, bodyColor(b, lit * 0.25));
  fill.addColorStop(1, 'rgba(3,4,12,0.6)');
  ctx.fillStyle = fill;
  ctx.fill();
  // facets like a cut gem: a smaller flat face (the table) turned toward the light, joined to every corner
  const fx = sx * R * 0.15, fy = sy * R * 0.15, inner = pts.map(([x, y]) => [fx + x * 0.45, fy + y * 0.45]);
  ctx.strokeStyle = bodyColor(b, 0.22);
  ctx.lineWidth = 1 * px;
  ctx.beginPath();
  inner.forEach(([x, y], i) => { ctx.moveTo(pts[i][0], pts[i][1]); ctx.lineTo(x, y); });
  inner.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.closePath();
  ctx.stroke();
  // the outline: bright on the lit side
  const rim = ctx.createLinearGradient(sx * R, sy * R, -sx * R, -sy * R);
  rim.addColorStop(0, bodyColor(b, 1));
  rim.addColorStop(0.5, bodyColor(b, 0.6));
  rim.addColorStop(1, bodyColor(b, 0.25));
  outline();
  ctx.strokeStyle = rim;
  ctx.lineWidth = 1.4 * px;
  ctx.stroke();
  // glints on the corners facing the sun
  ctx.strokeStyle = 'rgba(255,252,240,0.9)';
  ctx.lineWidth = 1 * px;
  ctx.beginPath();
  pts.forEach(([x, y], i) => {
    const facing = (x * sx + y * sy) / R, tw = Math.sin(time * 1.7 + i * 2.3);
    if (facing < 0.55 || tw < 0.3) return;
    const g = (tw - 0.3) * 6 * px + 1 * px;
    ctx.moveTo(x - g, y); ctx.lineTo(x + g, y); ctx.moveTo(x, y - g); ctx.lineTo(x, y + g);
  });
  ctx.stroke();
  if (b.plants.length) drawGardenCached(b);
  ctx.restore();
}

// Faint meridians and latitude lines that turn with the body: an unplanted world, still a sketch.
function drawWireframe(b, alpha) {
  const R = b.R;
  ctx.save();
  ctx.strokeStyle = bodyColor(b, alpha);
  ctx.lineWidth = 0.9 * px;
  ctx.beginPath();
  for (let k = 0; k < 4; k++) {
    const ph = ((b.spin * 2 + k * Math.PI / 4) % Math.PI + Math.PI) % Math.PI;
    ctx.moveTo(0, -R);
    ctx.ellipse(0, 0, Math.abs(Math.cos(ph)) * R, R, 0, -Math.PI / 2, Math.PI * 1.5);
  }
  for (const lat of [-0.5, 0, 0.5]) {
    const y = lat * R, w = Math.sqrt(R * R - y * y);
    ctx.moveTo(w, y);
    ctx.ellipse(0, y, w, w * 0.12, 0, 0, TAU);
  }
  ctx.stroke();
  ctx.restore();
}

// The far side from the sun falls into shadow (dimming the outline too); a thin bright rim catches the light.
function drawDayNight(b, night = system.night) {
  const sx = Math.cos(system.sunAngle), sy = Math.sin(system.sunAngle), R = b.R;
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, R + 0.5 * px, 0, TAU); ctx.clip();
  const shade = ctx.createLinearGradient(sx * R, sy * R, -sx * R, -sy * R);
  shade.addColorStop(0, `rgba(${night},0)`);
  shade.addColorStop(0.42, `rgba(${night},0)`);
  shade.addColorStop(0.62, `rgba(${night},0.55)`);
  shade.addColorStop(1, `rgba(${night},0.72)`);
  ctx.fillStyle = shade;
  ctx.fillRect(-R - 6, -R - 6, 2 * R + 12, 2 * R + 12);
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const id = system.identity;
  ctx.strokeStyle = `rgba(${id.sun},0.3)`;
  ctx.lineWidth = 1.4 * px;
  ctx.beginPath(); ctx.arc(0, 0, R, system.sunAngle - 1.1, system.sunAngle + 1.1); ctx.stroke();
  if (id.sun2 !== null) {  // a second, fainter sun catches the other edge
    const x2 = Math.cos(id.sun2) * R, y2 = Math.sin(id.sun2) * R, wash = ctx.createRadialGradient(x2, y2, 0, x2, y2, R * 1.2);
    wash.addColorStop(0, `rgba(${id.sun2Tint},0.12)`); wash.addColorStop(1, `rgba(${id.sun2Tint},0)`);
    ctx.fillStyle = wash;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    ctx.strokeStyle = `rgba(${id.sun2Tint},0.4)`;
    ctx.lineWidth = 1.8 * px;
    ctx.beginPath(); ctx.arc(0, 0, R, id.sun2 - 1, id.sun2 + 1); ctx.stroke();
  }
  ctx.restore();
}

let predCache = null, predAge = 0;
function drawTrajectory() {
  const s = ship;
  if (s.landed) { predCache = null; return; }
  // recompute every other frame (and not at all while paused); a one-frame-old path looks identical
  if (!predCache || (!paused && ++predAge >= 2)) { predCache = predict(); predAge = 0; }
  const p = predCache, n = p.pts.length / 2, d = 1 * px;
  ctx.save();
  // softer than the planet rims, and tinted toward the theme
  ctx.fillStyle = `rgb(${system.dustCore})`;
  for (let i = 0; i < n; i++) {
    ctx.globalAlpha = 0.28 * (1 - i / n);
    ctx.fillRect(p.pts[2 * i] - d, p.pts[2 * i + 1] - d, 2 * d, 2 * d);
  }
  if (p.impact && !p.impact.barren) {
    const ok = p.impact.speed <= cfg.landSpeed;
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = ok ? '#9dffc8' : '#ffb070';
    ctx.lineWidth = 1.5 * px;
    ctx.beginPath(); ctx.arc(p.impact.x, p.impact.y, 4 + Math.sin(time * 6), 0, TAU); ctx.stroke();
  }
  ctx.restore();
}

// The exit lane: a soft beam of light, brightest along its middle and fading out at the sides and ends
// (stacked narrowing wedges), with motes drifting outward along it.
// The lane is pre-rendered once: a trumpet of light (a thin thread at the heart of the system widening to
// about the capture lane's width at its edge) with a smooth brightness ramp, (r / edge)^3, so it's nearly
// invisible where it's narrow and brightest at the edge, easing off beyond, and soft at its sides.
// Drawing it as an image each frame is cheap and has none of the banding that stacked layers had.
const LANE_LEN = ARENA_R + 420, LANE_RES = 1.5;
let laneSprite = null;
const laneHalfWidth = r => 2 + 142 * Math.pow(r / ARENA_R, 1.8);
function makeLaneSprite() {
  const maxW = laneHalfWidth(LANE_LEN) * 1.2 + 10, c = document.createElement('canvas');
  c.width = Math.ceil(LANE_LEN * LANE_RES); c.height = Math.ceil(maxW * 2 * LANE_RES);
  const g = c.getContext('2d');
  g.scale(LANE_RES, LANE_RES); g.translate(0, maxW);
  // built strip by strip along its length: each strip fades smoothly from the middle to nothing at the
  // sides (a bell, so there's no hard edge and no centre line), at the brightness for that distance
  for (let r = 0; r < LANE_LEN; r += 1.5) {
    const k = r <= ARENA_R ? (r / ARENA_R) ** 3 : Math.max(0, 1 - (r - ARENA_R) / (LANE_LEN - ARENA_R)) ** 1.5;
    if (k < 0.002) continue;
    const hw = laneHalfWidth(r) * 1.2, a = 0.27 * k, grad = g.createLinearGradient(0, -hw, 0, hw);
    for (const [t, f] of [[0, 0], [0.15, 0.08], [0.3, 0.4], [0.5, 1], [0.7, 0.4], [0.85, 0.08], [1, 0]]) grad.addColorStop(t, `rgba(205,195,255,${a * f})`);
    g.fillStyle = grad;
    g.fillRect(r, -hw, 1.6, 2 * hw);
  }
  return { c, maxW };
}
function drawExit() {
  if (!exit) return;
  if (!laneSprite) laneSprite = makeLaneSprite();
  const a = clamp((time - exit.born) / 3, 0, 1) * (0.85 + 0.15 * Math.sin(time * 0.9));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.rotate(exit.angle);
  ctx.globalAlpha = a;
  ctx.drawImage(laneSprite.c, 0, -laneSprite.maxW, LANE_LEN, laneSprite.maxW * 2);
  // small round points drifting outward through the outer half of the lane: "this way out"
  const r0 = ARENA_R * 0.45, span = ARENA_R + 80 - r0;
  ctx.fillStyle = 'rgb(232,226,255)';
  for (let k = 0; k < 8; k++) {
    const r = r0 + (time * 60 + k * span / 8) % span, side = Math.sin(k * 2.3) * laneHalfWidth(r) * 0.4;
    const fade = Math.min(1, (r - r0) / 50) * Math.min(1, (ARENA_R + 80 - r) / 60);
    ctx.globalAlpha = 0.6 * a * fade;
    ctx.beginPath(); ctx.arc(r, side, 1.8 * px, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

// A small, faint chevron near the ship pointing toward the lane, until you're out near it.
function drawExitPointer() {
  if (!exit || title || warp) return;
  const s = ship, tx = Math.cos(exit.angle) * (ARENA_R + 60), ty = Math.sin(exit.angle) * (ARENA_R + 60);
  const dx = tx - s.x, dy = ty - s.y;
  if (Math.hypot(dx, dy) < 220) return;
  const a = Math.atan2(dy, dx), r = 34;
  ctx.save();
  ctx.translate(s.x + Math.cos(a) * r, s.y + Math.sin(a) * r);
  ctx.rotate(a);
  ctx.globalAlpha = 0.3 + 0.15 * Math.sin(time * 2);
  ctx.strokeStyle = '#d8ccff';
  ctx.lineWidth = 1.6 * px;
  ctx.beginPath(); ctx.moveTo(-3, -4); ctx.lineTo(2, 0); ctx.lineTo(-3, 4); ctx.stroke();
  ctx.restore();
}

// A comet in the game's line-art style: an outlined lumpy rock with a dark filled core (so it hides the
// stars behind it and reads as solid), shaded away from the sun like the planets with a small bright glow
// on its sunlit edge, a faint dashed coma, and two thin tails pointing away from the sun: a straight blue
// ion tail and a gold dust tail curving back along its path.
function drawComets() {
  const sx = Math.cos(system.sunAngle), sy = Math.sin(system.sunAngle);
  for (const c of comets) {
    const v = Math.hypot(c.vx, c.vy) || 1, bx = -c.vx / v, by = -c.vy / v, f = c.fade, len = 120;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    // dust tail: curves from "away from the sun" toward "behind the comet"
    const ex = c.x + (-sx * 0.55 + bx * 0.65) * len, ey = c.y + (-sy * 0.55 + by * 0.65) * len;
    const dust = ctx.createLinearGradient(c.x, c.y, ex, ey);
    dust.addColorStop(0, `rgba(255,214,120,${0.85 * f})`);
    dust.addColorStop(1, 'rgba(255,214,120,0)');
    ctx.strokeStyle = dust;
    ctx.lineWidth = 1.6 * px;
    ctx.beginPath(); ctx.moveTo(c.x - sx * 6, c.y - sy * 6); ctx.quadraticCurveTo(c.x - sx * len * 0.5, c.y - sy * len * 0.5, ex, ey); ctx.stroke();
    // ion tail: a few faint straight streamers pointing away from the sun (one long line read as a tether)
    const sa = system.sunAngle + Math.PI;
    ctx.lineWidth = 1 * px;
    for (const [da, k] of [[-0.06, 0.6], [0, 0.85], [0.07, 0.5]]) {
      const ix = c.x + Math.cos(sa + da) * len * k, iy = c.y + Math.sin(sa + da) * len * k;
      const ion = ctx.createLinearGradient(c.x, c.y, ix, iy);
      ion.addColorStop(0, `rgba(170,215,255,${0.55 * f})`);
      ion.addColorStop(1, 'rgba(170,215,255,0)');
      ctx.strokeStyle = ion;
      ctx.beginPath(); ctx.moveTo(c.x - sx * 6, c.y - sy * 6); ctx.lineTo(ix, iy); ctx.stroke();
    }
    // a small bright glow on the sunlit side
    const gx = c.x + sx * 4, gy = c.y + sy * 4, glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, 9);
    glow.addColorStop(0, `rgba(255,245,215,${0.5 * f})`);
    glow.addColorStop(1, 'rgba(255,245,215,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(gx, gy, 9, 0, TAU); ctx.fill();
    // faint dashed coma
    ctx.setLineDash([2 * px, 3 * px]);
    ctx.strokeStyle = `rgba(255,230,170,${0.3 * f})`;
    ctx.lineWidth = 1 * px;
    ctx.beginPath(); ctx.arc(c.x, c.y, 11, 0, TAU); ctx.stroke();
    ctx.restore();

    // nucleus: dark filled rock, shaded on the night side, with a glowing outline
    ctx.save();
    ctx.globalAlpha = f;
    ctx.translate(c.x, c.y);
    ctx.beginPath();
    c.shape.forEach((k, i) => {
      const a = c.spin + i / c.shape.length * TAU, rr = 6 * k;
      i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    });
    ctx.closePath();
    const shade = ctx.createLinearGradient(sx * 6, sy * 6, -sx * 6, -sy * 6);
    shade.addColorStop(0, '#3a3226');
    shade.addColorStop(1, '#06070c');
    ctx.fillStyle = shade;
    ctx.fill();
    ctx.strokeStyle = '#ffe9b0'; ctx.shadowColor = '#ffd27a'; ctx.shadowBlur = 8;
    ctx.lineWidth = 1.5 * px;
    ctx.stroke();
    ctx.restore();
  }
}

const fadeTime = m => m.hang ? 2 : MOTE_FADE;  // comet beads fade quickly at the end of their life

// Drawn in two passes per kind (normal, then gold) so each colour is set once; only alpha changes per mote.
function drawMotes() {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  drawCometRibbon();
  // zoomed in, glows grow more slowly than the world does, so they stay crisp points of light
  const zf = Math.pow(cam.zoom, -0.6);
  // meteor-shower stardust trails a short streak behind it
  ctx.strokeStyle = `rgb(${system.dustCore})`;
  ctx.lineWidth = 1.3 * px;
  ctx.lineCap = 'round';
  for (const m of motes) {
    if (!m.streak) continue;
    const age = time - m.born, fade = Math.min(1, age * 2) * clamp((m.life + MOTE_FADE - age) / MOTE_FADE, 0, 1);
    ctx.globalAlpha = 0.45 * fade;
    ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - m.vx * 0.22, m.y - m.vy * 0.22); ctx.stroke();
  }
  for (const gold of [false, true]) {
    const halo = gold ? '#ffd890' : `rgb(${system.dustHalo})`, core = gold ? '#ffe2a0' : `rgb(${system.dustCore})`;
    for (const [color, alpha, radius] of [[halo, gold ? 0.2 : 0.15, gold ? 6.5 : 5], [core, 0.9, gold ? 2.7 : 1.8]]) {
      ctx.fillStyle = color;
      for (const m of motes) {
        if (m.gold !== gold) continue;
        const age = time - m.born;
        let fade = Math.min(1, age * 2);
        if (m.life) fade *= clamp((m.life + fadeTime(m) - age) / fadeTime(m), 0, 1);
        // each mote has its own size and twinkle speed; comet beads taper from 1.3x (new) to 0.7x (old)
        const tw = 0.7 + 0.3 * Math.sin(time * (m.tws || 4) + m.tw);
        const size = (m.size || 1) * (m.hang ? 0.7 + 0.6 * clamp(1 - age / m.life, 0, 1) : 1);
        ctx.globalAlpha = alpha * fade * tw;
        ctx.beginPath(); ctx.arc(m.x, m.y, radius * size * zf, 0, TAU); ctx.fill();
      }
    }
  }
  ctx.restore();
}

// A faint glowing ribbon joins the newest comet beads (under 4 s old), so a fresh trail looks bold.
function drawCometRibbon() {
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#ffd27a';
  ctx.lineWidth = 4 * px;
  const fresh = motes.filter(m => m.comet && time - m.born < 4).sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < fresh.length; i++) {
    const prev = fresh[i - 1], m = fresh[i], age = time - m.born;
    if (prev.comet !== m.comet || prev.seq !== m.seq - 1) continue;
    ctx.globalAlpha = 0.15 * (1 - age / 4);
    ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(m.x, m.y); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawFireflies() {
  if (!fireflies.length) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const f of fireflies) {
    const a = clamp(Math.min(f.life / 2, (f.max - f.life) * 1.5), 0, 1) * (0.55 + 0.45 * Math.sin(time * 5 + f.ph));
    ctx.fillStyle = `rgba(${f.color},${0.18 * a})`;
    ctx.beginPath(); ctx.arc(f.x, f.y, 4, 0, TAU); ctx.fill();
    ctx.fillStyle = `rgba(${f.color},${a})`;
    ctx.beginPath(); ctx.arc(f.x, f.y, 1.1, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

function drawParticles() {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // soft round dots that shrink as they fade
  for (const p of particles) {
    const k = p.life / p.max;
    if (p.shard) {  // a little splinter of rock, pointing the way it flies
      const rx = p.vx - p.bvx, ry = p.vy - p.bvy, l = Math.hypot(rx, ry) || 1;
      ctx.strokeStyle = `rgba(${p.color},${k})`;
      ctx.lineWidth = 1.4 * px;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - rx / l * 4, p.y - ry / l * 4); ctx.stroke();
      continue;
    }
    const d = p.size * (0.3 + 0.7 * k) * px * 1.3;
    ctx.fillStyle = `rgba(${p.color},${k})`;
    ctx.beginPath(); ctx.arc(p.x, p.y, d, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

function drawShip() {
  const s = ship;
  ctx.save();
  ctx.translate(s.x, s.y);

  // seeds you're carrying circle the ship
  const shown = Math.min(s.seeds, 30);
  if (shown) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(216,246,255,0.8)';
    ctx.beginPath();
    for (let i = 0; i < shown; i++) {
      const a = time * 1.6 + i / shown * TAU, r = 18 + (i % 3) * 3, x = Math.cos(a) * r, y = Math.sin(a) * r;
      ctx.moveTo(x + 1.3, y); ctx.arc(x, y, 1.3, 0, TAU);
    }
    ctx.fill();
    ctx.restore();
  }

  if (s.pollen) {  // pollen you're carrying: a few motes in its garden's colour, close in
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = bodyColor(s.pollen, 0.9);
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = -time * 2.3 + i / 5 * TAU, r = 12 + Math.sin(time * 3 + i) * 1.5, x = Math.cos(a) * r, y = Math.sin(a) * r;
      ctx.moveTo(x + 1.8, y); ctx.arc(x, y, 1.8, 0, TAU);
    }
    ctx.fill();
    ctx.restore();
  }

  ctx.rotate(s.angle + Math.PI / 2);
  ctx.scale(SHIP_SCALE, SHIP_SCALE);
  drawHull(SHIPS[prefs.ship], s.throttle, 2.1 * px / SHIP_SCALE);
  ctx.restore();
}

// Close to a surface, show your speed relative to it (lander style).
function drawLandingReadout() {
  const s = ship;
  if (s.landed || title) return;
  const { b, alt } = nearestSurface(s.x, s.y);
  if (alt > 90) return;
  const speed = Math.hypot(s.vx - b.pvx, s.vy - b.pvy);
  ctx.save();
  ctx.globalAlpha = clamp((90 - alt) / 30, 0, 1);
  ctx.fillStyle = speed <= cfg.landSpeed ? '#9dffc8' : speed <= cfg.landSpeed * 1.6 ? '#ffcf8a' : '#ff8a7a';
  ctx.font = `${12 * px}px ui-monospace, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(speed.toFixed(0), s.x, s.y + 20 + 12 * px);
  ctx.restore();
}

function drawChainPopup() {
  if (!chainPopup) return;
  const age = time - chainPopup.t;
  if (age > 1.2) return;
  ctx.save();
  ctx.globalAlpha = 1 - age / 1.2;
  ctx.fillStyle = chainPopup.bonus ? '#fff3a0' : '#bfefff';
  ctx.font = `${(chainPopup.bonus ? 15 : 12) * px}px ui-monospace, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(`×${chainPopup.n}${chainPopup.bonus ? ' bonus!' : ''}`, ship.x, ship.y - (26 + age * 18) * px - 10);
  ctx.restore();
}

function drawTitle() {
  ctx.save();
  ctx.fillStyle = 'rgba(3,5,13,0.78)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e8f4ff';
  ctx.shadowColor = '#9fd8ff'; ctx.shadowBlur = 18;
  ctx.font = `300 ${Math.min(54, W / 16)}px ui-monospace, Consolas, monospace`;
  ctx.fillText('M O O N S E E D', W / 2, H * 0.24);
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(190,210,235,0.75)';
  ctx.font = '14px ui-monospace, Consolas, monospace';
  const tag = 'gather stardust  ·  land gently  ·  grow gardens';
  if (ctx.measureText(tag).width < W * 0.8) ctx.fillText(tag, W / 2, H * 0.24 + 46);
  else tag.split('  ·  ').forEach((t, i) => ctx.fillText(t, W / 2, H * 0.24 + 44 + i * 22));  // a phone: stacked

  // ship picker
  const design = SHIPS[prefs.ship], cy = H * 0.55;
  ctx.save();
  ctx.translate(W / 2, cy);
  ctx.scale(4, 4);
  drawHull(design, 0, 1.6 / 4);
  ctx.restore();
  ctx.fillStyle = '#cfe';
  ctx.font = '15px ui-monospace, Consolas, monospace';
  ctx.fillText(`◀   ${design.name}   ▶`, W / 2, cy + 64);
  ctx.fillStyle = 'rgba(160,180,210,0.6)';
  ctx.font = '12px ui-monospace, Consolas, monospace';
  ctx.fillText(TOUCH ? 'tap ◀ ▶ to choose a ship' : '← / → to choose a ship (C changes it in game)', W / 2, cy + 88);

  const resuming = systemNo > 1 || bodies.some(b => b.plants.length);
  ctx.fillStyle = `rgba(232,244,255,${0.55 + 0.45 * Math.sin(performance.now() / 500)})`;
  ctx.font = '16px ui-monospace, Consolas, monospace';
  const go = TOUCH ? 'tap' : 'press any key or click';
  ctx.fillText(resuming ? `${go} to continue (system ${systemNo})` : `${go} to begin`, W / 2, H * 0.84);
  ctx.restore();
}

function drawHUD() {
  const s = ship;
  ctx.save();
  ctx.font = '13px ui-monospace, Consolas, monospace';
  ctx.textBaseline = 'top';
  const x = 22;
  let y = 20;

  ctx.fillStyle = '#8fa8cc'; ctx.fillText('SEEDS', x, y);
  ctx.fillStyle = '#e8fbff'; ctx.fillText(String(s.seeds), x + 60, y);
  // no fuel gauge (it's almost always full); only a note while a long burn has emptied the tank
  if (s.empty) { ctx.fillStyle = '#ff9a6a'; ctx.fillText('engine recharging', x + 110, y); }

  y += 22;
  ctx.fillStyle = '#8fa8cc'; ctx.fillText('BLOOM', x, y);
  // in a row on a wide screen; on a narrow one (a phone held upright) one planet per line, a neat column,
  // since wrapping a row left them ragged
  const column = W < 560;
  let gx = x + 60;
  if (column) {  // names on the left, percentages lined up on the right
    const pctX = x + 60 + Math.max(...gardens.map(b => ctx.measureText(b.name).width)) + 12 + ctx.measureText('100%').width;
    gardens.forEach((b, i) => {
      if (i > 0) y += 18;
      ctx.fillStyle = bodyColor(b);
      ctx.fillText(b.name, gx, y);
      if (b.needs && !b.pollinated) ctx.fillText(`needs ${b.needs}`, pctX - ctx.measureText('100%').width, y);
      else { ctx.textAlign = 'right'; ctx.fillText(`${Math.round(bloomOf(b) * 100)}%`, pctX, y); ctx.textAlign = 'left'; }
    });
  } else gardens.forEach(b => {
    const label = b.needs && !b.pollinated ? `${b.name} needs ${b.needs}` : `${b.name} ${Math.round(bloomOf(b) * 100)}%`, w = ctx.measureText(label).width;
    if (gx + w > W - 20) { gx = x + 60; y += 18; }
    ctx.fillStyle = bodyColor(b);
    ctx.fillText(label, gx, y);
    gx += w + 14;
  });
  y += 22;
  ctx.fillStyle = '#8fa8cc'; ctx.fillText('SYSTEM', x, y);
  ctx.fillStyle = '#cde'; ctx.fillText(String(systemNo), x + 60, y);

  ctx.textAlign = 'center';
  const cardBottom = drawCard(Math.max(H * 0.13, y + 30));
  if (message) {
    const age = time - message.t;
    if (age < 4) {
      ctx.globalAlpha = clamp(4 - age, 0, 1);
      ctx.fillStyle = message.color;
      ctx.font = `${W < 500 ? 15 : 17}px ui-monospace, Consolas, monospace`;
      const my = Math.max(H * 0.16, y + 34, cardBottom + 26);
      wrapText(message.text, W - 40).forEach((l, i) => ctx.fillText(l, W / 2, my + i * 20));
      ctx.globalAlpha = 1;
    }
  }
  if (showHints && TOUCH) {
    ctx.font = '12px ui-monospace, Consolas, monospace';
    ctx.fillStyle = 'rgba(160,180,210,0.6)';
    ctx.fillText('drag anywhere to steer, further to thrust', W / 2, H - 62);
    ctx.fillText('second thumb: brake and land gently', W / 2, H - 44);
    ctx.fillText('lift to coast  ·  ❚❚ for the menu', W / 2, H - 26);
  } else if (showHints) {
    ctx.font = '12px ui-monospace, Consolas, monospace';
    ctx.fillStyle = 'rgba(160,180,210,0.6)';
    // just the essentials; every other key is in the pause menu
    ctx.fillText('← → turn  ·  ↑ thrust  ·  ↓ gentle thrust  ·  land slowly, feet first', W / 2, H - 44);
    ctx.fillText('P or Esc for the menu  ·  H hides these hints', W / 2, H - 26);
  }
  if (paused) drawPauseMenu();
  if (prefs.fps) {
    ctx.textAlign = 'right';
    ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.fillStyle = fpsShown < 45 ? 'rgba(255,170,130,0.75)' : 'rgba(160,180,210,0.45)';
    ctx.fillText(`${Math.round(fpsShown)} fps`, TOUCH ? W - PAUSE_ICON - 16 : W - 14, 14);  // top right, clear of the hints
  }

  if (inputMode === 'mouse') {
    ctx.strokeStyle = 'rgba(190,225,255,0.6)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(mouse.x, mouse.y, 5, 0, TAU); ctx.stroke();
  }
  ctx.restore();
}

// The arrival card: the system's number and bodies, then what's special here, NEW in gold.
// Returns the y of its bottom edge (or 0 when it isn't showing).
function drawCard(top) {
  const f = cardFade();
  if (!f) return 0;
  ctx.save();
  ctx.globalAlpha = f;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = '13px ui-monospace, Consolas, monospace';
  const title = `SYSTEM ${systemNo}  ·  ${gardens.map(b => b.name).join('  ·  ')}`;
  const lines = card.lines, maxW = W - 32;
  const w = Math.min(maxW, Math.max(ctx.measureText(title).width, ...lines.map(l => ctx.measureText(l.text).width + (l.isNew ? 54 : 0) + 18)) + 36);
  // on a narrow screen long lines wrap
  const titleLines = wrapText(title, w - 36), wrapped = lines.map(l => wrapText(l.text, w - 52 - (l.isNew ? 36 : 0)));
  const h = 18 + titleLines.length * 18 + wrapped.reduce((n, ls) => n + ls.length * 18 + 3, 0) + 12, x = W / 2 - w / 2;
  ctx.fillStyle = 'rgba(6,9,22,0.72)';
  ctx.strokeStyle = 'rgba(160,180,230,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(x, top, w, h, 8); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#e8f4ff';
  titleLines.forEach((t, i) => ctx.fillText(t, x + 18, top + 12 + i * 18));
  let ly = top + 20 + titleLines.length * 18;
  lines.forEach((l, i) => {
    ctx.fillStyle = l.isNew ? '#ffd27a' : 'rgba(170,190,225,0.8)';
    ctx.beginPath(); ctx.arc(x + 22, ly + 7, 2.5, 0, TAU); ctx.fill();
    let tx = x + 34;
    if (l.isNew) { ctx.font = 'bold 11px ui-monospace, Consolas, monospace'; ctx.fillText('NEW', tx, ly + 1); tx += 36; ctx.font = '13px ui-monospace, Consolas, monospace'; }
    ctx.fillStyle = l.isNew ? '#f4ecd8' : 'rgba(205,218,240,0.85)';
    wrapped[i].forEach((t, k) => ctx.fillText(t, tx, ly + k * 18));
    ly += wrapped[i].length * 18 + 3;
  });
  ctx.restore();
  return top + h;
}

// While the card is up, new things in the world get a pulsing gold marker so you can find them.
function drawHighlights() {
  const f = cardFade();
  if (!f || !system.newTags || !system.newTags.length) return;
  const t = system.newTags, a = f * (0.35 + 0.3 * Math.sin(performance.now() / 160));
  ctx.save();
  ctx.strokeStyle = `rgba(255,214,130,${a})`;
  ctx.lineWidth = 1.6 * px;
  ctx.setLineDash([6 * px, 6 * px]);
  ctx.lineDashOffset = -performance.now() / 60 * px;
  const ring = (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke(); };
  for (const b of bodies) {
    if (b.kind === 'hole' && t.includes('hole')) ring(b.px, b.py, b.R * 5.2);
    if (b.kind === 'gas' && t.includes('gas')) ring(b.px, b.py, b.R * 2.1);
    if (b.kind === 'crystal' && t.includes('crystal')) ring(b.px, b.py, b.R + 14);
    if (b.needs && t.includes('pollen')) { ring(b.px, b.py, b.R + 16); const d = gardens.find(o => o.name === b.needs); if (d) ring(d.px, d.py, d.R + 16); }
  }
  if (t.includes('rocks')) for (const k of rocks) ring(k.x, k.y, k.R + 9);
  if (t.includes('calm')) for (const c of system.identity.calm) ring(c.x, c.y, c.r);
  if (t.includes('current')) {
    const c = system.identity.current;
    ctx.beginPath(); ctx.arc(0, 0, c.r + c.w + 6, c.a0, c.a0 + c.span); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, c.r - c.w - 6, c.a0, c.a0 + c.span); ctx.stroke();
  }
  ctx.restore();
}

function drawPhotoHint() {
  const age = (performance.now() - photo.at) / 1000;
  if (age > 3) return;
  ctx.save();
  ctx.globalAlpha = clamp(3 - age, 0, 1) * 0.7;
  ctx.fillStyle = '#cfe';
  ctx.font = '12px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('photo mode  ·  scroll to zoom, drag to pan  ·  V to return', W / 2, H - 26);
  ctx.restore();
}

// What we remember about a system when we leave it, for the star map.
function snapshotSystem() {
  return {
    no: systemNo, theme: system.theme, archetype: system.archetype,
    bodies: bodies.map(b => ({ name: b.name, color: b.color, R: Math.round(b.R), kind: b.kind, bloom: Math.round(bloomOf(b) * 100) / 100 })),
  };
}
// The star map: the systems you've passed through as a winding trail, each drawn as a tiny schematic
// (its middle body and its moons in their colours, glowing where they bloomed), ending where you are.
function drawStarMap() {
  ctx.save();
  ctx.fillStyle = 'rgba(3,5,13,0.86)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e8f4ff';
  ctx.font = '300 22px ui-monospace, Consolas, monospace';
  ctx.fillText('S T A R   M A P', W / 2, 54);
  ctx.fillStyle = 'rgba(160,180,210,0.6)';
  ctx.font = '12px ui-monospace, Consolas, monospace';
  ctx.fillText('M to close', W / 2, H - 30);
  const nodes = [...visited, { ...snapshotSystem(), here: true }].slice(-10);
  const first = nodes[0].no, n = nodes.length, unrecorded = first - 1;
  const x0 = W * (unrecorded > 0 ? 0.2 : 0.1), x1 = W * 0.9, step = n > 1 ? (x1 - x0) / (n - 1) : 0;
  const at = i => [n > 1 ? x0 + i * step : W / 2, H * 0.5 + Math.sin(i * 1.3 + 0.5) * H * 0.14];
  if (unrecorded > 0) {  // systems from before the map existed: just faint stars leading in
    ctx.fillStyle = 'rgba(190,205,235,0.35)';
    for (let k = 1; k <= Math.min(unrecorded, 6); k++) { const [x, y] = at(0); ctx.beginPath(); ctx.arc(x - k * 16, y + Math.sin(k) * 6, 1.4, 0, TAU); ctx.fill(); }
    const [x, y] = at(0);
    ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.fillText(unrecorded === 1 ? 'system 1' : `systems 1–${unrecorded}`, x - 64, y - 22);
  }
  ctx.strokeStyle = 'rgba(190,205,235,0.25)';
  ctx.setLineDash([3, 6]);
  ctx.beginPath();
  nodes.forEach((_, i) => { const [x, y] = at(i); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.setLineDash([]);
  const unit = Math.min(1.1, step / 160 || 1.1);
  nodes.forEach((sys, i) => {
    const [x, y] = at(i), centre = sys.bodies[0], moons = sys.bodies.slice(1);
    const rgb = c => c.join(',');
    // the middle body
    const cr = (centre.kind === 'hole' ? 7 : 6 + centre.R * 0.12) * unit;
    if (centre.bloom >= 1) { ctx.fillStyle = `rgba(${rgb(centre.color)},0.25)`; ctx.beginPath(); ctx.arc(x, y, cr * 1.8, 0, TAU); ctx.fill(); }
    ctx.fillStyle = centre.kind === 'hole' ? '#000' : `rgba(${rgb(centre.color)},${0.25 + 0.5 * centre.bloom})`;
    ctx.strokeStyle = `rgba(${rgb(centre.color)},0.9)`;
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(x, y, cr, 0, TAU); ctx.fill(); ctx.stroke();
    if (centre.kind === 'gas' || centre.kind === 'hole') { ctx.beginPath(); ctx.ellipse(x, y, cr * 1.7, cr * 0.45, -0.3, 0, TAU); ctx.stroke(); }
    // its moons around it
    moons.forEach((m, k) => {
      const a = k / moons.length * TAU + i, rr = cr + (10 + k * 5) * unit, mx = x + Math.cos(a) * rr, my = y + Math.sin(a) * rr;
      const r = (1.8 + m.R * 0.08) * unit;
      if (m.bloom >= 1) { ctx.fillStyle = `rgba(${rgb(m.color)},0.3)`; ctx.beginPath(); ctx.arc(mx, my, r * 2.4, 0, TAU); ctx.fill(); }
      ctx.fillStyle = `rgba(${rgb(m.color)},${0.4 + 0.6 * m.bloom})`;
      ctx.beginPath(); ctx.arc(mx, my, r, 0, TAU); ctx.fill();
    });
    ctx.fillStyle = sys.here ? '#e8f4ff' : 'rgba(200,215,240,0.7)';
    ctx.font = '12px ui-monospace, Consolas, monospace';
    ctx.fillText(`${sys.no}  ${(sys.bodies.find(b => b.kind !== 'hole' && b.kind !== 'gas') || centre).name}`, x, y + 48 * unit + 8);
    if (sys.here) {
      ctx.strokeStyle = `rgba(232,244,255,${0.4 + 0.3 * Math.sin(performance.now() / 400)})`;
      ctx.beginPath(); ctx.arc(x, y, cr + 34 * unit, 0, TAU); ctx.stroke();
      ctx.fillStyle = 'rgba(200,215,240,0.6)';
      ctx.font = '11px ui-monospace, Consolas, monospace';
      ctx.fillText('you are here', x, y - 46 * unit - 6);
    }
  });
  ctx.restore();
}

// ===== Main loop (fixed physics step, render every frame) =====
let last = performance.now(), acc = 0, fpsSmooth = 60, fpsShown = 60, fpsTimer = 0;
const MIN_FRAME_MS = 1000 / 120 - 0.5;  // a hard cap at 120 fps (faster screens skip frames)
function frame(t) {
  if (t - last < MIN_FRAME_MS) { requestAnimationFrame(frame); return; }
  const raw = (t - last) / 1000, dt = Math.min(0.1, raw);
  last = t;
  if (raw > 0) fpsSmooth += (1 / raw - fpsSmooth) * 0.05;
  fpsTimer -= raw;
  if (fpsTimer <= 0) { fpsShown = fpsSmooth; fpsTimer = 0.5; }  // update the readout twice a second so it's legible
  // on a phone, a few seconds below 45 fps while playing drops the resolution to 1.5x
  if (TOUCH && !lowRes && !paused && !title) {
    lowFps = fpsSmooth < 45 ? lowFps + raw : 0;
    if (lowFps > 4) { lowRes = true; resize(); }
  }
  if (!paused && !title) {
    acc += dt;
    while (acc >= STEP) { update(STEP); acc -= STEP; }
    updateCamera(dt);
  }
  frameNo++;
  render();
  updateEngineSound();
  requestAnimationFrame(frame);
}

resize();
const savedGame = loadSave();
if (savedGame) {
  visited = savedGame.visited || [];
  try { enterSystem(savedGame.systemNo, savedGame); } catch (e) { enterSystem(1); }
} else enterSystem(1);
requestAnimationFrame(frame);

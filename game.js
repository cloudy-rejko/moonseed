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
// Lab build (index.html?lab): a playtest run through the newest features, one per system, with its own save
// and preferences so it never touches a real game.
const LAB = new URLSearchParams(location.search).has('lab');
const PREFS_KEY = LAB ? 'moonseed.lab.prefs' : 'moonseed.prefs';
// Player preferences that aren't physics.
const prefs = { ship: -1, autoZoom: true, orbits: 1, fps: false };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch (e) { /* storage blocked */ }
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* storage blocked */ }
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
const SAVE_KEY = LAB ? 'moonseed.lab.save' : 'moonseed.save.v1';

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
  // two small suns, one warm and one cool, dancing round each other in the middle. They ride rails like
  // everything else, so their pull swings round with them and the dotted line is the tool here. The garden
  // moons are kept wide of the pair (three times its separation and more), where the field is nearly calm.
  binary() {
    const m1 = rand(0.54, 0.64), m2 = rand(0.46, 0.56), M = m1 + m2, d = rand(68, 80), a = rand(0, TAU);
    const defs = [
      { kind: 'sun', R: rand(14, 16), mass: m1, orbit: d * m2 / M, start: a, omegaMass: M, omegaDist: d, tint: pick(['255,214,150', '255,196,140', '255,228,172']) },
      { kind: 'sun', R: rand(11, 13), mass: m2, orbit: d * m1 / M, start: a + Math.PI, omegaMass: M, omegaDist: d, tint: pick(['178,214,255', '196,192,255', '170,236,255']) },
    ];
    const count = Math.random() < 0.5 ? 2 : 3, inner = d * 3.1, gap = (425 - inner) / count;
    for (let i = 0; i < count; i++) {
      const R = rand(17, 26);
      defs.push({ R, mass: moonMass(R) * 1.3, orbit: inner + gap * (i + 0.5) + rand(-0.1, 0.1) * gap, start: rand(0, TAU), dir: i === count - 1 && Math.random() < 0.3 ? -1 : 1 });
    }
    return { defs, centralMass: M, innerR: d * 2.4 };
  },
  // a neutron star in the middle: tiny and white-hot, with a pull far beyond its size, two pulsar beams sweeping
  // round and a faint ring of bent light. A slingshot playground: a close pass whips you round hard. Too dense
  // to land on (touch it and it pushes you off); its garden moons keep well clear. (Lab only for now.)
  neutron() {
    const defs = [{ kind: 'neutron', R: rand(5, 7), mass: rand(0.7, 0.8), orbit: 0, tint: pick(['214,232,255', '200,224,255', '226,236,255']) }];
    [[rand(200, 215), rand(20, 26)], [rand(290, 310), rand(16, 22)], [rand(385, 410), rand(20, 26)]].forEach(([orbit, R], i) => {
      defs.push({ R, mass: moonMass(R) * 1.3, orbit, start: rand(0, TAU), dir: i === 1 && Math.random() < 0.3 ? -1 : 1 });
    });
    return { defs, innerR: 110 };
  },
};
const LAB_ONLY = [];  // archetypes the player only meets in the lab (none now)
// How often each layout and feature comes up, against 1 for the rest: the neutron star is a rare wonder (about
// 1 system in 25), and the rogue planet a treat rather than a regular (about 1 in 12).
const ARCHETYPE_WEIGHT = { neutron: 0.4 };
const FEATURE_WEIGHT = { rogue: 0.6 };
function pickWeighted(list, weights, rnd = Math.random) {
  const w = list.map(k => weights[k] ?? 1), total = w.reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (let i = 0; i < list.length; i++) { r -= w[i]; if (r <= 0) return list[i]; }
  return list[list.length - 1];
}

// What makes a system feel like its own place, beyond its layout and colours: the colour of its sun (and
// sometimes a second one), one far landmark in the sky, how its stardust is laid out, and one slow
// ambient event. Old saves without one get one picked from their system number, so it stays the same.
const SUN_TINTS = ['255,236,200', '255,205,165', '195,222,255', '255,195,222', '255,222,150'];
function pickIdentity(rnd, defs, innerR, force = {}) {
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
    ...pickFeature(rnd, lanes, innerR, force.feature, force.legacy),
  };
}
// One thing to play with per system: a pollen errand, a solar-wind current to ride, calm clouds that
// settle you into an orbit, asteroids to bump and crack open, or seed pods to tow. (Pollen is wired up in
// generateSystem; the pods are spawned in enterSystem.) Or a rogue planet wandering through now and then
// (its name and colour are picked in rollSystem), or solar gusts sweeping through (see Solar gusts). Old saves
// without an identity re-roll theirs from their system number, from the list as it was before the rogue
// planet, so they keep the feature they had.
function pickFeature(rnd, lanes, innerR, forced, legacy = false) {
  const list = legacy ? ['pollen', 'current', 'calm', 'rocks', 'tow', null] : ['pollen', 'current', 'calm', 'rocks', 'tow', 'rogue', 'gust', null];
  let feature = forced !== undefined ? forced : pickWeighted(list, FEATURE_WEIGHT, rnd);
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
  if (LAB) return labSystem(n, prev);
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
// ===== Lab =====
// Each new feature registers a system that shows it off: { name, desc, make(n, prev) -> a rolled system }.
// The lab runs through them in order (L or the pause menu skips ahead), starting with plenty of seeds.
const LAB_SYSTEMS = [];
// (in playtest order; each starts with its feature in view, and its desc says what to do in two short lines)
LAB_SYSTEMS.push(
  {
    name: 'Seed lob', make: (n, prev) => labRoomyMoon(n, prev, 'classic', null),
    desc: 'Drag back from the ship like a slingshot (or hold E, arrows aim) and let go: a pod of a tenth of your seeds sows where the arc lands',
    // landed on the home planet right under the big moon (it moves on as you aim), seeds kept for throwing
    setup() {
      const h = gardens[0], m = bodies[1], la = Math.atan2(m.py - h.py, m.px - h.px);
      Object.assign(ship, { landed: h, landAngle: la, angle: la, vx: 0, vy: 0, holdSeeds: true, tow: null });
      ship.seeds = Math.max(ship.seeds, 300);  // a full hold, so the pods are full too
      parkShip();
    },
  },
  {
    name: 'Light traces', make: (n, prev) => labRoomyMoon(n, prev, 'heavy', null),
    desc: 'Hands off: finish this lap round the moon and it lights up as a ring. Swing close past a body for an arc',
    // a near-circular orbit round the heavy moon, most of a hands-off lap already flown (the tracker is fed the
    // stretch behind you), so the ring closes a few seconds in
    setup() {
      const m = bodies[2], d = m.R + 28, a = m.angle + Math.PI / 2, v = Math.sqrt(m.gm / d) * -m.dir, sense = Math.sign(v) || 1;
      Object.assign(ship, {
        landed: null, x: m.px + Math.cos(a) * d, y: m.py + Math.sin(a) * d, vx: m.pvx - Math.sin(a) * v, vy: m.pvy + Math.cos(a) * v,
        angle: a, angVel: 0, holdSeeds: false, airborne: true, tow: null,
      });
      trackReset(shipTrack, m);
      for (let f = 0.8; f > 0; f -= 0.01) {
        const aa = a - sense * f * TAU;
        trackStep(shipTrack, { x: m.px + Math.cos(aa) * d, y: m.py + Math.sin(aa) * d }, m, false);
      }
      cam.focus = m;
    },
  },
  {
    name: 'Make a moon', make: (n, prev) => labRoomyMoon(n, prev, 'classic', 'rocks'),
    desc: 'Bump the rock gently toward the moon. The dashed ellipse is its orbit: once the moon catches it, it rounds out into a moon',
    // a rock trailing the big moon on its orbit just out of its reach (drifting back, so it needs a nudge),
    // already marked as nudged so its ellipse shows, the ship just behind
    setup() {
      const m = bodies[1];
      m.angle = 0.3; updateBodies(0);  // (to the right of the planet, clear of the arrival card at the top)
      // along its orbit (not the straight tangent, which would leave the rock crossing it), circling as the moon does
      const cx = m.px - Math.cos(m.angle) * m.orbit, cy = m.py - Math.sin(m.angle) * m.orbit;
      const at = (back, out) => {
        const a = m.angle - m.dir * back / m.orbit, r = m.orbit + out, v = Math.sqrt(homeGM() / r) * m.dir;
        return [cx + Math.cos(a) * r, cy + Math.sin(a) * r, -Math.sin(a) * v, Math.cos(a) * v, a + m.dir * Math.PI / 2];
      };
      const [rx, ry, rvx, rvy] = at(m.holdR * HOLD_CATCH + 14, 6);
      rocks = rocks.filter(k => !k.lab);
      addRock(rx, ry, rvx, rvy, 9);
      Object.assign(rocks[rocks.length - 1], { lab: true, nudged: true });
      const [sx, sy, svx, svy, sa] = at(m.holdR * HOLD_CATCH + 42, 8);
      Object.assign(ship, { landed: null, x: sx, y: sy, vx: svx, vy: svy, angle: sa, angVel: 0, holdSeeds: false, airborne: true });
      cam.focus = m;
    },
  },
  {
    name: 'Catch and tow', make: (n, prev) => labRoomyMoon(n, prev, 'classic', 'tow'),
    desc: 'A seed pod drifts just ahead. Ease close till its ring glows, match speed to hook it, swing it into a garden to burst it',
    // the ship on a circular orbit between the planet and its first moon, a pod a little way ahead on it
    setup() {
      const h = gardens[0], r = h.R + 100, a = bodies[1].angle + Math.PI, v = Math.sqrt(homeGM() / r);
      const x = Math.cos(a) * r, y = Math.sin(a) * r, vx = -Math.sin(a) * v, vy = Math.cos(a) * v;
      Object.assign(ship, { landed: null, x, y, vx, vy, angle: a + Math.PI / 2, angVel: 0, holdSeeds: false, airborne: true, tow: null });
      // straight ahead along your heading with your velocity, so it drifts only slowly away
      const p = pods[0] || spawnPod();
      Object.assign(p, { x: x + vx / v * 70, y: y + vy / v * 70, vx, vy, born: time - 2 });  // (already faded in)
    },
  },
  {
    name: 'Spinning world', make: (n, prev) => rollSystem(n, prev, { archetype: 'classic', feature: null, spin: 0 }),
    desc: 'You drop straight onto a fast-spinning world and skid. Take off, then land moving with the ground for a soft touchdown',
    // just above the ground, upright and falling straight down (so across the moving ground): a skid a second in
    setup() {
      const h = gardens[0], la = -Math.PI / 2, g = h.gm / (h.R + FOOT) ** 2, alt = Math.min(30, 16 * 16 / (2 * g)), r = h.R + FOOT + alt;
      Object.assign(ship, { landed: null, x: h.px + Math.cos(la) * r, y: h.py + Math.sin(la) * r, vx: h.pvx, vy: h.pvy, angle: la, angVel: 0, slide: null, holdSeeds: true, airborne: true, tow: null });
      cam.focus = h;
    },
  },
  {
    name: 'Thick air', make: (n, prev) => rollSystem(n, prev, { archetype: 'classic', feature: null, air: 0 }),
    desc: 'A fast pass skims the air and drops into orbit. At its high point, a tap of thrust lifts the low point clear of the air',
    // a fast unpowered pass (over escape speed) dipping into the top of the air: the shallowest one the dotted
    // line shows leaving the air bound, on an orbit that swings out no further than the outer moons
    setup() {
      const h = gardens[0], gm = h.gm, r0 = 330, a = bodies[1].angle + Math.PI * 0.8, v0 = 1.1 * Math.sqrt(2 * gm / r0), top = h.R * h.air;
      const place = f => {
        const rp = h.R + (top - h.R) * f, vp = Math.sqrt(v0 * v0 + 2 * gm * (1 / rp - 1 / r0)), vt = rp * vp / r0, vr = -Math.sqrt(Math.max(0, v0 * v0 - vt * vt));
        const ux = Math.cos(a), uy = Math.sin(a);
        Object.assign(ship, { landed: null, x: h.px + ux * r0, y: h.py + uy * r0, vx: h.pvx + ux * vr - uy * vt, vy: h.pvy + uy * vr + ux * vt, angle: a + Math.PI / 2, holdSeeds: false, airborne: true, tow: null, slide: null });
      };
      const captured = p => {  // leaving the air on the predicted path, is it bound, and how far out will it swing?
        if (p.impact) return false;
        const P = p.pts, n = P.length / 2;
        let i = 0;
        while (i < n - 1 && Math.hypot(P[2 * i], P[2 * i + 1]) > top) i++;
        while (i < n - 1 && Math.hypot(P[2 * i], P[2 * i + 1]) <= top) i++;
        if (i >= n - 1) return false;
        const r = Math.hypot(P[2 * i], P[2 * i + 1]), v = Math.hypot(P[2 * i + 2] - P[2 * i], P[2 * i + 3] - P[2 * i + 1]) * 15, E = v * v / 2 - gm / r;
        return E < 0 && -gm / E - r < ARENA_R - 100;
      };
      let best = 0.8;
      for (let f = 0.98; f > 0.5; f -= 0.004) { place(f); if (captured(predict())) { best = f; break; } }
      place(best);
    },
  },
  {
    name: 'Geysers',
    make: (n, prev) => {
      const sys = rollSystem(n, prev, { archetype: 'classic', feature: null, geyser: 1 });
      sys.defs = sys.defs.filter(d => d.parent === undefined);
      // the outermost moon, where the planet's pull is weakest, so a puff carries you highest
      const o = sys.defs[sys.defs.length - 1], v = sys.defs[1].vents;
      delete sys.defs[1].vents; delete o.kind;
      Object.assign(o, { R: 20, mass: moonMass(20), vents: v });
      return sys;
    },
    desc: 'Parked on an icy moon\'s vent, it puffs in a moment. Let go and ride it up, then catch the dust it throws',
    // parked right on the first vent, which puffs 2.5 s later
    setup() {
      const m = gardens.find(b => b.vents), v = m.vents[0];
      v.phase = ((-(time + 2.5)) % v.period + v.period) % v.period;
      Object.assign(ship, { landed: m, landAngle: m.spin + v.a, angle: m.spin + v.a, vx: 0, vy: 0, slide: null, holdSeeds: true, tow: null });
      parkShip();
    },
  },
  {
    name: 'Solar gusts', make: (n, prev) => labRoomyMoon(n, prev, 'classic', 'gust'),
    desc: 'The sun glows, then a gust rolls in, then a line of dust you can sweep up. It piles up behind moons. Bloomed gardens shed spores',
    // circling the planet, pointing away from the sun (a moon's tide is too strong here to hold a low orbit
    // round it), and the first front reaching you 4 s in
    setup() {
      const h = gardens[0], r = h.R + 110, a = bodies[1].angle + Math.PI, v = Math.sqrt(homeGM() / r);
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      Object.assign(ship, { landed: null, x, y, vx: -Math.sin(a) * v, vy: Math.cos(a) * v, angle: system.sunAngle + Math.PI, angVel: 0, holdSeeds: false, airborne: true, tow: null });
      const p = x * -Math.cos(system.sunAngle) + y * -Math.sin(system.sunAngle), t0 = time + 4 - (p - gustFrom()) / GUST_SPEED;
      gusts = [t0, t0 + 18, t0 + 36];
    },
  },
  {
    name: 'Dwarf stars', make: (n, prev) => rollSystem(n, prev, { archetype: 'binary', feature: null }),
    desc: 'Two dwarf stars dance in the middle. Fly in close and watch the dotted line bend; touching one pushes you out',
  },
  {
    name: 'Neutron star', make: (n, prev) => rollSystem(n, prev, { archetype: 'neutron', feature: null }),
    desc: 'A neutron star: tiny, with a huge pull. Coast past it close and it whips you round (a bright arc). Touching it pushes you off',
    // at the far end of a narrow orbit well inside the first moon's (110 out, swinging in to 32), so hands off
    // it falls in and whips round every 7 s or so; the dotted line shows it from the start
    setup() {
      const c = bodies[0], gm = c.gm, r0 = 110, rp = 32, a = -2.2, v = Math.sqrt(2 * gm * rp / (r0 * (r0 + rp)));
      const ux = Math.cos(a), uy = Math.sin(a);
      Object.assign(ship, { landed: null, x: c.px + ux * r0, y: c.py + uy * r0, vx: c.pvx - uy * v, vy: c.pvy + ux * v, angle: a + Math.PI, angVel: 0, holdSeeds: false, airborne: true, tow: null, slide: null });
      cam.focus = c;
    },
  },
  {
    name: 'Rogue planet', make: (n, prev) => rollSystem(n, prev, { archetype: 'classic', feature: 'rogue' }),
    desc: 'A rogue planet drifts by overhead, nearly in bloom. Land on it and finish it (or throw a pod): it sails off on a victory lap',
    // it's already drifting when you arrive, on a wandering path that passes close above you some 15 s in
    setup() {
      const b = rogue, h = gardens[0];
      if (!b) return;
      if (b.present) { b.present = false; bodies.splice(bodies.indexOf(b), 1); gardens.splice(gardens.indexOf(b), 1); }
      Object.assign(ship, { landed: h, landAngle: -0.3, angle: -0.3, vx: 0, vy: 0, holdSeeds: true, tow: null, slide: null });  // facing right, clear of the card
      parkShip();
      rogueArrive(b);
      const ux = Math.cos(-0.3), uy = Math.sin(-0.3), sense = pick([-1, 1]), tx = -uy * sense, ty = ux * sense, up = h.R + b.R + 60;
      const x = h.px + ux * (up + 70) - tx * 180, y = h.py + uy * (up + 70) - ty * 180;
      roguePlan(b, i => ({ x, y, h: Math.atan2(ty, tx), w: rogueWander(i, 0.4), bias: 0, bl: 1, k: [1.5, 1.25, 1][i % 3], sail: false }), ROGUE_LANE);
      b.s = 0; b.rate = ROGUE_LANE * b.arc.k;
      rogueMove(b);
      // most of the way to full bloom already, so a short visit (or one pod) sees it sail
      while (b.plants.length < b.maxPlants * 0.8) plantSeed(b, rand(0, TAU));
    },
  },
);
// lab systems with their big moon kept clear of moonlets (so it has room to hold an orbit), no crystal
function labRoomyMoon(n, prev, archetype, feature) {
  const sys = rollSystem(n, prev, { archetype, feature });
  sys.defs = sys.defs.filter(d => d.parent === undefined);
  for (const d of sys.defs) if (d.kind === 'crystal') delete d.kind;
  if (archetype === 'classic') Object.assign(sys.defs[1], { R: 24, mass: moonMass(24), dir: 1 });
  return sys;
}
function labEntry(n) { return LAB_SYSTEMS[(n - 1) % LAB_SYSTEMS.length]; }
function labSystem(n, prev) {
  const e = labEntry(n), sys = e.make(n, prev);
  sys.lab = { name: e.name, desc: e.desc, i: (n - 1) % LAB_SYSTEMS.length + 1, setup: e.setup };
  return sys;
}
function labSkip() {  // warp straight on to the next lab system
  if (!LAB || warp || title) return;
  exit = null; warp = { t: 0, switched: false };
  arpeggio([...SCALE].reverse(), 0.06, 0.07);
}

// force (for the lab): { archetype, feature, identity: {...} } pins those choices instead of rolling them.
function rollSystem(n, prev = {}, force = {}) {
  const kind = force.archetype || (n === 2 ? 'twin' : pickWeighted(Object.keys(ARCHETYPES).filter(k => k !== prev.archetype && !LAB_ONLY.includes(k)), ARCHETYPE_WEIGHT));
  const theme = pick(THEMES.filter(t => t.name !== prev.theme));
  const sys = ARCHETYPES[kind](), names = shuffle(NAMES.slice());
  let ni = 0;
  for (const d of sys.defs) { if (!d.anchor) d.name = names[ni++]; d.start = d.start ?? 0; }
  // now and then one moon is a crystal: faceted, growing glinting shards instead of plants
  const moons = sys.defs.filter((d, i) => i > 0 && !d.anchor && !d.kind && d.R >= 12 && d.R <= 26);
  if (moons.length && Math.random() < 0.35) pick(moons).kind = 'crystal';
  // suns (and neutron stars) wear their own light, not the theme's colours
  paint(sys.defs.filter(d => !d.tint), theme);
  for (const d of sys.defs) if (d.tint) { d.color = d.tint.split(',').map(Number); d.accents = [d.tint]; delete d.tint; }
  const home = sys.defs[0], identity = { ...pickIdentity(Math.random, sys.defs, sys.innerR ?? home.R + 40, force), ...force.identity };
  if (kind === 'binary') Object.assign(identity, { sun: sys.defs[0].color.join(','), sun2: null, sun2Tint: null });  // the light comes from the pair
  // Now and then one garden spins fast (land with the spin) or a big planet wears thick air (skim it to slow
  // down): one of the two at most, and neither on top of a binary sun and a rogue planet, so it stays calm.
  // (The lab only gets them where an entry asks.)
  const busy = (kind === 'binary') + (identity.feature === 'rogue');
  const extra = force.spin !== undefined ? 'spin' : force.air !== undefined ? 'air' : force.geyser !== undefined ? 'geyser'
    : LAB || busy >= 2 ? null : pick(['spin', 'air', 'geyser', null, null, null, null]);
  if (extra === 'spin') {
    const can = sys.defs.filter(d => !d.anchor && !d.kind && d.R >= 16);
    const d = force.spin !== undefined ? sys.defs[force.spin] : can.length ? pick(can) : null;
    // the ground moves at 20-28 units a second (a moon's no faster than about a turn in 11 s)
    if (d) { d.fast = true; d.spinRate = Math.min(rand(20, 28) / (d.R + FOOT), 0.55) * (Math.random() < 0.75 ? d.dir || 1 : -(d.dir || 1)); }
  } else if (extra === 'air') {
    const can = sys.defs.filter(d => !d.anchor && !d.kind && d.R >= 30);
    const d = force.air !== undefined ? sys.defs[force.air] : can.length ? pick(can) : null;
    if (d) d.air = rand(2, 2.4);  // the top of the air, in body radii (a thin shell barely mattered in play)
  } else if (extra === 'geyser') {
    // an icy moon with two or three vents, spread round it, each puffing on its own beat (see Geysers)
    // (one of the two with the most room above them before the planet's pull takes over, so a puff can carry
    // you a fair way and still bring you back down)
    const room = d => (d.parent === undefined ? d.orbit : 0) * Math.cbrt(d.mass) / d.R;
    const can = sys.defs.filter((d, i) => i > 0 && !d.anchor && !d.kind && d.R >= 12 && d.R <= 26).sort((a, b) => room(b) - room(a)).slice(0, 2);
    const d = force.geyser !== undefined ? sys.defs[force.geyser] : can.length ? pick(can) : null;
    if (d) {
      delete d.kind;  // (not a crystal: the lab can pin one)
      // vents at random spots (evenly spaced, two always sat exactly opposite), at least ~50° apart
      const n = Math.random() < 0.5 ? 2 : 3, angles = [];
      for (let tries = 0; angles.length < n && tries < 200; tries++) {
        const a = rand(0, TAU);
        if (angles.every(b => Math.abs(angleDiff(a, b)) > 0.9)) angles.push(a);
      }
      d.vents = angles.map(a => { const period = rand(4, 7); return { a, period, phase: rand(0, period) }; });
    }
  }
  // a rogue planet: its own name, and the theme colour fewest bodies here wear. (Round a black hole or a gas
  // giant the orbits leave it no open lane to linger in, so those get seed pods instead.)
  if (identity.feature === 'rogue' && (kind === 'hole' || kind === 'gas')) identity.feature = 'tow';
  if (identity.feature === 'rogue') {
    const wearing = c => sys.defs.filter(d => d.color && d.color.join() === c.join()).length;
    const base = theme.colors.slice().sort((a, b) => wearing(a) - wearing(b))[0];
    identity.rogue = {
      name: names[ni], R: rand(15, 19), color: base.map(v => Math.round(mix(v, 255, wearing(base) ? 0.5 : 0.15))),
      accents: [...theme.colors.filter(c => c !== base).map(c => c.join(',')), ...(theme.extra || []), '255,250,230'],
    };
  }
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
const GAMEPLAY_TAGS = ['hole', 'gas', 'crystal', 'pollen', 'current', 'calm', 'rocks', 'tow', 'shower', 'binary', 'rogue', 'spin', 'air', 'geyser', 'neutron'];
// listed on the arrival card, but never marked NEW: nice to notice, not worth a fanfare
const QUIET_TAGS = ['gust'];
function systemTags(defs, id) {
  const tags = [];
  for (const k of ['hole', 'gas', 'crystal', 'neutron']) if (defs.some(d => d.kind === k)) tags.push(k);
  if (defs.some(d => d.kind === 'sun')) tags.push('binary');
  if (defs.some(d => d.fast)) tags.push('spin');
  if (defs.some(d => d.air)) tags.push('air');
  if (defs.some(d => d.vents)) tags.push('geyser');
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
    neutron: `${named('neutron')} is a neutron star: tiny, with a huge pull. Swing close past it to be whipped round`,
    gas: `${named('gas')} is a gas giant with no ground: dive through its clouds. Its moons are the gardens`,
    crystal: `${named('crystal')} is a crystal moon. Seeds grow into chiming crystals`,
    pollen: needer ? `${needer.name} only grows with pollen from ${needer.needs}. Grow ${needer.needs} a little, then fly its pollen over` : 'A pollen errand',
    current: 'A solar wind blows along the bright band. Fly with it for a free boost',
    calm: 'Calm clouds: fly into the fog to settle into a smooth orbit',
    rocks: LAB ? 'Asteroids to bump, crack, or nudge into orbit as a new moon' : 'Asteroids to bump and crack open',  // (a made moon is an easter egg)
    tow: 'Seed pods drift here. Match their speed to hook one, then swing it into a garden to burst it',
    binary: 'Two dwarf stars dance in the middle. Their pull swings round as they turn: trust your dotted line',
    rogue: `A rogue planet, ${(system.identity.rogue || {}).name}, wanders through now and then. Land on it and plant it: in bloom it blasts off on its flower engine`,
    spin: `${(gardens.find(b => b.fast) || {}).name} is a fast-spinning world: land with the spin`,
    air: `${(gardens.find(b => b.air) || {}).name} is wrapped in thick air: skim it to slow down`,
    geyser: `${(gardens.find(b => b.vents) || {}).name} is an icy moon with geysers: ride a puff, catch the dust`,
    gust: "Solar gusts: a line of dust follows each one, and drifts pile up behind the moons",
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
function showCard(delay = 0) {  // delay: seconds to hold it back, so a new system gets a clean first look
  const tags = systemTags(allBodies, system.identity);
  if (!system.newTags) {  // what was new the first time we looked, so pressing I later still shows it
    const seen = new Set(prefs.seen || []);
    system.newTags = tags.filter(t => !seen.has(t) && !QUIET_TAGS.includes(t));
    prefs.seen = [...new Set([...seen, ...tags])];
    savePrefs();
  }
  const rank = t => (system.newTags.includes(t) ? 0 : 2) + (GAMEPLAY_TAGS.includes(t) ? 0 : 1);
  const lines = tags.slice().sort((a, b) => rank(a) - rank(b)).slice(0, 5)
    .map(t => ({ tag: t, text: describeTag(t), isNew: system.newTags.includes(t) }));
  if (system.lab) lines.unshift({ tag: 'lab', text: `LAB ${system.lab.i}/${LAB_SYSTEMS.length}  ${system.lab.name}: ${system.lab.desc}  (L skips on)`, isNew: true });
  card = { at: performance.now() + delay * 1000, lines };
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

let allBodies = [], bodies = [], gardens = [], airy = [], geysers = [], systemNo = 1, system = null;  // airy: gardens with thick air; geysers: moons with vents
// `saved` restores a system from the autosave (body list with angles and plants).
function buildSystem(n, saved = null) {
  systemNo = n;
  const prev = system ? { archetype: system.archetype, theme: system.theme } : {};
  if (saved && !THEMES.some(t => t.name === saved.theme)) saved = retheme(saved);  // older palettes
  const sys = saved ? { ...saved, defs: saved.bodies } : n === 1 && !LAB ? FIRST_SYSTEM : generateSystem(n, prev);
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
  // the two halves of a twin pair (twin planets, twin moons) know each other
  for (const b of allBodies) b.twin = b.omegaDist ? allBodies.find(o => o !== b && !o.anchor && o.omegaDist === b.omegaDist && o.parent === b.parent) || null : null;
  bodies = allBodies.filter(b => !b.anchor);
  // black holes and gas giants can't be landed on or planted. A black hole pulls hard, but its pull is
  // softened inside its disk.
  // Suns are too bright to land on, and neutron stars too dense: they bounce you off. A neutron star's pull is
  // softened inside the reach where it pushes you off, so nothing passing through its middle goes absurdly fast.
  for (const b of bodies) {
    b.barren = b.kind === 'hole' || b.kind === 'gas' || b.kind === 'sun' || b.kind === 'neutron';
    b.softR = b.kind === 'hole' ? b.R * 1.8 : b.kind === 'neutron' ? b.R + FOOT : b.R;
  }
  gardens = bodies.filter(b => !b.barren);
  airy = gardens.filter(b => b.air);
  geysers = gardens.filter(b => b.vents);
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
    lab: sys.lab || null,
  };
  system.hole = bodies.find(b => b.kind === 'hole') || null;
  system.binary = bodies.some(b => b.kind === 'sun');
  for (const b of bodies) b.holdR = holdRadius(b);  // which moons can hold an asteroid (see makeMoon)
  setMusic(system.theme);
  system.identity = sys.identity || (n === 1 ? FIRST_IDENTITY : pickIdentity(seededRandom(n * 7717 + 3), sys.defs, system.innerR, { legacy: true }));
  if (system.identity.sun2 === undefined) system.identity.sun2 = null;
  rogue = system.identity.feature === 'rogue' && system.identity.rogue ? makeRogue(system.identity.rogue, saved && saved.rogue) : null;
  // theme-derived colours: background wisps, stardust (tinted with the lead colour)
  const theme = THEMES.find(t => t.name === system.theme) || THEMES[0];
  const tint = (c, w) => c.map(v => Math.round(mix(v, 255, w))).join(',');
  system.palette = theme.colors;
  system.night = [1, 3, 5].map(i => Math.round(Math.min(255, parseInt(system.nebula[0].slice(i, i + 2), 16) * 2.4))).join(',');
  system.dustHalo = tint(theme.colors[0], 0.3);
  system.dustCore = tint(theme.colors[0], 0.75);
  updateBodies(0);
}

const homeGM = () => cfg.gravity * system.centralMass;
// Positions/velocities "now" are cached on each body every physics step (px, py, pvx, pvy);
// these compute them `ahead` seconds into the future for the trajectory preview.
function bodyPos(b, ahead = 0) {
  if (!ahead) return [b.px, b.py];
  if (b.rogue) return [b.px + b.pvx * ahead, b.py + b.pvy * ahead];  // (a rogue planet's own path is stepped in predict)
  if (!b.orbit) return [0, 0];
  const a = b.angle + b.omega * ahead;
  let x = Math.cos(a) * b.orbit, y = Math.sin(a) * b.orbit;
  if (b.parent) { const [px, py] = bodyPos(b.parent, ahead); x += px; y += py; }
  return [x, y];
}
function bodyVel(b, ahead = 0) {
  if (!ahead || b.rogue) return [b.pvx, b.pvy];
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
// Each ship is one colour from nose to flame: its lines tinted halfway to its glow, and a flame in its colour
// (pushed away from pastel so it reads as fire) around a white-hot core.
for (const d of SHIPS) {
  const g = [1, 3, 5].map(i => parseInt(d.glow.slice(i, i + 2), 16));
  d.line ??= `rgb(${g.map((v, i) => Math.round((v + [238, 247, 255][i]) / 2)).join(',')})`;
  d.plume ??= [
    g.map(v => Math.max(0, Math.round(255 - (255 - v) * 1.7))).join(','),
    g.join(','),
    '255,255,250',
  ];
}
// The pick is saved by name; older saves kept its place in the original four-ship lineup.
{
  const name = prefs.shipName ?? ['Arrow', 'Notch', 'Swallow', 'Kite'][prefs.ship];
  prefs.ship = Math.max(0, SHIPS.findIndex(d => d.name === name));
}
// Draw the chosen ship at the current transform (already rotated and scaled).
// A ship can set its own plume (outer flame, inner flame, core, as 'r,g,b') and hull line colour; the
// default is a warm orange flame and white lines.
const PLUME = ['255,150,70', '255,220,150', '255,255,240'];
function drawHull(design, throttle, lineWidth) {
  if (throttle > 0.02) {
    const [outer, inner, core] = design.plume || PLUME;
    // a layered plume: a soft warm glow, a flickering flame with a swaying tip and a white-hot core
    const t = throttle, len = (8 + 20 * t) * rand(0.85, 1.1);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const gy = 6 + len * 0.3, gr = len * 0.7;
    const glow = ctx.createRadialGradient(0, gy, 0, 0, gy, gr);
    glow.addColorStop(0, `rgba(${outer},${0.22 * t})`); glow.addColorStop(1, `rgba(${outer},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(0, gy, gr, 0, TAU); ctx.fill();
    const lick = (w, l, c0, c1) => {  // a teardrop of flame, w wide at the nozzle and l long
      const g = ctx.createLinearGradient(0, 5, 0, 5 + l);
      g.addColorStop(0, c0); g.addColorStop(1, c1);
      ctx.fillStyle = g;
      const tip = rand(-0.5, 0.5) * w;
      ctx.beginPath(); ctx.moveTo(-w, 5);
      ctx.quadraticCurveTo(-w * 1.2, 5 + l * 0.45, tip, 5 + l);
      ctx.quadraticCurveTo(w * 1.2, 5 + l * 0.45, w, 5);
      ctx.closePath(); ctx.fill();
    };
    lick(3.1, len, `rgba(${outer},${0.5 * t})`, `rgba(${outer},0)`);
    lick(2.0, len * 0.7, `rgba(${inner},${0.75 * t})`, `rgba(${outer},0)`);
    lick(0.8, len * 0.3, `rgba(${core},${0.85 * t})`, `rgba(${inner},0)`);
    ctx.restore();
  }
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = design.line || '#eef7ff'; ctx.shadowColor = design.glow; ctx.shadowBlur = 14;
  ctx.beginPath(); design.hull(); ctx.stroke();
  ctx.fillStyle = design.glow;
  ctx.beginPath(); design.detail(); ctx.fill();
}

// ===== Sound (synthesized, no files) =====
let actx = null, master = null, fxSend = null, engine = null, scrape = null, noiseBuf = null, muted = false;
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
    // a skid's scrape: one soft loop of band-passed noise, its volume and pitch following the slip
    const s2 = actx.createBufferSource(), f2 = actx.createBiquadFilter(), g2 = actx.createGain();
    s2.buffer = noiseBuf; s2.loop = true; s2.loopStart = 0.7;  // (out of step with the engine's loop)
    f2.type = 'bandpass'; f2.frequency.value = 900; f2.Q.value = 0.9;
    g2.gain.value = 0;
    s2.connect(f2); f2.connect(g2); g2.connect(master);
    s2.start(0, 0.7);
    scrape = { filter: f2, gain: g2 };
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
  // the scrape fades in and out over a tenth of a second or so, so little hops along the ground don't stutter it
  const slip = muted || paused || title || !ship.slide || !touching(ship) ? 0 : ship.slip || 0;
  scrape.gain.gain.setTargetAtTime(0.06 * smooth(clamp((slip - 1) / 30, 0, 1)), t, slip ? 0.06 : 0.15);
  scrape.filter.frequency.setTargetAtTime(700 + 18 * Math.min(slip, 60), t, 0.1);
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
// (while E aims a seed throw, the arrows adjust the aim instead: see Seed lob)
const fullThrust = () => !keyAim() && (keys.KeyW || keys.ArrowUp || mouse.down);
const gentleThrust = () => !keyAim() && (keys.KeyS || keys.ArrowDown || mouse.right);

function pickShip(i) {
  prefs.ship = i;
  prefs.shipName = SHIPS[i].name;
  savePrefs();
}
function cycleShip(step) {
  pickShip((prefs.ship + step + SHIPS.length) % SHIPS.length);
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
  if (k === 'KeyE' && !paused) { if (!releasePod()) lobBegin('keys'); return; }
  if (k === 'Escape' && keyAim()) { cancelLob(); return; }
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
  else if (k === 'KeyL' && LAB) { paused = false; labSkip(); }
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
// On a keyboard, holding Space does the same.
const brake = { id: null, x: 0, y: 0 };
const brakeHeld = () => brake.id !== null || !!keys.Space;
const braking = () => brakeHeld() && !ship.landed;
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
    if (onTowedPod(x, y)) podTap = { id: t.identifier, x, y, t: performance.now() };
    if (lob && lob.src === 'touch' && t.identifier !== lob.id) { cancelLob(); continue; }  // another finger calls the throw off
    if (joy.id === null && !lob && inShipZone(x, y)) { if (nearShip(x, y)) lobBegin('touch', t.identifier, x, y); continue; }  // the slingshot's zone
    if (joy.id === null && !(lob && lob.src === 'touch')) { joy.id = t.identifier; joy.ox = joy.x = x; joy.oy = joy.y = y; }
    else if (brake.id === null) { brake.id = t.identifier; brake.x = x; brake.y = y; }  // a second thumb brakes
  }
}, { passive: false });
canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === joy.id) { joy.x = t.clientX; joy.y = t.clientY; }
    else if (lob && t.identifier === lob.id) lobDrag(t.clientX, t.clientY);
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
    if (podTap && t.identifier === podTap.id) {
      if (e.type === 'touchend' && performance.now() - podTap.t < 350 && Math.hypot(t.clientX - podTap.x, t.clientY - podTap.y) < 15) releasePod();
      podTap = null;
    }
    if (lob && t.identifier === lob.id) { if (e.type === 'touchend') throwSeed(); else lob = null; }
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
    ...(LAB ? [['L', 'Next lab system', () => keyAction('KeyL')]] : []),
  ];
}
function menuTap(x, y) {
  for (const r of menuRects) if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { r.act(); message = null; return; }
}
function drawPauseMenu() {
  const items = menuItems(), pw = Math.min(W - 32, 480), cols = pw >= 340 ? 2 : 1, bh = 44, gap = 8;
  const bw = (pw - gap * (cols - 1)) / cols, rows = 1 + Math.ceil((items.length - 1) / cols);
  const showH = 116, ph = 56 + rows * (bh + gap) + showH, x0 = W / 2 - pw / 2, y0 = Math.max(70, H / 2 - ph / 2);
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
  // the ships, so you can see what you're picking: the current one bigger, lit and firing
  const sy = y0 + 44 + rows * (bh + gap) + 52, cw = pw / SHIPS.length;
  ctx.fillStyle = 'rgba(10,16,34,0.88)'; ctx.strokeStyle = 'rgba(150,180,230,0.25)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(x0, sy - 52, pw, 104, 8); ctx.fill(); ctx.stroke();
  SHIPS.forEach((d, i) => {
    const cx = x0 + cw * (i + 0.5), on = i === prefs.ship, k = on ? 2.6 : 1.9;
    menuRects.push({ x: cx - cw / 2, y: sy - 52, w: cw, h: 104, act: () => pickShip(i) });
    ctx.save();
    ctx.globalAlpha = on ? 1 : 0.5;
    ctx.translate(cx, sy - 16); ctx.scale(k, k);
    drawHull(d, on ? 0.5 : 0, 2 / k);
    ctx.restore();
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
  if (!brakeHeld() || paused || photo) return;
  const s = ship;
  ctx.save();
  ctx.fillStyle = s.landed ? 'rgba(255,224,170,0.55)' : 'rgba(255,214,150,0.9)';
  ctx.font = `${11 * px}px ui-monospace, Consolas, monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(s.landed ? 'landed' : 'braking', s.x, s.y - Math.max(30 * px, 25 + 12 * px));  // above the ring of seeds
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
addEventListener('keyup', e => {
  keys[e.code] = false;
  if (e.code === 'KeyE' && lob && lob.src === 'keys') throwSeed();
});
addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
  mouse.down = mouse.right = false; lob = null;
  if (!title) paused = true;
  saveGame();
});
addEventListener('beforeunload', () => saveGame());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  for (const k in keys) keys[k] = false;
  mouse.down = mouse.right = false; joy.id = null; brake.id = null; lob = null;
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
  if (lob && lob.src === 'mouse') lobDrag(e.clientX, e.clientY);
});
canvas.addEventListener('mousedown', e => {
  initAudio();
  mouse.x = e.clientX; mouse.y = e.clientY; inputMode = 'mouse';
  if (title) { if (e.button === 0) startGame(); return; }
  if (photo) { photo.drag = [e.clientX, e.clientY]; return; }
  if (paused && !starMap) { if (e.button === 0) menuTap(e.clientX, e.clientY); return; }
  if (e.button === 0 && onTowedPod(e.clientX, e.clientY)) { releasePod(); return; }
  if (e.button === 0 && !lob && nearShip(e.clientX, e.clientY) && lobBegin('mouse', null, e.clientX, e.clientY)) return;
  if (e.button === 2 && lob && lob.src === 'mouse') { cancelLob(); return; }
  if (e.button === 0) mouse.down = true;
  if (e.button === 2) mouse.right = true;
});
addEventListener('mouseup', e => {
  if (photo) photo.drag = null;
  if (e.button === 0 && lob && lob.src === 'mouse') throwSeed();
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
  if (systemNo > 1 || LAB) showCard(1.5);  // (the lab's first system has a card to show too)
}

function reset() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* storage blocked */ }
  visited = []; seedMark = 0;
  enterSystem(1);
  say('Gather stardust. Land gently to plant it.');
}

function enterSystem(n, saved = null) {
  buildSystem(n, saved);
  const la = -Math.PI / 2;  // start parked on top of the home planet
  ship = {
    x: 0, y: 0, vx: 0, vy: 0, angle: la, angVel: 0, throttle: 0, emitAcc: 0,
    fuel: FUEL_MAX, empty: false, seeds: saved ? saved.seeds || 0 : 0,
    landed: gardens[0], landAngle: la, tumble: 0, plantTimer: 0, snapping: false, pollen: null, tow: null,
    sailOpen: 0, sailPush: 0,  // the solar sail (gust systems only, opening by itself in a gust): how far out, its push
    holdSeeds: true,  // starting on a planet doesn't plant your seeds there: take off and land first
  };
  if (LAB) ship.seeds = Math.max(ship.seeds, 40);
  if (saved) seedMark = Math.floor(ship.seeds / SEED_MILESTONE) * SEED_MILESTONE;  // a reload doesn't re-announce
  parkShip();
  motes = []; comets = []; particles = []; fireflies = []; rocks = []; rockTimer = 0; waves = []; allBloomedAt = -99; card = null;
  traces = []; shipTrack = newTrack();
  lob = null; lobbed = []; sowing = []; pods = []; podTimer = POD_RESPAWN;
  if (system.identity.feature === 'rocks') for (let i = 0; i < 4; i++) spawnRock();
  if (system.identity.feature === 'tow') for (let i = 0; i < 2; i++) spawnPod();  // not saved: fresh pods each visit
  gusts = []; spores = [];  // not saved either: the first gust comes a little while after you arrive
  if (system.identity.feature === 'gust') { gusts.push(time + rand(8, 13)); while (gusts.length < 3) gusts.push(gusts[gusts.length - 1] + rand(...GUST_GAP)); }
  system.arrivedAt = time;
  chain = 0; lastPickup = -10; chainPopup = null;
  streamTimer = 0; cometTimer = Math.min(30, system.comet[0]); ringTimer = 0; fireflyTimer = 0; saveTimer = 5;
  allBloomed = gardens.every(b => b.bloomed || b.made || b.rogue);  // a moon you made (or a rogue planet) is a bonus garden, never a chore
  // older saves stored a gate position; its direction becomes the exit lane
  const savedExit = saved ? saved.exit ?? (saved.gate ? Math.atan2(saved.gate[1], saved.gate[0]) : null) : null;
  exit = null;
  if (allBloomed) openExit(savedExit ?? undefined);
  warp = null;
  cam.focus = gardens[0];
  for (let i = 0; i < (system.identity.dust === 'belt' ? 7 : 4); i++) spawnStream();
  if (system.ring) for (let i = 0; i < RING_MOTES; i++) spawnRingMote();
  if (!saved) labSetup();
}
// a lab entry can place things to show its feature off (runs again after the warp's arrival)
function labSetup() { if (system.lab && system.lab.setup) system.lab.setup(); }

// ===== Saving =====
function saveGame() {
  if (!ship || warp) return;
  const r = (v, d) => Math.round(v * d) / d;
  const data = {
    systemNo, seeds: ship.seeds + lobbed.reduce((n, m) => n + (m.fade ? 0 : m.n), 0) + sowing.reduce((n, w) => n + w.left, 0), visited,  // seeds in flight or still sowing go back in the bag
    exit: exit ? r(exit.angle, 1000) : null,
    rogue: rogue ? rogueSave(r) : undefined,
    nebula: system.nebula, ring: system.ring, theme: system.theme, archetype: system.archetype,
    centralMass: system.centralMass, innerR: system.innerR, comet: system.comet, sunAngle: system.sunAngle, identity: system.identity,
    lab: system.lab || undefined,
    bodies: allBodies.map(b => ({
      name: b.name, R: b.R, mass: b.mass, orbit: b.orbit, start: b.start, dir: b.dir,
      anchor: b.anchor || undefined, kind: b.kind, tilt: b.tilt, omegaMass: b.omegaMass, omegaDist: b.omegaDist,
      color: b.color, accents: b.accents, parent: b.parent ? allBodies.indexOf(b.parent) : undefined,
      needs: b.needs, pollinated: b.pollinated || undefined, made: b.made || undefined, fast: b.fast || undefined, air: b.air || undefined,
      vents: b.vents ? b.vents.map(v => ({ a: v.a, period: v.period, phase: v.phase })) : undefined,
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
  updateRogue(dt);
  updateGusts(dt);
  updateGeysers(dt);
  updateShip(dt);
  updateShipShapes();
  updateMotes(dt);
  updateComets(dt);
  updateRocks(dt);
  updatePods(dt);
  updateLob(dt);
  checkSeedMilestone();
  updateFireflies(dt);
  updateExit(dt);
  updateParticles(dt);
  updateMusic(dt);
  for (let i = waves.length - 1; i >= 0; i--) if (time - waves[i].t0 > waves[i].dur) removeAt(waves, i);
  for (let i = traces.length - 1; i >= 0; i--) if (time - traces[i].t0 > TRACE_LIFE) removeAt(traces, i);
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
      labSetup();
      warp = { t: 1.5, switched: true };
      showCard(3);  // the fade in takes 1.5 s: then a clean look at the new system for 1.5 s, then the card
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
  // Skidding along the ground with the engine off, it settles upright the same way (the ground's "up" there).
  const resting = !s.landed && s.slide && touching(s) && s.throttle < 0.05 && !(keys.KeyD || keys.ArrowRight || keys.KeyA || keys.ArrowLeft);
  if (s.landed || resting) {
    s.angVel = 0;
    const up = s.landed ? s.landAngle : Math.atan2(s.y - s.slide.py, s.x - s.slide.px);
    s.angle += angleDiff(up, s.angle) * (1 - Math.exp(-3.5 * dt));
  } else if (s.tumble > 0) {
    s.tumble -= dt;
    s.angVel *= Math.exp(-2 * dt);
  } else {
    let targetSpin = 0;
    const turnKeys = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    if (braking()) {  // a second thumb or Space: the ship flies itself down, whatever else is steering
      const bc = brakeControl(s);
      targetSpin = clamp(angleDiff(bc.angle, s.angle) * 8, -cfg.turnSpeed, cfg.turnSpeed);
      s.brakeThrottle = bc.throttle;
    } else if (turnKeys) {
      inputMode = 'keys';
      targetSpin = turnKeys * cfg.turnSpeed;
    } else if (inputMode === 'touch') {
      const [dx, dy, d] = joyVec();
      if (joy.id !== null && d > JOY_AIM) targetSpin = clamp(angleDiff(Math.atan2(dy, dx), s.angle) * 8, -cfg.turnSpeed, cfg.turnSpeed);
    } else if (inputMode === 'mouse') {
      const [wx, wy] = screenToWorld(mouse.x, mouse.y);
      targetSpin = clamp(angleDiff(Math.atan2(wy - s.y, wx - s.x), s.angle) * 8, -cfg.turnSpeed, cfg.turnSpeed);
    }
    // riding a geyser hands-off, the ship eases upright over its moon so it comes back down feet first (a
    // puff never turns you, but you drift round a small moon, and "up" turns under you)
    if (!targetSpin && inputMode !== 'mouse' && time - (s.inPlume ?? -9) < 6) {
      const g = geysers.find(b => Math.hypot(s.x - b.px, s.y - b.py) < b.R + plumeH(b) * 1.6);
      if (g) targetSpin = clamp(angleDiff(Math.atan2(s.y - g.py, s.x - g.px), s.angle) * 2.5, -1.5, 1.5);
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
  if (s.landed && s.sailOpen) s.sailOpen = sailTo(s.sailOpen, 0, dt);  // (in flight, shipSun opens and folds it)

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
      life: rand(0.3, 0.6), max: 0.6, color: pick(SHIPS[prefs.ship].plume.slice(0, 2)), size: 1.6, grav: false,
    });
  }

  if (s.landed) {
    const b = s.landed, nx = Math.cos(s.landAngle), ny = Math.sin(s.landAngle);
    const lift = tx * nx + ty * ny, surfaceG = b.gm / (b.R + FOOT) ** 2;
    // parked on a vent, a puff lifts you off softly (its updraft, along the ground's normal)
    const vent = b.vents && geyserLift(b, b.px, b.py, b.pvx, b.pvy, b.spin, time, s.x, s.y, s.vx, s.vy) ? GZ[0] * nx + GZ[1] * ny : 0;
    if (lift + vent <= surfaceG) {
      s.landAngle += b.spinRate * dt;  // ride along as the body turns
      parkShip();
      s.fuel = Math.min(FUEL_MAX, s.fuel + LAND_REFUEL * dt);
      // (aiming a throw pauses the planting, and once you've thrown the rest are kept for throwing)
      if (s.seeds > 0 && !s.holdSeeds && !lob && !b.bloomed && !(b.needs && !b.pollinated)) {  // a garden in full bloom doesn't take more seeds
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
    // until you're properly clear of the ground you're skidding on it: touching it again slides (see
    // slideStep), it doesn't land, so a takeoff that barely lifts (thick air, a fast spinner) is one smooth slide
    s.liftedAt = time; s.airborne = false; s.slide = b;
    if (vent > 0 && lift <= surfaceG) puffedUp(b);
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
  if (airy.length) airWisps(airDrag(s, dt), dt);
  for (const b of geysers) if (geyserLift(b, b.px, b.py, b.pvx, b.pvy, b.spin, time, s.x, s.y, s.vx, s.vy)) { s.vx += GZ[0] * dt; s.vy += GZ[1] * dt; s.inPlume = time; }
  if (gusts.length) shipSun(s, dx, dy, dt);
  for (const g of gardens) if (g.fullHint === false && altitudeOver(g, s.x, s.y) > 60) g.fullHint = true;
  // a few units clear of every surface counts as properly airborne: landing works normally again
  if (!s.airborne && nearestSurface(s.x, s.y).alt > 4) s.airborne = true;
  if (s.slide && (s.airborne || altitudeOver(s.slide, s.x, s.y) > 4 || !bodies.includes(s.slide))) { s.slide = null; s.airborne = true; }
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
    if (b.kind === 'sun' || b.kind === 'neutron') { sunBounce(b, nx, ny); break; }
    if (b.kind === 'gas') continue;  // no ground: you fly into its clouds (see cloudDrag)
    let rvx = s.vx - svx, rvy = s.vy - svy;
    const speed = Math.hypot(rvx, rvy);
    const tilt = Math.abs(angleDiff(s.angle, la));
    const vt = rvy * nx - rvx * ny, vdown = -(rvx * nx + rvy * ny);
    // skidding (just lifted off, or sliding along a fast spinner): touching the ground again slides on, it
    // doesn't land again, unless you come down on it hard
    if (s.slide === b && vdown <= cfg.landSpeed) { slideStep(b, nx, ny, svx, svy, tx * nx + ty * ny, dt); return; }
    // slow enough and roughly feet-first lands; touching down on the nose or side bounces off, however slow
    if (s.tumble <= 0 && speed <= cfg.landSpeed && tilt <= LAND_TILT && !(b.fast && Math.abs(vt) > SKID_MIN)) {
      land(b, la, speed);
      return;
    }
    // on a fast-spinning world the ground moves: coming down gently but across it (against the spin, or
    // straight down), you skid along it softly and settle, however fast it slides under you
    if (b.fast && s.tumble <= 0 && vdown <= cfg.landSpeed && tilt <= LAND_TILT) {
      s.slide = b; s.airborne = false; s.slideCalm = 0;
      thud(0.06, 900, 0.5, 300);
      slideStep(b, nx, ny, svx, svy, tx * nx + ty * ny, dt);
      if (!system.skidSaid) { system.skidSaid = true; say(`Skidding with ${b.name}'s spin: come down moving with the ground to touch down gently`, bodyColor(b)); }
      return;
    }
    s.slide = null;  // a bounce ends a skid
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
  if (s.tumble <= 0 && !s.slide && alt < SNAP_RANGE && time - (s.liftedAt ?? -9) > 1.2) {  // not right after taking off, nor skidding
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
  s.landed = b; s.landAngle = la; s.angVel = 0; s.plantTimer = 0.3; s.plantRun = 0; s.snapping = false; s.landedAt = time; s.slide = null;
  parkShip();
  const [c0, c1, c2] = b.color;
  burst(s.x - Math.cos(la) * FOOT, s.y - Math.sin(la) * FOOT, 6 + speed * 0.6, {
    vx: s.vx, vy: s.vy, dir: la, spread: 2.6, speed: [5, 15 + speed], life: [0.3, 0.8], color: '150,160,190', grav: true,
  });
  // a touch back down within a moment of lifting off (grinding along a spinning world or through thick air
  // while trying to take off) is silent: repeated, it made a thrum of clunks several times a second
  if (time - (s.liftedAt ?? -9) > 1.5) sfx.clunk();
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

// A skid: sliding along the ground in flight, from touching down across a fast spinner's moving ground, or
// from a takeoff that only just lifts (thick air, a weak burn). It's one continuous state: the ground holds
// you up and its friction slows the slide (harder on a heavier world, and the faster you go), kicking up dust
// behind you, with one soft scrape that follows the slip (see updateEngineSound). Skimming up and back down a
// little stays in it; it ends when you're properly clear of the ground (4 units up), or when you've slid to a
// rest with the engine quiet, which is then one ordinary landing.
const SKID_MIN = 10;  // a sideways mismatch above this, on touchdown, skids
const touching = s => time - (s.touchAt ?? -9) < 0.15;
function slideStep(b, nx, ny, svx, svy, lift, dt) {
  const s = ship, tx = -ny, ty = nx, g = b.gm / (b.R + FOOT) ** 2;
  s.x = b.px + nx * (b.R + FOOT); s.y = b.py + ny * (b.R + FOOT);
  let rvx = s.vx - svx, rvy = s.vy - svy;
  const vn = rvx * nx + rvy * ny;
  if (vn < 0) { rvx -= vn * nx; rvy -= vn * ny; }  // the ground holds you up
  const vt = rvx * tx + rvy * ty, v = Math.abs(vt), dv = Math.sign(vt) * Math.min(v, (Math.max(6, 0.15 * g) + 0.5 * v) * dt);
  rvx -= dv * tx; rvy -= dv * ty;
  s.vx = svx + rvx; s.vy = svy + rvy;
  // the ground carries your tilt round with it as you slide over its curve (or on a fast spinner a straight
  // burn would tip over sideways, little by little, and push you along the ground)
  const la = Math.atan2(ny, nx);
  if (touching(s) && s.slideLa !== undefined) s.angle += angleDiff(la, s.slideLa);
  s.slideLa = la;
  s.slip = v; s.touchAt = time;
  const fx = s.x - nx * FOOT, fy = s.y - ny * FOOT;
  s.dustAcc = (s.dustAcc || 0) + Math.max(0, v - 3) * 4 * dt;
  if (s.dustAcc >= 1) {  // a plume of dust kicked up behind you, low along the ground
    const n = Math.floor(s.dustAcc), back = Math.atan2(-ty * vt, -tx * vt);
    s.dustAcc -= n;
    burst(fx, fy, n, { vx: svx, vy: svy, dir: la + angleDiff(back, la) * 0.55, spread: 0.6, speed: [10, 14 + v], life: [0.8, 1.6], color: b.color.map(c => Math.round(mix(c, 235, 0.65))).join(','), size: 2.6, grav: true });
  }
  // slid to a rest with the engine quiet (for a moment, so pulsing the engine doesn't land and lift you in
  // turn): one landing, the clunk the whole skid has been waiting for (and no gentle-landing chime)
  const calm = v < 2 && Math.max(0, vn) < 3 && s.throttle < 0.05 && lift <= g && Math.abs(angleDiff(s.angle, la)) <= LAND_TILT;
  s.slideCalm = calm ? (s.slideCalm || 0) + dt : 0;
  if (s.slideCalm > 0.5) {
    s.slideCalm = 0;
    land(b, la, cfg.landSpeed * 0.3);
  }
}

// A sun is too bright to land on: touch one and its light pushes you back out, away from the pair, turning
// a little (no seeds lost, no harm). A neutron star does the same, just hard enough to carry you some 150 out
// against its far stronger pull.
function sunBounce(b, nx, ny) {
  const s = ship, r = Math.hypot(s.x, s.y) || 1, r0 = b.R + FOOT + 1;
  let ux = nx + s.x / r * 0.8, uy = ny + s.y / r * 0.8;
  const u = Math.hypot(ux, uy) || 1; ux /= u; uy /= u;
  const out = b.kind === 'neutron' ? Math.sqrt(2 * b.gm * (1 / r0 - 1 / 150)) : 160;
  s.x = b.px + nx * r0; s.y = b.py + ny * r0;
  s.vx = b.pvx + ux * out - uy * 35; s.vy = b.pvy + uy * out + ux * 35;  // out into a wide loop, not out of the system
  s.tumble = 0.5; s.angVel = rand(3, 5) * (Math.random() < 0.5 ? -1 : 1);
  burst(s.x, s.y, 24, { vx: s.vx * 0.3, vy: s.vy * 0.3, speed: [30, 100], life: [0.4, 1], color: b.color.join(',') });
  thud(0.2, 1800, 0.8, 200);
  if (time - (system.sunSaidAt ?? -99) > 30) { system.sunSaidAt = time; say(b.kind === 'neutron' ? `${b.name} is a neutron star, far too dense to land on` : `${b.name} is a sun, far too bright to land on`, `rgb(${b.color.join(',')})`); }
}

// Moving fast through thick air: faint wisps stream off the ship and a soft rush of wind (no heat, no harm).
function airWisps(through, dt) {
  if (through < 25) return;
  const s = ship, k = clamp((through - 25) / 100, 0, 1);
  if (Math.random() < 40 * k * dt) {
    const b = airy.find(o => Math.hypot(s.x - o.px, s.y - o.py) < o.R * o.air) || airy[0];
    particles.push({ x: s.x + rand(-4, 4), y: s.y + rand(-4, 4), vx: AIR[0] + rand(-8, 8), vy: AIR[1] + rand(-8, 8), life: rand(0.5, 1), max: 1, color: b.color.map(v => Math.round(mix(v, 255, 0.5))).join(','), size: rand(1.4, 2.2), grav: false });
  }
  if (time - (s.windAt ?? -9) > 0.3) { s.windAt = time; thud(0.02 + 0.05 * k, 900 + 1400 * k, 0.45); }
  const b = airy.find(o => Math.hypot(s.x - o.px, s.y - o.py) < o.R * o.air);
  if (b && !b.skimSaid && through > 50) { b.skimSaid = true; say(`Skimming the air of ${b.name}`, bodyColor(b)); }
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

// Thick air: a shell round some planets that slows what passes through toward the air's own motion, which
// turns with the planet. It's thicker lower down, and drags harder the faster you go (like real drag), so a
// skim near the top takes off a little speed and a dive takes off a lot: skim it to drop into orbit, or dive
// in fast and still touch down gently. No heat and no harm. The dotted line includes it (see predict).
// Stardust feels it too; thrown seeds don't (or a seed could never leave a world wrapped in it).
// drag per second, and per second per unit of speed, where the ship stands; it thins about e-fold every 1/h of
// the way up, and fades right out at the top. (The old shell kept 2% of its ground density at its very edge:
// any skim, however light, then bit hard enough to trap you in the air, where you sank in seconds.)
const AIR_DRAG = { k1: 1, k2: 0.5, h: 6 };
const AIR_NORM = 1 / (Math.exp(AIR_DRAG.h) - 1);
const AIR = [0, 0];               // airFactor's answer: the air's velocity there
const AIR_G0 = [0, 0], AIR_G = [0, 0];  // (predict's scratch)
// how much of the speed relative to the air is left after dt at (x, y) (1 = outside the air)
function airFactor(b, bx, by, bvx, bvy, x, y, vx, vy, dt) {
  const dx = x - bx, dy = y - by, r2 = dx * dx + dy * dy, top = b.R * b.air;
  if (r2 >= top * top) return 1;
  const depth = clamp((top - Math.sqrt(r2)) / (top - b.R - FOOT), 0, 1), w = b.spinRate;  // densest where the ship stands
  AIR[0] = bvx - dy * w; AIR[1] = bvy + dx * w;
  const rho = (Math.exp(AIR_DRAG.h * depth) - 1) * AIR_NORM;  // 0 at the top, 1 on the ground
  return Math.exp(-rho * (AIR_DRAG.k1 + AIR_DRAG.k2 * Math.hypot(vx - AIR[0], vy - AIR[1])) * dt);
}
// slows o in any thick air it's in; returns how fast it's moving through that air (0 outside)
function airDrag(o, dt) {
  let through = 0;
  for (const b of airy) {
    const k = airFactor(b, b.px, b.py, b.pvx, b.pvy, o.x, o.y, o.vx, o.vy, dt);
    if (k === 1) continue;
    through = Math.hypot(o.vx - AIR[0], o.vy - AIR[1]);
    o.vx = AIR[0] + (o.vx - AIR[0]) * k; o.vy = AIR[1] + (o.vy - AIR[1]) * k;
  }
  return through;
}

// ===== Geysers =====
// An icy moon with two or three vents that turn with it. Each puffs on its own beat (every 4-7 s, for about
// 1.5 s): a soft plume rising some 2.5 R, a few stardust motes thrown out on real arcs, and an updraft. The
// updraft only ever lifts, along the vent's normal, easing you toward the speed that would just carry you to
// the top of the plume (lower on a heavy moon), so whatever a puff does you come back down at no more than
// PUFF_SOFT: it can't tip you over, spin you or make you bounce. Parked on a vent, a puff lifts you off
// (you're properly airborne before you can land again, so there's no land-lift flutter, and the next puff is
// seconds away). Puffs keep time, so the dotted line includes them.
const PUFF_LEN = 1.7, PUFF_K = 2.5, PUFF_MAX = 60, PUFF_SOFT = 24;  // a puff's length; how fast the updraft brings you to its speed; its strongest push; the most you come down at
const GZ = [0, 0];                                                // geyserLift's answer: the updraft's push
const plumeH = b => b.R * 2.5 + 12;
const ventPhase = (v, t) => ((t + v.phase) % v.period + v.period) % v.period;
// how hard a vent is puffing at time t (0..1): a quick rise, a hold, a fade
function ventPuff(v, t) {
  const p = ventPhase(v, t);
  return p < 0.2 ? smooth(p / 0.2) : p < 1.3 ? 1 : p < PUFF_LEN ? 1 - smooth((p - 1.3) / 0.4) : 0;
}
// how far from the middle a puff carries you: the top of the plume, or lower on a heavy moon, so that falling
// back from there you touch down at PUFF_SOFT at most, and no further than most of the way to where the
// planet's pull takes over (its Hill radius), so a ride comes back down rather than flinging you off the moon
function plumeApex(b) {
  const r0 = b.R + FOOT, top = b.R + plumeH(b), p = b.parent, pair = p && !p.mass;  // (twin moons circle an empty centre)
  const hill = b.orbit ? (pair ? p.orbit : b.orbit) * Math.cbrt(b.mass / (3 * ((!pair && p && p.mass) || system.centralMass))) : Infinity;
  return Math.max(r0 + 6, Math.min(0.75 * hill, 1 / Math.max(1 / r0 - PUFF_SOFT * PUFF_SOFT / (2 * b.gm), 1 / top)));
}
// the updraft on something at (x, y) moving at (vx, vy), from geyser moon b (at bx, by, moving bvx, bvy,
// turned to spin angle sp) at time t; answers in GZ, and says whether it's inside a puffing plume
function geyserLift(b, bx, by, bvx, bvy, sp, t, x, y, vx, vy) {
  const dx = x - bx, dy = y - by, H = plumeH(b), top = b.R + H, d2 = dx * dx + dy * dy;
  if (d2 > top * top) return false;
  let on = false;
  GZ[0] = 0; GZ[1] = 0;
  for (const v of b.vents) {
    const f = ventPuff(v, t);
    if (!f) continue;
    const a = sp + v.a, nx = Math.cos(a), ny = Math.sin(a), h = dx * nx + dy * ny - b.R;
    if (h < 0 || h > H) continue;
    const w = 6 + 0.35 * h, lat = Math.abs(dx * ny - dy * nx);  // a cone, widening as it rises
    if (lat > w) continue;
    const r = Math.sqrt(d2), rA = plumeApex(b), want = r < rA ? Math.sqrt(2 * b.gm * (1 / r - 1 / rA)) : 0;
    const vn = (vx - bvx) * nx + (vy - bvy) * ny, k = f * (1 - (lat / w) ** 2) * (1 - 0.5 * h / H);
    const acc = clamp(PUFF_K * (want - vn), 0, PUFF_MAX) * k;  // a lift, never a pull down
    GZ[0] += nx * acc; GZ[1] += ny * acc;
    on = true;
  }
  return on;
}
// each puff as it starts: a soft hiss if you're near, and a few motes of stardust thrown out on real arcs
// (some fall back and some fly off; they fade after a while, like comet dust)
function updateGeysers(dt) {
  for (const b of geysers) {
    for (const v of b.vents) {
      const p = ventPhase(v, time);
      if (v.p !== undefined && p < v.p) {
        const a = b.spin + v.a, nx = Math.cos(a), ny = Math.sin(a), esc = Math.sqrt(2 * b.gm / b.R);
        const x = b.px + nx * (b.R + 2), y = b.py + ny * (b.R + 2), n = motes.length < 140 ? 2 + (Math.random() < 0.6) + (Math.random() < 0.3) : 0;
        for (let i = 0; i < n; i++) {
          const sp = esc * rand(0.62, 1.08), side = rand(-0.4, 0.4), c = Math.cos(side), s = Math.sin(side);
          motes.push(dustMote(x, y, b.pvx + (nx * c - ny * s) * sp, b.pvy + (ny * c + nx * s) * sp, { life: rand(14, 20), vent: true }));
        }
        const d = Math.hypot(ship.x - x, ship.y - y);
        if (d < 260) thud(0.012 + 0.03 * (1 - d / 260), 2600, 1.1, 700);  // pfff
      }
      v.p = p;
    }
  }
}
// lifted off a vent: a soft rising note, and once a system a word
function puffedUp(b) {
  voice(SCALE[4] * 2, 0.025, 1.2, 0.05, 'triangle');
  if (!system.puffSaid) { system.puffSaid = true; say(`A geyser on ${b.name} lifts you. Ride it up, catch the dust`, bodyColor(b)); }
}

// ===== Solar gusts =====
// Every 15-25 s the sun breathes out: a front of light rolls across the system from the sun's side (outward
// from the middle in a binary system) in about six seconds, and while it passes it pushes everything loose
// gently away from the light: the ship, stardust, rocks and pods (not seeds you throw, which keep their plain
// arc, and not a ring or a black hole's disk, which keep their own). Each body casts a shadow behind it where
// nothing is pushed, so you can tuck in behind a moon. A point feels a gust for about 1.5 s: a change of about
// 7 in speed out in the open, a wave to ride rather than a shove. Gusts keep time, so the dotted line knows
// them. While one passes over a coasting ship, a solar sail opens by itself to surf it (see shipSun).
const GUST_SPEED = 240, GUST_W = 360, GUST_ACC = 12, GUST_GAP = [15, 25];  // front speed, band width, push, seconds between
// The sail: no control of its own. In a gust system, while a gust is passing over you and you coast, it opens
// by itself; it folds when the gust has gone by or as soon as you thrust. Square to the ship's heading, it
// catches the light along its normal, cos² of the angle between the heading and the light, so pointing
// straight away from the sun is the full push, sideways almost none, and pointing into the light pushes you
// backwards (a brake): turning is how you surf. Nothing in a shadow.
const SAIL_BASE = 2, SAIL_GUST = 22, SAIL_OPEN = 4, SAIL_FOLD = 6, SAIL_AT = 0.05;  // ... and the gust that opens it
const sailTo = (open, want, dt) => { const o = open + (want - open) * (1 - Math.exp(-(want > open ? SAIL_OPEN : SAIL_FOLD) * dt)); return o < 0.001 && !want ? 0 : o; };
let gusts = [];               // start times of the next three gusts
const SUN = [0, 0, 0, 1];     // sunAt's answer: away from the light (x, y), the gust there (0..1), how lit (0 in a shadow)
const LIVE_POS = [];          // every body's position now, laid out like predictPos
const gustFrom = () => system.binary ? 30 : -(ARENA_R + 100);  // where a front sets off, along the light
const gustSpan = () => (ARENA_R + 100 + GUST_W - gustFrom()) / GUST_SPEED;
const gustProfile = q => q <= 0 || q >= 1 ? 0 : q < 0.2 ? smooth(q / 0.2) : 1 - smooth((q - 0.2) / 0.8);  // q: 0 at the leading edge, 1 at the tail
const shadowLen = R => R * 4 + 50;
// the light at (x, y) at time t, with the bodies at pos (LIVE_POS, or predictPos in the prediction)
function sunAt(x, y, t, pos, wantLit) {
  let ux, uy, p;
  if (system.binary) { const r = Math.hypot(x, y) || 1; ux = x / r; uy = y / r; p = r; }
  else { ux = -Math.cos(system.sunAngle); uy = -Math.sin(system.sunAngle); p = x * ux + y * uy; }
  SUN[0] = ux; SUN[1] = uy; SUN[3] = 1;
  let g = 0;
  const f0 = gustFrom();
  for (const t0 of gusts) {
    const q = (f0 + GUST_SPEED * (t - t0) - p) / GUST_W;
    if (q > 0 && q < 1) g = Math.max(g, gustProfile(q));
  }
  SUN[2] = g;
  if (!g && !wantLit) return;
  let shade = 0;
  for (let k = 0; k < allBodies.length && shade < 1; k++) {
    const b = allBodies[k];
    if (b.anchor || b.kind === 'sun') continue;
    shade = Math.max(shade, shadeBy(x, y, pos[2 * k], pos[2 * k + 1], b.R));
  }
  SUN[3] = 1 - shade;
}
// a body's shadow: a band as wide as it is, behind it from the light, softening at the sides and the far end
function shadeBy(x, y, bx, by, R) {
  let sx, sy;
  if (system.binary) { const r = Math.hypot(bx, by) || 1; sx = bx / r; sy = by / r; }
  else { sx = -Math.cos(system.sunAngle); sy = -Math.sin(system.sunAngle); }
  const dx = x - bx, dy = y - by, along = dx * sx + dy * sy, L = shadowLen(R);
  if (along <= 0 || along >= L) return 0;
  const lat = Math.abs(dx * sy - dy * sx);
  if (lat >= R * 1.15) return 0;
  return (lat < R * 0.9 ? 1 : (R * 1.15 - lat) / (R * 0.25)) * Math.min(1, (L - along) / 40);
}
function gustPush(o, dt) {
  sunAt(o.x, o.y, time, LIVE_POS, false);
  const a = GUST_ACC * SUN[2] * SUN[3];
  if (a) { o.vx += SUN[0] * a * dt; o.vy += SUN[1] * a * dt; }
}
// the sail's push along the heading (hx, hy), from the light in SUN (signed: negative pushes you backwards)
function sailForce(hx, hy) {
  const c = hx * SUN[0] + hy * SUN[1];
  return (SAIL_BASE + SAIL_GUST * SUN[2]) * SUN[3] * c * Math.abs(c);
}
// the gust (and the sail) on the ship in flight, with a whoosh as a front reaches you and a word or two
function shipSun(s, hx, hy, dt) {
  sunAt(s.x, s.y, time, LIVE_POS, true);
  s.sailOpen = sailTo(s.sailOpen, s.throttle < 0.05 && SUN[2] > SAIL_AT ? 1 : 0, dt);  // coasting in a gust, it opens
  const g = GUST_ACC * SUN[2] * SUN[3];
  s.vx += SUN[0] * g * dt; s.vy += SUN[1] * g * dt;
  s.sailPush = s.sailOpen > 0 ? sailForce(hx, hy) * s.sailOpen : 0;
  s.vx += hx * s.sailPush * dt; s.vy += hy * s.sailPush * dt;
  const inGust = SUN[2] > 0.08;
  if (inGust && !s.inGust && SUN[3] > 0.5) {
    thud(0.05, 2200, 1.3, 400);
    if (!system.gustSaid) { system.gustSaid = true; say('A solar gust: coast and a sail opens to surf it, or tuck in behind a moon', `rgb(${system.identity.sun})`); }
  }
  if (inGust && SUN[3] < 0.2 && !system.shadeSaid) { system.shadeSaid = true; say('In the shadow: the gust passes you by', `rgb(${system.identity.sun})`); }
  s.inGust = inGust;
}
function updateGusts(dt) {
  updateSpores(dt);
  if (!gusts.length) return;
  for (let k = 0; k < allBodies.length; k++) { LIVE_POS[2 * k] = allBodies[k].px; LIVE_POS[2 * k + 1] = allBodies[k].py; }
  if (time > gusts[0] + gustSpan()) { gusts.shift(); gusts.push(gusts[gusts.length - 1] + rand(...GUST_GAP)); }
  const t0 = gusts[0];
  // the sun draws a breath first: a soft rising tone (and a glow from its side, see drawGustWarning)
  if (t0 - GUST_WARN <= time && t0 - GUST_WARN > time - dt) voice(SCALE[4], 0.016, GUST_WARN + 0.6, GUST_WARN, 'triangle');
  if (t0 <= time && t0 > time - dt) { voice(SCALE[0] / 2, 0.03, 3.5, 1.2); dustWave(); }  // and breathes out: a low swell
  // as the front passes a garden in full bloom, the gust lifts a few spores off it
  if (time >= t0) {
    const f = gustFrom() + GUST_SPEED * (time - t0);
    for (const b of gardens) {
      if (!b.bloomed || b.rogue) continue;
      const pb = system.binary ? Math.hypot(b.px, b.py) : -(b.px * Math.cos(system.sunAngle) + b.py * Math.sin(system.sunAngle));
      if (pb <= f && pb > f - GUST_SPEED * dt) sporesFrom(b);
    }
  }
}

// The sun's breath carries stardust too, slower than its light: a few seconds after each gust front a line
// of glittering dust rolls across the system at a pace you can match (outward as a ring round a binary).
// Fly along it to sweep it up. Where it meets a moon or planet it piles up in a drift on the far side, in
// the body's lee, and stays there a while: the easy way to gather it. (Wind dust feels no gravity, so the
// line stays a line; a drift rides along behind its body until the ship comes close and its pull frees it.)
const GUST_WARN = 2.5;                    // seconds of warning before a front sets off
const WAVE_SPEED = 80, WAVE_GAP = 16;     // the dust line's pace, and the spacing of its motes
const DRIFT_PER = 2, DRIFT_MAX = 12;      // drift motes for each wind mote that meets a body, and at most behind one body
const DRIFT_LIFE = [10, 16];              // seconds a drift lasts before it fades (over 4 s)
function dustWave() {
  const bin = system.binary, ux = -Math.cos(system.sunAngle), uy = -Math.sin(system.sunAngle), ph = rand(0, TAU);
  if (bin) {
    const life = (ARENA_R + 80 - 40) / WAVE_SPEED - 2;
    const n = Math.round(TAU * 160 / WAVE_GAP);
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU + rand(-0.01, 0.01), r = 40 + 6 * Math.sin(a * 5 + ph);
      motes.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, vx: Math.cos(a) * WAVE_SPEED, vy: Math.sin(a) * WAVE_SPEED, born: time, tw: rand(0, TAU), gold: false, wind: true, sun: true, life });
    }
    return;
  }
  // it sets off from just out of view (or the arena's edge, if that's further), as wide as the view or the arena
  let a0 = -ARENA_R, l0 = -ARENA_R, l1 = ARENA_R;
  for (const [cx, cy] of [[0, 0], [W, 0], [0, H], [W, H]]) {
    const [wx, wy] = screenToWorld(cx, cy), al = wx * ux + wy * uy, lat = -wx * uy + wy * ux;
    a0 = Math.min(a0, al - 40); l0 = Math.min(l0, lat); l1 = Math.max(l1, lat);
  }
  a0 = Math.max(a0, -ARENA_R - 600); l0 = Math.max(l0, -ARENA_R - 500); l1 = Math.min(l1, ARENA_R + 500);
  const life = (ARENA_R + 80 - a0) / WAVE_SPEED - 2;  // (it fades out past the far edge)
  for (let l = l0; l <= l1; l += WAVE_GAP) {
    const a = a0 + 8 * Math.sin(l / 70 + ph) + rand(-2, 2);  // along the light: a gently rippled line
    motes.push({ x: ux * a - uy * l, y: uy * a + ux * l, vx: ux * WAVE_SPEED, vy: uy * WAVE_SPEED, born: time, tw: rand(0, TAU), gold: false, wind: true, sun: true, life });
  }
}
// wind dust meeting a body: it settles into a drift in the body's lee (a sun or a black hole just takes it)
function windDrift(m, b) {
  if (b.kind === 'sun' || b.kind === 'hole' || b.kind === 'neutron' || b.anchor) return;
  let have = 0;
  for (const o of motes) if (o.lee && o.lee.b === b) have++;
  for (let k = 0; k < DRIFT_PER && have + k < DRIFT_MAX; k++) {
    motes.push({ x: m.x, y: m.y, vx: 0, vy: 0, born: time, tw: rand(0, TAU), gold: false, sun: true, life: rand(...DRIFT_LIFE),
      lee: { b, along: b.R + rand(6, 10) + Math.pow(Math.random(), 1.6) * b.R * 1.8, lat: rand(-0.85, 0.85) * b.R * (1 - Math.random() * 0.3) } });
  }
}
// where a drift mote sits now: behind its body, away from the light
function leePos(m) {
  const { b, along, lat } = m.lee;
  let sx = -Math.cos(system.sunAngle), sy = -Math.sin(system.sunAngle);
  if (system.binary) { const r = Math.hypot(b.px, b.py) || 1; sx = b.px / r; sy = b.py / r; }
  m.x = b.px + sx * along - sy * lat; m.y = b.py + sy * along + sx * lat;
  m.vx = b.pvx; m.vy = b.pvy;
}

// Spores: as a gust front passes a garden in full bloom it lifts a few spores off it and carries them away from
// the light. Most come to nothing, but one that meets a garden still growing may take root there as a single
// flower in its home garden's colours: blooming worlds slowly help their neighbours along.
const SPORES = 6, SPORE_TAKE = 0.5, SPORE_LIFE = 16;
let spores = [];  // { x, y, vx, vy, born, from (its garden), fade }
function sporesFrom(b) {
  let ux = -Math.cos(system.sunAngle), uy = -Math.sin(system.sunAngle);
  if (system.binary) { const r = Math.hypot(b.px, b.py) || 1; ux = b.px / r; uy = b.py / r; }
  const h = Math.atan2(uy, ux);
  for (let i = 0; i < SPORES; i++) {
    const a = h + rand(-1.2, 1.2), sp = rand(40, 70), d = h + rand(-0.45, 0.45);
    spores.push({ x: b.px + Math.cos(a) * (b.R + 3), y: b.py + Math.sin(a) * (b.R + 3), vx: b.pvx + Math.cos(d) * sp, vy: b.pvy + Math.sin(d) * sp, born: time, from: b, fade: 0 });
  }
}
function updateSpores(dt) {
  for (let i = spores.length - 1; i >= 0; i--) {
    const sp = spores[i];
    if (sp.fade) { sp.fade -= dt; sp.x += sp.vx * dt; sp.y += sp.vy * dt; if (sp.fade <= 0) removeAt(spores, i); continue; }
    const wob = Math.sin((time - sp.born) * 3 + sp.born) * 6;  // drifting on the breeze, a little flutter
    sp.x += (sp.vx - sp.vy * wob / 60) * dt; sp.y += (sp.vy + sp.vx * wob / 60) * dt;
    if (time - sp.born > SPORE_LIFE || sp.x * sp.x + sp.y * sp.y > (ARENA_R + 60) ** 2) { sp.fade = 1.2; continue; }
    for (const b of bodies) {
      if (b === sp.from) continue;
      const dx = sp.x - b.px, dy = sp.y - b.py;
      if (dx * dx + dy * dy > b.R * b.R) continue;
      if (podTakes(b) && Math.random() < SPORE_TAKE) sporeRoots(sp, b, Math.atan2(dy, dx));
      else { sp.fade = 0.8; sp.vx = b.pvx; sp.vy = b.pvy; }  // a dud: it settles and fades
      if (!sp.fade) removeAt(spores, i);
      break;
    }
  }
}
function sporeRoots(sp, b, a) {
  const n = b.plants.length, from = sp.from, [c0, c1, c2] = from.color;
  plantSeed(b, a);
  const pl = b.plants.length > n ? b.plants[b.plants.length - 1] : null;
  if (pl && pl.kind !== BAMBOO) { pl.kind = 4; pl.tip = `${c0},${c1},${c2}`; }  // a flower in its home garden's colour
  const x = b.px + Math.cos(a) * b.R, y = b.py + Math.sin(a) * b.R;
  burst(x, y, 6, { vx: b.pvx, vy: b.pvy, dir: a, spread: 1.6, speed: [6, 20], life: [0.4, 0.9], color: `${c0},${c1},${c2}` });
  voice(SCALE[(n + 2) % SCALE.length] * 4, 0.012, 1.2, 0.02, 'triangle');  // a tiny high chime
  if (time - (system.sporeSaidAt ?? -99) > 30) { system.sporeSaidAt = time; say(`Spores from ${from.name} took root on ${b.name}`, bodyColor(from)); }
}
function drawSpores() {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const sp of spores) {
    const k = sp.fade ? clamp(sp.fade, 0, 1) : Math.min(1, (time - sp.born) * 2), c = sp.from.color.join(',');
    ctx.fillStyle = `rgba(${c},${0.18 * k})`;
    ctx.beginPath(); ctx.arc(sp.x, sp.y, 3.2, 0, TAU); ctx.fill();
    ctx.fillStyle = `rgba(${c},${0.85 * k})`;
    ctx.beginPath(); ctx.arc(sp.x, sp.y, 1.1, 0, TAU); ctx.fill();
  }
  ctx.restore();
}
// Before a front sets off, the light from the sun's side swells for a couple of seconds (round the middle in a
// binary): time to line up for the dust that follows, or to tuck in behind a moon.
function drawGustWarning() {
  const left = gusts[0] - time;
  if (left <= 0 || left > GUST_WARN + 0.5) return;
  const k = smooth(clamp((GUST_WARN + 0.5 - left) / GUST_WARN, 0, 1)) * (0.75 + 0.25 * Math.sin(time * 5)), sun = system.identity.sun;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  let g;
  if (system.binary) {
    g = ctx.createRadialGradient(0, 0, 10, 0, 0, 260);
    g.addColorStop(0, `rgba(${sun},${0.12 * k})`); g.addColorStop(1, `rgba(${sun},0)`);
  } else {
    const ux = -Math.cos(system.sunAngle), uy = -Math.sin(system.sunAngle);
    g = ctx.createLinearGradient(-ux * (ARENA_R + 120), -uy * (ARENA_R + 120), ux * ARENA_R * 0.4, uy * ARENA_R * 0.4);
    g.addColorStop(0, `rgba(${sun},${0.1 * k})`); g.addColorStop(1, `rgba(${sun},0)`);
  }
  ctx.fillStyle = g;
  const BIG = ARENA_R + 800;
  ctx.fillRect(-BIG, -BIG, BIG * 2, BIG * 2);
  ctx.restore();
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
    // and once in a while (1 in 20) a second clump follows a few seconds later, if you're still planting there
    const first = b.plants.find(p => p.kind === BAMBOO);
    const twin = !!first && b.bambooTwin && time >= b.bambooTwin && time < b.bambooTwin + 10;
    const bamboo = twin || (!b.poly && Math.random() < 0.0025 && !first);
    b.plants.push({
      a: twin ? first.a + (Math.random() < 0.5 ? -1 : 1) * rand(10, 16) / b.R : a, h: bamboo ? rand(34, 38) : Math.random() < 0.15 ? rand(12, 17) : rand(4, 9), grow: 0, sway: rand(0, TAU), flip: Math.random() < 0.5 ? -1 : 1,
      kind: bamboo ? BAMBOO : pickKind(bloomOf(b)), tip: Math.random() < 0.25 ? pick(b.accents) : `${c0},${c1},${c2}`,
    });
    if (twin) { b.bambooTwin = null; say('Double bamboo! What does it mean?', `rgb(${c0},${c1},${c2})`); }
    else if (bamboo) {
      say(`Bamboo is sprouting on ${b.name}!`, `rgb(${c0},${c1},${c2})`);
      if (Math.random() < 0.05) b.bambooTwin = time + rand(3, 5);
    }
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
    if (!allBloomed && gardens.every(o => o.bloomed || o.made || o.rogue)) {
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
    if (m.seek) {
      // seeds paid out by a light trace: they hang a moment, then fly into the ship
      if (time > m.seek) {
        const dx = s.x - m.x, dy = s.y - m.y, d = Math.hypot(dx, dy) || 1, k = Math.min(1, 4 * dt);
        m.vx += (s.vx + dx / d * 160 - m.vx) * k; m.vy += (s.vy + dy / d * 160 - m.vy) * k;
      }
    } else if (m.wind) {
      // the sun's breath carries it straight on (no gravity, so the line stays a line)
    } else if (m.lee) {
      leePos(m);  // a drift rides along behind its body, until the ship comes near and its pull takes it
      if ((s.x - m.x) ** 2 + (s.y - m.y) ** 2 < cfg.magnet * cfg.magnet) { m.lee = null; m.hang = true; }
    } else if (m.hang) {
      // comet stardust hangs where it was shed: no gravity, slowly settling, drifting a touch outward
      const r = Math.hypot(m.x, m.y) || 1;
      m.vx = m.vx * Math.exp(-0.4 * dt) + m.x / r * 1.5 * dt;
      m.vy = m.vy * Math.exp(-0.4 * dt) + m.y / r * 1.5 * dt;
    } else {
      const [ax, ay] = gravityAt(m.x, m.y);
      m.vx += ax * dt; m.vy += ay * dt;
      if (system.identity.current) applyFlows(m, dt, false);
      if (airy.length) airDrag(m, dt);
      if (gusts.length && !m.ring && !m.disk) gustPush(m, dt);  // (a ring or a disk keeps its own)
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
    if (!m.lee) { m.x += m.vx * dt; m.y += m.vy * dt; }
    if (m.wind && (m.x * m.vx + m.y * m.vy) / WAVE_SPEED > ARENA_R + 80) { removeAt(motes, i); continue; }  // past the far edge
    for (const b of bodies) {
      if (m.wind && Math.hypot(m.x - b.px, m.y - b.py) < b.R) { windDrift(m, b); removeAt(motes, i); break; }
      if (!m.seek && !m.lee && Math.hypot(m.x - b.px, m.y - b.py) < b.R) {
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
  if (m.seek) {  // a seed from a light trace: a rising note each, and no chain (it's a gift, not a score)
    s.seeds++;
    note(SCALE[(4 + (m.seekNo || 0)) % SCALE.length] * 2, 0.06, 1.4);
    burst(m.x, m.y, 7, { vx: s.vx, vy: s.vy, speed: [15, 45], life: [0.2, 0.6], color: '200,240,255' });
    return;
  }
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
// About half drift in near a moon that could hold one (a little ahead of it or behind on its orbit), so
// there's usually a rock within a nudge or two of becoming a moon.
const addRock = (x, y, vx, vy, R = rand(7, 11)) => rocks.push({
  x, y, vx, vy, R, born: time, spin: rand(0, TAU), spinRate: rand(-1, 1), shape: Array.from({ length: 8 }, () => rand(0.72, 1.12)),
  track: newTrack(), nudged: false, kicked: false, held: null, lap: null,
});
function spawnRock() {
  const hosts = bodies.filter(b => b.holdR && !b.parent && !b.twin);
  for (let tries = 0; tries < 20; tries++) {
    const h = hosts.length && Math.random() < 0.5 ? pick(hosts) : null;
    const r = h ? h.orbit + rand(-25, 25) : rand(system.innerR + 30, 430), a = h ? h.angle + rand(0.35, 0.7) * pick([-1, 1]) : rand(0, TAU);
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (!clearOfBodies(x, y) || Math.hypot(x - ship.x, y - ship.y) < 150) continue;
    const v = Math.sqrt(homeGM() / r) * (h ? h.dir * rand(0.98, 1.02) : rand(0.9, 1.08));
    addRock(x, y, -Math.sin(a) * v, Math.cos(a) * v);
    return;
  }
}
function updateRocks(dt) {
  if (system.identity.feature === 'rocks') {
    rockTimer -= dt;
    if (rockTimer <= 0) { rockTimer = 12; if (rocks.length < 4) spawnRock(); }
    // said once ever, a little while into the first system with rocks
    if (LAB && !prefs.moonHint && !warp && time - system.arrivedAt > 9 && time - (message ? message.t : -9) > 5 && bodies.some(b => b.holdR)) {
      prefs.moonHint = true; savePrefs();
      say('Nudge a rock into orbit around a moon to make a new moon', '#cfd8ff');
    }
  }
  const s = ship;
  for (let i = rocks.length - 1; i >= 0; i--) {
    const k = rocks[i];
    // a rock you've nudged, drifting slowly enough close to a moon, is held by that moon alone (see holdOf)
    const h = k.nudged ? holdOf(k) : null;
    if (h) {
      const dx = h.px - k.x, dy = h.py - k.y, d = Math.hypot(dx, dy), g = h.gm / (d * d), [fx, fy] = railAcc(h);
      k.vx += (dx / d * g + fx) * dt; k.vy += (dy / d * g + fy) * dt;
      if (k.lap) circularise(k, h, dt);
      else catchSoftly(k, h, dt);
    } else {
      const [ax, ay] = gravityAt(k.x, k.y);
      k.vx += ax * dt; k.vy += ay * dt;
      if (gusts.length) gustPush(k, dt);
    }
    k.x += k.vx * dt; k.y += k.vy * dt;
    k.spin += k.spinRate * dt;
    if (bodies.some(b => Math.hypot(k.x - b.px, k.y - b.py) < b.R + k.R * 0.6)) {
      burst(k.x, k.y, 14, { speed: [10, 40], life: [0.4, 0.9], color: '170,180,210' });
      removeAt(rocks, i);
      continue;
    }
    // held on an orbit that neither hits the ground nor slips out of the hold (or one clean lap round its moon,
    // however lopsided) and the hidden assist starts rounding it out at once; once it's nearly circular it
    // becomes a moon. (Waiting for a whole clean lap first lost most rocks: a playtester's nudge showed the
    // ellipse and never closed it.)
    if (h !== k.held) k.lap = null;
    k.held = h;
    if (h) {
      const shape = trackStep(k.track, k, h, k.kicked), o = !k.lap && relOrbit(k, h);
      if (!k.lap && ((shape && shape.kind === 'orbit') || (o && o.peri >= h.R + k.R * 1.2 && o.apo < h.holdR * 0.92))) {
        k.lap = { t: time };
        voice(SCALE[7], 0.035, 2.2, 0.3, 'triangle');  // a soft chime: it's going round
      }
      // the gold ring stays up for a good part of a lap before the moon is made, so you see it
      if (k.lap && time - k.lap.t > Math.max(3, 0.25 * TAU * Math.sqrt(Math.hypot(k.x - h.px, k.y - h.py) ** 3 / h.gm)) && roundness(k, h) < 0.06 && Math.hypot(k.x - h.px, k.y - h.py) > madeOrbit(k, h) - 2) { makeMoon(i); continue; }
    } else if (k.track.body) trackReset(k.track, null);
    k.kicked = false;
    // bump the ship: an elastic-ish knock, heavier rocks barely budge
    const dx = s.x - k.x, dy = s.y - k.y, d = Math.hypot(dx, dy);
    if (s.landed || d >= k.R + 8 || d === 0) continue;
    const nx = dx / d, ny = dy / d, rel = (s.vx - k.vx) * nx + (s.vy - k.vy) * ny;
    if (rel >= 0) continue;
    const mk = k.R * k.R * 0.03, j = -1.6 * rel / (1 + 1 / mk);
    s.vx += j * nx; s.vy += j * ny;
    k.vx -= j / mk * nx; k.vy -= j / mk * ny;
    s.x = k.x + nx * (k.R + 8); s.y = k.y + ny * (k.R + 8);
    k.nudged = true; k.kicked = true; k.lap = null;  // a bump starts its lap over
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

// ===== Seed lob =====
// While landed you can throw a seed: drag back from the ship like a slingshot (or hold E and aim with the
// arrows), let go, and it flies on a real free-fall arc under the same gravity as everything else, planting
// wherever it comes down on a garden: the far side of your own world, a moon overhead, or round the giant.
// The predicted arc is drawn while you aim. Gas giants and black holes swallow a seed softly, and one that
// never comes down fades after a while.
const LOB_GAP = 0.5, LOB_MAX = 6, LOB_LIFE = 25;  // seconds between throws, seeds in flight, seconds aloft
const LOB_GRAB = 72, LOB_DRAG = 110, LOB_DEAD = 14;  // px: a touch this close to the ship is a slingshot; full pull; a tap
const LOB_HOME = 24;  // px: let go this close to the ship and the throw is called off (wherever the drag began)
const LOB_TILT = 110 * Math.PI / 180;                // throws go up to this far from straight up (a little below level)
// A throw is a pod: a tenth of what you carry (1 to 50 seeds) flies as one, so the dotted line stays true, and
// bursts where it lands, sowing a stripe of ground as wide as its load. Gardens need tens to hundreds of seeds.
const LOB_SHARE = 0.1, LOB_LOAD_MAX = 50;
const lobLoad = () => Math.min(ship.seeds, clamp(Math.round(ship.seeds * LOB_SHARE), 1, LOB_LOAD_MAX));
const SEED_RGB = '216,246,255';

// A big bag of seeds shows: past 60 the ring round the ship slowly deepens from pale ice to sky blue,
// periwinkle, orchid and rose (anchors at 150, 500, 1000, 2000), blended on a log scale so it creeps rather
// than jumps. Every 500 the player gets a line about it.
const SEED_TINTS = [[60, [216, 246, 255]], [150, [150, 208, 255]], [500, [160, 155, 255]], [1000, [225, 140, 240]], [2000, [255, 150, 175]]];
function seedTint(n) {
  if (n <= SEED_TINTS[0][0]) return SEED_RGB;
  for (let i = 1; i < SEED_TINTS.length; i++) {
    const [n1, c1] = SEED_TINTS[i];
    if (n < n1) {
      const [n0, c0] = SEED_TINTS[i - 1], k = Math.log(n / n0) / Math.log(n1 / n0);
      return c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(',');
    }
  }
  return SEED_TINTS[SEED_TINTS.length - 1][1].join(',');
}
const SEED_MILESTONE = 500;
let seedMark = 0;  // the highest milestone already announced (a spill and a climb back doesn't repeat it)
function checkSeedMilestone() {
  const s = ship;
  if (warp || s.seeds < seedMark + SEED_MILESTONE) return;
  seedMark = Math.floor(s.seeds / SEED_MILESTONE) * SEED_MILESTONE;
  const n = seedMark.toLocaleString('en');
  const lines = {
    500: 'Over 500 seeds aboard. Wow! Land gently, now',
    1000: 'Over 1,000 seeds! A whole meadow in the hold. Careful!',
    1500: 'Over 1,500 seeds. The ship is mostly seeds by now',
    2000: 'Over 2,000 seeds! Somewhere a gardener weeps with joy',
  };
  const tint = seedTint(s.seeds);
  say(lines[seedMark] || `Over ${n} seeds aboard. Wow! Careful!`, `rgb(${tint})`);
  arpeggio([SCALE[3], SCALE[5], SCALE[7], SCALE[10]].map(f => f * 2), 0.07, 0.07);
  burst(s.x, s.y, 26, { vx: s.vx, vy: s.vy, speed: [25, 80], life: [0.5, 1.1], color: tint });
}
let lob = null;    // aiming: { src: 'touch' | 'mouse' | 'keys', id, sx, sy (where the drag began), x, y, rel (from up), power (0..1), set }
let lobbed = [];    // pods in flight: { x, y, vx, vy, n (seeds aboard), born, fade, on }
let sowing = [];    // pods that landed, sowing their seeds one by one: { b, la (local angle), w, left, next, gap }
let lobAt = -9, lobPred = null, lobPredAge = 0;
const keyAim = () => !!lob && lob.src === 'keys';
const shipOnScreen = () => [(ship.x - cam.x) * scale * cam.zoom + W / 2, (ship.y - cam.y) * scale * cam.zoom + H / 2];
// While landed, the zone round the ship belongs to the slingshot: no joystick starts there, and with seeds a touch
// there aims a throw. In flight it's ordinary joystick ground (players steer from close to the ship too).
function inShipZone(x, y) {
  if (!ship || warp || !ship.landed) return false;  // only while landed: in flight players steer from close to the ship
  const [sx, sy] = shipOnScreen();
  return Math.hypot(x - sx, y - sy) < LOB_GRAB;
}
function nearShip(x, y) {
  if (!ship || !ship.landed || ship.seeds <= 0 || warp) return false;
  const [sx, sy] = shipOnScreen();
  return Math.hypot(x - sx, y - sy) < LOB_GRAB;
}
// the fastest throw: a little over what escapes the body you stand on, and never too feeble from a moon
const lobSpeed = b => Math.max(90, 1.8 * Math.sqrt(2 * b.gm / (b.R + FOOT)));  // quick enough to reach far orbits
function lobBegin(src, id = null, x = 0, y = 0) {
  if (!ship.landed || ship.seeds <= 0 || warp || title) return false;
  lob = { src, id, t0: time, sx: x, sy: y, x, y, rel: 0, power: src === 'keys' ? 0.5 : 0, set: src === 'keys' };
  lobPred = null;
  if (src === 'keys') sayLoaded();
  return true;
}
// "Loaded" as a throw is first drawn back, with how to call it off for the first few throws of a session
let lobAims = 0;
function sayLoaded() {
  const n = lobLoad(), what = n === 1 ? '1 seed' : `${n} seeds`;
  const off = lob.src === 'keys' ? 'Esc to cancel' : lob.src === 'mouse' ? 'right-click to cancel' : 'slide back to the ship or tap another finger to cancel';
  say(lobAims++ < 3 ? `Loaded ${what}  ·  ${off}` : `Loaded ${what}`, `rgb(${SEED_RGB})`);
}
function cancelLob() {
  if (!lob) return;
  lob = null; lobPred = null;
  say('Throw cancelled, seeds back in the hold', `rgb(${SEED_RGB})`);
}
// A drag back from the ship aims the other way. The zone is the slingshot's alone: a drag that would throw
// into the ground (you pulled up, away from the surface) aims nothing, the band goes dim with no arc, and
// letting go there throws nothing. To take off, steer from outside the zone (where the thumb rests anyway).
function lobDrag(x, y) {
  const l = lob, s = ship;
  l.x = x; l.y = y;
  const dx = l.sx - x, dy = l.sy - y, d = Math.hypot(dx, dy);
  const [hx, hy] = shipOnScreen();
  // back where the drag began, or back on the ship: letting go here cancels (a drag can begin a way off the ship)
  if (d < LOB_DEAD || (l.moved && Math.hypot(x - hx, y - hy) < LOB_HOME)) { l.power = 0; l.off = false; return; }
  if (!l.moved) { l.moved = true; sayLoaded(); }
  const rel = angleDiff(Math.atan2(dy, dx), s.landAngle);
  l.off = Math.abs(rel) > LOB_TILT + 0.3;
  l.set = true;
  l.rel = clamp(rel, -LOB_TILT, LOB_TILT);
  l.power = l.off ? 0 : clamp((d - LOB_DEAD) / LOB_DRAG, 0, 1);
}
function lobLaunch(l) {
  const s = ship, b = s.landed, a = s.landAngle + l.rel, v = lobSpeed(b) * l.power, ux = Math.cos(s.landAngle), uy = Math.sin(s.landAngle);
  return { x: s.x + ux * 3, y: s.y + uy * 3, vx: s.vx + Math.cos(a) * v, vy: s.vy + Math.sin(a) * v };
}
function throwSeed() {
  const l = lob, s = ship;
  lob = null; lobPred = null;
  if (l && l.moved && l.power < 0.06) { lob = l; cancelLob(); return; }
  if (!l || !s.landed || s.seeds <= 0 || l.power < 0.06) return;
  if (time - lobAt < LOB_GAP || lobbed.reduce((n, m) => n + (m.fade ? 0 : 1), 0) >= LOB_MAX) return;
  const o = lobLaunch(l), n = lobLoad();
  lobbed.push({ ...o, n, born: time, fade: 0, on: null });
  s.seeds -= n; lobAt = time;
  s.holdSeeds = true;  // the rest of this landing's seeds are kept for throwing
  thud(0.05, 2200, 0.4, 500);  // a soft whoosh
  voice(SCALE[9] * 2, 0.022, 0.8, 0.01, 'triangle');
  burst(o.x, o.y, 5, { vx: s.vx, vy: s.vy, dir: Math.atan2(o.vy - s.vy, o.vx - s.vx), spread: 0.8, speed: [10, 30], life: [0.2, 0.5], color: SEED_RGB });
}
function updateLob(dt) {
  const s = ship;
  if (lob && (!s.landed || s.seeds <= 0 || warp)) { lob = null; lobPred = null; }
  // the mouse button held still on the ship for a moment is plain thrust, as it is anywhere else (a click is
  // where a mouse player's engine lives; a thumb never turns into the joystick here)
  if (lob && lob.src === 'mouse' && !lob.moved && time - lob.t0 > 0.45) { lob = null; mouse.down = true; }
  if (keyAim()) {  // E held: left and right swing the aim, up and down set the strength
    const turn = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    const pow = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
    lob.rel = clamp(lob.rel + turn * 1.1 * dt, -LOB_TILT, LOB_TILT);
    lob.power = clamp(lob.power + pow * 0.5 * dt, 0.06, 1);
  }
  // said once ever, the first time you sit landed with seeds to spare (on a garden that isn't taking them, or
  // still left over once it's had a few seconds of planting)
  const taking = s.landed && !s.holdSeeds && !s.landed.bloomed && !(s.landed.needs && !s.landed.pollinated);
  if (s.landed && s.seeds > 0 && !prefs.lobHint && !warp && time - (s.landedAt ?? time) > (taking ? 4 : 1.5) && time - (message ? message.t : -9) > 3) {
    prefs.lobHint = true; savePrefs();
    say(inputMode === 'touch' ? 'Drag back from the ship to throw seeds' : inputMode === 'mouse' ? 'Drag back from the ship to throw seeds (or hold E to aim)' : 'Hold E to aim a throw of seeds: arrows adjust, let go to throw');
  }
  for (let i = lobbed.length - 1; i >= 0; i--) {
    const m = lobbed[i];
    if (m.fade) {  // lost: it fades where it is (riding the body that swallowed it)
      m.fade -= dt;
      if (m.on) { m.x += m.on.pvx * dt; m.y += m.on.pvy * dt; } else { m.x += m.vx * dt; m.y += m.vy * dt; }
      if (m.fade <= 0) removeAt(lobbed, i);
      continue;
    }
    const [ax, ay] = gravityAt(m.x, m.y);
    m.vx += ax * dt; m.vy += ay * dt;
    m.x += m.vx * dt; m.y += m.vy * dt;
    if (time - m.born > LOB_LIFE || Math.hypot(m.x, m.y) > ARENA_R) {  // a miss isn't a loss: it breaks into stardust
      podDust(m.n, m.x, m.y, m.vx * 0.3, m.vy * 0.3, 0, 0);
      removeAt(lobbed, i);
      continue;
    }
    for (const b of bodies) {
      const dx = m.x - b.px, dy = m.y - b.py, d = Math.hypot(dx, dy);
      if (d >= b.R + 1) continue;
      if (b.barren) {  // a gas giant or a black hole swallows it softly (the dotted line said so)
        m.fade = 1; m.on = b;
        burst(m.x, m.y, 3, { vx: b.pvx, vy: b.pvy, speed: [3, 10], life: [0.4, 0.8], color: SEED_RGB });
        break;
      }
      seedLands(m, b, Math.atan2(dy, dx));
      removeAt(lobbed, i);
      break;
    }
  }
  for (let i = sowing.length - 1; i >= 0; i--) {  // a landed pod sows its stripe over about half a second
    const w = sowing[i], b = w.b;
    while (w.left > 0 && time >= w.next) {
      const a = w.la + b.spin + rand(-w.w / 2, w.w / 2);
      plantSeed(b, a);
      w.left--; w.next += w.gap;
      burst(b.px + Math.cos(a) * b.R, b.py + Math.sin(a) * b.R, 2, { vx: b.pvx, vy: b.pvy, dir: a, spread: 1.2, speed: [8, 25], life: [0.2, 0.5], color: SEED_RGB });
      if (w.left % 4 === 0) voice(SCALE[(b.plants.length + 4) % SCALE.length] * 2, 0.02, 0.9, 0.01, 'triangle');
    }
    if (w.left <= 0) removeAt(sowing, i);
  }
}
// Seeds a pod couldn't use become stardust floating where it ended: no seed is ever really lost, only scattered.
// They hang (gravity would just drop them back onto the world) and fade after a while like comet dust.
function podDust(n, x, y, vx, vy, nx, ny) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, TAU), sp = rand(4, 14), out = rand(6, 22);
    motes.push({
      x: x + nx * out + Math.cos(a) * 3, y: y + ny * out + Math.sin(a) * 3, vx: vx + nx * 14 + Math.cos(a) * sp, vy: vy + ny * 14 + Math.sin(a) * sp,
      born: time - 0.4, tw: rand(0, TAU), gold: false, hang: true, life: rand(20, 26),
    });
  }
}
// A thrown seed comes down on a garden: it takes root there like one planted from a landing (on a crystal
// it grows a shard), with a little flash of light so you see it land from afar.
// Only what the garden still needs takes root (a garden in full bloom, or one waiting for pollen, takes none);
// the rest drifts off as stardust to scoop up again.
function seedLands(m, b, a) {
  const sx = Math.cos(a) * b.R, sy = Math.sin(a) * b.R, [c0, c1, c2] = b.color, own = `${c0},${c1},${c2}`;
  const queued = sowing.reduce((n, w) => n + (w.b === b ? w.left : 0), 0);
  const need = b.bloomed || (b.needs && !b.pollinated) ? 0 : Math.max(0, b.maxPlants - b.plants.length - queued);
  const n = Math.min(m.n, need), spare = m.n - n;
  if (spare) podDust(spare, b.px + sx, b.py + sy, b.pvx, b.pvy, Math.cos(a), Math.sin(a));
  waves.push({ body: b, off: [sx, sy], t0: time, dur: 0.9, r0: 2, r1: 18 + Math.sqrt(m.n) * 3, color: SEED_RGB, w: 1.6 });
  burst(b.px + sx, b.py + sy, 8 + Math.min(m.n, 20), { vx: b.pvx, vy: b.pvy, dir: a, spread: 2.2, speed: [10, 50], life: [0.3, 0.8], color: own });
  burst(b.px + sx, b.py + sy, 4, { vx: b.pvx, vy: b.pvy, dir: a, spread: 1.4, speed: [15, 35], life: [0.3, 0.6], color: SEED_RGB });
  voice(SCALE[(b.plants.length + 4) % SCALE.length] * 2, 0.03, 1.4, 0.02, 'triangle');  // a soft chime
  if (n) {
    // the stripe is about as wide as its plants would stand in clumps, never more than a third of the world
    const w = Math.min(TAU / 3, (6 + n * 2.2) / b.R);
    sowing.push({ b, la: a - b.spin, w, left: n, next: time, gap: Math.min(0.03, 0.6 / n) });
  }
  if (b !== ship.landed && time - (system.lobSaidAt ?? -9) > 6) {
    system.lobSaidAt = time;
    say(!n ? `${b.name} has no room for more` : `Nice shot! ${n === 1 ? 'A seed' : `${n} seeds`} took root on ${b.name}`, bodyColor(b));
  }
}
function drawLob() {
  const s = ship;
  if (lobbed.length) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const m of lobbed) {
      const k = m.fade ? clamp(m.fade, 0, 1) : 1, big = Math.sqrt(m.n);  // a fuller pod is a little bigger
      ctx.strokeStyle = `rgba(${SEED_RGB},${0.35 * k})`; ctx.lineWidth = 1.2 * px;  // a short streak behind it
      ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - m.vx * 0.06, m.y - m.vy * 0.06); ctx.stroke();
      ctx.fillStyle = `rgba(${SEED_RGB},${0.16 * k})`;
      ctx.beginPath(); ctx.arc(m.x, m.y, 4 + big * 0.6, 0, TAU); ctx.fill();
      ctx.fillStyle = `rgba(${SEED_RGB},${0.95 * k})`;
      ctx.beginPath(); ctx.arc(m.x, m.y, 1.4 + big * 0.2, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }
  if (!lob || !s.landed || !lob.set) return;
  if (lob.off) {  // pulled into the ground: just a dim band back to the thumb, nothing will fly
    const [bx, by] = screenToWorld(lob.x, lob.y);
    ctx.save();
    ctx.globalAlpha = 0.14; ctx.strokeStyle = `rgb(${SEED_RGB})`; ctx.lineWidth = 1 * px;
    ctx.setLineDash([3 * px, 4 * px]);
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(bx, by); ctx.stroke();
    ctx.restore();
    return;
  }
  // the predicted arc: round dots in the seed colour, a little ring where it comes down on a garden
  if (!lobPred || (!paused && ++lobPredAge >= 2)) { lobPred = predict(lobLaunch(lob), true); lobPredAge = 0; }
  const p = lobPred, n = p.pts.length / 2, gap = 7 * px, r = 1.1 * px;
  const ends = !p.impact || p.impact.body.barren || (p.impact.body.needs && !p.impact.body.pollinated);
  ctx.save();
  ctx.fillStyle = `rgb(${SEED_RGB})`;
  let lx = s.x, ly = s.y;
  for (let i = 0; i < n; i++) {
    const x = p.pts[2 * i], y = p.pts[2 * i + 1];
    if (Math.hypot(x - lx, y - ly) < gap) continue;
    lx = x; ly = y;
    const t = i / n;
    ctx.globalAlpha = ends ? 0.6 * (1 - t) : 0.6 - 0.25 * t;  // a seed that won't take root fades out along its arc
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  if (p.impact && !ends) {
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = bodyColor(p.impact.body);
    ctx.lineWidth = 1.4 * px;
    ctx.beginPath(); ctx.arc(p.impact.x, p.impact.y, 3.5 + 0.8 * Math.sin(time * 6), 0, TAU); ctx.stroke();
    // a faint ghost of the body where it will be by then (moons move on while a seed flies)
    const b = p.impact.body;
    if (Math.hypot(p.impact.bx - b.px, p.impact.by - b.py) > 4) {
      ctx.globalAlpha = 0.22;
      ctx.lineWidth = 1 * px;
      ctx.setLineDash([3 * px, 4 * px]);
      ctx.beginPath(); ctx.arc(p.impact.bx, p.impact.by, b.R, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  // a faint band from the ship back to the thumb (or, with the keys, back along the aim)
  let bx, by;
  if (lob.src === 'keys') { const a = s.landAngle + lob.rel, l = 10 + lob.power * 34; bx = s.x - Math.cos(a) * l; by = s.y - Math.sin(a) * l; }
  else [bx, by] = screenToWorld(lob.x, lob.y);
  ctx.globalAlpha = 0.3;
  ctx.strokeStyle = `rgb(${SEED_RGB})`;
  ctx.lineWidth = 1 * px;
  ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(bx, by); ctx.stroke();
  ctx.globalAlpha = 0.5;
  ctx.beginPath(); ctx.arc(bx, by, 2.5 * px, 0, TAU); ctx.fill();
  // how many seeds this throw carries, just past the end of the band
  ctx.globalAlpha = 0.75;
  ctx.font = `${12 * px}px ui-monospace, Consolas, monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const ox = bx - s.x, oy = by - s.y, od = Math.hypot(ox, oy) || 1;
  ctx.fillText(`×${lobLoad()}`, bx + ox / od * 14 * px, by + oy / od * 14 * px);
  ctx.restore();
}

// ===== Seed pods (tow) =====
// Some systems have big glowing seed pods drifting on loose orbits. Fly close and match their speed and the
// ship hooks one on a soft tether: a rope with some slack and a well-damped spring, real momentum both ways,
// so the pod tugs you and swings like a pendulum. Smash it into a garden and it bursts open there into a big
// patch of growth: that's the only way to plant it (landing with it in tow doesn't drop it). The rope never
// breaks (a pod slipping free mid-swing was only frustrating). Each pod's rope is its own length, mostly long.
// A pod never sits stuck against anything: it bounces off what it can't grow on, and a free one resting on a
// garden for a moment bursts there by itself.
const POD_HOOK = 40, POD_MATCH = 24;          // catch within this distance at under this relative speed
const POD_K = 14, POD_DAMP = 4, POD_MASS = 1.2;  // the rope's spring and damping, the pod's mass (ship = 1)
const podSlack = () => 50 + 70 * Math.sqrt(Math.random());  // a rope 50-120 long, weighted long
const POD_RESPAWN = 30;
let pods = [], podTimer = 0;
function spawnPod() {
  const orbits = bodies.filter(b => !b.parent && b.orbit).map(b => b.orbit);
  for (let tries = 0; tries < 30; tries++) {
    const r = rand(system.innerR + 25, 340), a = rand(0, TAU), x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (!clearOfBodies(x, y) || (orbits.some(o => Math.abs(o - r) < 35) && tries < 20)) continue;
    if (Math.hypot(x - ship.x, y - ship.y) < 120 || pods.some(p => Math.hypot(x - p.x, y - p.y) < 150)) continue;
    const [vx, vy] = circular(x, y);
    pods.push({ x, y, vx, vy, R: rand(10, 13), slack: podSlack(), rest: 0, born: time, spin: rand(0, TAU), spinRate: rand(-0.4, 0.4), ci: Math.floor(rand(0, system.palette.length)), free: 0, taut: false });
    return pods[pods.length - 1];
  }
  return null;
}
const podRGB = p => system.palette[p.ci % system.palette.length].join(',');
// Letting go of the pod you're towing (E, or a tap or click on the pod): it sails on with its own momentum,
// and can't be hooked again for a moment, so it doesn't snap straight back on.
let podTap = null;  // a touch that began on the towed pod: a quick tap lets it go
function releasePod() {
  const s = ship, p = s && s.tow;
  if (!p || warp) return false;
  s.tow = null; p.free = time + 2.5;
  thud(0.06, 800, 0.25, 260);  // the latch opening: a click and a falling note
  voice(SCALE[4] * 2, 0.03, 0.8, 0.005, 'triangle');
  burst((p.x + s.x) / 2, (p.y + s.y) / 2, 5, { vx: s.vx, vy: s.vy, speed: [6, 20], life: [0.3, 0.6], color: podRGB(p) });
  return true;
}
function onTowedPod(x, y) {
  const p = ship && ship.tow;
  if (!p || warp) return false;
  const z = scale * cam.zoom, px0 = (p.x - cam.x) * z + W / 2, py0 = (p.y - cam.y) * z + H / 2;
  return Math.hypot(x - px0, y - py0) < Math.max(30, p.R * z + 16);  // the pod or a thumb's width round it
}
// The rope's pull on the ship, per unit of the ship-to-pod offset (dx, dy) (the pod gets the opposite).
// Slack below its length; beyond it a spring with damping along the rope, and a rope only ever pulls.
function tetherPull(dx, dy, dvx, dvy, slack) {
  const d = Math.hypot(dx, dy), ext = d - slack;
  if (ext <= 0) return 0;
  return Math.max(0, POD_K * ext + POD_DAMP * (dvx * dx + dvy * dy) / d) / d;
}
function updatePods(dt) {
  const s = ship;
  if (system.identity.feature === 'tow') {
    podTimer -= dt;
    if (podTimer <= 0) { podTimer = POD_RESPAWN; if (pods.length < 2) spawnPod(); }
  }
  for (let i = pods.length - 1; i >= 0; i--) {
    const p = pods[i];
    p.spin += p.spinRate * dt;
    const [ax, ay] = gravityAt(p.x, p.y);
    p.vx += ax * dt; p.vy += ay * dt;
    cloudDrag(p, dt, false);
    if (gusts.length) gustPush(p, dt);
    p.taut = false;
    if (s.tow === p) {
      const dx = p.x - s.x, dy = p.y - s.y, k = tetherPull(dx, dy, p.vx - s.vx, p.vy - s.vy, p.slack);
      if (k) {
        p.taut = true;
        p.vx -= dx * k / POD_MASS * dt; p.vy -= dy * k / POD_MASS * dt;
        if (!s.landed) { s.vx += dx * k * dt; s.vy += dy * k * dt; }  // landed, the ground holds the ship
      }
    }
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (podContacts(p, dt)) { removeAt(pods, i); continue; }
    // the ship and a pod bump gently instead of passing through each other (momentum shared by mass)
    const dx = p.x - s.x, dy = p.y - s.y, d = Math.hypot(dx, dy), min = p.R + 7;
    if (d < min && d > 0) {
      const nx = dx / d, ny = dy / d, vn = (p.vx - s.vx) * nx + (p.vy - s.vy) * ny;
      if (vn < 0) {
        const j = -1.3 * vn / (1 + 1 / POD_MASS);
        p.vx += j / POD_MASS * nx; p.vy += j / POD_MASS * ny;
        if (!s.landed) { s.vx -= j * nx; s.vy -= j * ny; }
      }
      p.x = s.x + nx * min; p.y = s.y + ny * min;
    }
    // hooking: close by and drifting along together
    if (!s.tow && !s.landed && !warp && time > p.free && d < POD_HOOK && Math.hypot(p.vx - s.vx, p.vy - s.vy) < POD_MATCH) {
      s.tow = p;
      thud(0.1, 1100, 0.15);  // a latch: a click and two rising notes
      voice(SCALE[4] * 2, 0.04, 0.7, 0.005, 'triangle');
      setTimeout(() => voice(SCALE[7] * 2, 0.035, 1, 0.005, 'triangle'), 90);
      burst((p.x + s.x) / 2, (p.y + s.y) / 2, 6, { vx: s.vx, vy: s.vy, speed: [8, 25], life: [0.3, 0.6], color: podRGB(p) });
      if (!system.towSaid) {
        system.towSaid = true;
        const off = inputMode === 'touch' ? 'tap it' : inputMode === 'mouse' ? 'click it' : 'press E';
        say(`Hooked a seed pod. Smash it into a garden to burst it, or ${off} to let go`, `rgb(${podRGB(p)})`);
      }
    }
  }
}
// a garden that a pod can burst open on (not one in full bloom, nor one still waiting for its pollen)
const podTakes = b => gardens.includes(b) && !b.bloomed && !(b.needs && !b.pollinated);
// A pod touching a body. Towed into a garden, it smashes open there. Free, it rolls softly on a garden and
// bursts if it comes to rest for a moment; on anything it can't grow on (a sun, a black hole, a gas giant's
// cloud tops, a garden in full bloom) it bounces off with a little push, outward and along its way, so it
// never sits wedged. (A towed pod can follow you into a gas giant's clouds.) True if it burst.
const POD_PUSH = 20;
function podContacts(p, dt) {
  const s = ship, towed = s.tow === p;
  let resting = false;
  for (const b of bodies) {
    if (b.kind === 'gas' && towed) continue;
    const dx = p.x - b.px, dy = p.y - b.py, d = Math.hypot(dx, dy) || 1, min = b.R + p.R * 0.8;
    if (d >= min) continue;
    const nx = dx / d, ny = dy / d, la = Math.atan2(ny, nx);
    let rvx = p.vx - b.pvx, rvy = p.vy - b.pvy;
    const vn = rvx * nx + rvy * ny;
    if (podTakes(b)) {
      p.x = b.px + nx * min; p.y = b.py + ny * min;
      if (towed) { podSmash(p, b, la, -vn); return true; }
      if (vn < 0) { rvx -= 1.4 * vn * nx; rvy -= 1.4 * vn * ny; }  // free, it rolls softly
      rvx *= 0.9; rvy *= 0.9;
      p.vx = b.pvx + rvx; p.vy = b.pvy + rvy;
      resting = true;
      if ((p.rest += dt) > 1) { podBloom(p, b, la); return true; }  // at rest a moment: it bursts there
      continue;
    }
    // something it can't grow on: out, and a little push off (along the way it was rolling, or the body's turn)
    if (towed && gardens.includes(b) && time - (b.podSaidAt ?? -99) > 8) {
      b.podSaidAt = time;
      say(b.bloomed ? `${b.name} is in full bloom. Take the pod to another garden` : `${b.name} needs ${b.needs} pollen first`, bodyColor(b));
    }
    p.x = b.px + nx * (min + 0.5); p.y = b.py + ny * (min + 0.5);
    const vt = rvy * nx - rvx * ny, side = Math.sign(vt) || b.dir || 1;
    rvx -= Math.min(0, vn) * 1.6 * nx; rvy -= Math.min(0, vn) * 1.6 * ny;  // a bounce, keeping 60% of the impact
    const push = Math.max(POD_PUSH, 0.45 * Math.sqrt(b.gm / d));  // (a hop that shows, even off a heavy sun)
    rvx += (nx - ny * side * 0.6) * push; rvy += (ny + nx * side * 0.6) * push;
    p.vx = b.pvx + rvx; p.vy = b.pvy + rvy;
    if (b.kind === 'gas') burst(p.x, p.y, 4, { vx: b.pvx, vy: b.pvy, dir: la, spread: 1.2, speed: [6, 16], life: [0.5, 1], color: b.color.join(','), size: 2 });
  }
  p.rest = resting ? p.rest : Math.max(0, p.rest - dt * 2);
  return false;
}
// Swung into a garden on its rope, the pod smashes open where it hits: a spray of husk along the ground,
// then the same bloom as a landing delivery.
function podSmash(p, b, la, speed) {
  ship.tow = null;
  const pc = podRGB(p);
  for (const side of [-1, 1]) burst(p.x, p.y, 10, { vx: b.pvx, vy: b.pvy, dir: la + side * 1.1, spread: 0.6, speed: [20, 45 + speed], life: [0.5, 1.1], color: pc, size: 2.4 });
  thud(0.1, 900, 0.3, 220);
  podBloom(p, b, la);
}
// About a quarter of the garden comes up at once, nearest first, rolling out over a second or two
// (if that fills it, the last plant brings the full-bloom moment).
function podBloom(p, b, at) {
  const [c0, c1, c2] = b.color, own = `${c0},${c1},${c2}`, local = at - b.spin;
  const room = b.maxPlants - b.plants.length, n = Math.min(Math.ceil(b.maxPlants * 0.25), room);
  const fills = n >= room, spread = Math.min(Math.PI, 0.3 + n * 4 / b.R);
  for (let k = 0; k < (fills ? n - 1 : n); k++) {
    const off = rand(-1, 1) * spread;
    b.plants.push({
      a: local + off, h: Math.random() < 0.15 ? rand(12, 17) : rand(4, 9), grow: 0, delay: Math.abs(off) / spread * 1.4 + rand(0, 0.2),
      sway: rand(0, TAU), flip: Math.random() < 0.5 ? -1 : 1, kind: pickKind(bloomOf(b)), tip: Math.random() < 0.3 ? pick(b.accents) : own,
    });
  }
  if (fills) setTimeout(() => { if (!b.bloomed) plantSeed(b, at); }, 1700);
  const pc = podRGB(p);
  burst(p.x, p.y, 36, { vx: b.pvx, vy: b.pvy, speed: [20, 90], life: [0.6, 1.4], color: pc, size: 2.2 });
  burst(p.x, p.y, 18, { vx: b.pvx, vy: b.pvy, speed: [15, 60], life: [0.5, 1.2], color: SEED_RGB });
  waves.push({ body: b, t0: time, dur: 1.8, r0: b.R, r1: b.R + 70, color: pc, w: 2 });
  thud(0.12, 500, 0.5, 150);
  arpeggio(SCALE.slice(2, 8), 0.1, 0.07);
  say(`The pod bursts open on ${b.name}`, bodyColor(b));
  saveGame();
}
function drawPods() {
  if (!pods.length) return;
  const s = ship;
  ctx.save();
  for (const p of pods) {
    const pc = podRGB(p), appear = clamp((time - p.born) / 2, 0, 1);
    if (s.tow === p) {
      // the tether: sags toward the local pull while slack, straight and a little brighter when taut
      const mx = (s.x + p.x) / 2, my = (s.y + p.y) / 2, d = Math.hypot(p.x - s.x, p.y - s.y);
      const [gx, gy] = gravityAt(mx, my), g = Math.hypot(gx, gy) || 1, sag = Math.sqrt(Math.max(0, p.slack * p.slack - d * d)) * 0.5;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.quadraticCurveTo(mx + gx / g * sag, my + gy / g * sag, p.x, p.y);
      ctx.strokeStyle = `rgba(${pc},0.12)`; ctx.lineWidth = 4 * px; ctx.stroke();
      ctx.strokeStyle = `rgba(${pc},${p.taut ? 0.9 : 0.7})`; ctx.lineWidth = 1.5 * px; ctx.stroke();
    } else if (!s.tow && time > p.free) {
      // the catch ring: faint from a way off, brightening as your speed comes to match the pod's
      const d = Math.hypot(p.x - s.x, p.y - s.y), v = Math.hypot(p.vx - s.vx, p.vy - s.vy);
      const a = appear * (1 - smooth(clamp((d - 150) / 120, 0, 1))) * (0.06 + 0.34 * smooth(clamp((POD_MATCH * 3 - v) / (POD_MATCH * 2), 0, 1)));
      if (a > 0.01) {
        ctx.beginPath(); ctx.arc(p.x, p.y, POD_HOOK, 0, TAU);
        ctx.strokeStyle = `rgba(${pc},${a * 0.3})`; ctx.lineWidth = 5 * px; ctx.stroke();
        ctx.strokeStyle = `rgba(${pc},${a})`; ctx.lineWidth = 1.1 * px; ctx.stroke();
      }
    }
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = appear;
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(0, 0, p.R * 0.4, 0, 0, p.R * 2.3);
    glow.addColorStop(0, `rgba(${pc},0.22)`);
    glow.addColorStop(1, `rgba(${pc},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(0, 0, p.R * 2.3, 0, TAU); ctx.fill();
    // seeds glowing inside the husk, slowly turning
    ctx.fillStyle = `rgba(${SEED_RGB},0.75)`;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = p.spin * 1.7 + k / 6 * TAU, r = p.R * (0.3 + 0.2 * Math.sin(k * 2.1 + time)), x = Math.cos(a) * r, y = Math.sin(a) * r;
      ctx.moveTo(x + 1.2, y); ctx.arc(x, y, 1.2, 0, TAU);
    }
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // the husk: an outline and a few seams that turn with it
    ctx.strokeStyle = `rgba(${pc},0.85)`;
    ctx.lineWidth = 1.3 * px;
    ctx.beginPath(); ctx.arc(0, 0, p.R, 0, TAU); ctx.stroke();
    ctx.strokeStyle = `rgba(${pc},0.4)`;
    ctx.lineWidth = 1 * px;
    for (let k = 0; k < 3; k++) {
      const ph = p.spin + k / 3 * Math.PI, rx = p.R * Math.abs(Math.cos(ph));
      if (rx < 0.5) continue;
      ctx.beginPath(); ctx.ellipse(0, 0, rx, p.R, 0.5, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

// ===== Shapes: orbits, slingshots, figure-eights =====
// A tracker follows a moving thing's path relative to one body (in that body's moving frame, since the body
// travels too) and recognises shapes: a closed orbit (a full unpowered lap, roughly round, clear of the
// ground), a slingshot (a close unpowered pass that bends the path by over 100°). The ship's tracker also
// spots a figure-eight round a twin pair. Asteroids use it to become moons; the ship's shapes become light.
const newTrack = () => ({ body: null, pts: [], sw: 0, swAll: 0, la: null, enc: null, since: 0, rot0: 0, loops: [], pair: [] });
function trackReset(tr, b) { tr.body = b; tr.pts.length = 0; tr.sw = 0; tr.swAll = 0; tr.la = null; tr.enc = null; tr.since = time; }
// Feed one physics step of `o` around `b` (powered: thrust or a knock this step). Returns a shape or null.
// (a neutron star is so small for its pull that its passes count from further out: see traceR)
const traceR = b => b.kind === 'neutron' ? 26 : b.R;
function trackStep(tr, o, b, powered) {
  let found = null;
  if (b !== tr.body) { if (tr.body) found = endPass(tr, o); trackReset(tr, b); }
  const rx = o.x - b.px, ry = o.y - b.py, d = Math.hypot(rx, ry), a = Math.atan2(ry, rx);
  const da = tr.la === null ? 0 : angleDiff(a, tr.la);
  tr.la = a; tr.swAll += da;
  if (powered) { tr.pts.length = 0; tr.sw = 0; if (tr.enc) tr.enc.powered = true; } else tr.sw += da;
  // a pass: from coming within 3.5 R until leaving again (or another body taking over)
  const passR = traceR(b) * 3.5;
  if (!tr.enc && d < passR) tr.enc = { vx: o.vx - b.pvx, vy: o.vy - b.pvy, minD: d, powered, t0: time, sw0: tr.sw };
  if (tr.enc) { tr.enc.minD = Math.min(tr.enc.minD, d); if (d > passR) found = endPass(tr, o) || found; }
  if (powered) return found;
  const last = tr.pts[tr.pts.length - 1];
  if (!last || Math.abs(tr.sw - last.sw) > 0.04 || Math.abs(d - last.d) > 4) {
    tr.pts.push({ x: rx, y: ry, d, sw: tr.sw, t: time });
    if (tr.pts.length > 600) tr.pts.shift();
    found = lapCheck(tr, b) || found;
  }
  return found;
}
// The newest stretch of path that sweeps a full turn: a closed orbit if it stayed clear of the ground and
// roughly round (farthest under 1.6x nearest). Otherwise the window slides on, so the next clean lap counts.
function lapCheck(tr, b) {
  const pts = tr.pts, end = pts[pts.length - 1];
  let i = pts.length - 1;
  while (i > 0 && Math.abs(end.sw - pts[i].sw) < TAU) i--;
  if (Math.abs(end.sw - pts[i].sw) < TAU) return null;
  let lo = Infinity, hi = 0, sum = 0;
  for (let k = i; k < pts.length; k++) { const d = pts[k].d; lo = Math.min(lo, d); hi = Math.max(hi, d); sum += d; }
  const lap = pts.slice(i + 1);  // just under a full turn, so the ring closes without a notch
  pts.splice(0, i + 1);
  if (lo < b.R * 1.02 || hi / lo > 1.6) return null;
  pts.splice(0, pts.length - 1);  // the next lap starts here
  return { kind: 'orbit', body: b, pts: lap, mean: sum / lap.length };
}
function endPass(tr, o) {
  const e = tr.enc, b = tr.body;
  tr.enc = null;
  if (!e || e.powered || e.minD > traceR(b) * 2.5 || Math.abs(tr.sw - e.sw0) >= TAU) return null;
  const bend = Math.abs(angleDiff(Math.atan2(o.vy - b.pvy, o.vx - b.pvx), Math.atan2(e.vy, e.vx)));
  if (bend < 100 * Math.PI / 180) return null;
  return { kind: 'sling', body: b, pts: tr.pts.filter(p => p.t >= e.t0) };
}
// The body whose pull is strongest here: the one a free thing is really going round.
function dominantBody(x, y) {
  let best = null, g = 0;
  for (const b of bodies) {
    const a = b.gm / Math.max((x - b.px) ** 2 + (y - b.py) ** 2, b.R * b.R);
    if (a > g) { g = a; best = b; }
  }
  return best;
}
// Twin pairs (twin planets, twin moons) circle a shared centre; figure-eights are measured in the pair's
// turning frame, so the eight stays an eight while the pair goes round.
const pairLead = b => bodies.indexOf(b) < bodies.indexOf(b.twin) ? b : b.twin;
const pairCentre = b => b.parent ? [b.parent.px, b.parent.py] : [0, 0];

// ===== Light traces =====
// Fly a shape the tracker knows (an unpowered lap, a slingshot, a figure-eight round twins) and the path
// you just flew lights up round the body, fades over ten seconds, sings a little and sends a few seeds
// flying into the ship. A flourish, not a score: no counters, and each shape is named only the first time.
const TRACE_LIFE = 10;
let shipTrack = newTrack(), traces = [];
function updateShipShapes() {
  const s = ship, tr = shipTrack;
  const leaving = exit && inExitLane(s.x, s.y) && Math.hypot(s.x, s.y) > ARENA_R - 200;
  if (s.landed || warp || leaving) {
    if (tr.body) { trackReset(tr, null); tr.loops.length = 0; tr.pair.length = 0; }
    return;
  }
  const b = dominantBody(s.x, s.y), prev = tr.body;
  if (!b) return;
  // figure-eights: loops round each twin in turn, measured in the pair's frame
  if (prev && b !== prev) {
    if (prev.twin) tr.loops.push({ b: prev, sw: tr.swAll - (pairLead(prev).angle - tr.rot0), t0: tr.since });
    if (tr.loops.length > 2) tr.loops.shift();
  }
  const shape = trackStep(tr, s, b, s.throttle > 0.03 || s.tumble > 0 || (s.tow && s.tow.taut));
  if (prev !== b) tr.rot0 = b.twin ? pairLead(b).angle : 0;
  if (b.twin) {
    const lead = pairLead(b), [cx, cy] = pairCentre(b), c = Math.cos(-lead.angle), sn = Math.sin(-lead.angle);
    const last = tr.pair[tr.pair.length - 1];
    if (!last || time - last.t > 0.06) {
      tr.pair.push({ x: (s.x - cx) * c - (s.y - cy) * sn, y: (s.x - cx) * sn + (s.y - cy) * c, t: time });
      if (tr.pair.length > 600) tr.pair.shift();
    }
    const [l1, l2] = tr.loops, loop = 300 * Math.PI / 180;
    if (l2 && l1.b.twin === l2.b && Math.abs(l1.sw) > loop && Math.abs(l2.sw) > loop && l1.sw * l2.sw < 0) {
      tr.loops.length = 0;
      lightTrace({ kind: 'eight', body: lead, pair: true, pts: tr.pair.filter(p => p.t >= l1.t0) });
    }
  } else { tr.pair.length = 0; tr.loops.length = 0; }
  // a lap round one twin just after looping the other is half of an eight, not an orbit
  if (shape && !(shape.kind === 'orbit' && b.twin && tr.loops.some(l => l.b === b.twin))) lightTrace(shape);
}
const TRACE_GAP = { orbit: 40, sling: 25, eight: 40 }, TRACE_SEEDS = { orbit: 4, sling: 2, eight: 6 };
function lightTrace(shape) {
  const b = shape.body, kind = shape.kind;
  if (shape.pts.length < 4) return;
  b.traceAt = b.traceAt || {};
  if (time - (b.traceAt[kind] ?? -99) < TRACE_GAP[kind]) return;
  b.traceAt[kind] = time;
  const light = w => b.color.map(v => Math.round(mix(v, 255, w))).join(',');
  const color = kind === 'orbit' ? light(0.35) : kind === 'sling' ? light(0.7) : system.palette[2 % system.palette.length].join(',');
  const pts = [];
  for (const p of shape.pts) pts.push(p.x, p.y);
  if (kind === 'orbit') {  // ease the lap's last third onto the height it started at, so the ring closes smoothly
    const P = shape.pts, n = P.length, m = Math.max(2, Math.floor(n / 3)), gap = P[0].d - P[n - 1].d;
    for (let i = n - m; i < n; i++) { const k = 1 + gap * smooth((i - (n - m) + 1) / m) / P[i].d; pts[2 * i] *= k; pts[2 * i + 1] *= k; }
  }
  const t = { kind, body: b, pair: !!shape.pair, pts, t0: time, color };
  // a figure-eight usually also closes a lap round one twin: the eight replaces that ring
  if (kind === 'eight') traces = traces.filter(o => o.pair || (o.body !== b && o.body !== b.twin) || time - o.t0 > 4);
  traces.push(t);
  // a few seeds lift off the trace and fly into the ship
  const n = TRACE_SEEDS[kind], [cx, cy, rot] = traceFrame(t), c = Math.cos(rot), sn = Math.sin(rot);
  for (let i = 0; i < n; i++) {
    const k = 2 * Math.floor((i + 0.5) / n * pts.length / 2), x = pts[k], y = pts[k + 1];
    motes.push(dustMote(cx + x * c - y * sn, cy + x * sn + y * c, b.pvx, b.pvy, { seek: time + 0.9 + i * 0.15, seekNo: i, born: time - 0.8 }));
  }
  if (kind === 'orbit') {
    for (const f of CHORDS[0]) voice(f, 0.025, 4, 0.7, 'triangle');
    arpeggio([SCALE[0], SCALE[2], SCALE[4], SCALE[7]], 0.14, 0.05);
  } else if (kind === 'sling') arpeggio([SCALE[4], SCALE[6], SCALE[8], SCALE[10]], 0.06, 0.05);
  else arpeggio([SCALE[0], SCALE[4], SCALE[7], SCALE[9], SCALE[7], SCALE[4], SCALE[0]], 0.1, 0.05);
  prefs.shapes = prefs.shapes || [];
  if (!prefs.shapes.includes(kind)) {
    prefs.shapes.push(kind);
    savePrefs();
    const other = b.twin ? b.twin.name : '';
    say(kind === 'orbit' ? `A ring of light around ${b.name}` : kind === 'sling' ? `A bright arc past ${b.name}` : `A figure-eight round ${b.name} and ${other}`, `rgb(${color})`);
  }
}
// where a trace sits now: round its body, or for a figure-eight in its twin pair's turning frame
function traceFrame(t) {
  if (t.pair) { const [cx, cy] = pairCentre(t.body); return [cx, cy, t.body.angle]; }
  return [t.body.px, t.body.py, 0];
}

// ===== Making a moon =====
// Real gravity round a small moon is mostly its planet's tide, so a free rock almost never stays in orbit.
// Instead, a nudged rock close to a moon and moving slowly enough to be bound to it (two-body energy below
// zero) is held by that moon alone: the patched-conic approximation, where inside a body's sphere of
// influence only that body pulls (plus the frame following it along its rails). Inside the hold the orbit
// is a clean ellipse, drawn faintly so you can see where a nudge sends it. A rock is caught a little way out
// past the hold (HOLD_CATCH), where its ellipse already shows, and eased in: generous, since the tide makes a
// real capture nearly impossible to aim. Whether it's slow enough is judged in the frame turning with the
// moon round its planet (as in the real three-body capture problem), so a rock drifting alongside the moon on
// its orbit counts as nearly still, and a gentle nudge toward the moon is caught.
const HOLD_CATCH = 1.6;
function holdRadius(b) {
  // a garden moon on its own orbit (not the middle of the system, a moonlet, a black hole or a gas giant)
  if (b.barren || !b.orbit || b.R < 12 || b.made || (b.parent && !b.parent.anchor)) return 0;
  const M = b.omegaMass ?? (b.parent ? b.parent.mass : system.centralMass), D = b.omegaDist ?? b.orbit;
  let r = clamp(D * Math.cbrt(b.mass / (3 * M)) * 0.8, b.R * 2.2, b.R * 3.5);  // most of its Hill sphere
  for (const o of bodies) {  // and clear of its moonlets and its twin
    if (o.parent === b) r = Math.min(r, o.orbit - o.R - 12);
    if (o === b.twin) r = Math.min(r, b.omegaDist / 2.5);  // twin moons are too close together; twin planets have room
  }
  return r >= b.R + 27 ? r : 0;  // (room for a made moon with clear space round it, see madeOrbit)
}
// A made moon's radius, and the least orbit it may have round its host: clear space of about 15 between them
// (inside the hold, below where the catch lets go), so it never touches or hugs its host. The assist lifts a
// lower one gently (circularise).
const madeR = k => clamp(k.R + 1, 9, 11);
const madeOrbit = (k, h) => Math.min(h.R + madeR(k) + 15, h.holdR * 0.9 - 1);
function holdOf(k) {
  for (const b of bodies) {
    if (!b.holdR) continue;
    const rx = k.x - b.px, ry = k.y - b.py, d2 = rx * rx + ry * ry;
    const reach = b.holdR * (k.held === b ? HOLD_CATCH + 0.1 : HOLD_CATCH);  // (a little slack, so it can't flicker at the edge)
    if (d2 >= reach * reach) continue;
    const vx = k.vx - b.pvx, vy = k.vy - b.pvy, wx = vx + b.omega * ry, wy = vy - b.omega * rx;  // (w: in the turning frame)
    if (Math.min(vx * vx + vy * vy, wx * wx + wy * wy) / 2 < b.gm / Math.sqrt(d2)) return b;
  }
  return null;
}
// the acceleration of a body riding its rails, so a held rock moves along with it
function railAcc(b) {
  if (!b.orbit) return [0, 0];
  const w2 = b.omega * b.omega, [ax, ay] = b.parent ? railAcc(b.parent) : [0, 0];
  return [ax - Math.cos(b.angle) * b.orbit * w2, ay - Math.sin(b.angle) * b.orbit * w2];
}
// the two-body ellipse of o round b: semi-major axis, eccentricity, periapsis direction; null if unbound
function relOrbit(o, b) {
  const rx = o.x - b.px, ry = o.y - b.py, vx = o.vx - b.pvx, vy = o.vy - b.pvy, r = Math.hypot(rx, ry), mu = b.gm;
  const E = (vx * vx + vy * vy) / 2 - mu / r;
  if (E >= 0) return null;
  const a = -mu / (2 * E), h = rx * vy - ry * vx, ex = vy * h / mu - rx / r, ey = -vx * h / mu - ry / r, e = Math.min(0.99, Math.hypot(ex, ey));
  return { a, e, ang: Math.atan2(ey, ex), peri: a * (1 - e), apo: a * (1 + e) };
}
// how far a held rock's velocity is from a circular orbit at its height (0 = perfectly round)
function roundness(k, h) {
  const rx = k.x - h.px, ry = k.y - h.py, d = Math.hypot(rx, ry), vc = Math.sqrt(h.gm / d);
  const sense = Math.sign(rx * (k.vy - h.pvy) - ry * (k.vx - h.pvx)) || 1;
  return Math.hypot(k.vx - h.pvx + ry / d * vc * sense, k.vy - h.pvy - rx / d * vc * sense) / vc;
}
// The hidden assist, from the moment it's on a safe orbit: ease the rock toward a circular orbit at its height,
// over half a lap or so (the rate follows its own orbit speed), so a lopsided orbit still becomes a moon. One
// that's too low (it would hug its host) is also lifted gently, a few units a second, until it has clear space.
function circularise(k, h, dt) {
  const rx = k.x - h.px, ry = k.y - h.py, d = Math.hypot(rx, ry), vc = Math.sqrt(h.gm / d);
  const sense = Math.sign(rx * (k.vy - h.pvy) - ry * (k.vx - h.pvx)) || 1, f = Math.min(1, 0.8 * vc / d * dt);
  const up = clamp((madeOrbit(k, h) + 1 - d) * 0.8, 0, 4);  // (aiming a little above, so it gets there)
  k.vx += (h.pvx - ry / d * vc * sense + rx / d * up - k.vx) * f;
  k.vy += (h.pvy + rx / d * vc * sense + ry / d * up - k.vy) * f;
}
// A rock coasting into a moon's hold would coast straight out again (or into the ground): with nothing to
// take energy away, two-body orbits can't capture. So while its orbit would escape the hold or hit the
// ground, its in-and-out motion is damped, the way a tug of thin dust would, and it settles in: caught out
// past the hold it's drawn in over a few seconds, heading for the ground it's eased sideways toward orbit
// speed (so it swings round instead), and too fast to stay it's eased down toward orbit speed.
function catchSoftly(k, h, dt) {
  const rx = k.x - h.px, ry = k.y - h.py, d = Math.hypot(rx, ry), ux = rx / d, uy = ry / d;
  const wx = k.vx - h.pvx, wy = k.vy - h.pvy, vr = wx * ux + wy * uy, f = Math.min(1, 3 * dt);
  // its low point round the moon, bound or not (caught, it may still be too fast to stay)
  const L = rx * wy - ry * wx, E = (wx * wx + wy * wy) / 2 - h.gm / d, e = Math.sqrt(Math.max(0, 1 + 2 * E * L * L / (h.gm * h.gm)));
  const low = L * L / (h.gm * (1 + e)) < h.R + k.R * 1.2;
  if (E < 0 && -h.gm / E - L * L / (h.gm * (1 + e)) < h.holdR * 0.92 && !low) return;  // (its high point is inside the hold)
  const sink = -clamp(d - h.holdR * 0.85, 0, 10);  // the in-and-out speed it's eased to (drawn in from past the hold)
  k.vx -= ux * (vr - sink) * f; k.vy -= uy * (vr - sink) * f;
  const sense = Math.sign(rx * wy - ry * wx) || 1, vt = (wy * ux - wx * uy) * sense, vc = Math.sqrt(h.gm / d);
  const g = Math.min(1, (vt < vc ? (low ? 2.5 : 0) : 1) * dt);
  k.vx -= uy * sense * (vc - vt) * g; k.vy += ux * sense * (vc - vt) * g;
}
// The rock becomes a real moonlet on rails round its moon: landable, seedable, saved like any other body.
function makeMoon(i) {
  const k = rocks[i], h = k.held, rx = k.x - h.px, ry = k.y - h.py, d = Math.hypot(rx, ry);
  const dir = Math.sign(rx * (k.vy - h.pvy) - ry * (k.vx - h.pvx)) || 1;
  removeAt(rocks, i);
  const R = madeR(k), used = new Set(allBodies.map(b => b.name));
  const free = NAMES.filter(n => !used.has(n)), name = free.length ? pick(free) : pick(NAMES);
  // the theme colour the fewest bodies here wear, lightened if every one is taken
  const theme = THEMES.find(t => t.name === system.theme) || THEMES[0];
  const wearing = c => bodies.filter(b => b.color && b.color.join() === c.join()).length;
  const base = theme.colors.slice().sort((a, b) => wearing(a) - wearing(b))[0];
  const color = wearing(base) ? base.map(v => Math.round(mix(v, 255, 0.45))) : base.slice();
  const angle = Math.atan2(ry, rx);
  const b = {
    name, R, mass: moonMass(R), orbit: d, start: angle, angle, dir, parent: h, made: true, madeAt: time,
    color, accents: [...theme.colors.filter(c => c !== base).map(c => c.join(',')), ...(theme.extra || []), '255,250,230'],
    plants: [], maxPlants: Math.max(8, Math.round(TAU * R / 4)), glow: null, bloomed: false,
    spin: 0, spinRate: TAU / rand(80, 150) * (Math.random() < 0.8 ? 1 : -1), barren: false, softR: R,
  };
  // the moonlet rule from buildSystem: it must hold you against its parent's tidal pull
  b.mass = Math.max(b.mass, 4 * h.mass * ((R + FOOT) / d) ** 3);
  allBodies.push(b); bodies.push(b); gardens.push(b);
  for (const o of bodies) o.holdR = holdRadius(o);
  updateBodies(0);
  // the moment: a ring of light, the rock's dust flying off, a chord, its name
  const own = color.join(','), light = color.map(v => Math.round(mix(v, 255, 0.5))).join(',');
  // (rings round the host from the new orbit outward, so none crosses the host)
  waves.push({ body: h, t0: time, dur: 2.6, r0: d, r1: d + 120, color: own, w: 2.2 });
  waves.push({ body: h, t0: time + 0.35, dur: 2.2, r0: d, r1: d + 60, color: light, w: 1.3 });
  waves.push({ body: b, t0: time + 0.1, dur: 1.6, r0: R, r1: R + (d - h.R - R) * 0.8, color: light, w: 1.2 });
  burst(b.px, b.py, 26, { vx: b.pvx, vy: b.pvy, speed: [15, 70], life: [0.5, 1.2], color: '185,195,225' });
  burst(b.px, b.py, 30, { vx: b.pvx, vy: b.pvy, speed: [20, 90], life: [0.8, 1.6], color: own, size: 2.2 });
  for (const f of CHORDS[0]) voice(f, 0.03, 5, 0.9, 'triangle');
  voice(CHORDS[0][0] / 2, 0.05, 5, 0.8);
  arpeggio([SCALE[0], SCALE[4], SCALE[7], SCALE[9], SCALE[10]], 0.13, 0.06);
  say(`A new moon: ${name}`, `rgb(${own})`);
  saveGame();
}
// Hints, kept quiet: a nudged rock near a moon shows the orbit it's on as a faint dashed ellipse (fainter
// still if it would hit the ground or slip out of reach), gold once it has flown one good lap. A new moon
// wears a soft gold ring for a while, like anything new.
function drawMoonHints() {
  ctx.save();
  ctx.lineWidth = 1.2 * px;
  for (const k of rocks) {
    if (!k.nudged) continue;
    // (from as soon as it's nearly bound to a moon, so you see a nudge working)
    const h = k.held || bodies.find(b => b.holdR && Math.hypot(k.x - b.px, k.y - b.py) < b.holdR * 2);
    const o = h && relOrbit(k, h);
    if (!o) continue;
    const off = o.peri < h.R + k.R * 0.6 || o.apo > h.holdR;
    ctx.strokeStyle = k.lap ? 'rgba(255,214,130,0.55)' : `rgba(200,215,255,${off ? 0.17 : 0.32})`;
    ctx.setLineDash(k.lap ? [5 * px, 5 * px] : [3 * px, 6 * px]);
    ctx.lineDashOffset = -time * (k.lap ? 12 : 6) * px;
    const cx = h.px - Math.cos(o.ang) * o.a * o.e, cy = h.py - Math.sin(o.ang) * o.a * o.e;
    ctx.beginPath(); ctx.ellipse(cx, cy, o.a, o.a * Math.sqrt(1 - o.e * o.e), o.ang, 0, TAU); ctx.stroke();
  }
  ctx.setLineDash([6 * px, 6 * px]);
  ctx.lineDashOffset = -time * 10 * px;
  for (const b of bodies) {
    const age = b.madeAt === undefined ? 99 : time - b.madeAt;
    if (age > 14) continue;
    ctx.strokeStyle = `rgba(255,214,130,${clamp(Math.min(age, 14 - age) / 2, 0, 1) * (0.35 + 0.2 * Math.sin(time * 3))})`;
    ctx.beginPath(); ctx.arc(b.px, b.py, b.R + 9, 0, TAU); ctx.stroke();
  }
  ctx.restore();
}
function drawTraces() {
  if (!traces.length) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const t of traces) {
    const age = time - t.t0, fade = (1 - age / TRACE_LIFE) ** 1.5, n = Math.max(2, Math.ceil(t.pts.length / 2 * smooth(clamp(age / 1.2, 0, 1))));
    if (fade <= 0) continue;
    const [cx, cy, rot] = traceFrame(t);
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(rot);
    ctx.beginPath();
    for (let i = 0; i < n; i++) i ? ctx.lineTo(t.pts[2 * i], t.pts[2 * i + 1]) : ctx.moveTo(t.pts[0], t.pts[1]);
    if (t.kind === 'orbit' && n * 2 >= t.pts.length) ctx.closePath();
    // (kept well under the ship's brightness)
    ctx.strokeStyle = `rgba(${t.color},${0.06 * fade})`; ctx.lineWidth = 8 * px; ctx.stroke();
    ctx.strokeStyle = `rgba(${t.color},${0.13 * fade})`; ctx.lineWidth = 3.5 * px; ctx.stroke();
    ctx.strokeStyle = `rgba(${t.color},${0.48 * fade})`; ctx.lineWidth = 1.3 * px; ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

// ===== Rogue planet =====
// A world bound to nothing: it drifts in from past the edge on a slow, gently wandering path (its turn eases
// one way and then the other), crosses the system and leaves, and a minute or two later comes back on another.
// It's always moving: slow in the open, quicker across the moons' orbits and past the edge. It rides rails (a
// path, and a speed rule that doesn't depend on you), so the dotted line can step it, and each path is flown
// ahead against every body's rails before it's taken, so it never runs into anything. It never carries you
// out of the system: with you on board near the edge it turns back in. A bonus garden like a moon you made:
// landable and seedable, but never needed for "everything blooms". In full bloom it lets you off with a breath
// of petals, then sails out of the system on its flowers, trailing petals, and doesn't come back (another,
// bare one may wander in some while later).
const ROGUE_OUT = ARENA_R + 80;          // its paths begin and end this far from the middle
const ROGUE_LANE = 7, ROGUE_BAND = 20;   // its speed in the open, and crossing orbits (or the edge)
const ROGUE_SAIL = 90;                   // sailing off on its flowers
const ROGUE_EASE = 0.8;                  // how quickly it changes speed (per second)
const ROGUE_K = [1, 0.8, 1.25, 0.65, 1.5];  // overall paces to try, when the first won't keep clear
const RG = [0, 0, 0, 0];                 // rogueAt's answer: x, y and the unit direction of travel
let rogue = null;
function makeRogue(id, saved) {
  const R = id.R, mass = moonMass(R) * 1.6, b = {
    name: id.name, R, mass, gm: cfg.gravity * mass, orbit: 0, angle: 0, omega: 0, dir: 1, parent: null, twin: null,
    color: id.color, accents: id.accents, rogue: true, barren: false, softR: R, holdR: 0,
    plants: ((saved && saved.plants) || []).map(([a, h, kind, tip, flip, sway]) => ({ a, h, kind, tip, flip, sway, grow: 1 })),
    maxPlants: Math.max(8, Math.round(TAU * R / 4)), glow: null, bloomed: !!(saved && saved.bloomed),
    spin: saved ? saved.spin || 0 : 0, spinRate: saved && saved.spinRate ? saved.spinRate : TAU / rand(70, 110) * pick([-1, 1]),
    px: 0, py: 0, pvx: 0, pvy: 0, petalAcc: 0, ready: 0,
    // on its path: `s` units along it at `rate` units a second; or away for another `away` seconds
    present: false, s: 0, rate: ROGUE_LANE, away: saved ? saved.away ?? 30 : rand(20, 45), arcs: saved ? saved.arcs || 0 : 0,
    arc: null, path: null,
  };
  if (saved && saved.present && saved.arc && saved.arc.w) {
    rogueBuild(b, saved.arc);
    Object.assign(b, { present: true, s: saved.s || 0, rate: saved.rate ?? ROGUE_LANE });
    bodies.push(b); gardens.push(b);
    rogueMove(b);
  } else if (saved && saved.present) b.away = rand(4, 10);  // (an older save's arc: it drifts back in on a new path)
  return b;
}
function rogueSave(r) {
  const b = rogue;
  return {
    present: b.present, s: r(b.s, 100), rate: r(b.rate, 100), away: r(b.away, 10), arcs: b.arcs, arc: b.present ? b.arc : undefined,
    spin: r(b.spin % TAU, 1000), spinRate: b.spinRate, bloomed: b.bloomed,
    plants: b.plants.map(p => [r(p.a, 1000), r(p.h, 10), p.kind, p.tip, p.flip, r(p.sway, 100)]),
  };
}
// how much room a body needs (a black hole's disk, a gas giant's rings, a sun's corona)
const rogueRoom = o => o.R + (o.kind === 'hole' ? o.R * 4.4 : o.kind === 'gas' ? o.R * 0.9 : o.kind === 'sun' ? 30 : o.kind === 'neutron' ? 60 : 0);
// The rings round the middle it hurries across: every body's orbit (a moonlet's widened by its own), merged.
function rogueBands(R) {
  const bands = [];
  for (const o of bodies) {
    if (o.rogue) continue;
    let wob = 0, top = o;
    while (top.parent) { wob += top.orbit; top = top.parent; }
    const w = wob + rogueRoom(o) + R + 12;
    bands.push([Math.max(0, top.orbit - w), top.orbit + w]);
  }
  bands.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const b of bands) {
    const m = merged[merged.length - 1];
    if (m && b[0] < m[1] + 14) m[1] = Math.max(m[1], b[1]); else merged.push(b.slice());
  }
  return merged;
}
// A path, as a table of points with the distance along it: from (x, y) heading h, turning by a curvature that
// wanders (two slow waves, w = [size, length, phase] twice) plus `bias` easing off over the first `bl` units,
// until it's out past ROGUE_OUT again. Also the stretches where it crosses orbits, and where it last passes
// the edge on its way out. The same arc always builds the same path (a save keeps only the arc).
function rogueBuild(b, arc) {
  const ds = 6, xs = [], ys = [], ss = [], bands = rogueBands(b.R), zones = [], [a1, l1, p1, a2, l2, p2] = arc.w;
  let x = arc.x, y = arc.y, h = arc.h, len = 0, zone = null, inside = false, edge = 0, done = false;
  for (let i = 0; i < 700; i++) {
    const r = Math.hypot(x, y);
    xs.push(x); ys.push(y); ss.push(len);
    const inBand = bands.some(([a, z]) => r > a && r < z);
    if (inBand && !zone) zones.push(zone = [i ? ss[i - 1] : 0, len]);
    else if (inBand) zone[1] = len;
    else if (zone) { zone[1] = len; zone = null; }
    if (r < ARENA_R - 40) inside = true;
    if (r < ARENA_R - 30) edge = len;
    if (inside && r > ROGUE_OUT) { done = true; break; }
    const fl = arc.f ? arc.f[0] * Math.sin(len / arc.f[1] + arc.f[2]) : 0;  // the flower engine's flutter
    // a sailing arc's victory lap: a long curve round the middle, then one tight loop-the-loop, then away
    const lap = arc.lap ? (len < arc.lap[1] ? arc.lap[0] : len < arc.lap[1] + arc.lap[3] ? arc.lap[2] : 0) : 0;
    h += (a1 * Math.sin(len / l1 + p1) + a2 * Math.sin(len / l2 + p2) + fl + lap + arc.bias * Math.max(0, 1 - len / arc.bl)) * ds;
    x += Math.cos(h) * ds; y += Math.sin(h) * ds; len += ds;
  }
  b.arc = arc;
  b.path = { xs: Float64Array.from(xs), ys: Float64Array.from(ys), ss: Float64Array.from(ss), len, zones, edge, done };
}
// where it is s units along its path (into RG)
function rogueAt(b, s) {
  const { xs, ys, ss } = b.path;
  let lo = 0, hi = ss.length - 1;
  s = clamp(s, 0, ss[hi]);
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ss[m] <= s) lo = m; else hi = m; }
  const seg = ss[hi] - ss[lo] || 1, t = (s - ss[lo]) / seg, dx = xs[hi] - xs[lo], dy = ys[hi] - ys[lo];
  RG[0] = xs[lo] + dx * t; RG[1] = ys[lo] + dy * t; RG[2] = dx / seg; RG[3] = dy / seg;
  return RG;
}
function rogueMove(b) {
  rogueAt(b, b.s);
  b.px = RG[0]; b.py = RG[1]; b.pvx = RG[2] * b.rate; b.pvy = RG[3] * b.rate;
}
// the next orbit crossing that hasn't been passed yet (or the one it's in)
function rogueZone(b, s) {
  for (const z of b.path.zones) if (z[1] > s) return z;
  return null;
}
// One step along its path for state st ({ s, rate }: the rogue itself, or the prediction's or the plan's copy
// of it). The speed it eases toward depends only on where it is on its path, so this is deterministic.
function rogueStep(b, st, dt) {
  const a = b.arc, z = rogueZone(b, st.s);
  rogueAt(b, st.s);
  const v = a.sail ? ROGUE_SAIL : (z && z[0] <= st.s || RG[0] * RG[0] + RG[1] * RG[1] > (ARENA_R - 20) ** 2 ? ROGUE_BAND : ROGUE_LANE) * a.k;
  st.rate += (v - st.rate) * (1 - Math.exp(-(a.sail ? ROGUE_EASE * 0.5 : ROGUE_EASE) * dt));
  st.s += st.rate * dt;
}
// Would it keep clear of every body, flying its whole path from s at `rate`? It flies it ahead in 1/20 s
// steps against the bodies' rails (with some room to spare for the finer steps it really takes).
function rogueClear(b, s, rate) {
  const st = { s, rate }, dt = 1 / 20, others = bodies.filter(o => !o.rogue);
  for (let t = dt; st.s < b.path.len; t += dt) {
    if (t > 400) return false;
    rogueStep(b, st, dt);
    rogueAt(b, st.s);
    const x = RG[0], y = RG[1];
    if (x * x + y * y > (ARENA_R + 60) ** 2) continue;  // out past the edge nothing's in the way
    for (const o of others) {
      const [ox, oy] = bodyPos(o, t);
      if (Math.hypot(x - ox, y - oy) < b.R + rogueRoom(o) + 12) return false;
    }
  }
  return true;
}
// Picks a path: make(i) gives the i-th arc to try. Takes the first that comes out the far side and keeps
// clear of everything (and passes ok(), if given); failing that (unless `strict`: there's time to try again
// later), the first that passes ok(). With none, it keeps the path it had and says false.
function roguePlan(b, make, rate, ok, strict, tries = 24) {
  const was = { arc: b.arc, path: b.path };
  let fallback = null;
  for (let i = 0; i < tries; i++) {
    rogueBuild(b, make(i % 24));
    if (!b.path.done || (ok && !ok(b.path))) continue;
    if (rogueClear(b, 0, rate)) return true;
    fallback = fallback || b.arc;
  }
  if (fallback && !strict) { rogueBuild(b, fallback); return true; }
  if (was.arc) { b.arc = was.arc; b.path = was.path; }
  return false;
}
// a curvature that wanders gently (the last few tries plain, in case nothing wavier will do)
const rogueWander = (i, f = 1) => i >= 20 ? [0, 1, 0, 0, 1, 0] :
  [rand(0.6, 1.5) / 400 * f * pick([-1, 1]), rand(120, 220), rand(0, TAU), rand(0.4, 0.9) / 400 * f * pick([-1, 1]), rand(260, 420), rand(0, TAU)];
// where it is and which way it's heading now, and which way is in toward the middle (+1: turning left)
function rogueHeading(b) {
  rogueAt(b, b.s);
  return { x: RG[0], y: RG[1], h: Math.atan2(RG[3], RG[2]), inward: Math.sign(RG[0] * RG[3] - RG[1] * RG[2]) || 1 };
}
function updateRogue(dt) {
  const b = rogue;
  if (!b) return;
  b.gm = cfg.gravity * b.mass;
  b.spin += b.spinRate * dt;
  for (const pl of b.plants) {
    if (pl.delay > 0) pl.delay -= dt;
    else if (pl.grow < 1) pl.grow = Math.min(1, pl.grow + dt * 1.2);
  }
  if (!b.present) {
    b.away -= dt;
    if (b.away <= 0 && !warp) rogueArrive(b);
    return;
  }
  const s = ship, aboard = s.landed === b;
  if (b.bloomed && !b.arc.sail) {
    // in full bloom it's ready to sail, and goes once you're clear of it (still on board after a while, it
    // lets you off itself)
    if (aboard) {
      b.ready += dt;
      if (b.ready > 3 && !b.readySaid) { b.readySaid = true; say(`${b.name}'s flower engine is ready. Take off to see it off`, bodyColor(b)); }
      if (b.ready > 12) rogueLetGo(b);
    }
    else if (time - (b.letGoAt ?? -9) > 1.5 && altitudeOver(b, s.x, s.y) > 35 && time - (b.sailTry ?? -9) > 1) rogueSail(b);
  } else if (aboard && b.arc.sail) rogueLetGo(b);  // (caught it as it sailed? it lets you off at once)
  // with you on board it doesn't leave: nearing the edge, it turns back in
  if (s.landed === b && b.s > b.path.edge - 160 && time - (b.turnAt ?? -9) > 1) rogueTurnBack(b);
  rogueStep(b, b, dt);
  if (b.s >= b.path.len) { rogueLeave(b); return; }
  rogueMove(b);
  // in bloom it sheds petals behind it, drifting where they fall like a comet's dust (a stream as it sails)
  if (b.bloomed) {
    const sail = b.arc.sail;
    b.petalAcc += dt * (sail ? 50 : 14);
    while (b.petalAcc >= 1) {
      b.petalAcc -= 1;
      const a = Math.atan2(-RG[3], -RG[2]) + rand(-0.9, 0.9) * (sail ? 0.6 : 1), sp = rand(4, 14), keep = sail ? 0.15 : 0.4;
      const col = Math.random() < 0.6 ? b.color.join(',') : pick(b.accents);
      particles.push({ x: b.px + Math.cos(a) * b.R, y: b.py + Math.sin(a) * b.R, vx: b.pvx * keep + Math.cos(a) * sp, vy: b.pvy * keep + Math.sin(a) * sp, life: rand(3, 5), max: 5, color: col, size: rand(2, 3), grav: false });
    }
  }
}
function rogueArrive(b) {
  const last = b.arc ? Math.atan2(b.arc.y, b.arc.x) : null;
  roguePlan(b, i => {
    let th = rand(0, TAU);
    for (let j = 0; j < 12 && last !== null && Math.abs(angleDiff(th, last)) < 1.3; j++) th = rand(0, TAU);  // a new way in each visit
    return { x: Math.cos(th) * ROGUE_OUT, y: Math.sin(th) * ROGUE_OUT, h: th + Math.PI + rand(-0.6, 0.6), w: rogueWander(i), bias: 0, bl: 1, k: ROGUE_K[i % 5], sail: false };
  }, ROGUE_BAND);
  Object.assign(b, { present: true, s: 0, rate: ROGUE_BAND, ready: 0 });
  b.arcs++;
  bodies.push(b); gardens.push(b);
  rogueMove(b);
  say(b.arcs === 1 ? `A rogue planet drifts in: ${b.name}` : b.bloomed ? `${b.name} wanders back in, trailing petals` : `${b.name} wanders back in`, bodyColor(b));
  voice(SCALE[0] / 2, 0.05, 4, 0.8); voice(SCALE[4], 0.02, 4, 1.2, 'triangle');  // a low, slow swell
}
// Near the edge with you on board, it bends back in toward the middle (from right where it is, as it's going).
function rogueTurnBack(b) {
  const { x, y, h, inward } = rogueHeading(b);
  b.turnAt = time;
  const back = roguePlan(b, i => ({ x, y, h, w: rogueWander(i, 0.6), bias: inward / rand(45, 80), bl: rand(200, 300), k: ROGUE_K[i % 5], sail: false }), b.rate, P => P.edge > 250, b.s < b.path.edge - 70, 48);
  if (back) b.s = 0;
}
// A breath of petals lifts you clear (straight up from where you stand, a little faster than its pull can
// hold you), so it can sail.
function rogueLetGo(b) {
  const s = ship, la = s.landAngle, nx = Math.cos(la), ny = Math.sin(la), [svx, svy] = surfaceVel(b, la);
  const up = Math.max(16, 1.3 * Math.sqrt(2 * b.gm / (b.R + FOOT)));
  Object.assign(s, { landed: null, holdSeeds: false, liftedAt: time, airborne: false, slide: b, x: s.x + nx, y: s.y + ny, vx: svx + nx * up, vy: svy + ny * up });
  b.ready = 0; b.letGoAt = time;
  const petals = { vx: svx, vy: svy, dir: la, spread: 1.6, speed: [15, 45], life: [1, 2], size: 2.6 };
  burst(s.x - nx * FOOT, s.y - ny * FOOT, 18, { ...petals, color: b.color.join(',') });
  burst(s.x - nx * FOOT, s.y - ny * FOOT, 8, { ...petals, color: pick(b.accents) });
  thud(0.06, 1600, 0.6, 400);  // a soft whoosh
  say(`${b.name} lets you go. It's ready to sail`, bodyColor(b));
}
// The flower engine: from where it is, it sails out of the system, picking up speed, on a path that keeps clear
// of you. Not the shortest way: a flower engine is a whimsical thing. It flies a victory lap first, a long
// curve most of the way round the middle, then one tight loop-the-loop, and only then wanders off, fluttering
// side to side as it goes. Grander paths are tried first; ones that would run into anything are passed over,
// down to a plain curve if nothing else will do. A chord, and it's off. (If no path keeps clear of you yet, it
// tries again in a moment.)
function rogueSail(b) {
  b.sailTry = time;
  const { x, y, h, inward } = rogueHeading(b), s = ship;
  const clearOfShip = P => { for (let i = 0; i < P.xs.length && P.ss[i] < 300; i++) if (Math.hypot(P.xs[i] - s.x, P.ys[i] - s.y) < b.R + 30) return false; return true; };
  const wild = i => i < 12 ? 1 : i < 20 ? 0.5 : 0;  // the first tries wildest, the last few plain
  if (!roguePlan(b, i => {
    const lap = i < 16 ? victoryLap(x, y, h, inward) : undefined;
    return {
      x, y, h, w: rogueWander(i, lap ? 0.4 : 0.3 + 2.2 * wild(i)), bias: lap ? 0 : (i % 3 ? inward : -inward) / rand(60, 110) * (0.5 + wild(i)), bl: rand(260, 460) * (0.5 + wild(i) / 2), k: 1, sail: true,
      f: wild(i) ? [rand(0.007, 0.013) * wild(i) * pick([-1, 1]), rand(28, 48), rand(0, TAU)] : undefined, lap,
    };
  }, b.rate, clearOfShip)) return;
  b.s = 0;
  for (const f of CHORDS[0]) voice(f * 2, 0.03, 4.5, 0.4, 'triangle');
  voice(CHORDS[0][0] / 2, 0.05, 5, 0.6);
  arpeggio(SCALE.slice(3, 9), 0.08, 0.06);
  burst(b.px, b.py, 30, { vx: b.pvx, vy: b.pvy, speed: [20, 70], life: [1, 2], color: b.color.join(','), size: 2.6 });
  say(`${b.name} ${pick(['sails', 'blasts'])} off on its flower engine`, bodyColor(b));
}
// A victory lap from (x, y) heading h: [curvature, length] of a curve 230-320° round toward the middle, on a
// circle that stays well inside the edge, then [curvature, length] of one tight loop (the other way, mostly).
function victoryLap(x, y, h, inward) {
  let R = rand(120, 240);
  for (let k = 0; k < 6; k++) {  // shrink it till the whole circle fits inside
    const cx = x - Math.sin(h) * inward * R, cy = y + Math.cos(h) * inward * R;
    if (Math.hypot(cx, cy) + R < ARENA_R - 70) break;
    R *= 0.8;
  }
  const r = rand(32, 50), way = Math.random() < 0.75 ? -inward : inward;
  return [inward / R, R * rand(4, 5.6), way / r, TAU * r];
}
function rogueLeave(b) {
  if (ship.landed === b) rogueLetGo(b);  // (it shouldn't carry you out, but never leave you standing on nothing)
  b.present = false; b.away = rand(70, 130);
  bodies.splice(bodies.indexOf(b), 1); gardens.splice(gardens.indexOf(b), 1);
  if (cam.focus === b) cam.focus = gardens[0];
  for (let i = fireflies.length - 1; i >= 0; i--) if (fireflies[i].body === b) removeAt(fireflies, i);
  if (shipTrack.body === b) trackReset(shipTrack, null);
  if (b.arc.sail) {
    // gone for good: another, bare one may wander in a good while later, under its own name
    const used = new Set([...allBodies.map(o => o.name), b.name]);
    system.identity.rogue = { ...system.identity.rogue, name: pick(NAMES.filter(n => !used.has(n))) || b.name, R: rand(15, 19) };
    rogue = makeRogue(system.identity.rogue, { away: rand(120, 200), arcs: 0 });
    saveGame();
    return;
  }
  say(b.bloomed ? `${b.name} drifts on, trailing petals. It will be back` : `${b.name} drifts on. It will be back`, bodyColor(b));
}
// A dark wanderer: a short wake behind it, bending gently the way its arc turns, thinning and fading out.
function drawRogueTrail(b) {
  const n = 8, L = b.R * 1.8, [r, g, bl] = b.color;
  rogueAt(b, b.s); const hx = RG[2], hy = RG[3];
  rogueAt(b, Math.max(0, b.s - 60));
  const turn = Math.sign(hx * RG[3] - hy * RG[2]) || 1, nx = hy * turn, ny = -hx * turn;  // toward the inside of its turn, as the path behind it lies
  ctx.save();
  ctx.lineCap = 'round';
  let x0 = b.px - hx * b.R, y0 = b.py - hy * b.R;
  for (let k = 1; k <= n; k++) {
    const u = k / n, back = b.R + L * u, side = b.R * 0.35 * u * u;
    const x1 = b.px - hx * back + nx * side, y1 = b.py - hy * back + ny * side;
    ctx.strokeStyle = `rgba(${r},${g},${bl},${0.2 * (1 - u) ** 1.5 * (0.5 + 0.5 * b.fade)})`;
    ctx.lineWidth = (1.4 - 0.8 * u) * px;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    x0 = x1; y0 = y1;
  }
  ctx.restore();
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
// A towed pod is stepped along with the ship on its tether, so the line includes its tug. With `seed` it
// predicts a thrown seed instead: gravity only (seeds don't ride currents or calm clouds), finer steps, up to
// its lifetime, ending where it comes down on any body (`impact.body`) or leaves the system (`escape`).
const predictPos = [], predOx = [], predOy = [], predC = [], predS = [], predParent = [], predAir = [], predGey = [], predTakes = [], predDense = [];
// Close to a compact body (a neutron star, a black hole, a dwarf star) the pull turns faster than a 1/30 s step
// can follow: within the distance where an orbit would take under about five seconds (gm / d^3 above 1.44),
// the step is taken in pieces as short as the flight's own, with that body's pull re-taken each time.
// (Stepped this way, a speed really belongs half a step before its position. So whenever the step length
// changes, the speed is moved on to the new half step first, or a fast pass would come out of the switch a
// little off and the slingshot would magnify it.)
const DENSE_W2 = 1.44;
// What a touchdown at (x, y) moving at (vx, vy) would be, on body b (at bx, by moving at bvx, bvy): the speed
// relative to the ground under you, and on a fast-spinning world whether it would be a skid instead.
function touchdown(b, bx, by, bvx, bvy, x, y, vx, vy) {
  const dx = x - bx, dy = y - by, d = Math.hypot(dx, dy) || 1, nx = dx / d, ny = dy / d, w = b.spinRate * (b.R + FOOT);
  const rvx = vx - bvx + ny * w, rvy = vy - bvy - nx * w, speed = Math.hypot(rvx, rvy);
  const lands = speed <= cfg.landSpeed && !(b.fast && Math.abs(rvy * nx - rvx * ny) > SKID_MIN);
  const skid = !lands && b.fast && -(rvx * nx + rvy * ny) <= cfg.landSpeed;
  return { x, y, speed, skid, barren: b.barren };
}
function predict(o = ship, seed = false) {
  const pts = [], dt = seed ? 1 / 60 : 1 / 30, n = allBodies.length;
  let pod = seed ? null : ship.tow;  // (until it would smash into a garden and burst: then the line flies on without it)
  for (let k = 0; k < n; k++) {
    const b = allBodies[k];
    predOx[k] = Math.cos(b.angle) * b.orbit; predOy[k] = Math.sin(b.angle) * b.orbit;
    predC[k] = Math.cos(b.omega * dt); predS[k] = Math.sin(b.omega * dt);
    predParent[k] = b.parent ? allBodies.indexOf(b.parent) : -1;
    const near = b.anchor ? 0 : Math.cbrt(b.gm / DENSE_W2);
    predDense[k] = near > b.R + FOOT ? near * near : 0;  // (only bodies small for their pull: never a planet's sky)
  }
  let x = o.x, y = o.y, vx = o.vx, vy = o.vy, swept = 0, prevA = Math.atan2(y, x), lag = STEP;  // (see DENSE_W2)
  let qx = 0, qy = 0, qvx = 0, qvy = 0;
  // a rogue planet is stepped along its path by the same rule it follows
  const rg = rogue && rogue.present ? rogue : null, rst = rg && { s: rg.s, rate: rg.rate };
  let rx = 0, ry = 0, rvx = 0, rvy = 0;
  for (let k = 0; k < airy.length; k++) predAir[k] = allBodies.indexOf(airy[k]);
  // geysers puff on the clock, and gusts roll in on it, so both are stepped exactly; the sail is taken as
  // held at today's heading, opening in a gust and folding after it as it does while you coast
  for (let k = 0; k < geysers.length; k++) predGey[k] = allBodies.indexOf(geysers[k]);
  const sunOn = !seed && gusts.length > 0, sails = sunOn && o === ship, hx = Math.cos(o.angle), hy = Math.sin(o.angle);
  let sailO = sails ? ship.sailOpen : 0;
  if (pod) { qx = pod.x; qy = pod.y; qvx = pod.vx; qvy = pod.vy; for (let k = 0; k < n; k++) predTakes[k] = podTakes(allBodies[k]); }
  const steps = seed ? Math.round(LOB_LIFE / dt) : 900;
  for (let i = 0; i < steps; i++) {
    // where every body is at this moment (parents come first in the list)
    for (let k = 0; k < n; k++) {
      const p = predParent[k];
      predictPos[2 * k] = (p >= 0 ? predictPos[2 * p] : 0) + predOx[k];
      predictPos[2 * k + 1] = (p >= 0 ? predictPos[2 * p + 1] : 0) + predOy[k];
      const ox = predOx[k];
      predOx[k] = ox * predC[k] - predOy[k] * predS[k];
      predOy[k] = ox * predS[k] + predOy[k] * predC[k];
    }
    let ax = 0, ay = 0, pax = 0, pay = 0, dense = -1;
    const rgOn = rg && rst.s < rg.path.len;
    if (rgOn) {
      rogueAt(rg, rst.s);
      rx = RG[0]; ry = RG[1]; rvx = RG[2] * rst.rate; rvy = RG[3] * rst.rate;
      const ddx = rx - x, ddy = ry - y, r2 = Math.max(ddx * ddx + ddy * ddy, rg.R * rg.R), r = Math.sqrt(r2), a = rg.gm / r2;
      ax += ddx / r * a; ay += ddy / r * a;
      if (pod) {
        const qdx = rx - qx, qdy = ry - qy, q2 = Math.max(qdx * qdx + qdy * qdy, rg.R * rg.R), q = Math.sqrt(q2), qa = rg.gm / q2;
        pax += qdx / q * qa; pay += qdy / q * qa;
        if (q < rg.R + pod.R * 0.8 && podTakes(rg)) pod = null;
      }
    }
    for (let k = 0; k < n; k++) {
      const b = allBodies[k];
      if (b.anchor) continue;
      const ddx = predictPos[2 * k] - x, ddy = predictPos[2 * k + 1] - y;
      const r2 = Math.max(ddx * ddx + ddy * ddy, b.softR * b.softR), r = Math.sqrt(r2), a = b.gm / r2;
      ax += ddx / r * a; ay += ddy / r * a;
      if (r2 < predDense[k]) dense = k;
      if (pod) {
        const qdx = predictPos[2 * k] - qx, qdy = predictPos[2 * k + 1] - qy;
        const q2 = Math.max(qdx * qdx + qdy * qdy, b.softR * b.softR), q = Math.sqrt(q2), qa = b.gm / q2;
        pax += qdx / q * qa; pay += qdy / q * qa;
        if (predTakes[k] && q < b.R + pod.R * 0.8) pod = null;
      }
    }
    const rr = Math.hypot(x, y);
    if (seed && rr > ARENA_R) return { pts, impact: null, escape: true };
    if (rr > ARENA_R && !inExitLane(x, y)) { const kk = (rr - ARENA_R) * 1.5; ax -= x / rr * kk; ay -= y / rr * kk; }
    if (pod) {
      const pr = Math.hypot(qx, qy);
      if (pr > ARENA_R) { const kk = (pr - ARENA_R) * 1.5; pax -= qx / pr * kk; pay -= qy / pr * kk; }
      const k = tetherPull(qx - x, qy - y, qvx - vx, qvy - vy, pod.slack);
      ax += (qx - x) * k; ay += (qy - y) * k;
      pax -= (qx - x) * k / POD_MASS; pay -= (qy - y) * k / POD_MASS;
      qvx += pax * dt; qvy += pay * dt; qx += qvx * dt; qy += qvy * dt;
    }
    // thick air (thrown seeds pass through it: you can still throw from a world wrapped in it)
    let air = -1;
    for (let j = 0; j < (seed ? 0 : airy.length); j++) {
      const k = predAir[j], b = allBodies[k], top = b.R * b.air + 6;
      if ((x - predictPos[2 * k]) ** 2 + (y - predictPos[2 * k + 1]) ** 2 < top * top) { air = k; break; }
    }
    if (air >= 0) dense = -1;
    const h = air >= 0 ? dt / 4 : dense >= 0 ? dt / Math.round(dt / STEP) : dt;
    if (h !== lag) { vx += ax * (lag - h) / 2; vy += ay * (lag - h) / 2; lag = h; }
    if (air < 0 && dense < 0) { vx += ax * dt; vy += ay * dt; }
    if (!seed) {
      const cp = currentPush(x, y, vx, vy);
      if (cp) { vx += cp[0] * dt; vy += cp[1] * dt; }
      const f = calmAt(x, y);
      if (f) {
        const r = Math.hypot(x, y), v = Math.sqrt(homeGM() / r), k = 1 - Math.exp(-1.2 * f * dt);
        vx += (-y / r * v - vx) * k; vy += (x / r * v - vy) * k;
      }
      for (let j = 0; j < geysers.length; j++) {
        const k = predGey[j], b = allBodies[k], [bvx, bvy] = bodyVel(b, i * dt);
        if (geyserLift(b, predictPos[2 * k], predictPos[2 * k + 1], bvx, bvy, b.spin + b.spinRate * i * dt, time + i * dt, x, y, vx, vy)) { vx += GZ[0] * dt; vy += GZ[1] * dt; }
      }
      if (sunOn) {
        sunAt(x, y, time + i * dt, predictPos, sails);
        if (sails) sailO = sailTo(sailO, SUN[2] > SAIL_AT ? 1 : 0, dt);
        const g = GUST_ACC * SUN[2] * SUN[3];
        vx += SUN[0] * g * dt; vy += SUN[1] * g * dt;
        if (sailO > 0.001) { const f = sailForce(hx, hy) * sailO; vx += hx * f * dt; vy += hy * f * dt; }
      }
    }
    // the air thickens quickly with depth, so inside it this step is taken in four, as short as the flight's own
    if (air >= 0) {
      const b = allBodies[air], bx = predictPos[2 * air], by = predictPos[2 * air + 1], [bvx, bvy] = bodyVel(b, i * dt);
      const pull = (px, py, out) => { const dx = bx - px, dy = by - py, r2 = Math.max(dx * dx + dy * dy, b.R * b.R), r = Math.sqrt(r2); out[0] = dx / r * b.gm / r2; out[1] = dy / r * b.gm / r2; };
      pull(x, y, AIR_G0);  // its pull is re-taken at each quarter step (it changes fast this close in)
      for (let q = 0; q < 4; q++) {
        pull(x, y, AIR_G);
        vx += (ax - AIR_G0[0] + AIR_G[0]) * h; vy += (ay - AIR_G0[1] + AIR_G[1]) * h;
        const f = airFactor(b, bx + bvx * h * q, by + bvy * h * q, bvx, bvy, x, y, vx, vy, h);
        if (f < 1) { vx = AIR[0] + (vx - AIR[0]) * f; vy = AIR[1] + (vy - AIR[1]) * f; }
        x += vx * h; y += vy * h;
      }
    } else if (dense >= 0) {  // (see DENSE_W2) its surface is watched on the way, so a fast pass can't skip it
      const b = allBodies[dense], bx = predictPos[2 * dense], by = predictPos[2 * dense + 1], [bvx, bvy] = bodyVel(b, i * dt);
      const m = Math.round(dt / h), s2 = b.softR * b.softR, hit = b.R + (seed ? 1 : FOOT);
      const pull = (px, py, cx, cy, out) => { const dx = cx - px, dy = cy - py, r2 = Math.max(dx * dx + dy * dy, s2), r = Math.sqrt(r2); out[0] = dx / r * b.gm / r2; out[1] = dy / r * b.gm / r2; };
      pull(x, y, bx, by, AIR_G0);
      for (let q = 0; q < m; q++) {
        const cx = bx + bvx * h * q, cy = by + bvy * h * q;
        pull(x, y, cx, cy, AIR_G);
        vx += (ax - AIR_G0[0] + AIR_G[0]) * h; vy += (ay - AIR_G0[1] + AIR_G[1]) * h;
        x += vx * h; y += vy * h;
        if ((x - cx - bvx * h) ** 2 + (y - cy - bvy * h) ** 2 < hit * hit) break;
      }
    } else { x += vx * dt; y += vy * dt; }
    for (let k = 0; k < n; k++) {
      const b = allBodies[k];
      if (b.anchor) continue;
      const bx = predictPos[2 * k], by = predictPos[2 * k + 1];
      if (seed) {
        if (Math.hypot(x - bx, y - by) < b.R + 1) return { pts, impact: { x, y, body: b, bx, by } };
        continue;
      }
      if (b.kind === 'gas') {
        const r = Math.hypot(x - bx, y - by);
        if (r < b.R) { const kk = Math.exp(-(0.15 + 0.5 * (1 - r / b.R)) * dt); vx *= kk; vy *= kk; }
        continue;
      }
      if (Math.hypot(x - bx, y - by) < b.R + FOOT) {
        // (only coming down: rising slowly off the ground, as a geyser lifts you, the step's lag behind the
        // body's own motion could otherwise read as a touchdown)
        const [bvx, bvy] = bodyVel(b, i * dt);
        if ((x - bx) * (vx - bvx) + (y - by) * (vy - bvy) < 0) return { pts, impact: touchdown(b, bx, by, bvx, bvy, x, y, vx, vy) };
      }
    }
    if (rgOn) {
      const d = Math.hypot(x - rx, y - ry);
      if (seed && d < rg.R + 1) return { pts, impact: { x, y, body: rg, bx: rx, by: ry } };
      if (!seed && d < rg.R + FOOT) return { pts, impact: touchdown(rg, rx, ry, rvx, rvy, x, y, vx, vy) };
      rogueStep(rg, rst, dt);
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
    if (!system.binary) sunGlow(system.sunAngle, id.sun, 0.12);  // (a binary's suns are right there in the middle)
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

// Where the light comes from at (x, y): the distant sun, or in a binary system the pair in the middle (so
// day and night swing round each world as it orbits).
const lightAt = (x, y) => system.binary ? Math.atan2(-y, -x) : system.sunAngle;
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
  drawTraces();
  if (!photo) drawMoonHints();
  for (const b of bodies) drawBody(b);
  drawWaves();
  drawPollenHints();
  drawRocks();
  drawPods();
  if (!photo) drawHighlights();
  drawComets();
  drawMotes();
  drawFireflies();
  drawParticles();
  drawLob();
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
    // fade to black and back in (a white flash was harsh, especially on an OLED screen at night), eased at
    // both ends and holding dark for a moment around the switch
    const a = warp.t < 1.5 ? smooth(clamp(warp.t / 1.3, 0, 1)) : 1 - smooth(clamp((warp.t - 1.7) / 1.3, 0, 1));
    ctx.fillStyle = `rgba(3,5,13,${a})`;
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
    if (rogue && rogue.present) {  // a rogue planet's rails: the arc ahead of it
      const P = rogue.path, i0 = Math.max(1, P.ss.findIndex(v => v > rogue.s));
      ctx.beginPath();
      ctx.moveTo(rogue.px, rogue.py);
      for (let i = Math.max(1, i0); i < P.xs.length; i += 2) ctx.lineTo(P.xs[i], P.ys[i]);
      ctx.stroke();
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
  if (gusts.length) { drawGustWarning(); drawGust(); }
  if (spores.length) drawSpores();
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
// A solar gust: a broad soft band of the sun's light rolling across, brightest just behind its leading edge,
// with faint streaks riding along in it and every body's shadow cut out of it. While a gust is on anywhere,
// each shadow's edges are traced faintly too, so you can find cover before the front arrives.
// The gust is painted at a quarter of the screen's resolution and laid over the scene: a soft wash whose front
// rises over 150+ screen pixels (the streaks carry the motion, not an edge), with each body's shadow dimmed out
// of it (to about 40% at the body, soft at the sides, fading away down its length) rather than cut out.
let gustCanvas = null;
function drawGust() {
  const span = gustSpan(), t0 = gusts.find(t => time >= t && time <= t + span);
  if (t0 === undefined) return;
  const front = gustFrom() + GUST_SPEED * (time - t0), back = front - GUST_W, bin = system.binary, sun = system.identity.sun;
  const env = smooth(clamp((time - t0) / 1.2, 0, 1)) * smooth(clamp((t0 + span - time) / 1.2, 0, 1));
  const ux = -Math.cos(system.sunAngle), uy = -Math.sin(system.sunAngle), BIG = ARENA_R + 400;
  const at = (a, l) => [ux * a - uy * l, uy * a + ux * l];  // along the light, and across it
  const shadows = [];
  for (const b of allBodies) {
    if (b.anchor || b.kind === 'sun') continue;
    let sx = ux, sy = uy;
    if (bin) { const r = Math.hypot(b.px, b.py) || 1; sx = b.px / r; sy = b.py / r; }
    shadows.push([b, sx, sy, shadowLen(b.R)]);
  }
  // the band, on its own small canvas
  const cw = Math.ceil(canvas.width / 4), ch = Math.ceil(canvas.height / 4);
  if (!gustCanvas) gustCanvas = document.createElement('canvas');
  if (gustCanvas.width !== cw || gustCanvas.height !== ch) { gustCanvas.width = cw; gustCanvas.height = ch; }
  const g = gustCanvas.getContext('2d'), m = ctx.getTransform();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, cw, ch);
  g.setTransform(m.a / 4, m.b / 4, m.c / 4, m.d / 4, m.e / 4, m.f / 4);
  const ramp = Math.min(GUST_W * 0.6, Math.max(GUST_W * 0.3, 170 * px));  // the front's soft rise, in world units
  const look = q => { const d = q * GUST_W; return d < ramp ? smooth(d / ramp) : 1 - smooth((d - ramp) / (GUST_W - ramp)); };
  const r0 = bin ? Math.max(0, back) : back, grad = bin ? g.createRadialGradient(0, 0, r0, 0, 0, front) : g.createLinearGradient(ux * back, uy * back, ux * front, uy * front);
  for (let i = 0; i <= 12; i++) { const t = i / 12; grad.addColorStop(t, `rgba(${sun},${0.06 * env * look((front - r0) * (1 - t) / GUST_W)})`); }
  g.fillStyle = grad;
  g.fillRect(-BIG * 2, -BIG * 2, BIG * 4, BIG * 4);
  // shadows dim it: a few stacked tapering wedges, so the sides are feathered and the far end fades out
  g.globalCompositeOperation = 'destination-out';
  for (const [b, sx, sy, L] of shadows) {
    const qx = -sy, qy = sx, sg = g.createLinearGradient(b.px, b.py, b.px + sx * L, b.py + sy * L);
    sg.addColorStop(0, 'rgba(0,0,0,0.25)'); sg.addColorStop(0.55, 'rgba(0,0,0,0.15)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sg;
    for (const k of [1.2, 1, 0.8]) {
      const w0 = b.R * k, w1 = b.R * k * 0.6;
      g.beginPath();
      g.moveTo(b.px + qx * w0, b.py + qy * w0); g.lineTo(b.px + sx * L + qx * w1, b.py + sy * L + qy * w1);
      g.lineTo(b.px + sx * L - qx * w1, b.py + sy * L - qy * w1); g.lineTo(b.px - qx * w0, b.py - qy * w0);
      g.closePath(); g.fill();
    }
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(gustCanvas, 0, 0, cw * 4, ch * 4);
  ctx.restore();
  ctx.save();
  // each shadow's edges in faint dashes (the main cue for cover), fading down its length
  ctx.lineWidth = 1 * px;
  ctx.setLineDash([4 * px, 7 * px]);
  for (const [b, sx, sy, L] of shadows) {
    const qx = -sy * b.R, qy = sx * b.R, ex = b.px + sx * L, ey = b.py + sy * L;
    const sg = ctx.createLinearGradient(b.px, b.py, ex, ey);
    sg.addColorStop(0, `rgba(${sun},${0.16 * env})`); sg.addColorStop(1, `rgba(${sun},0)`);
    ctx.strokeStyle = sg;
    ctx.beginPath(); ctx.moveTo(b.px + qx, b.py + qy); ctx.lineTo(ex + qx * 0.6, ey + qy * 0.6); ctx.moveTo(b.px - qx, b.py - qy); ctx.lineTo(ex - qx * 0.6, ey - qy * 0.6); ctx.stroke();
  }
  ctx.setLineDash([]);
  // streaks riding with the front (longest near it, fading toward the tail), none in a shadow
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  const shaded = (x, y) => shadows.some(([b, sx, sy, L]) => { const dx = x - b.px, dy = y - b.py, al = dx * sx + dy * sy; return al > 0 && al < L && Math.abs(dx * sy - dy * sx) < b.R; });
  for (let band = 0; band < 3; band++) {
    ctx.strokeStyle = `rgba(${sun},${[0.22, 0.15, 0.08][band] * env})`;
    ctx.beginPath();
    for (let j = 0; j < 44; j++) {
      const q = (j * 0.618 + 0.1) % 1;
      if (Math.min(2, Math.floor(q * 3)) !== band) continue;
      const a = front - GUST_W * (0.1 + 0.7 * q), len = 8 + 18 * (1 - q);
      let x, y, lx, ly;
      if (bin) {
        if (a - len <= 0) continue;
        const th = j / 44 * TAU + 0.4 * Math.sin(j * 1.7), cx = Math.cos(th), cy = Math.sin(th);
        x = cx * a; y = cy * a; lx = cx * len; ly = cy * len;
      } else {
        [x, y] = at(a, -BIG + (j + 0.5 + 0.4 * Math.sin(j * 2.3)) / 44 * 2 * BIG);
        lx = ux * len; ly = uy * len;
      }
      if (shaded(x, y)) continue;
      ctx.moveTo(x, y); ctx.lineTo(x - lx, y - ly);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// A geyser moon's vents: small pale notches in the ice that stir just before a puff (a tell for timing it),
// and while one puffs, a soft glow at the vent and wisps of vapour tinted like the moon, rising, spreading and
// fading. Drawn in the body's frame (see drawBody).
const ICE = '225,240,255';
function drawVents(b) {
  const H = plumeH(b), R = b.R, tint = b.color.map((c, i) => Math.round(mix(c, ICE.split(',')[i], 0.6))).join(',');  // vapour tinted like the moon
  ctx.save();
  ctx.lineCap = 'round';
  for (const v of b.vents) {
    const p = ventPhase(v, time), f = ventPuff(v, time), soon = clamp(1 - (v.period - p) / 0.9, 0, 1);
    ctx.save();
    ctx.rotate(b.spin + v.a);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = `rgba(${ICE},${0.4 + 0.4 * Math.max(f, soon)})`;
    ctx.lineWidth = 1.2 * px;
    ctx.beginPath();
    ctx.moveTo(R - 1.8, -1); ctx.lineTo(R + 0.6, -2.6); ctx.moveTo(R - 1.8, 1); ctx.lineTo(R + 0.6, 2.6);  // the notch
    ctx.moveTo(R - 0.6, -5.5); ctx.lineTo(R + 0.4, -6.4); ctx.moveTo(R - 0.6, 5.5); ctx.lineTo(R + 0.4, 6.4);  // frost
    ctx.stroke();
    if (p < 2.4) {
      ctx.globalCompositeOperation = 'lighter';
      if (f > 0) {  // a gentle glow at the vent
        const gl = ctx.createRadialGradient(R, 0, 0, R, 0, 9);
        gl.addColorStop(0, `rgba(${tint},${0.22 * f})`); gl.addColorStop(1, `rgba(${tint},0)`);
        ctx.fillStyle = gl;
        ctx.beginPath(); ctx.arc(R, 0, 9, 0, TAU); ctx.fill();
      }
      // wisps: soft little puffs (a faint halo round a brighter core) with a short streak behind, rising,
      // drifting apart, growing and fading as they go
      ctx.lineWidth = 1 * px;
      for (let j = 0; j < 12; j++) {  // a wisp leaves every 0.11 s while it puffs, rising for 1.2 s
        const age = p - j * 0.11;
        if (age < 0 || age > 1.2) continue;
        const u = age / 1.2, h = H * (1 - (1 - u) ** 2), side = Math.sin(j * 2.4 + v.phase * 3) * (1 + 0.28 * h), a = 0.5 * (1 - u) ** 1.6;
        const x = R + h, len = 1 + 3 * (1 - u), lean = side / (h + 6);  // the streak lies along its way out from the vent
        ctx.fillStyle = `rgba(${tint},${a * 0.22})`;
        ctx.beginPath(); ctx.arc(x, side, 1.5 + 3.5 * u, 0, TAU); ctx.fill();
        ctx.fillStyle = `rgba(${tint},${a * 0.55})`;
        ctx.beginPath(); ctx.arc(x, side, 0.6 + 1.1 * u, 0, TAU); ctx.fill();
        ctx.strokeStyle = `rgba(${tint},${a * 0.45})`;
        ctx.beginPath(); ctx.moveTo(x - len, side - lean * len); ctx.lineTo(x, side); ctx.stroke();
      }
    }
    ctx.restore();
  }
  ctx.restore();
}

// The solar sail, in the ship's frame (nose up, see drawShip): one thin arc of line in the ship's colour just
// ahead of the nose, like a spinnaker, opening from the middle and bowing with its push (back toward the ship
// when you point into the light and it brakes you).
function drawSail(s) {
  const o = smooth(s.sailOpen), w = 14 * o, y0 = -14;
  const bow = o * (2 + 3 * clamp(s.sailPush / 10, -1, 1));
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = SHIPS[prefs.ship].glow;
  ctx.globalAlpha = 0.8 * o;
  ctx.lineWidth = 2.2 * px / SHIP_SCALE;
  ctx.beginPath(); ctx.moveTo(-w, y0 + 3 * o); ctx.quadraticCurveTo(0, y0 - 2 * bow, w, y0 + 3 * o); ctx.stroke();
  ctx.restore();
}

function drawWaves() {
  if (!waves.length) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const w of waves) {
    const t = (time - w.t0) / w.dur;
    if (t < 0 || t > 1) continue;
    const e = 1 - (1 - t) ** 3, o = w.off || [0, 0], x = w.body ? w.body.px + o[0] : w.x, y = w.body ? w.body.py + o[1] : w.y, r = mix(w.r0, w.r1, e);
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
  for (const k of rocks) {
    const la = lightAt(k.x, k.y), sx = Math.cos(la), sy = Math.sin(la);
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
  const sun = lightAt(b.px, b.py);
  for (const p of b.plants) {
    const wa = p.a + b.spin;  // where on the body the plant is right now
    day = smooth(clamp((Math.cos(wa - sun) + 0.25) / 0.5, 0, 1));
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
  if (b.kind === 'sun') return drawSun(b);
  if (b.kind === 'neutron') return drawNeutron(b);
  const bloom = bloomOf(b), G = b.R * (1.35 + bloom * 0.15), R = b.R, small = R < 25, la = lightAt(b.px, b.py);
  const sx = Math.cos(la), sy = Math.sin(la);
  // a rogue planet is a dark wanderer (a darker fill, even planted, and a broken rim), fading in and out past the edge
  const dim = b.rogue ? 0.2 + 0.5 * bloom : 1;
  if (b.rogue) { b.fade = clamp((ROGUE_OUT - Math.hypot(b.px, b.py)) / 70, 0, 1); drawRogueTrail(b); }
  ctx.save();
  ctx.translate(b.px, b.py);
  if (b.rogue) ctx.globalAlpha = b.fade;
  if (!b.rogue || bloom > 0.05) ctx.drawImage(glowSprite(b), -G, -G, 2 * G, 2 * G);
  bloomHalo(b);
  if (b.air) drawAir(b);

  if (!small && bloom > 0.05) {  // thin atmosphere band, coming in as the garden fills
    ctx.strokeStyle = bodyColor(b, 0.14 * bloom);
    ctx.lineWidth = R * 0.1;
    ctx.beginPath(); ctx.arc(0, 0, R * 1.05, 0, TAU); ctx.stroke();
  }
  ctx.fillStyle = '#070a14';
  ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
  // the sunlit side is slightly whitened so a dim fill reads warm rather than muddy (dim yellow goes olive)
  const lit = 0.6 * (0.3 + 0.7 * bloom) * dim, [cr, cg, cb] = b.color;
  const fill = ctx.createRadialGradient(sx * R * 0.45, sy * R * 0.45, 0, sx * R * 0.2, sy * R * 0.2, R * 1.3);
  fill.addColorStop(0, `rgba(${Math.round(mix(cr, 255, 0.4))},${Math.round(mix(cg, 255, 0.4))},${Math.round(mix(cb, 255, 0.4))},${lit})`);
  fill.addColorStop(1, bodyColor(b, 0.06));
  ctx.fillStyle = fill;
  ctx.fill();
  if (bloom < 1) drawWireframe(b, 0.12 * (1 - bloom));
  if (b.fast) drawSpinMarks(b, bloom);
  drawDayNight(b);
  // crescent rim: full strength on the lit side, about a quarter on the night side
  const rim = ctx.createLinearGradient(sx * R, sy * R, -sx * R, -sy * R);
  // (a rogue's rim stays clear though its fill is dark: broken into dashes that turn with it, see below)
  rim.addColorStop(0, bodyColor(b, b.rogue ? 0.8 : 0.95 * dim));
  rim.addColorStop(0.5, bodyColor(b, b.rogue ? 0.55 : 0.55 * dim));
  rim.addColorStop(1, bodyColor(b, b.rogue ? 0.35 : 0.22));
  ctx.strokeStyle = rim;
  ctx.lineWidth = (small ? 1.2 : 1.5) * (b.bloomed ? 1.5 + 0.3 * Math.sin(time * 1.3 + R) : 1) * px;
  if (b.rogue) { const seg = TAU * R / 10; ctx.setLineDash([seg * 0.55, seg * 0.45]); ctx.lineDashOffset = -b.spin * R; }
  ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.stroke();
  ctx.setLineDash([]);
  if (b.plants.length) drawGardenCached(b);
  if (b.vents) drawVents(b);
  ctx.restore();
}

// Thick air: a soft glowing shell out to its top, a faint line where it ends, and a few streaks of wind
// turning with the planet.
function drawAir(b) {
  const R = b.R, top = R * b.air, [cr, cg, cb] = b.color;
  const shell = ctx.createRadialGradient(0, 0, R, 0, 0, top);
  shell.addColorStop(0, `rgba(${cr},${cg},${cb},0.2)`);
  shell.addColorStop(0.5, `rgba(${cr},${cg},${cb},0.07)`);
  shell.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
  ctx.fillStyle = shell;
  ctx.beginPath(); ctx.arc(0, 0, top, 0, TAU); ctx.fill();
  ctx.save();
  ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.12)`;
  ctx.lineWidth = 1 * px;
  ctx.beginPath(); ctx.arc(0, 0, top, 0, TAU); ctx.stroke();
  ctx.rotate(b.spin);
  ctx.lineCap = 'round';
  ctx.strokeStyle = `rgba(${Math.round(mix(cr, 255, 0.4))},${Math.round(mix(cg, 255, 0.4))},${Math.round(mix(cb, 255, 0.4))},0.13)`;
  ctx.beginPath();
  for (let k = 0; k < 7; k++) {  // short arcs at a few heights, all riding round with the air
    const r = R * (1 + (b.air - 1) * (0.25 + 0.2 * (k % 3))), a = k / 7 * TAU;
    ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); ctx.arc(0, 0, r, a, a + 0.35 + 0.1 * (k % 2));
  }
  ctx.stroke();
  ctx.restore();
}
// A fast-spinning world's ground visibly turns: a few rings of dashes and short marks near the rim, riding
// round with it (they stay faintly through full bloom, so it still reads as spinning).
function drawSpinMarks(b, bloom) {
  const R = b.R;
  ctx.save();
  ctx.rotate(b.spin);
  ctx.strokeStyle = bodyColor(b, 0.28 - 0.08 * bloom);
  ctx.lineWidth = 1 * px;
  ctx.setLineDash([R * 0.12, R * 0.2]);
  ctx.beginPath(); ctx.arc(0, 0, R * 0.5, 0, TAU); ctx.stroke();
  ctx.setLineDash([R * 0.2, R * 0.16]);
  ctx.beginPath(); ctx.arc(0, 0, R * 0.78, 0, TAU); ctx.stroke();
  ctx.setLineDash([]);
  // ticks round the rim, standing out past it a little, so the ground's turning is plain to see
  ctx.strokeStyle = bodyColor(b, 0.6 - 0.15 * bloom);
  ctx.lineWidth = 1.4 * px;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let k = 0; k < 16; k++) {
    const a = k / 16 * TAU, r0 = R * (k % 2 ? 0.9 : 0.84);
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); ctx.lineTo(Math.cos(a) * (R + 3), Math.sin(a) * (R + 3));
  }
  ctx.stroke();
  ctx.restore();
}
// A sun: a small glowing disc (white-hot in the middle, its own warm or cool tint at the edge) with a soft
// corona, a crisp rim, and a few faint rays turning slowly round it.
function drawSun(b) {
  const R = b.R, c = b.color.join(','), hot = b.color.map(v => Math.round(mix(v, 255, 0.6))).join(',');
  const pulse = 0.85 + 0.15 * Math.sin(time * 0.9 + R);
  ctx.save();
  ctx.translate(b.px, b.py);
  ctx.globalCompositeOperation = 'lighter';
  const corona = ctx.createRadialGradient(0, 0, R * 0.8, 0, 0, R * 4.2);
  corona.addColorStop(0, `rgba(${c},${0.32 * pulse})`);
  corona.addColorStop(0.35, `rgba(${c},${0.09 * pulse})`);
  corona.addColorStop(1, `rgba(${c},0)`);
  ctx.fillStyle = corona;
  ctx.beginPath(); ctx.arc(0, 0, R * 4.2, 0, TAU); ctx.fill();
  // rays: thin lines of uneven length, slowly turning
  ctx.rotate(time * 0.07 * (R > 13 ? 1 : -1));
  ctx.strokeStyle = `rgba(${c},0.22)`;
  ctx.lineWidth = 1 * px;
  ctx.beginPath();
  for (let k = 0; k < 12; k++) {
    const a = k / 12 * TAU, l = R * (1.5 + 0.5 * ((k * 7) % 3) + 0.25 * Math.sin(time * 1.3 + k));
    ctx.moveTo(Math.cos(a) * R * 1.3, Math.sin(a) * R * 1.3); ctx.lineTo(Math.cos(a) * l, Math.sin(a) * l);
  }
  ctx.stroke();
  ctx.strokeStyle = `rgba(${c},0.12)`;
  ctx.beginPath(); ctx.arc(0, 0, R * 1.6, 0, TAU); ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
  const disc = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  disc.addColorStop(0, 'rgba(255,253,245,0.95)');
  disc.addColorStop(0.6, `rgba(${hot},0.85)`);
  disc.addColorStop(1, `rgba(${c},0.75)`);
  ctx.fillStyle = disc;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
  ctx.strokeStyle = `rgba(${hot},0.95)`;
  ctx.lineWidth = 1.5 * px;
  ctx.stroke();
  ctx.restore();
}

// A neutron star: a tiny white-hot core in a small soft glow, a faint ring of light bent round it, and two
// thin pulsar beams sweeping round fast (faint wedges, brightest near the star). Cheap: the glow and the
// beam's fade are made once and only rotated.
function drawNeutron(b) {
  const R = b.R, c = b.color.join(','), L = 260, w = 0.05;
  const g = b.grads || (b.grads = {
    glow: (() => { const q = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 5); q.addColorStop(0, `rgba(${c},0.45)`); q.addColorStop(0.3, `rgba(${c},0.12)`); q.addColorStop(1, `rgba(${c},0)`); return q; })(),
    beam: (() => { const q = ctx.createLinearGradient(0, 0, L, 0); q.addColorStop(0, `rgba(${c},0.2)`); q.addColorStop(0.35, `rgba(${c},0.07)`); q.addColorStop(1, `rgba(${c},0)`); return q; })(),
  });
  ctx.save();
  ctx.translate(b.px, b.py);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g.glow;
  ctx.beginPath(); ctx.arc(0, 0, R * 5, 0, TAU); ctx.fill();
  // the lensing ring: light from behind it bent into a thin circle, shimmering a touch
  ctx.strokeStyle = `rgba(${c},${0.22 + 0.05 * Math.sin(time * 2.3)})`;
  ctx.lineWidth = 1 * px;
  ctx.beginPath(); ctx.arc(0, 0, R * 2.6, 0, TAU); ctx.stroke();
  ctx.strokeStyle = `rgba(${c},0.08)`;
  ctx.beginPath(); ctx.arc(0, 0, R * 3.3, 0, TAU); ctx.stroke();
  // the beams, from its two poles, sweeping round about once every two seconds
  ctx.rotate(time * 3.1 + (b.start || 0));
  for (let k = 0; k < 2; k++) {
    ctx.fillStyle = g.beam;
    ctx.beginPath(); ctx.moveTo(R * 0.8, 0); ctx.lineTo(L, -L * w); ctx.lineTo(L, L * w); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = g.beam; ctx.lineWidth = 1 * px;
    ctx.beginPath(); ctx.moveTo(R * 0.8, 0); ctx.lineTo(L, 0); ctx.stroke();
    ctx.rotate(Math.PI);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(250,252,255,0.97)';
  ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
  ctx.strokeStyle = `rgba(${c},0.9)`;
  ctx.lineWidth = 1.5 * px;
  ctx.stroke();
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
  const R = b.R, FL = 0.24, la = lightAt(b.px, b.py), sx = Math.cos(la), sy = Math.sin(la);
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
  const bloom = bloomOf(b), R = b.R, G = R * 1.45, la = lightAt(b.px, b.py), sx = Math.cos(la), sy = Math.sin(la);
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
  const la = lightAt(b.px, b.py), sx = Math.cos(la), sy = Math.sin(la), R = b.R;
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
  if (system.binary) {  // each sun catches the rim from where it is right now, in its own colour
    for (const o of bodies) {
      if (o.kind !== 'sun') continue;
      const a = Math.atan2(o.py - b.py, o.px - b.px);
      ctx.strokeStyle = `rgba(${o.color.join(',')},0.32)`;
      ctx.lineWidth = 1.4 * px;
      ctx.beginPath(); ctx.arc(0, 0, R, a - 1.05, a + 1.05); ctx.stroke();
    }
  } else {
    ctx.strokeStyle = `rgba(${id.sun},0.3)`;
    ctx.lineWidth = 1.4 * px;
    ctx.beginPath(); ctx.arc(0, 0, R, system.sunAngle - 1.1, system.sunAngle + 1.1); ctx.stroke();
  }
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
  // once the exit lane has hold of you (or you're warping) the path is the lane's, which the prediction
  // doesn't model; it would curve back into the system, so show nothing
  if (warp || (exit && inExitLane(s.x, s.y) && Math.hypot(s.x, s.y) > ARENA_R - 200)) { predCache = null; return; }
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
    const ok = p.impact.speed <= cfg.landSpeed && !p.impact.skid;
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = ok ? '#9dffc8' : p.impact.skid ? '#a9d8ff' : '#ffb070';  // land, skid (soft blue), bounce
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
  for (const c of comets) {
    const la = lightAt(c.x, c.y), sx = Math.cos(la), sy = Math.sin(la);
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
    const sa = la + Math.PI;
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

const fadeTime = m => m.lee ? 4 : m.hang || m.wind ? 2 : MOTE_FADE;  // comet beads fade quickly at the end of their life

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
  // three kinds: ordinary stardust in the theme's tint, a comet's gold, and dust the sun breathed out in the sun's colour
  const sc = (system.identity.sun || system.dustHalo).split(',').map(Number), sunCore = sc.map(v => Math.round(v + (255 - v) * 0.55)).join(',');
  for (const kind of ['dust', 'gold', 'sun']) {
    const gold = kind === 'gold';
    const halo = gold ? '#ffd890' : kind === 'sun' ? `rgb(${sc.join(',')})` : `rgb(${system.dustHalo})`, core = gold ? '#ffe2a0' : kind === 'sun' ? `rgb(${sunCore})` : `rgb(${system.dustCore})`;
    for (const [color, alpha, radius] of [[halo, gold ? 0.2 : kind === 'sun' ? 0.18 : 0.15, gold ? 6.5 : 5], [core, 0.9, gold ? 2.7 : 1.8]]) {
      ctx.fillStyle = color;
      for (const m of motes) {
        if ((m.gold ? 'gold' : m.sun ? 'sun' : 'dust') !== kind) continue;
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
    ctx.fillStyle = `rgba(${seedTint(s.seeds)},0.8)`;
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
  if (s.sailOpen > 0.01) drawSail(s);
  drawHull(SHIPS[prefs.ship], s.throttle, 2.1 * px / SHIP_SCALE);
  ctx.restore();
}

// Close to a surface, show your speed relative to it (lander style).
function drawLandingReadout() {
  const s = ship;
  if (s.landed || title) return;
  const { b, alt } = nearestSurface(s.x, s.y);
  if (alt > 90) return;
  // relative to the ground right under you (on a fast-spinning world, soft blue: you'd skid)
  const t = touchdown(b, b.px, b.py, b.pvx, b.pvy, s.x, s.y, s.vx, s.vy), speed = t.speed;
  ctx.save();
  ctx.globalAlpha = clamp((90 - alt) / 30, 0, 1);
  ctx.fillStyle = t.skid ? '#a9d8ff' : speed <= cfg.landSpeed ? '#9dffc8' : speed <= cfg.landSpeed * 1.6 ? '#ffcf8a' : '#ff8a7a';
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
  if (LAB) { ctx.fillStyle = '#ffd27a'; ctx.fillText('LAB BUILD  ·  new features, one per system  ·  L skips on', W / 2, H * 0.24 + (W < 560 ? 120 : 80)); ctx.fillStyle = '#cfe'; }
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
  ctx.fillStyle = s.seeds > SEED_TINTS[0][0] ? `rgb(${seedTint(s.seeds)})` : '#e8fbff'; ctx.fillText(String(s.seeds), x + 60, y);
  // no fuel gauge (it's almost always full); only a note while a long burn has emptied the tank
  if (s.empty) { ctx.fillStyle = '#ff9a6a'; ctx.fillText('engine recharging', x + 110, y); }

  y += 22;
  ctx.fillStyle = '#8fa8cc'; ctx.fillText('BLOOM', x, y);
  // in a row on a wide screen; on a narrow one (a phone held upright) one planet per line, a neat column,
  // since wrapping a row left them ragged
  const column = W < 560;
  const listed = gardens.filter(b => !b.made);  // a moon you made is a bonus, not another line on the to-do list
  let gx = x + 60;
  if (column) {  // names on the left, percentages lined up on the right
    const pctX = x + 60 + Math.max(...listed.map(b => ctx.measureText(b.name).width)) + 12 + ctx.measureText('100%').width;
    listed.forEach((b, i) => {
      if (i > 0) y += 18;
      ctx.fillStyle = bodyColor(b);
      ctx.fillText(b.name, gx, y);
      if (b.needs && !b.pollinated) ctx.fillText(`needs ${b.needs}`, pctX - ctx.measureText('100%').width, y);
      else { ctx.textAlign = 'right'; ctx.fillText(`${Math.round(bloomOf(b) * 100)}%`, pctX, y); ctx.textAlign = 'left'; }
    });
  } else listed.forEach(b => {
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
    ctx.fillText('landed: pull back from the ship to throw seeds', W / 2, H - 80);
    ctx.fillText('drag anywhere to steer, further to thrust', W / 2, H - 62);
    ctx.fillText('second thumb: brake and land gently', W / 2, H - 44);
    ctx.fillText('lift to coast  ·  ❚❚ for the menu', W / 2, H - 26);
  } else if (showHints) {
    ctx.font = '12px ui-monospace, Consolas, monospace';
    ctx.fillStyle = 'rgba(160,180,210,0.6)';
    // just the essentials; every other key is in the pause menu
    ctx.fillText('← → turn  ·  ↑ thrust  ·  ↓ gentle thrust  ·  Space brakes to land  ·  land slowly, feet first', W / 2, H - 44);
    ctx.fillText('landed: hold E to aim a throw of seeds  ·  P or Esc for the menu  ·  H hides these hints', W / 2, H - 26);
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
    if (b.kind === 'neutron' && t.includes('neutron')) ring(b.px, b.py, b.R * 5);
    if (b.kind === 'gas' && t.includes('gas')) ring(b.px, b.py, b.R * 2.1);
    if (b.kind === 'crystal' && t.includes('crystal')) ring(b.px, b.py, b.R + 14);
    if (b.needs && t.includes('pollen')) { ring(b.px, b.py, b.R + 16); const d = gardens.find(o => o.name === b.needs); if (d) ring(d.px, d.py, d.R + 16); }
    if (b.fast && t.includes('spin')) ring(b.px, b.py, b.R + 14);
    if (b.air && t.includes('air')) ring(b.px, b.py, b.R * b.air + 8);
    if (b.vents && t.includes('geyser')) ring(b.px, b.py, b.R + 14);
    if (b.rogue && t.includes('rogue')) ring(b.px, b.py, b.R + 14);
  }
  if (t.includes('binary')) { const sun = bodies.find(b => b.kind === 'sun'); if (sun) ring(0, 0, sun.omegaDist / 2 + sun.R * 3); }
  if (t.includes('rocks')) for (const k of rocks) ring(k.x, k.y, k.R + 9);
  if (t.includes('tow')) for (const p of pods) ring(p.x, p.y, p.R + 10);
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
    bodies: bodies.filter(b => !b.rogue).map(b => ({ name: b.name, color: b.color, R: Math.round(b.R), kind: b.kind, bloom: Math.round(bloomOf(b) * 100) / 100 })),
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
    ctx.fillText(`${sys.no}  ${(sys.bodies.find(b => b.kind !== 'hole' && b.kind !== 'gas' && b.kind !== 'neutron') || centre).name}`, x, y + 48 * unit + 8);
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

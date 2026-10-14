'use strict';

// Counts the people and vehicles a camera sees, from its analytics scene description.
//
// Each object keeps its ObjectId while the camera tracks it. An object is counted once,
// in one category, when it has been classified with enough confidence in at least
// MIN_FRAMES frames. Counts go into hourly buckets (kept HISTORY_DAYS) so they can be
// shown per hour and per day, and compared with what is usual for that hour.
//
// While a counted object is in view the tracker also follows where it goes (for the
// direction it went and a heatmap of the paths taken) and how long it stays.

const MIN_LIKELIHOOD = 0.5;
const MIN_FRAMES = 2;
const FORGET_MS = 15000; // an object not seen this long is gone
const HISTORY_DAYS = 35;
const USUAL_MIN_DAYS = 7; // days of history needed before anything is called unusual
const USUAL_MAX_DAYS = 28;
const MOVE_MIN = 0.15; // fraction of the picture an object must move to have a direction
const HEAT_W = 40;
const HEAT_H = 30;
const HEAT_DAILY_KEEP = 0.85; // older paths fade: each day the heatmap keeps 85 %

const CATEGORIES = ['person', 'car', 'truck', 'bus', 'bicycle', 'motorcycle', 'vehicle'];
const DIRECTIONS = ['right', 'left', 'down', 'up'];
const groupOf = (category) => (category === 'person' ? 'people' : 'vehicles');

// Object type as the camera names it -> our category (null = not counted, e.g. faces,
// licence plates, which belong to a person or vehicle already counted).
// Faces and licence plates are parts of a person or vehicle: reported, never counted.
const FEATURES = ['face', 'plate'];

function categoryOf(type) {
  const t = String(type || '').toLowerCase();
  if (/face/.test(t)) return 'face';
  if (/licen[cs]e_?plate|^plate$/.test(t)) return 'plate';
  if (/^(human|person|pedestrian)$|hardhat/.test(t)) return 'person';
  if (/motorcycle\/bicycle/.test(t)) return 'bicycle';
  if (/^othervehicle$|^other_?vehicle$/.test(t)) return 'vehicle';
  if (/^car$|sedan|van|suv|pickup/.test(t)) return 'car';
  if (/truck|lorry/.test(t)) return 'truck';
  if (/bus/.test(t)) return 'bus';
  if (/bicycle|cycle$|^bike$/.test(t) && !/motor/.test(t)) return 'bicycle';
  if (/motor|scooter|moped/.test(t)) return 'motorcycle';
  if (/vehicle/.test(t)) return 'vehicle';
  return null;
}

// The details of a tracked object for flows and the timeline.
function attrsOf(o) {
  return {
    upper: [...o.upper],
    lower: [...o.lower],
    vehicleColors: [...o.vehicleColors],
    bag: Boolean(o.bag),
    hat: Boolean(o.hat),
    plate: o.plate || null,
    speed: Number.isFinite(o.speed) ? o.speed : null,
    geo: o.geo || null,
  };
}

// Which way an object went in the picture, from where it was first and last seen
// (0..1 from the top-left corner). null when it hardly moved.
function directionOf(from, to) {
  if (!from || !to) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < MOVE_MIN) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

// '2026-10-13T21' for the hour of a timestamp in a time zone (bucket key).
function hourKey(ms, timeZone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
}

// Whole days between two 'YYYY-MM-DD' dates.
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

class Tracker {
  // history: { '<hourKey>': { person: 3, car: 1, dir: { person: { left: 2 } }, stay: { person: 40 } } }
  // heat: { day: 'YYYY-MM-DD', grids: { person: [HEAT_W * HEAT_H numbers] } }
  // Callbacks, all optional:
  //   onCounted({ id, category, type, colors, image, box })  a new person or vehicle
  //   onImage({ id, image })               the camera's close-up arrived after counting
  //   onDwell({ id, category, minutes, colors })   still in view, every whole minute
  //   onGone({ id, category, direction, seconds, colors })   left the picture
  //   onUnusual({ group, count, usual, hour })   more than usual this hour (people/vehicles)
  //   onFeature({ id, kind: 'face'|'plate', image, plate })  a face or licence plate, once each
  // Counted/dwell/gone objects also carry attrs: { upper, lower, vehicleColors, bag, hat,
  // plate, speed (m/s, highest seen), geo }.
  // timeZone: Homey's time zone (e.g. 'Europe/Stockholm'), for hours and days.
  constructor({
    history = {}, heat = null, now = () => Date.now(), timeZone,
    onCounted = () => {}, onImage = () => {}, onDwell = () => {}, onGone = () => {}, onUnusual = () => {}, onFeature = () => {},
  } = {}) {
    this.timeZone = timeZone;
    this.history = history;
    this.heat = heat && heat.grids ? heat : { day: null, grids: {} };
    Object.assign(this, {
      now, onCounted, onImage, onDwell, onGone, onUnusual, onFeature,
    });
    this.objects = new Map(); // id -> tracked object
    this.unusualFired = new Set(); // '<hourKey>/<group>'
    this.dirty = false;
  }

  // frame: { objects: [{ id, type, likelihood, colors, image, box }], deleted: [id] }
  addFrame(frame) {
    const now = this.now();
    for (const { from, to } of frame.renames || []) this._rename(from, to);
    for (const obj of frame.objects || []) {
      if (!obj.id) continue;
      let o = this.objects.get(obj.id);
      if (!o) {
        o = {
          first: now,
          seen: now,
          frames: 0,
          votes: {},
          colors: new Set(),
          upper: new Set(),
          lower: new Set(),
          vehicleColors: new Set(),
          image: null,
          counted: false,
          dwell: 0,
          cells: new Set(),
        };
        this.objects.set(obj.id, o);
      }
      for (const k of ['upper', 'lower', 'vehicleColors']) for (const c of obj[k] || []) o[k].add(c);
      if (obj.bag) o.bag = true;
      if (obj.hat) o.hat = true;
      if (obj.plate && obj.plate.number) o.plate = obj.plate;
      if (Number.isFinite(obj.speed)) o.speed = Math.max(o.speed || 0, obj.speed);
      if (obj.geo) o.geo = obj.geo;
      o.seen = now;
      o.frames += 1;
      if (obj.box) {
        const centre = { x: obj.box.x + obj.box.w / 2, y: obj.box.y + obj.box.h / 2 };
        if (!o.from) o.from = centre;
        o.to = centre;
        o.box = obj.box;
        // Where its feet are (bottom middle of the box): that is the path walked or driven.
        const cx = Math.min(HEAT_W - 1, Math.floor(centre.x * HEAT_W));
        const cy = Math.min(HEAT_H - 1, Math.floor(Math.min(1, obj.box.y + obj.box.h) * HEAT_H));
        o.cells.add(cy * HEAT_W + cx);
      }
      for (const c of obj.colors || []) o.colors.add(c);
      if (obj.image && !o.image) {
        o.image = obj.image;
        if (o.counted) this.onImage({ id: obj.id, image: obj.image });
      }
      const category = categoryOf(obj.type);
      if (FEATURES.includes(category)) {
        o.feature = category;
        if (o.image && !o.reported) this._feature(obj.id, o);
        continue;
      }
      if (category && (obj.likelihood === 0 || obj.likelihood >= MIN_LIKELIHOOD)) {
        o.votes[category] = (o.votes[category] || 0) + 1;
        o.type = obj.type;
      }
      if (!o.counted) this._maybeCount(obj.id, o, now);
      if (o.counted) {
        const minutes = Math.floor((now - o.first) / 60000);
        if (minutes > o.dwell) {
          o.dwell = minutes;
          this.onDwell({
            id: obj.id, category: o.category, minutes, colors: [...o.colors], attrs: attrsOf(o),
          });
        }
      }
    }
    for (const id of frame.deleted || []) this._gone(id);
    this.tick();
  }

  // Forget objects not seen for a while (also called without frames).
  tick() {
    const now = this.now();
    for (const [id, o] of this.objects) if (now - o.seen > FORGET_MS) this._gone(id);
  }

  _maybeCount(id, o, now) {
    const best = Object.entries(o.votes).sort((a, b) => b[1] - a[1])[0];
    if (!best || best[1] < MIN_FRAMES) return;
    o.counted = true;
    const category = best[0];
    o.category = category;
    const key = hourKey(now, this.timeZone);
    o.key = key;
    const bucket = this.history[key] || (this.history[key] = {});
    bucket[category] = (bucket[category] || 0) + 1;
    this.dirty = true;
    this._trim(now);
    this.onCounted({
      id, category, type: o.type, colors: [...o.colors], image: o.image, box: o.box || null, attrs: attrsOf(o),
    });
    this._checkUnusual(key, groupOf(category));
  }

  // The camera says two ids are the same object (tt:ObjectTree Rename/Merge).
  _rename(from, to) {
    const a = this.objects.get(from);
    if (!a) return;
    this.objects.delete(from);
    const b = this.objects.get(to);
    if (!b) {
      this.objects.set(to, a);
      return;
    }
    // Both known: keep the one that was counted (or seen first), add the other's details.
    const [keep, other] = (a.counted && !b.counted) || (a.counted === b.counted && a.first < b.first) ? [a, b] : [b, a];
    keep.first = Math.min(a.first, b.first);
    keep.seen = Math.max(a.seen, b.seen);
    for (const k of ['colors', 'upper', 'lower', 'vehicleColors', 'cells']) for (const v of other[k]) keep[k].add(v);
    for (const [c, n] of Object.entries(other.votes)) keep.votes[c] = (keep.votes[c] || 0) + n;
    keep.image = keep.image || other.image;
    keep.bag = keep.bag || other.bag;
    keep.hat = keep.hat || other.hat;
    keep.plate = keep.plate || other.plate;
    if (other.speed) keep.speed = Math.max(keep.speed || 0, other.speed);
    if (!keep.from) keep.from = other.from;
    this.objects.set(to, keep);
  }

  _feature(id, o) {
    o.reported = true;
    this.onFeature({
      id, kind: o.feature, image: o.image, plate: o.plate || null,
    });
  }

  _gone(id) {
    const o = this.objects.get(id);
    if (!o) return;
    this.objects.delete(id);
    if (o.feature && !o.reported && o.frames >= MIN_FRAMES) this._feature(id, o);
    if (!o.counted) return;
    const direction = directionOf(o.from, o.to);
    const seconds = Math.round((o.seen - o.first) / 1000);
    const bucket = this.history[o.key] || (this.history[o.key] = {});
    if (direction) {
      bucket.dir = bucket.dir || {};
      const d = bucket.dir[o.category] || (bucket.dir[o.category] = {});
      d[direction] = (d[direction] || 0) + 1;
    }
    bucket.stay = bucket.stay || {};
    bucket.stay[o.category] = Math.max(bucket.stay[o.category] || 0, seconds);
    this._addHeat(o.category, o.cells);
    this.dirty = true;
    this.onGone({
      id, category: o.category, direction, seconds, colors: [...o.colors], attrs: attrsOf(o),
    });
  }

  _trim(now) {
    const oldest = hourKey(now - HISTORY_DAYS * 86400000, this.timeZone);
    for (const key of Object.keys(this.history)) if (key < oldest) delete this.history[key];
  }

  _today() {
    return hourKey(this.now(), this.timeZone).slice(0, 10);
  }

  // ---- Heatmap ----

  _fadeHeat() {
    const today = this._today();
    if (this.heat.day === today) return;
    const days = this.heat.day ? Math.max(0, dayDiff(this.heat.day, today)) : 0;
    const keep = HEAT_DAILY_KEEP ** days;
    for (const grid of Object.values(this.heat.grids)) {
      for (let i = 0; i < grid.length; i++) grid[i] = grid[i] * keep < 0.05 ? 0 : Math.round(grid[i] * keep * 100) / 100;
    }
    this.heat.day = today;
  }

  _addHeat(category, cells) {
    if (!cells.size) return;
    this._fadeHeat();
    const grid = this.heat.grids[category] || (this.heat.grids[category] = new Array(HEAT_W * HEAT_H).fill(0));
    for (const i of cells) grid[i] += 1;
  }

  // kind: 'people', 'vehicles' or 'all' -> { w, h, cells: [numbers] }
  heatmap(kind = 'all') {
    this._fadeHeat();
    const cells = new Array(HEAT_W * HEAT_H).fill(0);
    for (const [category, grid] of Object.entries(this.heat.grids)) {
      if (kind !== 'all' && groupOf(category) !== kind) continue;
      for (let i = 0; i < grid.length; i++) cells[i] += grid[i];
    }
    return { w: HEAT_W, h: HEAT_H, cells };
  }

  // ---- Totals ----

  // Counts per category over whole days (first..last 'YYYY-MM-DD', inclusive).
  _totals(first, last) {
    const totals = {};
    const directions = {};
    const longest = { category: null, seconds: 0 };
    const hours = {};
    for (const [key, bucket] of Object.entries(this.history)) {
      const day = key.slice(0, 10);
      if (day < first || day > last) continue;
      for (const c of CATEGORIES) {
        if (!bucket[c]) continue;
        totals[c] = (totals[c] || 0) + bucket[c];
        hours[key.slice(11, 13)] = (hours[key.slice(11, 13)] || 0) + bucket[c];
      }
      for (const [c, d] of Object.entries(bucket.dir || {})) {
        const t = directions[c] || (directions[c] = {});
        for (const [k, n] of Object.entries(d)) t[k] = (t[k] || 0) + n;
      }
      for (const [c, s] of Object.entries(bucket.stay || {})) {
        if (s > longest.seconds) Object.assign(longest, { category: c, seconds: s });
      }
    }
    const busiest = Object.entries(hours).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return {
      totals, directions, longest: longest.category ? longest : null, busiest: busiest ? { hour: busiest[0], count: busiest[1] } : null,
    };
  }

  // Totals per category since local midnight.
  today() {
    const day = this._today();
    return this._totals(day, day).totals;
  }

  // period: 'today', 'yesterday' or 'week' (the last 7 days, today included).
  summary(period = 'today') {
    const today = this._today();
    const first = { today, yesterday: addDays(today, -1), week: addDays(today, -6) }[period] || today;
    const last = period === 'yesterday' ? first : today;
    return { period, first, last, ...this._totals(first, last) };
  }

  // ---- What is usual ----

  // Full days of history before today, newest first (at most USUAL_MAX_DAYS).
  _pastDays() {
    const keys = Object.keys(this.history);
    if (!keys.length) return [];
    const start = keys.reduce((a, b) => (a < b ? a : b)).slice(0, 10);
    const today = this._today();
    const n = Math.min(USUAL_MAX_DAYS, dayDiff(start, today));
    return Array.from({ length: Math.max(0, n) }, (_, i) => addDays(today, -1 - i));
  }

  // Average count for an hour of the day ('07') over the past days, or null without enough history.
  usual(hour, group = 'all') {
    const days = this._pastDays();
    if (days.length < USUAL_MIN_DAYS) return null;
    let sum = 0;
    for (const day of days) {
      const bucket = this.history[`${day}T${hour}`];
      if (!bucket) continue;
      for (const c of CATEGORIES) if (bucket[c] && (group === 'all' || groupOf(c) === group)) sum += bucket[c];
    }
    return sum / days.length;
  }

  _count(key, group) {
    const bucket = this.history[key] || {};
    return CATEGORIES.reduce((n, c) => n + (groupOf(c) === group ? bucket[c] || 0 : 0), 0);
  }

  // Unusual: anything at an hour when there is normally (almost) nothing, or clearly
  // more than normal (at least 3, and more than 2.5 x usual + 2). Once per hour and group.
  _checkUnusual(key, group) {
    const id = `${key}/${group}`;
    if (this.unusualFired.has(id)) return;
    const hour = key.slice(11, 13);
    const usual = this.usual(hour, group);
    if (usual === null) return;
    const count = this._count(key, group);
    const quietHour = usual < 0.15 && count >= 1;
    const busy = count >= 3 && count >= usual * 2.5 + 2;
    if (!quietHour && !busy) return;
    this.unusualFired.add(id);
    if (this.unusualFired.size > 100) this.unusualFired.delete(this.unusualFired.values().next().value);
    this.onUnusual({
      group, count, usual: Math.round(usual * 10) / 10, hour,
    });
  }

  // ---- Charts ----

  // period 'day' = the last 24 hours per hour, 'week' = the last 7 days per day,
  // 'month' = the last 30 days per day.
  // -> { labels, series: { person: [..] }, totals, usual: [..] | null, directions }
  series(period = 'day') {
    const now = this.now();
    const labels = [];
    const keys = [];
    const perDay = period === 'week' || period === 'month';
    if (perDay) {
      const today = this._today();
      for (let i = (period === 'month' ? 29 : 6); i >= 0; i--) {
        const k = addDays(today, -i);
        keys.push(k);
        labels.push(k);
      }
    } else {
      for (let i = 23; i >= 0; i--) {
        const k = hourKey(now - i * 3600000, this.timeZone);
        keys.push(k);
        labels.push(`${k.slice(11, 13)}:00`);
      }
    }
    const series = {};
    const totals = {};
    const directions = {};
    for (const c of CATEGORIES) series[c] = keys.map(() => 0);
    for (const [key, bucket] of Object.entries(this.history)) {
      const i = perDay ? keys.indexOf(key.slice(0, 10)) : keys.indexOf(key);
      if (i < 0) continue;
      for (const c of CATEGORIES) {
        if (!bucket[c]) continue;
        series[c][i] += bucket[c];
        totals[c] = (totals[c] || 0) + bucket[c];
      }
      for (const [c, d] of Object.entries(bucket.dir || {})) {
        const t = directions[c] || (directions[c] = {});
        for (const [k, n] of Object.entries(d)) t[k] = (t[k] || 0) + n;
      }
    }
    for (const c of CATEGORIES) if (!totals[c]) delete series[c];
    let usual = null;
    if (!perDay && this.usual('00') !== null) usual = keys.map((k) => this.usual(k.slice(11, 13)));
    return {
      period, labels, series, totals, usual, directions,
    };
  }

  // What is in view now, per category (counted objects only).
  inView() {
    const out = {};
    for (const o of this.objects.values()) if (o.counted) out[o.category] = (out[o.category] || 0) + 1;
    return out;
  }
}

module.exports = {
  Tracker, categoryOf, FEATURES, directionOf, hourKey, groupOf, dayDiff, addDays, CATEGORIES, DIRECTIONS,
};

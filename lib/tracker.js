'use strict';

// Counts the people and vehicles a camera sees, from its analytics scene description.
//
// Each object keeps its ObjectId while the camera tracks it. An object is counted once,
// in one category, when it has been classified with enough confidence in at least
// MIN_FRAMES frames. Counts go into hourly buckets (kept HISTORY_HOURS) so they can be
// shown per hour and per day.

const MIN_LIKELIHOOD = 0.5;
const MIN_FRAMES = 2;
const FORGET_MS = 15000; // an object not seen this long is gone
const HISTORY_HOURS = 8 * 24;

const CATEGORIES = ['person', 'car', 'truck', 'bus', 'bicycle', 'motorcycle', 'vehicle'];

// Object type as the camera names it -> our category (null = not counted, e.g. faces,
// licence plates, which belong to a person or vehicle already counted).
function categoryOf(type) {
  const t = String(type || '').toLowerCase();
  if (/^(human|person|pedestrian)$/.test(t)) return 'person';
  if (/^car$|sedan|van|suv|pickup/.test(t)) return 'car';
  if (/truck|lorry/.test(t)) return 'truck';
  if (/bus/.test(t)) return 'bus';
  if (/bicycle|cycle$|^bike$/.test(t) && !/motor/.test(t)) return 'bicycle';
  if (/motor|scooter|moped/.test(t)) return 'motorcycle';
  if (/vehicle/.test(t)) return 'vehicle';
  return null;
}

// '2026-10-13T21' for the hour of a timestamp in a time zone (bucket key).
function hourKey(ms, timeZone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
}

class Tracker {
  // history: { '<hourKey>': { person: 3, car: 1 } } from an earlier run.
  // onCounted({ id, category, type, colors, image }) for every newly counted object.
  // timeZone: Homey's time zone (e.g. 'Europe/Stockholm'), for hours and days.
  constructor({
    history = {}, onCounted = () => {}, now = () => Date.now(), timeZone,
  } = {}) {
    this.timeZone = timeZone;
    this.history = history;
    this.onCounted = onCounted;
    this.now = now;
    this.objects = new Map(); // id -> { seen, frames, votes: {category: n}, colors, image, counted }
    this.dirty = false;
  }

  // frame: { objects: [{ id, type, likelihood, colors, image }], deleted: [id] }
  addFrame(frame) {
    const now = this.now();
    for (const obj of frame.objects || []) {
      if (!obj.id) continue;
      let o = this.objects.get(obj.id);
      if (!o) {
        o = {
          seen: now, frames: 0, votes: {}, colors: new Set(), image: null, counted: false,
        };
        this.objects.set(obj.id, o);
      }
      o.seen = now;
      o.frames += 1;
      if (obj.image && !o.image) o.image = obj.image;
      for (const c of obj.colors || []) o.colors.add(c);
      const category = categoryOf(obj.type);
      if (category && (obj.likelihood === 0 || obj.likelihood >= MIN_LIKELIHOOD)) {
        o.votes[category] = (o.votes[category] || 0) + 1;
        o.type = obj.type;
      }
      if (!o.counted) this._maybeCount(obj.id, o, now);
    }
    for (const id of frame.deleted || []) this.objects.delete(id);
    for (const [id, o] of this.objects) if (now - o.seen > FORGET_MS) this.objects.delete(id);
  }

  _maybeCount(id, o, now) {
    const best = Object.entries(o.votes).sort((a, b) => b[1] - a[1])[0];
    if (!best || best[1] < MIN_FRAMES) return;
    o.counted = true;
    const category = best[0];
    const key = hourKey(now, this.timeZone);
    const bucket = this.history[key] || (this.history[key] = {});
    bucket[category] = (bucket[category] || 0) + 1;
    this.dirty = true;
    this._trim(now);
    this.onCounted({
      id, category, type: o.type, colors: [...o.colors], image: o.image,
    });
  }

  _trim(now) {
    const oldest = hourKey(now - HISTORY_HOURS * 3600000, this.timeZone);
    for (const key of Object.keys(this.history)) if (key < oldest) delete this.history[key];
  }

  // Totals per category since local midnight.
  today() {
    const day = hourKey(this.now(), this.timeZone).slice(0, 10);
    const out = {};
    for (const [key, bucket] of Object.entries(this.history)) {
      if (!key.startsWith(day)) continue;
      for (const [c, n] of Object.entries(bucket)) out[c] = (out[c] || 0) + n;
    }
    return out;
  }

  // Chart series: period 'day' = the last 24 hours per hour, 'week' = the last 7 days per day.
  // -> { labels: [...], series: { person: [..], car: [..] }, totals: {...} }
  series(period = 'day') {
    const now = this.now();
    const labels = [];
    const keys = [];
    if (period === 'week') {
      for (let i = 6; i >= 0; i--) {
        const k = hourKey(now - i * 86400000, this.timeZone).slice(0, 10);
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
    for (const c of CATEGORIES) series[c] = keys.map(() => 0);
    for (const [key, bucket] of Object.entries(this.history)) {
      const i = period === 'week' ? keys.indexOf(key.slice(0, 10)) : keys.indexOf(key);
      if (i < 0) continue;
      for (const [c, n] of Object.entries(bucket)) {
        if (!series[c]) continue;
        series[c][i] += n;
        totals[c] = (totals[c] || 0) + n;
      }
    }
    for (const c of CATEGORIES) if (!totals[c]) delete series[c];
    return { period, labels, series, totals };
  }
}

module.exports = {
  Tracker, categoryOf, hourKey, CATEGORIES,
};

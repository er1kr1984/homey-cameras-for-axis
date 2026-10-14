'use strict';

// Motion over time, for every camera (also those without Object Analytics): how often
// motion started and for how long it lasted, per hour, kept HISTORY_DAYS. Like the
// tracker it knows what is usual for each hour and says when an hour is unusual.

const { hourKey, dayDiff, addDays } = require('./tracker');

const HISTORY_DAYS = 35;
const USUAL_MIN_DAYS = 7;
const USUAL_MAX_DAYS = 28;

class Activity {
  // history: { '<hourKey>': { n: 3, s: 95 } } (motion starts, seconds of motion)
  // onUnusual({ count, usual, hour }) at most once per hour.
  constructor({
    history = {}, now = () => Date.now(), timeZone, onUnusual = () => {},
  } = {}) {
    this.history = history;
    this.now = now;
    this.timeZone = timeZone;
    this.onUnusual = onUnusual;
    this.startedAt = null;
    this.unusualFired = new Set();
    this.dirty = false;
  }

  _bucket(ms) {
    const key = hourKey(ms, this.timeZone);
    return this.history[key] || (this.history[key] = { n: 0, s: 0 });
  }

  // Motion turned on.
  start() {
    if (this.startedAt !== null) return;
    const now = this.now();
    this.startedAt = now;
    this._bucket(now).n += 1;
    this.dirty = true;
    this._trim(now);
    this._checkUnusual(hourKey(now, this.timeZone));
  }

  // Motion turned off: its time goes to the hours it lasted in.
  stop() {
    if (this.startedAt === null) return;
    let t = this.startedAt;
    const end = this.now();
    this.startedAt = null;
    while (t < end) {
      const nextHour = Math.min(end, (Math.floor(t / 3600000) + 1) * 3600000);
      this._bucket(t).s += Math.round((nextHour - t) / 1000);
      t = nextHour;
    }
    this.dirty = true;
  }

  _trim(now) {
    const oldest = hourKey(now - HISTORY_DAYS * 86400000, this.timeZone);
    for (const key of Object.keys(this.history)) if (key < oldest) delete this.history[key];
  }

  _today() {
    return hourKey(this.now(), this.timeZone).slice(0, 10);
  }

  _pastDays() {
    const keys = Object.keys(this.history);
    if (!keys.length) return [];
    const start = keys.reduce((a, b) => (a < b ? a : b)).slice(0, 10);
    const today = this._today();
    const n = Math.min(USUAL_MAX_DAYS, dayDiff(start, today));
    return Array.from({ length: Math.max(0, n) }, (_, i) => addDays(today, -1 - i));
  }

  // Average motion starts for an hour of the day ('07'), or null without a week of history.
  usual(hour) {
    const days = this._pastDays();
    if (days.length < USUAL_MIN_DAYS) return null;
    return days.reduce((sum, day) => sum + ((this.history[`${day}T${hour}`] || {}).n || 0), 0) / days.length;
  }

  _checkUnusual(key) {
    if (this.unusualFired.has(key)) return;
    const hour = key.slice(11, 13);
    const usual = this.usual(hour);
    if (usual === null) return;
    const count = (this.history[key] || {}).n || 0;
    if (!((usual < 0.15 && count >= 1) || (count >= 3 && count >= usual * 2.5 + 2))) return;
    this.unusualFired.add(key);
    if (this.unusualFired.size > 100) this.unusualFired.delete(this.unusualFired.values().next().value);
    this.onUnusual({ count, usual: Math.round(usual * 10) / 10, hour });
  }

  // Seconds of motion so far, including motion still going on.
  _openSeconds(first, last) {
    if (this.startedAt === null) return 0;
    const day = this._today();
    return day >= first && day <= last ? Math.round((this.now() - this.startedAt) / 1000) : 0;
  }

  // period: 'today', 'yesterday' or 'week' -> { count, seconds, busiest: { hour, count } }
  summary(period = 'today') {
    const today = this._today();
    const first = { today, yesterday: addDays(today, -1), week: addDays(today, -6) }[period] || today;
    const last = period === 'yesterday' ? first : today;
    let count = 0;
    let seconds = this._openSeconds(first, last);
    const hours = {};
    for (const [key, b] of Object.entries(this.history)) {
      const day = key.slice(0, 10);
      if (day < first || day > last) continue;
      count += b.n;
      seconds += b.s;
      hours[key.slice(11, 13)] = (hours[key.slice(11, 13)] || 0) + b.n;
    }
    const busiest = Object.entries(hours).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return {
      period, count, seconds, busiest: busiest && busiest[1] ? { hour: busiest[0], count: busiest[1] } : null,
    };
  }

  today() {
    return this.summary('today').count;
  }

  // Same shape as Tracker.series, with one series: 'motion' (motion starts).
  series(period = 'day') {
    const now = this.now();
    const perDay = period === 'week' || period === 'month';
    const keys = [];
    const labels = [];
    if (perDay) {
      const today = this._today();
      for (let i = (period === 'month' ? 29 : 6); i >= 0; i--) {
        keys.push(addDays(today, -i));
        labels.push(keys[keys.length - 1]);
      }
    } else {
      for (let i = 23; i >= 0; i--) {
        const k = hourKey(now - i * 3600000, this.timeZone);
        keys.push(k);
        labels.push(`${k.slice(11, 13)}:00`);
      }
    }
    const motion = keys.map(() => 0);
    let minutes = 0;
    for (const [key, b] of Object.entries(this.history)) {
      const i = keys.indexOf(perDay ? key.slice(0, 10) : key);
      if (i < 0) continue;
      motion[i] += b.n;
      minutes += b.s / 60;
    }
    const total = motion.reduce((a, b) => a + b, 0);
    let usual = null;
    if (!perDay && this.usual('00') !== null) usual = keys.map((k) => this.usual(k.slice(11, 13)));
    return {
      period, labels, series: total ? { motion } : {}, totals: total ? { motion: total } : {}, usual, directions: {}, minutes: Math.round(minutes),
    };
  }
}

module.exports = { Activity };

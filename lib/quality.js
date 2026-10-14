'use strict';

// Automatic stream quality.
//
// Homey stops apps that use too much CPU, and relaying video costs CPU per packet.
// The relay offers three quality levels per camera (high/medium/low, see
// rtsp-upstream.js). This module watches the app's own CPU use and tells the relay
// when to step a stream down.

const PROFILES = ['high', 'medium', 'low'];

// Highest pixel rate we start with in Auto mode: 1280x720 at 15 fps.
const START_MAX_PIXEL_RATE = 1280 * 720 * 15;

const SAMPLE_MS = 5000;
// % of one core, averaged over two samples. Overridable for tests.
const CPU_HIGH = Number(process.env.AXIS_CPU_HIGH) || 35; // step an Auto stream down
const CPU_CRITICAL = Number(process.env.AXIS_CPU_CRITICAL) || 50; // also step down fixed-quality streams
const SWITCH_COOLDOWN_MS = 15000;
// Below this an Auto stream may go one level up (at most to AUTO_CEILING), once the
// last quality change is this long ago.
const CPU_LOW = Number(process.env.AXIS_CPU_LOW) || 12;
const STEP_UP_AFTER_MS = 60000;
const AUTO_CEILING = 'medium';
// Starting a stream (DTLS handshake, ICE, login) briefly costs a lot of CPU; readings
// taken right after a start say nothing about the steady video load.
const SETUP_GRACE_MS = 12000;
const SAMPLES_TO_ACT = 3; // 3 x 5 s of high CPU before stepping down

function lower(profile) {
  const i = PROFILES.indexOf(profile);
  return i >= 0 && i < PROFILES.length - 1 ? PROFILES[i + 1] : null;
}

function higher(profile) {
  const i = PROFILES.indexOf(profile);
  return i > 0 ? PROFILES[i - 1] : null;
}

function pixelRate(p) {
  const m = /^(\d+)x(\d+)$/.exec((p && p.Resolution) || '');
  if (!m) return Infinity;
  return Number(m[1]) * Number(m[2]) * (Number(p.Framerate) || 30);
}

// profiles: { High: {Resolution, Framerate}, Medium: {...}, Low: {...} } from ACS.
function chooseStartProfile(profiles) {
  if (!profiles) return 'medium';
  const available = PROFILES.filter((name) => profiles[name[0].toUpperCase() + name.slice(1)]);
  if (!available.length) return 'medium';
  for (const name of available) {
    if (pixelRate(profiles[name[0].toUpperCase() + name.slice(1)]) <= START_MAX_PIXEL_RATE) return name;
  }
  return available[available.length - 1];
}

// Samples this process' CPU use; calls onSample(percentOfOneCore).
class CpuMonitor {
  constructor({ onSample, intervalMs = SAMPLE_MS }) {
    this.onSample = onSample;
    this.last = process.cpuUsage();
    this.lastAt = Date.now();
    this.timer = setInterval(() => this._sample(), intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  _sample() {
    const usage = process.cpuUsage(this.last);
    const now = Date.now();
    const percent = ((usage.user + usage.system) / 1000 / (now - this.lastAt)) * 100;
    this.last = process.cpuUsage();
    this.lastAt = now;
    this.onSample(percent);
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = {
  PROFILES, lower, higher, CPU_LOW, STEP_UP_AFTER_MS, AUTO_CEILING, chooseStartProfile, CpuMonitor, CPU_HIGH, CPU_CRITICAL, SWITCH_COOLDOWN_MS,
  SETUP_GRACE_MS, SAMPLES_TO_ACT,
};

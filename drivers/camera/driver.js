'use strict';

const Homey = require('homey');
const { VapixClient, usableAddress } = require('../../lib/vapix');
const { scanSubnet } = require('../../lib/scan');

// Product types offered as cameras; speakers, recorders and door controllers come later.
const CAMERA_TYPES = /camera|door station|encoder|intercom|thermal/i;
const NOT_CAMERAS = /recorder|speaker|audio|door controller|radar|i\/o|switch/i;
const isCamera = (type) => !type || (CAMERA_TYPES.test(type) && !NOT_CAMERAS.test(type));
// Flow card filters: 'any', a category ('car'), or a group ('people', 'vehicles').
const typeMatches = (type, category) => !type || type === 'any' || type === category
  || (type === 'people' && category === 'person') || (type === 'vehicles' && category !== 'person');
const colorMatches = (color, colors) => !color || color === 'any' || (colors || []).includes(color);
const CHECK_TIMEOUT_MS = 6000; // per request while searching
const LIST_DEADLINE_MS = 12000; // after the network search, for the logins

// When the app starts, cameras start this far apart: logging in, reading events and
// opening streams for all of them at once is a CPU spike Homey warns about.
const START_GAP_MS = 3000;

class CameraDriver extends Homey.Driver {

  // ms a camera should wait before it starts (0 for one added later).
  startDelay() {
    const now = Date.now();
    const at = Math.max(now, this.nextStartAt || 0);
    this.nextStartAt = at + START_GAP_MS;
    return at - now;
  }

  async onInit() {
    const flow = this.homey.flow;
    const card = (id) => flow.getDeviceTriggerCard(id);
    this.triggers = {
      motionStarted: card('motion_started'),
      motionStopped: card('motion_stopped'),
      analytics: card('analytics_triggered'),
      tampering: card('tampering_detected'),
      dayNight: card('day_night_changed'),
      input: card('input_changed'),
      audio: card('audio_detected'),
      event: card('event_received'),
      sound: card('sound_recognised'),
      counted: card('object_counted'),
      problem: card('camera_problem'),
      problemSolved: card('camera_problem_solved'),
      watched: card('live_watched_changed'),
      schedule: card('schedule_changed'),
      inView: card('in_view_changed'),
      detected: card('object_detected'),
      passed: card('object_passed'),
      lingering: card('object_lingering'),
      unusual: card('unusual_activity'),
      summary: card('daily_summary'),
    };
    this.triggers.detected.registerRunListener(async (args, state) => typeMatches(args.type, state.category) && colorMatches(args.color, state.colors));
    this.triggers.passed.registerRunListener(async (args, state) => typeMatches(args.type, state.category)
      && (!args.direction || args.direction === 'any' || args.direction === state.direction) && colorMatches(args.color, state.colors));
    this.triggers.lingering.registerRunListener(async (args, state) => typeMatches(args.type, state.category)
      && Math.max(1, Math.round(Number(args.minutes) || 0)) === state.minutes);
    this.triggers.unusual.registerRunListener(async (args, state) => !args.group || args.group === 'any' || args.group === state.group);
    this.triggers.summary.registerRunListener(async (args, state) => args.time === state.time && (args.period || 'today') === state.period);
    this.triggers.sound.registerRunListener(async (args, state) => args.sound === 'any' || args.sound === state.sound);
    this.triggers.counted.registerRunListener(async (args, state) => !args.scenario || args.scenario.id === 'any' || args.scenario.id === state.topic);
    this.triggers.counted.registerArgumentAutocompleteListener('scenario', async (query, args) => args.device.countingChoices(query));
    this.triggers.analytics.registerRunListener(async (args, state) => !args.scenario || args.scenario.id === 'any' || args.scenario.id === state.topic);
    this.triggers.analytics.registerArgumentAutocompleteListener('scenario', async (query, args) => args.device.scenarioChoices(query));
    this.triggers.input.registerRunListener(async (args, state) => !args.port || Number(args.port) === state.port);

    flow.getConditionCard('is_night').registerRunListener(async (args) => args.device.getCapabilityValue('axis_night') === true);
    flow.getConditionCard('live_watched').registerRunListener(async (args) => args.device.isWatched());
    flow.getConditionCard('has_problem').registerRunListener(async (args) => args.device.getCapabilityValue('alarm_problem') === true);
    flow.getConditionCard('object_in_view').registerRunListener(async (args) => args.device.inViewCount(args.type) > 0);
    flow.getConditionCard('in_view_more').registerRunListener(async (args) => args.device.inViewCount(args.type) > Number(args.count));
    flow.getConditionCard('input_active').registerRunListener(async (args) => args.device.isInputActive(Number(args.port)));

    flow.getActionCard('make_summary').registerRunListener(async (args) => args.device.summaryTokens(args.period));
    flow.getActionCard('take_snapshot').registerRunListener(async (args) => args.device.snapshotToken());
    const preset = flow.getActionCard('ptz_goto_preset');
    preset.registerRunListener(async (args) => args.device.ptzGotoPreset(args.preset));
    preset.registerArgumentAutocompleteListener('preset', async (query, args) => args.device.presetChoices(query));
    flow.getActionCard('ptz_home').registerRunListener(async (args) => args.device.ptzHome());
    flow.getActionCard('set_light').registerRunListener(async (args) => args.device.setLight(args.state));
    flow.getActionCard('virtual_input').registerRunListener(async (args) => args.device.virtualInput(Number(args.port), args.action, Number(args.duration) || 0));
    flow.getActionCard('set_output').registerRunListener(async (args) => args.device.setOutput(Number(args.port), args.action, Number(args.duration) || 0));
  }

  // ---- Pairing ----
  // 1. login (Homey's username/password screen), 2. list cameras that accept that login.

  async onPair(session) {
    let login = null;
    this.homey.app.diag('pairing started');
    session.setHandler('showView', async (view) => this.homey.app.diag(`pairing view: ${view}`));
    session.setHandler('login', async ({ username, password }) => {
      this.homey.app.diag('pairing: login entered');
      login = { username: String(username || '').trim(), password: String(password || '') };
      if (!login.username) throw new Error(this.homey.__('pair.noUsername'));
      return true;
    });
    session.setHandler('list_devices', async () => {
      if (!login) throw new Error(this.homey.__('pair.noUsername'));
      const t0 = Date.now();
      try {
        const list = await this._camerasForLogin(login);
        this.homey.app.diag(`pairing: ${list.length} camera(s) listed after ${Date.now() - t0} ms`);
        return list;
      } catch (err) {
        this.homey.app.diagError('pairing failed:', err.message);
        throw err;
      }
    });
  }

  // Homey "Repair": type the camera's login again (e.g. after a password change).
  async onRepair(session, device) {
    session.setHandler('login', async ({ username, password }) => {
      await device.changeLogin(String(username || '').trim(), String(password || ''));
      return true;
    });
  }

  async _candidates() {
    const found = new Map(); // serial -> { host, secure, info, needsLogin }
    let strategy;
    try {
      strategy = this.getDiscoveryStrategy();
    } catch (err) {
      strategy = null;
    }
    const results = strategy ? Object.values(strategy.getDiscoveryResults()) : [];
    for (const r of results) {
      const serial = String((r.txt && r.txt.macaddress) || r.id || '').toUpperCase();
      if (serial && usableAddress(r.address)) found.set(serial, { host: r.address, secure: true, info: { SerialNumber: serial }, needsLogin: true });
    }
    // mDNS may be blocked: also look around Homey's own network.
    try {
      const local = String(await this.homey.cloud.getLocalAddress()).split(':')[0];
      const scanned = await scanSubnet(local);
      for (const s of scanned) {
        const serial = String((s.info && s.info.SerialNumber) || '').toUpperCase();
        if (!serial) continue;
        const known = found.get(serial);
        found.set(serial, { ...known, ...s, info: { ...(known && known.info), ...s.info } });
      }
      this.homey.app.diag(`pairing: ${results.length} by mDNS, ${scanned.length} by network scan`);
    } catch (err) {
      this.homey.app.diagError('network scan failed:', err.message);
    }
    return [...found.entries()].map(([serial, c]) => ({ serial, ...c }));
  }

  async _camerasForLogin({ username, password }) {
    const existing = new Set(this.getDevices().map((d) => d.getData().id));
    const candidates = (await this._candidates()).filter((c) => !existing.has(c.serial));
    const loginFailed = [];
    const devices = [];
    const check = async (c) => {
      // Recorders, speakers, etc. say what they are without a login: skip them here.
      if (c.info && !isCamera(c.info.ProdType)) return;
      let pin = null;
      const t0 = Date.now();
      const client = new VapixClient({
        host: c.host, secure: c.secure, username, password, timeoutMs: CHECK_TIMEOUT_MS, onNewPin: (fp) => { pin = fp; },
      });
      client.onStep = (step) => this.homey.app.diag(`pairing: ${c.host} ${step} after ${Date.now() - t0} ms`);
      try {
        const info = await client.deviceInfo();
        if (!isCamera(info.ProdType)) return;
        const model = info.ProdNbr || info.ProdShortName || 'Axis camera';
        devices.push({
          name: `AXIS ${model}`.replace(/^AXIS AXIS /, 'AXIS '),
          data: { id: c.serial },
          store: {
            host: c.host, secure: c.secure, username, password, pin,
          },
          settings: { address: c.host, use_https: c.secure },
        });
        this.homey.app.diag(`pairing: ${c.host} ${model} OK after ${Date.now() - t0} ms`);
      } catch (err) {
        if (err.code === 'login_failed') loginFailed.push(c.host);
        this.homey.app.diag(`pairing: ${c.host} skipped (${err.code || err.message}) after ${Date.now() - t0} ms`);
      } finally {
        client.close();
      }
    };
    // Homey gives this screen 30 seconds: answer with what is ready by the deadline.
    await Promise.race([
      Promise.all(candidates.map(check)),
      new Promise((r) => setTimeout(r, LIST_DEADLINE_MS)),
    ]);
    if (!devices.length && loginFailed.length) {
      throw new Error(this.homey.__('pair.loginRefused', { n: loginFailed.length }));
    }
    const list = devices.slice();
    list.sort((a, b) => a.store.host.localeCompare(b.store.host, undefined, { numeric: true }));
    return list;
  }
}

module.exports = CameraDriver;

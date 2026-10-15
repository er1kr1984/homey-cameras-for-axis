'use strict';

const Homey = require('homey');
const {
  VapixClient, usableAddress, probe, NOT_CAMERAS,
} = require('../../lib/vapix');
const { scanSubnet, parseAddresses, ADDRESS } = require('../../lib/scan');

// Product types offered as cameras; speakers, recorders and door controllers come later.
const CAMERA_TYPES = /camera|door station|encoder|intercom|thermal/i;
const isCamera = (type) => !type || (CAMERA_TYPES.test(type) && !NOT_CAMERAS.test(type));
// Flow card filters: 'any', a category ('car'), or a group ('people', 'vehicles').
const typeMatches = (type, category) => !type || type === 'any' || type === category
  || (type === 'people' && category === 'person') || (type === 'vehicles' && category !== 'person');
const colorMatches = (color, colors) => !color || color === 'any' || (colors || []).includes(color);
const CHECK_TIMEOUT_MS = 6000; // per request while searching
const SEARCH_MS = 10000; // network scan: no new checks after this
const TOTAL_MS = 22000; // the whole camera list, well inside Homey's limit for the screen

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
      pir: card('pir_changed'),
      blockedIp: card('ip_blocked'),
      soundLimit: card('sound_limit'),
      doorbell: card('doorbell'),
      callState: card('call_state'),
      pin: card('pin_entered'),
      rfid: card('tag_shown'),
      access: card('access_decided'),
      presence: card('presence'),
      face: card('face_seen'),
      plate: card('plate_seen'),
      occupancy: card('occupancy_changed'),
    };
    this.triggers.pir.registerRunListener(async (args, state) => !args.state || args.state === 'any' || (args.state === 'on') === state.active);
    this.triggers.soundLimit.registerRunListener(async (args, state) => (args.limit === 'above') === state.above);
    this.triggers.access.registerRunListener(async (args, state) => !args.result || args.result === 'any' || (args.result === 'granted') === state.granted);
    this.triggers.occupancy.registerRunListener(async (args, state) => !args.scenario || args.scenario.id === 'any' || args.scenario.id === state.topic);
    this.triggers.occupancy.registerArgumentAutocompleteListener('scenario', async (query, args) => args.device.occupancyChoices(query));
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
    flow.getConditionCard('pir_active').registerRunListener(async (args) => args.device.getCapabilityValue('axis_pir') === true);
    flow.getConditionCard('privacy_on').registerRunListener(async (args) => args.device.getCapabilityValue('axis_privacy') === true);
    flow.getConditionCard('call_active').registerRunListener(async (args) => args.device.getCapabilityValue('axis_call') === true);
    const occupancyMore = flow.getConditionCard('occupancy_more');
    occupancyMore.registerRunListener(async (args) => args.device.occupancyOf(args.scenario) > Number(args.count));
    occupancyMore.registerArgumentAutocompleteListener('scenario', async (query, args) => (await args.device.occupancyChoices(query)).filter((c) => c.id !== 'any'));
    flow.getConditionCard('input_active').registerRunListener(async (args) => args.device.isInputActive(Number(args.port)));

    flow.getActionCard('make_summary').registerRunListener(async (args) => args.device.summaryTokens(args.period));
    flow.getActionCard('take_snapshot').registerRunListener(async (args) => args.device.snapshotToken());
    const preset = flow.getActionCard('ptz_goto_preset');
    preset.registerRunListener(async (args) => args.device.ptzGotoPreset(args.preset));
    preset.registerArgumentAutocompleteListener('preset', async (query, args) => args.device.presetChoices(query));
    flow.getActionCard('ptz_home').registerRunListener(async (args) => args.device.ptzHome());
    flow.getActionCard('set_light').registerRunListener(async (args) => args.device.setLight(args.state));
    flow.getActionCard('virtual_input').registerRunListener(async (args) => args.device.virtualInput(Number(args.port), args.action, Number(args.duration) || 0));
    flow.getActionCard('privacy_set').registerRunListener(async (args) => args.device.setPrivacy(args.state === 'on'));
    const playClip = flow.getActionCard('play_clip');
    playClip.registerRunListener(async (args) => args.device.playClip(args.clip, args.volume === undefined || args.volume === null || args.volume === '' ? NaN : Number(args.volume)));
    playClip.registerArgumentAutocompleteListener('clip', async (query, args) => args.device.clipChoices(query));
    flow.getActionCard('stop_clip').registerRunListener(async (args) => args.device.stopClip());
    const siren = flow.getActionCard('siren_start');
    siren.registerRunListener(async (args) => args.device.startSiren(args.profile));
    siren.registerArgumentAutocompleteListener('profile', async (query, args) => args.device.sirenChoices(query));
    flow.getActionCard('siren_stop').registerRunListener(async (args) => args.device.stopSiren());
    flow.getActionCard('restart_camera').registerRunListener(async (args) => args.device.restartCamera());
    flow.getActionCard('show_text').registerRunListener(async (args) => args.device.showText(args.text, args.position));
    flow.getActionCard('remove_text').registerRunListener(async (args) => args.device.removeText());
    const reset = flow.getActionCard('reset_counts');
    reset.registerRunListener(async (args) => args.device.resetCounts(args.scenario));
    reset.registerArgumentAutocompleteListener('scenario', async (query, args) => args.device.aoaChoices(query, true));
    const testAlarm = flow.getActionCard('test_scenario');
    testAlarm.registerRunListener(async (args) => args.device.testScenario(args.scenario));
    testAlarm.registerArgumentAutocompleteListener('scenario', async (query, args) => args.device.aoaChoices(query, false));
    flow.getActionCard('set_output').registerRunListener(async (args) => args.device.setOutput(Number(args.port), args.action, Number(args.duration) || 0));
  }

  // ---- Pairing ----
  // 1. login, plus camera addresses if the search can't find them (own view 'login'),
  // 2. list cameras that accept that login.

  async onPair(session) {
    let login = null;
    this.homey.app.diag('pairing started');
    session.setHandler('showView', async (view) => this.homey.app.diag(`pairing view: ${view}`));
    session.setHandler('login', async ({ username, password, addresses }) => {
      login = null;
      const user = String(username || '').trim();
      if (!user) throw new Error(this.homey.__('pair.noUsername'));
      const typed = parseAddresses(addresses);
      const bad = typed.filter((a) => !ADDRESS.test(a));
      if (bad.length) throw new Error(this.homey.__('pair.badAddress', { address: bad.join(', ') }));
      login = { username: user, password: String(password || ''), addresses: typed };
      this.homey.app.diag(`pairing: login entered, ${typed.length} address(es) typed`);
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
      const scanned = await scanSubnet(local, { timeoutMs: SEARCH_MS });
      for (const s of scanned) {
        const serial = String((s.info && s.info.SerialNumber) || '').toUpperCase();
        if (!serial) continue;
        const known = found.get(serial);
        found.set(serial, { ...known, ...s, info: { ...(known && known.info), ...s.info } });
      }
      this.homey.app.diag(`pairing: ${results.length} by mDNS, ${scanned.length} by network scan on ${local}`);
    } catch (err) {
      this.homey.app.diagError('network scan failed:', err.message);
    }
    return [...found.entries()].map(([serial, c]) => ({ serial, ...c }));
  }

  // A typed address: is there an Axis device? Resolves a candidate, or { host, problem }.
  async _typedCandidate(host) {
    const r = await probe(host, CHECK_TIMEOUT_MS);
    if (!r) return { host, problem: 'unreachable' };
    const serial = String((r.info && r.info.SerialNumber) || '').toUpperCase();
    return { serial, host, ...r };
  }

  async _camerasForLogin({ username, password, addresses = [] }) {
    const deadline = Date.now() + TOTAL_MS;
    const existing = new Set(this.getDevices().map((d) => d.getData().id));
    const loginFailed = [];
    const devices = [];
    const problems = new Map(); // typed address -> why it wasn't listed
    const typed = new Set(addresses);
    const check = async (c) => {
      // Recorders, speakers, etc. say what they are without a login: skip them here.
      if (c.info && c.info.ProdType && !isCamera(c.info.ProdType)) {
        problems.set(c.host, 'notCamera');
        return;
      }
      let pin = null;
      const t0 = Date.now();
      const client = new VapixClient({
        host: c.host, secure: c.secure, username, password, timeoutMs: CHECK_TIMEOUT_MS, onNewPin: (fp) => { pin = fp; },
      });
      client.onStep = (step) => this.homey.app.diag(`pairing: ${c.host} ${step} after ${Date.now() - t0} ms`);
      try {
        const info = await client.deviceInfo();
        if (!isCamera(info.ProdType)) {
          problems.set(c.host, 'notCamera');
          return;
        }
        const serial = c.serial || String(info.SerialNumber || '').toUpperCase();
        if (!serial) {
          problems.set(c.host, 'unreachable');
          return;
        }
        if (existing.has(serial)) {
          problems.set(c.host, 'alreadyAdded');
          return;
        }
        if (devices.some((d) => d.data.id === serial)) return; // typed and also found
        const model = info.ProdNbr || info.ProdShortName || 'Axis camera';
        devices.push({
          name: `AXIS ${model}`.replace(/^AXIS AXIS /, 'AXIS '),
          data: { id: serial },
          store: {
            host: c.host, secure: c.secure, username, password, pin,
          },
          settings: { address: c.host, use_https: c.secure },
        });
        this.homey.app.diag(`pairing: ${c.host} ${model} OK after ${Date.now() - t0} ms`);
      } catch (err) {
        if (err.code === 'login_failed') {
          loginFailed.push(c.host);
          problems.set(c.host, 'loginFailed');
        } else {
          problems.set(c.host, 'unreachable');
        }
        this.homey.app.diag(`pairing: ${c.host} skipped (${err.code || err.message}) after ${Date.now() - t0} ms`);
      } finally {
        client.close();
      }
    };

    // Typed addresses are checked straight away, next to the search.
    const typedChecks = addresses.map(async (host) => {
      const c = await this._typedCandidate(host);
      if (c.problem) {
        problems.set(host, c.problem);
        return;
      }
      if (c.serial && existing.has(c.serial)) {
        problems.set(host, 'alreadyAdded');
        return;
      }
      await check(c);
    });
    const searched = (async () => {
      const candidates = (await this._candidates())
        .filter((c) => !existing.has(c.serial) && !typed.has(c.host));
      await Promise.all(candidates.map(check));
    })();
    // Homey gives this screen about 30 seconds: answer with what is ready by the deadline.
    await Promise.race([
      Promise.all([searched, ...typedChecks]),
      new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now()))),
    ]);

    // Say why a typed address isn't in the list (it would otherwise just be missing).
    const typedProblems = addresses
      .filter((a) => !devices.some((d) => d.store.host === a))
      .map((a) => this.homey.__(`pair.address.${problems.get(a) || 'noAnswer'}`, { address: a }));
    if (typedProblems.length) throw new Error(typedProblems.join('\n'));
    if (!devices.length && loginFailed.length) {
      throw new Error(this.homey.__('pair.loginRefused', { n: loginFailed.length }));
    }
    if (!devices.length) throw new Error(this.homey.__('pair.noneFound'));
    const list = devices.slice();
    list.sort((a, b) => a.store.host.localeCompare(b.store.host, undefined, { numeric: true }));
    return list;
  }
}

module.exports = CameraDriver;

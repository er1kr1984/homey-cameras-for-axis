'use strict';

const Homey = require('homey');
const {
  VapixClient, usableAddress, probe, NOT_CAMERAS,
} = require('../../lib/vapix');
const {
  scanHosts, subnetHosts, prefixOf, parseAddresses, parseEntry, splitHostPort,
} = require('../../lib/scan');

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
const MAX_REMEMBERED_NETWORKS = 4; // other networks with added cameras, searched too

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
  // 1. login (own view 'login', with optional camera addresses or networks),
  // 2. list cameras that accept that login,
  // 3. found nothing: own view 'address' asks for the cameras' addresses or network, then 2
  //    again for just those.

  async onPair(session) {
    let login = null;
    this.homey.app.diag('pairing started');
    session.setHandler('showView', async (view) => this.homey.app.diag(`pairing view: ${view}`));
    // Typed text -> { singles: ['192.168.40.10', 'cam.local:8443'], rangeHosts: [...] }
    const typedAddresses = (text) => {
      const singles = [];
      const rangeHosts = new Set();
      const bad = [];
      for (const entry of parseAddresses(text)) {
        const parsed = parseEntry(entry);
        if (!parsed) bad.push(entry);
        else if (parsed.hosts) parsed.hosts.forEach((h) => rangeHosts.add(h));
        else singles.push(entry);
      }
      if (bad.length) throw new Error(this.homey.__('pair.badAddress', { address: bad.join(', ') }));
      return { singles, rangeHosts: [...rangeHosts] };
    };
    session.setHandler('login', async ({ username, password, addresses }) => {
      login = null;
      const user = String(username || '').trim();
      if (!user) throw new Error(this.homey.__('pair.noUsername'));
      const typed = typedAddresses(addresses);
      login = {
        username: user, password: String(password || ''), ...typed, search: true,
      };
      this.homey.app.diag(`pairing: login entered, ${typed.singles.length} address(es) and ${typed.rangeHosts.length} network address(es) typed`);
      return true;
    });
    session.setHandler('addresses', async ({ addresses }) => {
      if (!login) throw new Error(this.homey.__('pair.noUsername'));
      const typed = typedAddresses(addresses);
      if (!typed.singles.length && !typed.rangeHosts.length) throw new Error(this.homey.__('pair.noAddress'));
      login = { ...login, ...typed, search: false };
      this.homey.app.diag(`pairing: ${typed.singles.length} address(es) and ${typed.rangeHosts.length} network address(es) typed after an empty search`);
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
        if (err.code === 'none_found') {
          this.homey.app.diag('pairing: nothing found, asking for addresses');
          await session.showView('address');
          return [];
        }
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

  // Networks to search: Homey's own, and those of cameras already added (cameras on a
  // separate network are found again when adding the next one).
  async _searchNetworks() {
    const local = String(await this.homey.cloud.getLocalAddress().catch(() => '')).split(':')[0];
    const own = prefixOf(local);
    const others = new Set();
    for (const device of this.getDevices()) {
      const prefix = prefixOf(splitHostPort(device.getSetting('address')).host);
      if (prefix && prefix !== own) others.add(prefix);
    }
    return { local, own, others: [...others].slice(0, MAX_REMEMBERED_NETWORKS) };
  }

  // search: Homey's discovery and network scans; rangeHosts: typed networks, always checked.
  async _candidates({ search = true, rangeHosts = [] } = {}) {
    const found = new Map(); // serial -> { host, secure, info, needsLogin }
    const add = (list) => {
      for (const c of list) {
        const serial = String((c.info && c.info.SerialNumber) || '').toUpperCase();
        if (!serial) continue;
        const known = found.get(serial);
        found.set(serial, { ...known, ...c, info: { ...(known && known.info), ...c.info } });
      }
    };
    const hosts = new Set(rangeHosts);
    let mdns = 0;
    if (search) {
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
      mdns = results.length;
      // mDNS may be blocked, or not reach other networks: also look around.
      const { local, own, others } = await this._searchNetworks();
      if (own) subnetHosts(own, [local]).forEach((h) => hosts.add(h));
      for (const prefix of others) subnetHosts(prefix).forEach((h) => hosts.add(h));
      this.homey.app.diag(`pairing: searching ${[own, ...others].filter(Boolean).map((p) => `${p}.x`).join(', ') || 'no network'}`
        + `${rangeHosts.length ? ` and ${rangeHosts.length} typed network address(es)` : ''}`);
    }
    try {
      const scanned = await scanHosts([...hosts], { timeoutMs: SEARCH_MS });
      add(scanned);
      this.homey.app.diag(`pairing: ${mdns} by mDNS, ${scanned.length} by network scan of ${hosts.size} address(es)`);
    } catch (err) {
      this.homey.app.diagError('network scan failed:', err.message);
    }
    return [...found.entries()].map(([serial, c]) => ({ serial, ...c }));
  }

  // A typed address ("host" or "host:port"): is there an Axis device there?
  // Resolves a candidate, or { host, problem }.
  async _typedCandidate(address) {
    const { host, port } = splitHostPort(address);
    const r = await probe(host, CHECK_TIMEOUT_MS, port);
    if (!r) return { address, host, problem: 'unreachable' };
    const serial = String((r.info && r.info.SerialNumber) || '').toUpperCase();
    return {
      serial, address, host, port, ...r,
    };
  }

  async _camerasForLogin({
    username, password, singles = [], rangeHosts = [], search = true,
  }) {
    const deadline = Date.now() + TOTAL_MS;
    const existing = new Set(this.getDevices().map((d) => d.getData().id));
    const loginFailed = []; // [{ host, model }]
    const devices = [];
    const problems = new Map(); // typed address -> why it wasn't listed
    const typedHosts = new Set(singles.map((a) => splitHostPort(a).host));
    const check = async (c) => {
      const address = c.address || c.host;
      // Recorders, speakers, etc. say what they are without a login: skip them here.
      if (c.info && c.info.ProdType && !isCamera(c.info.ProdType)) {
        problems.set(address, 'notCamera');
        return;
      }
      let pin = null;
      const t0 = Date.now();
      const client = new VapixClient({
        host: c.host, port: c.port, secure: c.secure, username, password, timeoutMs: CHECK_TIMEOUT_MS, onNewPin: (fp) => { pin = fp; },
      });
      client.onStep = (step) => this.homey.app.diag(`pairing: ${address} ${step} after ${Date.now() - t0} ms`);
      try {
        // identify: a user with too few rights (e.g. Viewer) is still added; the device
        // then shows a warning that some functions need more rights.
        const info = await client.identify();
        if (!isCamera(info.ProdType)) {
          problems.set(address, 'notCamera');
          return;
        }
        const serial = c.serial || String(info.SerialNumber || '').toUpperCase();
        if (!serial) {
          problems.set(address, 'unreachable');
          return;
        }
        if (existing.has(serial)) {
          problems.set(address, 'alreadyAdded');
          return;
        }
        if (devices.some((d) => d.data.id === serial)) return; // typed and also found
        const model = info.ProdNbr || info.ProdShortName || 'Axis camera';
        devices.push({
          name: `AXIS ${model}`.replace(/^AXIS AXIS /, 'AXIS '),
          data: { id: serial },
          store: {
            host: address, secure: c.secure, username, password, pin,
          },
          settings: { address, use_https: c.secure },
        });
        this.homey.app.diag(`pairing: ${address} ${model}${info.limitedRights ? ' (limited rights)' : ''} OK after ${Date.now() - t0} ms`);
      } catch (err) {
        if (err.code === 'login_failed') {
          loginFailed.push({ host: address, model: (c.info && (c.info.ProdNbr || c.info.ProdShortName)) || '' });
          problems.set(address, 'loginFailed');
        } else {
          problems.set(address, 'unreachable');
        }
        this.homey.app.diag(`pairing: ${address} skipped (${err.code || err.message}) after ${Date.now() - t0} ms`);
      } finally {
        client.close();
      }
    };

    // Typed addresses are checked straight away, next to the search.
    const typedChecks = singles.map(async (address) => {
      const c = await this._typedCandidate(address);
      if (c.problem) {
        problems.set(address, c.problem);
        return;
      }
      if (c.serial && existing.has(c.serial)) {
        problems.set(address, 'alreadyAdded');
        return;
      }
      await check(c);
    });
    const searched = (async () => {
      if (!search && !rangeHosts.length) return;
      const candidates = (await this._candidates({ search, rangeHosts }))
        .filter((c) => !existing.has(c.serial) && !typedHosts.has(c.host));
      await Promise.all(candidates.map(check));
    })();
    // Homey gives this screen about 30 seconds: answer with what is ready by the deadline.
    await Promise.race([
      Promise.all([searched, ...typedChecks]),
      new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now()))),
    ]);

    // Say why a typed address isn't in the list (it would otherwise just be missing).
    const typedProblems = singles
      .filter((a) => !devices.some((d) => d.store.host === a))
      .map((a) => this.homey.__(`pair.address.${problems.get(a) || 'noAnswer'}`, { address: a }));
    if (typedProblems.length) throw new Error(typedProblems.join('\n'));
    if (!devices.length && loginFailed.length) {
      loginFailed.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
      const list = loginFailed.map((f) => (f.model ? `${f.host} (${f.model})` : f.host)).join(', ');
      throw new Error(this.homey.__('pair.loginRefused', { n: loginFailed.length, list }));
    }
    if (!devices.length) {
      const err = new Error(this.homey.__('pair.noneFound'));
      err.code = 'none_found';
      throw err;
    }
    const list = devices.slice();
    list.sort((a, b) => a.store.host.localeCompare(b.store.host, undefined, { numeric: true }));
    return list;
  }
}

module.exports = CameraDriver;

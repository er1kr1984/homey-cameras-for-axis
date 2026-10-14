'use strict';

const path = require('node:path');
const Homey = require('homey');
const { VapixClient, usableAddress } = require('../../lib/vapix');
const { EventStream } = require('../../lib/event-stream');
const { RtspEventStream } = require('../../lib/rtsp-events');
const {
  Tracker, CATEGORIES, groupOf, categoryOf,
} = require('../../lib/tracker');
const { Timeline } = require('../../lib/timeline');
const { Activity } = require('../../lib/activity');
const events = require('../../lib/events-map');

const FEATURES_REFRESH_MS = 6 * 60 * 60 * 1000; // re-read what the camera supports
const FEATURES_VERSION = 5; // bump to re-read after an app update that uses more
const SOUND_LEVEL_MS = 10 * 1000; // sound level reading updated at most this often
const AUDIO_CLASS_GAP_MS = 10 * 1000; // per sound type
const SCENE_CHANGE_SAMPLES = 2; // a new people/vehicle count must hold this many frames
const RECENT_EVENTS = 20; // kept for the dashboard widgets
const WIDGET_SCENE_MS = 300; // scene frames while a widget shows the boxes
const WIDGET_LEASE_MS = 15000; // keep the widget's scene stream this long after its last poll
const TRACK_FRAME_MS = 300; // scene frames read while tracking (objects pass quickly)
const TRAFFIC_SAVE_MS = 15 * 60 * 1000; // history is also saved when the app stops
const DETECTED_GAP_MS = 5000; // per category, for the "detected" flow
const HEALTH_MS = 5 * 60 * 1000;
const TAMPER_HOLD_MS = 60 * 1000;
const EVENT_IMAGES = 10; // flow pictures kept per camera (oldest reused)
const EVENT_SNAPSHOT_TIMEOUT_MS = 4000;
const MAX_VIEWERS = 4;
const AUDIO_TRIGGER_GAP_MS = 30 * 1000; // sound detection can flip every second
const EVENT_LOG_GAP_MS = 60 * 1000; // the same event is logged at most this often
const TRACK_SUMMARY_MS = 15 * 60 * 1000;
const APPS_CHECK_MS = 30 * 60 * 1000; // installed camera apps (a new one can add events)
const TRACK_TICK_MS = 5000; // objects that stopped being reported are let go
const FLOW_USE_CHECK_MS = 60 * 1000; // how long "does a flow use this card" is remembered
const SAVE_SOON_MS = 30 * 1000; // after a person/vehicle left: save its path within this
const POWER_MS = 60 * 1000; // power use and PoE ports
const STATUS_MS = 10 * 60 * 1000; // temperature, memory card, privacy mode, counts
const CALL_ACTIVE = /calling|ringing|active|connected|conversation/i; // call states while a call is on
const SNAPSHOT_REUSE_MS = 3000; // a scene picture this recent is reused for the next object
const SNAPSHOT_SIZES = { small: 640, medium: 1280, full: Infinity };

class CameraDevice extends Homey.Device {

  async onInit() {
    this.app = this.homey.app;
    this.tag = `[${this.getName()}]`;
    this.motionSources = new Map(); // source key -> pulse timer or true
    this.inputs = new Map(); // port -> active
    this.viewers = new Map();
    this.eventImages = [];
    this.problems = new Map(); // source key -> problem text (active camera problems)
    this.audioClassAt = {};
    this.recent = []; // [{ time, kind, text }] newest first, for the widgets
    this.detectedAt = {};
    const failed = (what) => (err) => this.error(`${what}:`, err.message);
    this.tracker = new Tracker({
      history: this.getStoreValue('traffic') || {},
      heat: this.getStoreValue('heat') || null,
      timeZone: this.homey.clock.getTimezone(),
      onCounted: (obj) => this._onCounted(obj).catch(failed('counted')),
      onImage: (obj) => this._onObjectImage(obj).catch(failed('close-up')),
      onDwell: (obj) => this._onDwell(obj).catch(failed('dwell')),
      onGone: (obj) => this._onGone(obj),
      onUnusual: (u) => this._onUnusual(u),
      onFeature: (f) => this._onFeature(f).catch(failed('face/plate')),
    });
    this.activity = new Activity({
      history: this.getStoreValue('motion_history') || {},
      timeZone: this.homey.clock.getTimezone(),
      onUnusual: (u) => this._onUnusual({ ...u, group: 'motion' }),
    });
    this.timeline = new Timeline({
      dir: path.join('/userdata', 'timeline', String(this.getData().id).replace(/[^\w-]/g, '')),
      entries: this.getStoreValue('timeline') || [],
    });
    this.trackTickTimer = this.homey.setInterval(() => this.tracker.tick(), TRACK_TICK_MS);
    this._scheduleMinute();
    this.trafficTimer = this.homey.setInterval(() => this._saveTraffic(), TRAFFIC_SAVE_MS);
    // "Today" counters start again at midnight: refresh them every 10 minutes.
    this.todayTimer = this.homey.setInterval(() => this._updateToday().catch(this.error), 10 * 60 * 1000);
    this.trackStats = null;
    this.trackSummaryTimer = this.homey.setInterval(() => this._trackSummary(), TRACK_SUMMARY_MS);
    this.features = this.getStoreValue('features') || null;
    // What earlier readings found (kept so capabilities don't disappear at every start,
    // before the first reading): PoE port numbers, power measurable, memory card present.
    this.poePortNumbers = this.getStoreValue('poe_ports') || null;
    this.powerReadable = this.getStoreValue('power_readable') || false;
    this.hasMemoryCard = this.getStoreValue('memory_card') || false;
    this.instances = this.getStoreValue('event_instances') || [];
    // Every device reports its health; everything else is added once the device has said
    // what it can do (_syncCapabilities).
    for (const cap of ['alarm_problem', 'axis_problem']) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }
    // Live video used to default to Medium; Automatic (start Low, go up when there is
    // room) is much lighter for Homey. Moved over once, a later choice is kept.
    if (!this.getStoreValue('quality_v2')) {
      if (this.getSetting('quality') === 'medium') await this.setSettings({ quality: 'auto' }).catch(this.error);
      await this.setStoreValue('quality_v2', true).catch(this.error);
    }
    // Alarms held by a timer don't survive a restart.
    if (this.getCapabilityValue('alarm_tamper')) await this.setCapabilityValue('alarm_tamper', false).catch(this.error);
    this._makeClient();
    // Picture and live view only for devices with their own image (not e.g. a recorder).
    // Not known yet for a new device: then after its features are read.
    if (this.features) await this._attachMedia();
    this.startTimer = this.homey.setTimeout(() => this._start(), this.driver.startDelay());
    this.healthTimer = this.homey.setInterval(() => this._healthCheck(), HEALTH_MS);
    this.appsTimer = this.homey.setInterval(() => this._checkApps().catch(this.error), APPS_CHECK_MS);
    this.statusTimer = this.homey.setInterval(() => this._pollStatus().catch(this.error), STATUS_MS);
    this.powerTimer = this.homey.setInterval(() => this._pollPower().catch(this.error), POWER_MS);
    this._listenPrivacy();
  }

  diag(...args) {
    this.app.diag(this.tag, ...args);
  }

  // ---- Connection ----

  _makeClient() {
    if (this.client) this.client.close();
    const store = this.getStore();
    const settings = this.getSettings();
    this.client = new VapixClient({
      host: settings.address || store.host,
      secure: settings.use_https !== false,
      username: store.username,
      password: store.password,
      pin: store.pin || null,
      onNewPin: (fp) => this.setStoreValue('pin', fp).catch(this.error),
    });
  }

  // What the relay needs to open the camera's video.
  liveCamera() {
    const store = this.getStore();
    return {
      id: this.getData().id,
      name: this.getName(),
      host: this.client.host,
      rtspPort: Number(this.getSetting('rtsp_port')) || 554,
      username: store.username,
      password: store.password,
      resolutions: (this.features && this.features.resolutions) || [],
    };
  }

  async _start() {
    try {
      await this._loadFeatures(false);
      await this.setAvailable();
    } catch (err) {
      this._connectionProblem(err);
    }
    // What the device shows always follows what it can do (also after an app update).
    await this._syncCapabilities().catch(this.error);
    await this._attachMedia();
    if (this.hasVideo() === false && this.getClass() === 'camera') {
      this.diag('no image of its own (e.g. a recorder): shown as a plain device, without picture or live view');
      await this.setClass('other').catch(this.error);
    }
    this._startEvents();
    this._startScene();
    this._checkApps().catch(this.error);
    this._pollStatus().catch(this.error);
    this._pollPower().catch(this.error);
  }

  // The apps installed on the camera (AXIS Motion Guard, Fence Guard, Object Analytics...).
  // When they change, read the camera's events again so a new app's alarms show up.
  async _checkApps() {
    let apps;
    try {
      apps = await this.client.applications();
    } catch (err) {
      if (!this.appsLogged) this.diag(`could not list the camera's apps: ${err.code || err.message}`);
      this.appsLogged = true;
      return;
    }
    const running = apps.filter((a) => /running/i.test(a.status));
    const sig = running.map((a) => `${a.name}@${a.version}`).sort().join(',');
    const old = this.getStoreValue('apps_sig');
    if (!this.appsLogged || sig !== old) {
      this.diag(`camera apps: ${apps.map((a) => `${a.niceName} ${a.version} (${a.status}${a.license && a.license !== 'None' ? `, licence ${a.license}` : ''})`).join('; ') || 'none'}`);
    }
    this.appsLogged = true;
    this.apps = apps;
    if (sig === old) return;
    await this.setStoreValue('apps_sig', sig);
    if (old === null || old === undefined) return; // first look: nothing to compare with
    this.diag('camera apps changed: reading the camera\'s events again');
    await this._loadFeatures(true);
    this._startEvents();
  }

  async _loadFeatures(force) {
    const fresh = this.features && this.features.v === FEATURES_VERSION && Date.now() - this.features.at < FEATURES_REFRESH_MS;
    if (fresh && !force && this.instances.length) return;
    const [info, caps] = await Promise.all([this.client.deviceInfo(), this.client.capabilities()]);
    let instances = [];
    try {
      instances = await this.client.eventInstances();
    } catch (err) {
      this.diag(`could not list event types: ${err.message}`);
    }
    this.features = { ...caps, at: Date.now(), v: FEATURES_VERSION };
    this.instances = instances.map((i) => ({
      topic: i.topic, name: i.name, stateful: i.stateful, data: i.data,
    }));
    // Everything the camera can report, for diagnostics (one line per topic).
    for (const i of instances) {
      this.diag(`can send ${events.bare(i.topic)}${i.name ? ` "${i.name}"` : ''} [${i.stateful ? 'state' : 'pulse'}] `
        + `source ${JSON.stringify(i.source)} data ${JSON.stringify(i.data)}${events.classify(i.topic) ? ` -> ${events.classify(i.topic)}` : ''}`);
    }
    await this.setStoreValue('features', this.features);
    await this.setStoreValue('event_instances', this.instances);
    await this._syncCapabilities();
    await this.setSettings({
      model: info.ProdFullName || info.ProdNbr || '',
      serial: info.SerialNumber || this.getData().id,
      firmware: info.Version || '',
    }).catch(this.error);
    const kinds = {};
    for (const i of this.instances) {
      const k = events.classify(i.topic);
      if (k) kinds[k] = (kinds[k] || 0) + 1;
    }
    this.diag(`${info.ProdNbr || '?'} AXIS OS ${info.Version || '?'}; PTZ ${caps.ptz ? 'yes' : 'no'}, light ${caps.light ? 'yes' : 'no'}, `
      + `inputs ${caps.inputs}, outputs ${caps.outputs}; events ${JSON.stringify(kinds)}`);
  }

  // Capabilities that depend on what the camera has: sound level, SD recording, IR light,
  // live stream watched, one alarm per analytics scenario, one counter per counting
  // scenario, people/vehicles in view. Added and removed to match the camera.
  async _syncCapabilities() {
    // Without the device's event list (it couldn't be read) nothing is removed.
    if (!this.instances.length) return;
    const has = (re) => this.instances.some((i) => re.test(events.bare(i.topic)));
    const kinds = new Set(this.instances.map((i) => events.classify(i.topic)).filter(Boolean));
    const video = this.hasVideo() !== false;
    const wanted = new Map(); // capability id -> options or null
    // Basics, only with evidence from the device.
    if (kinds.has('motion') || kinds.has('analytics') || kinds.has('pir')) {
      wanted.set('alarm_motion', null);
      wanted.set('axis_motion_today', null);
    }
    if (kinds.has('tampering')) wanted.set('alarm_tamper', null);
    if (kinds.has('daynight')) wanted.set('axis_night', null);
    if (has(/^SoundPressureLevel\/Metrics$/)) wanted.set('measure_noise', null);
    if (video && has(/^Storage\/Recording$/)) wanted.set('axis_recording', null);
    if (has(/^Device\/Light\/Status$|^LightControl\/LightStatusChanged\/Status$/)) wanted.set('axis_ir', null);
    // "Live view watched" also counts the app's own RTSP connections (events on older
    // AXIS OS, people/vehicle tracking), which would make it always on: only offered when
    // the app doesn't keep such a connection open.
    const ownRtsp = this.getStoreValue('event_transport') === 'rtsp' || Boolean(this.getSetting('scene_counts'));
    if (video && !ownRtsp && has(/^VideoSource\/LiveStreamAccessed$/)) wanted.set('axis_watched', null);
    if (has(/^Device\/Sensor\/PIR$/)) wanted.set('axis_pir', null);
    if (has(/^Call\/State$|^Device\/Intercom\/CallState$/)) wanted.set('axis_call', null);
    const f = this.features || {};
    if (f.privacyMask) wanted.set('axis_privacy', null);
    if (f.temperature) wanted.set('measure_temperature', null);
    if (f.disks && this.hasMemoryCard) wanted.set('axis_storage', null);
    // Power: what a newer camera uses itself (Homey Energy counts this), and on a recorder
    // the PoE power per port (its own capability, so a camera powered by the recorder
    // isn't counted twice in Energy).
    if (f.power && this.powerReadable) wanted.set('measure_power', null);
    if (f.recorderPoe && this.poePortNumbers && this.poePortNumbers.length) {
      wanted.set('axis_poe', null);
      for (const n of this.poePortNumbers) wanted.set(`axis_poe.port${n}`, { title: { en: this.homey.__('device.poePort', { n }) } });
    }
    for (const sc of events.analyticsScenarios(this.instances)) {
      if (sc.counting) wanted.set(`axis_count.${sc.id}`, { title: { en: sc.name } });
      else if (sc.occupancy) wanted.set(`axis_occupancy.${sc.id}`, { title: { en: sc.name } });
      else if (sc.stateful) wanted.set(`alarm_generic.${sc.id}`, { title: { en: sc.name } });
    }
    if (this.getSetting('scene_counts')) {
      wanted.set('axis_people', null);
      wanted.set('axis_vehicles', null);
      // A "today" counter for each kind of object this camera has counted so far.
      const seen = new Set(Object.values(this.tracker.history).flatMap((b) => Object.keys(b)));
      for (const c of CATEGORIES) if (seen.has(c)) wanted.set(`axis_today.${c}`, { title: { en: this.homey.__(`objects.today.${c}`) } });
    }
    const dynamic = /^(alarm_motion|axis_motion_today|alarm_tamper|axis_night|measure_noise|axis_recording|axis_ir|axis_watched|axis_people|axis_vehicles|axis_pir|axis_call|axis_privacy|measure_temperature|axis_storage|measure_power|axis_poe)$|^axis_poe\.|^axis_count\.|^axis_occupancy\.|^axis_today\.|^alarm_generic\.(oa|mg|fg|lg|cl|an)_/;
    for (const cap of this.getCapabilities()) {
      if (dynamic.test(cap) && !wanted.has(cap)) await this.removeCapability(cap).catch(this.error);
    }
    for (const [cap, options] of wanted) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
      if (options) await this.setCapabilityOptions(cap, options).catch(this.error);
    }
    this._listenPrivacy();
  }

  _connectionProblem(err) {
    this.app.diagError(this.tag, err.message);
    const message = this.app.friendly(err);
    this.setUnavailable(message).catch(this.error);
  }

  async _healthCheck() {
    if (this.stream && this.stream.connected) return;
    try {
      await this.client.deviceInfo();
      if (!this.getAvailable()) await this.setAvailable();
      if (Date.now() - ((this.features && this.features.at) || 0) > FEATURES_REFRESH_MS) await this._loadFeatures(true);
    } catch (err) {
      this._connectionProblem(err);
    }
  }

  // ---- Events ----

  // Events over WebSocket (AXIS OS 10 and later), else over RTSP (older AXIS OS).
  _startEvents() {
    if (this.stream) this.stream.stop();
    const topics = events.usedTopics(this.instances);
    if (!topics.length) {
      this.diag('no events to listen to (none listed by the camera)');
      return;
    }
    const transport = this.getStoreValue('event_transport') || 'websocket';
    this.stream = transport === 'rtsp'
      ? new RtspEventStream({ camera: this.liveCamera(), topics, log: (...args) => this.diag(...args) })
      : new EventStream({ client: this.client, filters: [{ topicFilter: topics.join('|') }], log: (...args) => this.diag(...args) });
    const stream = this.stream;
    stream.on('connected', () => {
      // The first report of each thing after (re)connecting is its current state, not news.
      this.seen = new Set();
      this.problems.clear();
      this.setCapabilityValue('alarm_problem', false).catch(this.error);
      this.setCapabilityValue('axis_problem', this.homey.__('problems.none')).catch(this.error);
      this.diag(`listening for events (${transport === 'rtsp' ? 'RTSP' : 'WebSocket'})`);
      if (!this.getAvailable()) this.setAvailable().catch(this.error);
    });
    stream.on('error', (err) => {
      if (['login_failed', 'cert_changed', 'forbidden'].includes(err.code)) this._connectionProblem(err);
      // No WebSocket event stream on this camera (AXIS OS before 10): use RTSP from now on.
      if (transport === 'websocket' && err.code === 'not_supported' && this.stream === stream) {
        this.diag('no WebSocket event stream on this camera; using the RTSP event stream');
        this.setStoreValue('event_transport', 'rtsp').catch(this.error);
        this._startEvents();
      }
    });
    stream.on('event', (ev) => this._onEvent(ev).catch((err) => this.error('event:', err.message)));
    stream.start();
  }

  async _onEvent(ev) {
    const kind = events.classify(ev.topic);
    const state = events.stateOf(ev);
    const topic = events.bare(ev.topic);
    const details = { ...ev.source, ...ev.data };
    const key = events.sourceKey(ev);
    if (!this.seen) this.seen = new Set();
    // Stateful events: the first report after connecting only gives the current state.
    const initial = (state !== null && !this.seen.has(key)) || ev.operation === 'Initialized';
    this.seen.add(key);
    if (initial) {
      this._applyInitial(kind, ev, state, key);
      return;
    }
    if (kind === 'soundlevel') {
      this._soundLevel(ev);
      return;
    }
    this.eventLogAt = this.eventLogAt || {};
    if (Date.now() - (this.eventLogAt[topic] || 0) > EVENT_LOG_GAP_MS) {
      this.eventLogAt[topic] = Date.now();
      this.diag(`event ${topic} ${JSON.stringify(details)}`);
    }
    this.driver.triggers.event.trigger(this, {
      topic, active: state !== false, details: JSON.stringify(details),
    }).catch(this.error);

    if (kind === 'motion' || (kind === 'analytics' && this.getSetting('analytics_motion') !== false)) {
      this._setMotionSource(events.sourceKey(ev), state);
    }
    if (kind === 'analytics') await this._analytics(ev, topic, state, details);
    if (kind === 'tampering' && state !== false) {
      await this.setCapabilityValue('alarm_tamper', true).catch(this.error);
      this.homey.clearTimeout(this.tamperTimer);
      this.tamperTimer = this.homey.setTimeout(() => this.setCapabilityValue('alarm_tamper', false).catch(this.error), TAMPER_HOLD_MS);
      const reason = this.homey.__(`tampering.${/Shock/.test(topic) ? 'shock' : /GlobalSceneChange/.test(topic) ? 'scene' : 'covered'}`);
      this._remember('tampering', `${this.homey.__('widget.tampering')}: ${reason}`);
      this.driver.triggers.tampering.trigger(this, { reason, image: await this._flowImage(this.driver.triggers.tampering) }).catch(this.error);
    }
    if (kind === 'pir' && state !== null) await this._pir(ev, state);
    if (kind === 'blockedip') {
      const address = String(details.address || '');
      this._remember('security', this.homey.__('widget.blockedIp', { address }));
      this.driver.triggers.blockedIp.trigger(this, { address }).catch(this.error);
    }
    if (kind === 'soundlimit' && state !== false) {
      const above = /Above/.test(topic);
      this._remember('sound', this.homey.__(above ? 'widget.soundAbove' : 'widget.soundBelow'));
      this.driver.triggers.soundLimit.trigger(this, { above }, { above }).catch(this.error);
    }
    if (['call', 'pin', 'rfid', 'access', 'presence'].includes(kind)) await this._intercom(kind, topic, details);
    if (kind === 'daynight' && state !== null) {
      const night = !state;
      const before = this.getCapabilityValue('axis_night');
      await this.setCapabilityValue('axis_night', night).catch(this.error);
      // The first report after connecting only tells the current state.
      if (before !== null && before !== night) this.driver.triggers.dayNight.trigger(this, { night }).catch(this.error);
    }
    if (kind === 'input') {
      const port = Number(ev.source.port || ev.source.Port || ev.source.InputToken || 0);
      const active = state !== false;
      const known = this.inputs.has(port);
      const before = this.inputs.get(port);
      this.inputs.set(port, active);
      if (known && before !== active) {
        this.driver.triggers.input.trigger(this, { port, active, virtual: /Virtual/.test(topic) }, { port }).catch(this.error);
      }
    }
    if (kind === 'audio' && state !== false && Date.now() - (this.lastAudioAt || 0) > AUDIO_TRIGGER_GAP_MS) {
      this.lastAudioAt = Date.now();
      this.driver.triggers.audio.trigger(this, {}).catch(this.error);
    }
    if (kind === 'audioclass' && state !== false) {
      const sound = events.soundOf(ev.topic);
      if (Date.now() - (this.audioClassAt[sound] || 0) > AUDIO_CLASS_GAP_MS) {
        this.audioClassAt[sound] = Date.now();
        this._remember('sound', this.homey.__(`sounds.${sound}`) || sound);
        this.driver.triggers.sound.trigger(this, {
          sound: this.homey.__(`sounds.${sound}`) || sound, image: await this._flowImage(this.driver.triggers.sound),
        }, { sound }).catch(this.error);
      }
    }
    if (kind === 'health') this._health(ev, key, state, false);
    if (kind === 'watched' && state !== null) {
      await this.setCapabilityValue('axis_watched', state).catch(this.error);
      this.driver.triggers.watched.trigger(this, { watching: state }).catch(this.error);
    }
    if (kind === 'recording' && state !== null) await this.setCapabilityValue('axis_recording', state).catch(this.error);
    if (kind === 'light' && state !== null) await this.setCapabilityValue('axis_ir', state).catch(this.error);
    if (kind === 'schedule' && state !== null) {
      const id = String(ev.source.id || '');
      this.driver.triggers.schedule.trigger(this, { schedule: id, active: state }).catch(this.error);
    }
  }

  // Object Analytics and the guards: per-scenario alarms, counters, flows.
  async _analytics(ev, topic, state, details) {
    const scenario = events.analyticsScenarios(this.instances).find((sc) => sc.topic === topic);
    const name = scenario ? scenario.name : topic.split('/').pop();
    if (scenario && (scenario.counting || scenario.occupancy)) {
      await this._scenarioCounts(scenario, events.countsOf(details, scenario.occupancy), true);
      return;
    }
    if (scenario && state !== null) await this.setCapabilityValue(`alarm_generic.${scenario.id}`, state).catch(this.error);
    if (state === false) return;
    const object = String(details.classTypes || details.objectClass || details.ObjectClass || '');
    const kind = String(details.scenarioType || '');
    this._remember('analytics', `${name}${object ? ` (${object})` : ''}`);
    this.driver.triggers.analytics.trigger(this, {
      scenario: name,
      object: this._className(object),
      kind: this.homey.__(`scenarioTypes.${kind}`) || kind,
      image: await this._flowImage(this.driver.triggers.analytics),
    }, { topic }).catch(this.error);
  }

  // Numbers of a crossline counting or occupancy scenario -> capability and flows.
  // fromEvent: false when read from the API (start-up), which doesn't run flows.
  async _scenarioCounts(scenario, c, fromEvent) {
    const cap = scenario.occupancy ? `axis_occupancy.${scenario.id}` : `axis_count.${scenario.id}`;
    const before = this.getCapabilityValue(cap);
    if (this.hasCapability(cap)) await this.setCapabilityValue(cap, c.total).catch(this.error);
    if (!fromEvent) return;
    const tokens = {
      scenario: scenario.name,
      total: c.total,
      humans: c.human,
      cars: c.car,
      trucks: c.truck,
      buses: c.bus,
      bikes: c.bike,
      others: c.otherVehicle,
    };
    if (scenario.occupancy) {
      if (before === c.total) return;
      this._remember('counted', `${scenario.name}: ${c.total}`);
      this.driver.triggers.occupancy.trigger(this, { ...tokens, change: before === null ? 0 : c.total - before }, { topic: scenario.topic }).catch(this.error);
      return;
    }
    const what = this._className(c.reason);
    this._remember('counted', `${scenario.name}: ${c.total}${what ? ` (${what})` : ''}`);
    this.driver.triggers.counted.trigger(this, { ...tokens, object: what }, { topic: scenario.topic, category: categoryOf(c.reason) }).catch(this.error);
  }

  // 'human' / 'car' / 'otherVehicle' / 'human,car' (Object Analytics) -> words.
  _className(types) {
    return String(types || '').split(',').map((t) => t.trim()).filter(Boolean).map((t) => {
      if (/hardhat/i.test(t)) return this.homey.__('objects.noHardhat');
      const c = categoryOf(t.replace(/^otherVehicle$/i, 'vehicle'));
      return c && CATEGORIES.includes(c) ? this._objectName(c).toLowerCase() : t;
    }).join(', ');
  }

  // Camera health: the problem alarm is on while any problem is active; pulses (an action
  // that failed, a PTZ error) only show as the last problem and run the flow.
  _health(ev, key, state, initial) {
    const problem = events.problemOf(ev.topic);
    if (!problem) return;
    const where = ev.source.disk_id || ev.source.Name || ev.source.interface || '';
    const extra = ev.data.description ? `: ${ev.data.description}` : '';
    const text = `${this.homey.__(`problems.${problem}`) || problem}${where ? ` (${where})` : ''}${extra}`;
    // At connect: a missing SD card or unused network share reports a storage failure, and
    // "network lost" can't be true while we are talking to the camera. Only such problems
    // that appear while running count.
    if (initial && state) this.diag(`starting state: ${events.bare(ev.topic)} ${JSON.stringify({ ...ev.source, ...ev.data })}`);
    if (initial && ['storage', 'storageFailure', 'storageAlert', 'network'].includes(problem)) return;
    if (state === false) {
      if (!this.problems.has(key)) return;
      this.problems.delete(key);
      if (!initial) {
        this._remember('solved', `${this.homey.__('widget.solved')}: ${text}`);
        this.driver.triggers.problemSolved.trigger(this, { problem: text }).catch(this.error);
      }
    } else {
      if (state === true) this.problems.set(key, text);
      if (!initial) {
        this._remember('problem', text);
        this.driver.triggers.problem.trigger(this, { problem: text }).catch(this.error);
      }
    }
    const active = [...this.problems.values()];
    this.setCapabilityValue('alarm_problem', active.length > 0).catch(this.error);
    this.setCapabilityValue('axis_problem', active.length ? active.join(', ') : (state === null ? text : this.homey.__('problems.none'))).catch(this.error);
  }

  // Sound level: the equivalent level (LEQ) over the camera's interval, else the current SPL.
  _soundLevel(ev) {
    const value = Number(ev.data.LEQ !== undefined ? ev.data.LEQ : ev.data.SPL);
    if (!Number.isFinite(value)) return;
    this.soundMax = Math.max(this.soundMax || -Infinity, value);
    if (Date.now() - (this.soundAt || 0) < SOUND_LEVEL_MS) return;
    this.soundAt = Date.now();
    const level = Math.round(this.soundMax * 10) / 10;
    this.soundMax = -Infinity;
    if (this.hasCapability('measure_noise')) this.setCapabilityValue('measure_noise', level).catch(this.error);
  }

  // ---- Recent events and the dashboard widgets ----

  _remember(kind, text) {
    this.recent.unshift({ time: Date.now(), kind, text });
    if (this.recent.length > RECENT_EVENTS) this.recent.pop();
  }

  widgetState() {
    const cap = (id) => (this.hasCapability(id) ? this.getCapabilityValue(id) : null);
    const scenarios = events.analyticsScenarios(this.instances);
    return {
      id: this.getId(),
      name: this.getName(),
      model: this.getSetting('model') || '',
      available: this.getAvailable(),
      events: Boolean(this.stream && this.stream.connected),
      motion: cap('alarm_motion') === true,
      tamper: cap('alarm_tamper') === true,
      night: cap('axis_night'),
      problem: cap('alarm_problem') === true ? cap('axis_problem') : null,
      noise: cap('measure_noise'),
      watched: cap('axis_watched'),
      recording: cap('axis_recording'),
      people: cap('axis_people'),
      vehicles: cap('axis_vehicles'),
      motionToday: this.hasCapability('axis_motion_today') ? this.activity.today() : null,
      scenarios: scenarios.filter((sc) => !sc.counting && !sc.occupancy && sc.stateful)
        .map((sc) => ({ name: sc.name, active: cap(`alarm_generic.${sc.id}`) === true })),
      counters: scenarios.filter((sc) => sc.counting || sc.occupancy)
        .map((sc) => ({ name: sc.name, total: cap(`${sc.occupancy ? 'axis_occupancy' : 'axis_count'}.${sc.id}`) })),
      recent: this.recent.slice(0, 8),
    };
  }

  // The objects in view right now, for drawing boxes. Starts the scene stream for as long
  // as a widget keeps asking (even when "count people and vehicles" is off).
  widgetScene() {
    this.sceneLeaseUntil = Date.now() + WIDGET_LEASE_MS;
    if (!this.scene) {
      this._startScene(true);
    }
    if (this.scene) this.scene.frameIntervalMs = WIDGET_SCENE_MS;
    this.homey.clearTimeout(this.sceneLeaseTimer);
    this.sceneLeaseTimer = this.homey.setTimeout(() => this._endSceneLease(), WIDGET_LEASE_MS + 1000);
    const frame = this.lastFrame;
    return {
      age: frame ? Date.now() - frame.at : null,
      // name: what to call it on the box ("Person", "Car"), colours in the user's words.
      objects: frame && Date.now() - frame.at < 3000 ? frame.objects.map((o) => {
        const c = categoryOf(o.type);
        return {
          ...o,
          // Without a type (cameras that track movement but don't classify it): "Moving object".
          name: c ? this._objectName(c) : this.homey.__('objects.moving'),
          colors: (o.colors || []).map((x) => this.homey.__(`colors.${x}`) || x),
        };
      }) : [],
    };
  }

  _endSceneLease() {
    if (Date.now() < (this.sceneLeaseUntil || 0)) return;
    if (!this.scene) return;
    if (this.getSetting('scene_counts')) this.scene.frameIntervalMs = TRACK_FRAME_MS;
    else this._stopScene();
  }

  // ---- Counting people and vehicles over time ----

  _objectName(category) {
    return this.homey.__(`objects.one.${category}`) || category;
  }

  // What the user calls a direction ("Towards the house"), else a plain default.
  directionName(direction) {
    if (!direction) return this.homey.__('directions.none');
    return String(this.getSetting(`dir_${direction}`) || '').trim() || this.homey.__(`directions.${direction}`);
  }

  // Flow tokens for an object's details (Object Analytics attributes).
  _attrTokens(attrs = {}) {
    const list = (a) => (a || []).map((c) => this.homey.__(`colors.${c}`) || c).join(', ');
    const speed = Number.isFinite(attrs.speed) ? Math.round(attrs.speed * 3.6) : 0;
    return {
      top: list(attrs.upper),
      bottom: list(attrs.lower),
      bag: Boolean(attrs.bag),
      hat: Boolean(attrs.hat),
      plate: attrs.plate && attrs.plate.number ? attrs.plate.number : '',
      speed,
    };
  }

  async _onCounted({
    id, category, type, colors, image, box, attrs,
  }) {
    const name = this._objectName(category);
    const colorText = (colors || []).join(', ');
    if (this.trackStats) this.trackStats.counted += 1;
    this.diag(`counted: ${name}${type ? ` (${type})` : ''}${colorText ? `, ${colorText}` : ''}`);
    this._remember('object', `${name}${colorText ? ` (${colorText})` : ''}`);
    const cap = `axis_today.${category}`;
    if (!this.hasCapability(cap)) await this._syncCapabilities();
    await this._updateToday();
    // A picture for the timeline: the camera's close-up, else the scene with the object's box.
    const entry = this.timeline.add({
      objectId: id, category, type, colors,
    });
    let jpeg = image ? Buffer.from(image, 'base64') : null;
    if (jpeg) {
      await this.timeline.setPicture(entry, jpeg, 'crop');
    } else {
      jpeg = await this._snapshotJpeg(true);
      await this.timeline.setPicture(entry, jpeg, 'scene', box);
    }
    if (Date.now() - (this.detectedAt[category] || 0) < DETECTED_GAP_MS) return;
    this.detectedAt[category] = Date.now();
    const token = await this._imageFromJpeg(jpeg);
    this.driver.triggers.detected.trigger(this, {
      type: name, colors: colorText, image: token, ...this._attrTokens(attrs),
    }, { category, colors, attrs }).catch(this.error);
  }

  // A face or licence plate (parts of a person or vehicle; not counted). Needs a camera
  // whose Object Analytics reports faces or plates.
  async _onFeature({ kind, image, plate }) {
    const card = kind === 'face' ? this.driver.triggers.face : this.driver.triggers.plate;
    const number = plate && plate.number ? plate.number : '';
    this.diag(`${kind} seen${number ? ` (${number})` : ''}${image ? ' with picture' : ''}`);
    this._remember('object', this.homey.__(kind === 'face' ? 'widget.face' : 'widget.plate', { plate: number }));
    if (Date.now() - (this.detectedAt[kind] || 0) < DETECTED_GAP_MS) return;
    this.detectedAt[kind] = Date.now();
    const jpeg = image ? Buffer.from(image, 'base64') : await this._snapshotJpeg(true);
    const tokens = { image: await this._imageFromJpeg(jpeg) };
    if (kind === 'plate') Object.assign(tokens, { plate: number, country: plate && plate.country ? plate.country : '' });
    card.trigger(this, tokens).catch(this.error);
  }

  async _onObjectImage({ id, image }) {
    await this.timeline.setPicture(this.timeline.forObject(id), Buffer.from(image, 'base64'), 'crop');
  }

  // Still in view after a whole number of minutes: only build the flow tokens when a
  // flow waits for exactly this many minutes.
  async _onDwell({
    id, category, minutes, colors, attrs,
  }) {
    const wanted = await this.driver.triggers.lingering.getArgumentValues(this).catch(() => []);
    if (!wanted.some((args) => Math.max(1, Math.round(Number(args.minutes) || 0)) === minutes)) return;
    const name = this._objectName(category);
    this.diag(`${name} in view for ${minutes} min`);
    this._remember('object', this.homey.__('widget.stayed', { name, n: minutes }));
    const entry = this.timeline.forObject(id);
    const picture = entry && (await this.timeline.picture(entry.key));
    const jpeg = picture && picture.kind === 'crop' ? picture.jpeg : await this._snapshotJpeg(true);
    const image = await this._imageFromJpeg(jpeg);
    this.driver.triggers.lingering.trigger(this, {
      type: name, minutes, colors: colors.join(', '), image, ...this._attrTokens(attrs),
    }, { category, minutes }).catch(this.error);
  }

  _onGone({
    id, category, direction, seconds, colors, attrs,
  }) {
    this.timeline.finish(id, { direction, seconds, attrs });
    this._saveSoon();
    if (!direction) return;
    const name = this._objectName(category);
    this.driver.triggers.passed.trigger(this, {
      type: name, direction: this.directionName(direction), seconds, colors: colors.join(', '), ...this._attrTokens(attrs),
    }, { category, direction, colors, attrs }).catch(this.error);
  }

  _onUnusual({
    group, count, usual, hour,
  }) {
    const what = this.homey.__(group === 'motion' ? 'widget.motionWord' : `widget.${group}`);
    this.diag(`unusual: ${count} ${what} between ${hour}:00 and ${hour}:59, usually ${usual}`);
    this._remember('unusual', this.homey.__('widget.unusual', { n: count, what }));
    this.driver.triggers.unusual.trigger(this, {
      what, count, usual, hour: `${hour}:00`,
    }, { group }).catch(this.error);
  }

  // A plain sentence: "Today: 34 people, 12 cars and 3 bicycles. Busiest hour 17:00 (9). Longest stay: a car, 14 min."
  summaryText(period = 'today') {
    const s = this.tracker.summary(period);
    const m = this.activity.summary(period);
    const __ = (k, v) => this.homey.__(k, v);
    const label = __(`summary.${period}`);
    const motionText = m.count ? __('summary.motion', { n: m.count, time: this._duration(m.seconds) }) : __('summary.noMotion');
    // Without counting (cameras without Object Analytics): motion only.
    if (!this.getSetting('scene_counts') && !Object.keys(s.totals).length) {
      let text = `${label}: ${motionText}.`;
      if (m.busiest) text += ` ${__('summary.busiest', { hour: `${m.busiest.hour}:00`, n: m.busiest.count })}`;
      return {
        text, ...s, motion: m, busiest: m.busiest,
      };
    }
    const parts = CATEGORIES.filter((c) => s.totals[c])
      .map((c) => `${s.totals[c]} ${__(`objects.${s.totals[c] === 1 ? 'one' : 'many'}.${c}`).toLowerCase()}`);
    if (!parts.length) return { text: `${__('summary.nothing', { label })} ${__('summary.motionAlso', { text: motionText })}`, ...s, motion: m };
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} ${__('summary.and')} ${parts[parts.length - 1]}` : parts[0];
    let text = `${label}: ${list}.`;
    if (s.busiest) text += ` ${__('summary.busiest', { hour: `${s.busiest.hour}:00`, n: s.busiest.count })}`;
    if (s.longest && s.longest.seconds >= 60) {
      text += ` ${__('summary.longest', { name: this._objectName(s.longest.category).toLowerCase(), n: Math.round(s.longest.seconds / 60) })}`;
    }
    text += ` ${__('summary.motionAlso', { text: motionText })}`;
    return { text, ...s, motion: m };
  }

  // 3 h 10 min / 25 min / 40 s
  _duration(seconds) {
    if (seconds < 60) return this.homey.__('widget.seconds', { n: seconds });
    const min = Math.round(seconds / 60);
    if (min < 60) return this.homey.__('widget.minutes', { n: min });
    return this.homey.__('widget.hoursMinutes', { h: Math.floor(min / 60), m: min % 60 });
  }

  summaryTokens(period) {
    const s = this.summaryText(period);
    const sum = (group) => CATEGORIES.reduce((n, c) => n + (groupOf(c) === group ? s.totals[c] || 0 : 0), 0);
    return {
      summary: s.text, people: sum('people'), vehicles: sum('vehicles'), motion: s.motion.count, busiest: s.busiest ? `${s.busiest.hour}:00` : '',
    };
  }

  // Once a minute, on the minute: the "daily summary at <time>" flows.
  _scheduleMinute() {
    const now = new Date();
    this.minuteTimer = this.homey.setTimeout(() => {
      this._scheduleMinute();
      this._summaryTime().catch(this.error);
    }, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  }

  async _summaryTime() {
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: this.homey.clock.getTimezone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date());
    const wanted = await this.driver.triggers.summary.getArgumentValues(this).catch(() => []);
    const periods = new Set(wanted.filter((args) => args.time === time).map((args) => args.period || 'today'));
    for (const period of periods) {
      this.driver.triggers.summary.trigger(this, this.summaryTokens(period), { time, period }).catch(this.error);
    }
  }

  // Conditions: people/vehicles in view now (counted ones; needs tracking on).
  inViewCount(type) {
    if (!this.scene || !this.getSetting('scene_counts')) return 0;
    const now = this.tracker.inView();
    return Object.entries(now)
      .filter(([c]) => type === 'any' || type === c || type === groupOf(c))
      .reduce((n, [, k]) => n + k, 0);
  }

  async _imageFromJpeg(jpeg) {
    let slot;
    if (this.eventImages.length < EVENT_IMAGES) {
      slot = { image: await this.homey.images.createImage(), jpeg: null };
      slot.image.setStream(async (stream) => {
        if (!slot.jpeg) throw new Error(this.homey.__('errors.no_picture'));
        stream.end(slot.jpeg);
      });
      this.eventImages.push(slot);
    } else {
      slot = this.eventImages.shift();
      this.eventImages.push(slot);
    }
    slot.jpeg = jpeg;
    await slot.image.update().catch(() => {});
    return slot.image;
  }

  async _updateToday() {
    const motion = this.activity.today();
    if (this.getCapabilityValue('axis_motion_today') !== motion) await this.setCapabilityValue('axis_motion_today', motion).catch(this.error);
    const today = this.tracker.today();
    for (const c of CATEGORIES) {
      const cap = `axis_today.${c}`;
      if (this.hasCapability(cap) && this.getCapabilityValue(cap) !== (today[c] || 0)) {
        await this.setCapabilityValue(cap, today[c] || 0).catch(this.error);
      }
    }
  }

  // Every TRACK_SUMMARY_MS while counting: what the scene stream brought (diagnostics).
  _trackSummary() {
    if (!this.getSetting('scene_counts')) return;
    const st = this.trackStats;
    this.trackStats = null;
    const traffic = this.scene && this.scene.takeSceneStats ? this.scene.takeSceneStats() : null;
    const rate = traffic ? `; stream ${traffic.kbps} kbit/s, ${traffic.fps} frames/s, ${traffic.pictures} with object pictures` : '';
    if (!st) {
      this.diag(`tracking: no scene frames in the last ${TRACK_SUMMARY_MS / 60000} min${this.scene ? '' : ' (scene stream not running)'}${rate}`);
      return;
    }
    const types = Object.entries(st.types).map(([t, e]) => `${t} ${e.n}x (best ${e.best.toFixed(2)})`).join(', ');
    this.diag(`tracking: ${st.frames} frames, objects: ${types || 'none'}; counted ${st.counted}${rate}`);
  }

  // Something worth keeping happened (a path for the heatmap, a finished visitor): save
  // within SAVE_SOON_MS instead of waiting for the regular save, so an app restart or
  // update doesn't lose it. Several in a row are saved once.
  _saveSoon() {
    if (this.saveSoonTimer) return;
    this.saveSoonTimer = this.homey.setTimeout(() => {
      this.saveSoonTimer = null;
      this._saveTraffic();
    }, SAVE_SOON_MS);
  }

  _saveTraffic() {
    if (this.tracker.dirty) {
      this.tracker.dirty = false;
      this.setStoreValue('traffic', this.tracker.history).catch(this.error);
      this.setStoreValue('heat', this.tracker.heat).catch(this.error);
    }
    if (this.activity.dirty) {
      this.activity.dirty = false;
      this.setStoreValue('motion_history', this.activity.history).catch(this.error);
    }
    if (this.timeline.dirty) {
      this.timeline.dirty = false;
      this.setStoreValue('timeline', this.timeline.entries).catch(this.error);
    }
  }

  // show: 'auto' (people and vehicles when counting, else motion), 'objects' or 'motion'.
  trafficSeries(period, show = 'auto') {
    const motion = show === 'motion' || (show === 'auto' && !this.getSetting('scene_counts'));
    if (motion) {
      return {
        name: this.getName(), tracking: true, motionChart: true, ...this.activity.series(period),
      };
    }
    const data = this.tracker.series(period);
    const directions = {};
    for (const [c, d] of Object.entries(data.directions)) {
      directions[c] = Object.entries(d).sort((a, b) => b[1] - a[1]).map(([dir, n]) => ({ name: this.directionName(dir), n }));
    }
    return {
      name: this.getName(),
      tracking: Boolean(this.getSetting('scene_counts')),
      ...data,
      directions,
    };
  }

  timelineList(kind, limit) {
    return {
      name: this.getName(),
      tracking: Boolean(this.getSetting('scene_counts')),
      entries: this.timeline.list(kind, limit).map((e) => ({
        ...e,
        name: this._objectName(e.category),
        direction: e.direction ? this.directionName(e.direction) : null,
        details: this._detailsText(e.attrs),
      })),
    };
  }

  // "red top, blue trousers, bag" / "ABC123, 34 km/h" for the visitors widget.
  _detailsText(a) {
    if (!a) return '';
    const __ = (k, v) => this.homey.__(k, v);
    const colors = (list) => list.map((c) => __(`colors.${c}`) || c).join('/');
    const parts = [];
    if (a.upper) parts.push(__('details.top', { c: colors(a.upper) }));
    if (a.lower) parts.push(__('details.bottom', { c: colors(a.lower) }));
    if (a.hat) parts.push(__('details.hat'));
    if (a.bag) parts.push(__('details.bag'));
    if (a.plate) parts.push(a.plate);
    if (a.speed) parts.push(__('details.speed', { n: Math.round(a.speed * 3.6) }));
    return parts.join(', ');
  }

  async timelinePicture(key) {
    const p = await this.timeline.picture(key);
    if (!p) return null;
    return { jpeg: p.jpeg.toString('base64'), kind: p.kind, box: p.box };
  }

  async heatmap(kind) {
    return {
      name: this.getName(),
      tracking: Boolean(this.getSetting('scene_counts')),
      ...this.tracker.heatmap(kind),
      jpeg: ((await this._snapshotJpeg(true)) || Buffer.alloc(0)).toString('base64'),
    };
  }

  // ---- People and vehicles in view (analytics scene description, opt-in) ----

  // forWidget: start even when counting is off (a widget wants to draw boxes).
  _startScene(forWidget = false) {
    this._stopScene();
    if (!this.getSetting('scene_counts') && !forWidget) return;
    this.diag(`starting the scene stream${forWidget ? ' for a widget' : ''}`);
    if (!forWidget) this._ensureSceneProducer().catch(this.error);
    this.scene = new RtspEventStream({ camera: this.liveCamera(), mode: 'scene', log: (...args) => this.diag(...args) });
    this.sceneSamples = [];
    // Failures are logged and retried by the stream itself.
    this.scene.on('error', () => {});
    this.scene.on('connected', () => {
      this.diag('reading the scene description (people and vehicles in view)');
      this.homey.clearTimeout(this.sceneCheckTimer);
      this.sceneCheckTimer = this.homey.setTimeout(() => {
        if (!this.scene || this.scene.lastFrameAt) return;
        this.diag('no scene description received in 30 s; the camera may need AXIS Object Analytics or a newer AXIS OS');
      }, 30000);
      this.homey.clearTimeout(this.sceneRateTimer);
      this.sceneRateTimer = this.homey.setTimeout(() => {
        const t = this.scene && this.scene.takeSceneStats();
        if (t) this.diag(`scene stream: ${t.kbps} kbit/s, ${t.fps} frames/s, ${t.pictures} with object pictures (first 2 min)`);
      }, 120000);
    });
    if (this.getSetting('scene_counts')) this.scene.frameIntervalMs = TRACK_FRAME_MS;
    this.scene.on('frame', (frame) => this._onSceneFrame(frame));
    this.scene.start();
  }

  // Counting needs Object Analytics' metadata (producer AnalyticsSceneDescription). If the
  // camera has it switched off, switch it on (Analytics Metadata Producer Configuration).
  async _ensureSceneProducer() {
    if (!this.features || !this.features.metadataConfig) return;
    const producers = await this.client.metadataProducers().catch(() => []);
    const asd = producers.find((p) => p.name === 'AnalyticsSceneDescription');
    if (!asd) return;
    const off = (asd.videochannels || []).filter((c) => c.enabled === false);
    if (!off.length) return;
    this.diag('Object Analytics metadata was switched off on the camera; switching it on for counting');
    await this.client.enableMetadataProducer('AnalyticsSceneDescription', off[0].channel || 1)
      .catch((err) => this.diag(`could not switch on Object Analytics metadata: ${err.message}`));
  }

  _stopScene() {
    this.homey.clearTimeout(this.sceneCheckTimer);
    this.homey.clearTimeout(this.sceneRateTimer);
    this.homey.clearTimeout(this.sceneLeaseTimer);
    if (this.scene) this.scene.stop();
    this.scene = null;
  }

  _onSceneFrame(frame) {
    this.lastFrame = { at: Date.now(), objects: frame.objects.map((o) => ({ ...o, image: undefined })) };
    if (!this.getSetting('scene_counts')) return;
    this.tracker.addFrame(frame);
    const st = this.trackStats || (this.trackStats = { frames: 0, types: {}, counted: 0 });
    st.frames += 1;
    for (const o of frame.objects) {
      const t = o.type || '(no type)';
      const e = st.types[t] || (st.types[t] = { n: 0, best: 0 });
      e.n += 1;
      e.best = Math.max(e.best, o.likelihood || 0);
    }
    const isHuman = (t) => /human|person|face|head/.test(t || '');
    const isVehicle = (t) => /vehicle|car|truck|bus|bike|bicycle|motorcycle/.test(t || '');
    const people = frame.objects.filter((o) => isHuman(o.type)).length;
    const vehicles = frame.objects.filter((o) => isVehicle(o.type)).length;
    // A count only changes when it holds for a few frames (detections flicker).
    this.sceneSamples.push(`${people}/${vehicles}`);
    if (this.sceneSamples.length > SCENE_CHANGE_SAMPLES) this.sceneSamples.shift();
    if (this.sceneSamples.length < SCENE_CHANGE_SAMPLES || new Set(this.sceneSamples).size !== 1) return;
    if (people === this.getCapabilityValue('axis_people') && vehicles === this.getCapabilityValue('axis_vehicles')) return;
    const before = { people: this.getCapabilityValue('axis_people') || 0, vehicles: this.getCapabilityValue('axis_vehicles') || 0 };
    this.setCapabilityValue('axis_people', people).catch(this.error);
    this.setCapabilityValue('axis_vehicles', vehicles).catch(this.error);
    const colors = [...new Set(frame.objects.flatMap((o) => o.colors))].join(', ');
    const types = [...new Set(frame.objects.map((o) => o.type).filter(Boolean))].join(', ');
    this.diag(`in view: ${people} people, ${vehicles} vehicles${types ? ` (${types})` : ''}${colors ? `; colours ${colors}` : ''}`);
    this.driver.triggers.inView.trigger(this, {
      people, vehicles, objects: types, colors, more_people: people > before.people, more_vehicles: vehicles > before.vehicles,
    }).catch(this.error);
  }

  // Current state at connect: update the device quietly, run no flows.
  _applyInitial(kind, ev, state, key) {
    if (kind === 'motion' || (kind === 'analytics' && this.getSetting('analytics_motion') !== false)) {
      if (state) this.motionSources.set(key, true);
      else this.motionSources.delete(key);
      const active = this.motionSources.size > 0;
      if (this.getCapabilityValue('alarm_motion') !== active) this.setCapabilityValue('alarm_motion', active).catch(this.error);
    }
    if (kind === 'daynight') this.setCapabilityValue('axis_night', !state).catch(this.error);
    if (kind === 'input') {
      const port = Number(ev.source.port || ev.source.Port || 0);
      this.inputs.set(port, state === true);
    }
    if (kind === 'analytics') {
      const sc = events.analyticsScenarios(this.instances).find((x) => x.topic === events.bare(ev.topic));
      if (sc && !sc.counting && sc.stateful) this.setCapabilityValue(`alarm_generic.${sc.id}`, state === true).catch(this.error);
    }
    if (kind === 'health') this._health(ev, key, state, true);
    if (kind === 'watched') this.setCapabilityValue('axis_watched', state === true).catch(this.error);
    if (kind === 'recording') this.setCapabilityValue('axis_recording', state === true).catch(this.error);
    if (kind === 'light') this.setCapabilityValue('axis_ir', state === true).catch(this.error);
    if (kind === 'pir') {
      this.setCapabilityValue('axis_pir', state === true).catch(this.error);
      if (this.getSetting('pir_motion') !== false) {
        if (state) this.motionSources.set(key, true);
        else this.motionSources.delete(key);
      }
    }
    if (kind === 'call') {
      const callState = String(ev.data.CallState || '');
      if (callState) this.setCapabilityValue('axis_call', CALL_ACTIVE.test(callState)).catch(this.error);
    }
  }

  // Body heat sensor (PIR): its own alarm, and motion unless switched off in the settings.
  async _pir(ev, state) {
    const before = this.getCapabilityValue('axis_pir');
    await this.setCapabilityValue('axis_pir', state).catch(this.error);
    if (this.getSetting('pir_motion') !== false) this._setMotionSource(events.sourceKey(ev), state);
    if (before === state) return;
    if (state) this._remember('motion', this.homey.__('widget.pir'));
    this.driver.triggers.pir.trigger(this, { active: state }, { active: state }).catch(this.error);
  }

  // Door stations: calls (doorbell), PIN codes, RFID tags, access decisions, presence.
  async _intercom(kind, topic, d) {
    if (kind === 'call') {
      const callState = String(d.CallState || '');
      if (!callState) return;
      const active = CALL_ACTIVE.test(callState);
      const before = this.callState;
      this.callState = callState;
      if (this.hasCapability('axis_call')) await this.setCapabilityValue('axis_call', active).catch(this.error);
      if (before === callState) return;
      this.driver.triggers.callState.trigger(this, { state: callState, active }).catch(this.error);
      // A visitor pressed the call button: the door station starts calling out.
      if (/^calling$/i.test(callState) && !/^calling$/i.test(before || '')) {
        this._remember('call', this.homey.__('widget.doorbell'));
        this.driver.triggers.doorbell.trigger(this, { image: await this._flowImage(this.driver.triggers.doorbell) }).catch(this.error);
      }
      return;
    }
    if (kind === 'pin') {
      // The digits are only sent when the door station is set to send them ("sensitive" events).
      const pin = String(d.KeyPin || '').replace(/#$/, '');
      this._remember('access', this.homey.__('widget.pinEntered'));
      this.driver.triggers.pin.trigger(this, { pin }).catch(this.error);
      return;
    }
    if (kind === 'rfid') {
      const card = String(d.CardNumber || d.UID || '');
      this._remember('access', this.homey.__('widget.tagShown'));
      this.driver.triggers.rfid.trigger(this, { card, type: String(d.TagType || '') }).catch(this.error);
      return;
    }
    if (kind === 'access') {
      const granted = /Granted/.test(topic);
      const credential = String(d.CredentialId || '');
      this._remember('access', this.homey.__(granted ? 'widget.accessGranted' : 'widget.accessDenied'));
      this.driver.triggers.access.trigger(this, { granted, credential }, { granted }).catch(this.error);
      return;
    }
    if (kind === 'presence') {
      const present = Number(d.Presence) === 1;
      if (present && !this.presence) this.driver.triggers.presence.trigger(this, {}).catch(this.error);
      this.presence = present;
    }
  }

  // Motion is on while any motion source is active. Sources without an on/off value
  // (pulses) count as active for the hold time.
  _setMotionSource(key, state) {
    const holdMs = (Number(this.getSetting('motion_hold')) || 10) * 1000;
    const old = this.motionSources.get(key);
    if (old && old !== true) this.homey.clearTimeout(old);
    if (state === false) this.motionSources.delete(key);
    else if (state === true) this.motionSources.set(key, true);
    else this.motionSources.set(key, this.homey.setTimeout(() => this._setMotionSource(key, false), holdMs));
    this._updateMotion(holdMs);
  }

  _updateMotion(holdMs) {
    const active = this.motionSources.size > 0;
    if (active) {
      this.homey.clearTimeout(this.motionOffTimer);
      this.motionOffTimer = null;
      if (this.getCapabilityValue('alarm_motion') !== true) {
        this.setCapabilityValue('alarm_motion', true).catch(this.error);
        this.activity.start();
        this.setCapabilityValue('axis_motion_today', this.activity.today()).catch(this.error);
        this._remember('motion', this.homey.__('widget.motionStarted'));
        this._flowImage(this.driver.triggers.motionStarted).then((image) => this.driver.triggers.motionStarted.trigger(this, { image })).catch(this.error);
      }
    } else if (this.getCapabilityValue('alarm_motion') === true && !this.motionOffTimer) {
      // Keep the alarm on a little longer so short gaps don't flap it.
      this.motionOffTimer = this.homey.setTimeout(() => {
        this.motionOffTimer = null;
        if (this.motionSources.size) return;
        this.setCapabilityValue('alarm_motion', false).catch(this.error);
        this.activity.stop();
        this._remember('motion_end', this.homey.__('widget.motionStopped'));
        this.driver.triggers.motionStopped.trigger(this, {}).catch(this.error);
      }, holdMs);
    }
  }

  isWatched() {
    return this.getCapabilityValue('axis_watched') === true;
  }

  async countingChoices(query) {
    const q = String(query || '').toLowerCase();
    return [{ id: 'any', name: this.homey.__('flow.anyScenario') }]
      .concat(events.analyticsScenarios(this.instances).filter((sc) => sc.counting).map((sc) => ({ id: sc.topic, name: sc.name })))
      .filter((sc) => sc.name.toLowerCase().includes(q));
  }

  isInputActive(port) {
    return this.inputs.get(port) === true;
  }

  // ---- Pictures ----

  _snapshotResolution() {
    const max = SNAPSHOT_SIZES[this.getSetting('snapshot_size')] || SNAPSHOT_SIZES.medium;
    const all = ((this.features && this.features.resolutions) || [])
      .map((r) => /^(\d+)x(\d+)$/.exec(r)).filter(Boolean)
      .map((m) => ({ w: Number(m[1]), text: m[0] }))
      .sort((a, b) => b.w - a.w);
    const fit = all.find((r) => r.w <= max);
    return fit ? fit.text : undefined;
  }

  // Whether the device has an image of its own (cameras, door stations; not recorders or
  // speakers). Unknown before its features are read.
  hasVideo() {
    const f = this.features;
    if (!f) return null;
    return Boolean((f.resolutions && f.resolutions.length) || (f.formats && f.formats.includes('jpeg')));
  }

  async _attachMedia() {
    if (this.mediaAttached || this.hasVideo() === false) return;
    this.mediaAttached = true;
    await this._attachImage().catch((err) => this.error('image:', err.message));
    await this._attachVideo().catch((err) => this.error('video:', err.message));
  }

  async _attachImage() {
    const image = await this.homey.images.createImage();
    image.setStream(async (stream) => {
      const jpeg = await this.client.snapshot({ resolution: this._snapshotResolution() });
      stream.end(jpeg);
    });
    await this.setCameraImage('snapshot', this.homey.__('device.snapshot'), image);
    this.image = image;
  }

  // A picture of the camera now, or null. reuse: a picture from the last few seconds will do.
  async _snapshotJpeg(reuse = false) {
    if (reuse && this.lastSnapshot && Date.now() - this.lastSnapshot.at < SNAPSHOT_REUSE_MS) return this.lastSnapshot.jpeg;
    try {
      const jpeg = await Promise.race([
        this.client.snapshot({ resolution: this._snapshotResolution() }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('snapshot timeout')), EVENT_SNAPSHOT_TIMEOUT_MS)),
      ]);
      this.lastSnapshot = { at: Date.now(), jpeg };
      return jpeg;
    } catch (err) {
      this.diag(`event picture failed: ${err.message}`);
      return null;
    }
  }

  // A picture of this moment for a flow token (images are reused round-robin).
  async _eventImage() {
    return this._imageFromJpeg(await this._snapshotJpeg());
  }

  // The picture for a trigger's image token, taken only when a flow uses that card for
  // this camera (motion starts often; a full-size picture each time costs CPU).
  async _flowImage(card) {
    this.flowUse = this.flowUse || {};
    const known = this.flowUse[card.id];
    let used = known && Date.now() - known.at < FLOW_USE_CHECK_MS ? known.used : null;
    if (used === null) {
      used = await card.getArgumentValues(this).then((args) => args.length > 0).catch(() => true);
      if (!known) this.diag(`flows using "${card.id}": ${used ? 'yes' : 'none'}`);
      this.flowUse[card.id] = { at: Date.now(), used };
    }
    return used ? this._eventImage() : this._imageFromJpeg(null);
  }

  async snapshotToken() {
    return { image: await this._eventImage() };
  }

  // ---- Live video ----

  async _attachVideo() {
    const video = await this.homey.videos.createVideoWebRTC({ dataChannel: false });
    video.registerOfferListener(async (offerSdp) => this._onOffer(offerSdp));
    video.registerKeepAliveListener(async (streamId) => {
      const viewer = this.viewers.get(streamId);
      if (viewer) viewer.keepAlive();
    });
    await this.setCameraVideo('live', this.homey.__('device.live'), video);
  }

  // How long one live view may stay open (setting "Close live view after"); 0 = no limit.
  liveLimitMs() {
    const value = this.getSetting('live_limit');
    const minutes = Number(value === null || value === undefined ? 15 : value);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60000 : 0;
  }

  async _onOffer(offerSdp) {
    this.diag(`viewer offer (${this.viewers.size} already watching)`);
    if (this.viewers.size >= MAX_VIEWERS) this.viewers.values().next().value.close();
    const mode = this.getSetting('quality') || 'auto';
    try {
      const { viewer, answerSdp } = await this.app.getRelay().openViewer({
        camera: this.liveCamera(),
        mode,
        startProfile: 'low',
        maxMs: this.liveLimitMs(),
        viewerOfferSdp: offerSdp,
        onClose: (v) => this.viewers.delete(v.id),
      });
      this.viewers.set(viewer.id, viewer);
      return { answerSdp, streamId: viewer.id };
    } catch (err) {
      this.app.diagError(this.tag, 'live video failed:', err.message);
      throw new Error(this.app.friendly(err));
    }
  }

  // ---- PTZ ----

  async presetChoices(query) {
    const presets = await this.client.ptzPresets().catch((err) => {
      throw new Error(this.app.friendly(err));
    });
    const q = String(query || '').toLowerCase();
    return presets.filter((p) => p.name.toLowerCase().includes(q)).map((p) => ({ name: p.name, id: String(p.number) }));
  }

  async ptzGotoPreset(preset) {
    try {
      await this.client.ptzGotoPreset(preset.name);
    } catch (err) {
      throw new Error(this.app.friendly(err));
    }
  }

  async ptzHome() {
    try {
      await this.client.ptzHome();
    } catch (err) {
      throw new Error(this.app.friendly(err));
    }
  }

  // ---- Light (IR or white light) ----

  async setLight(state) {
    try {
      const lights = await this.client.lights();
      if (!lights.length) throw Object.assign(new Error('No light'), { code: 'not_supported' });
      for (const light of lights) {
        if (state === 'auto') {
          await this.client.setLightAutomatic(light.lightID, true);
        } else {
          await this.client.setLightAutomatic(light.lightID, false).catch(() => {});
          await this.client.setLight(light.lightID, state === 'on');
        }
      }
    } catch (err) {
      throw new Error(this.app.friendly(err));
    }
  }

  // ---- Inputs and outputs ----

  async virtualInput(port, action, durationS) {
    try {
      if (action === 'pulse') await this.client.virtualInput(port, true, durationS || 1);
      else await this.client.virtualInput(port, action === 'activate');
    } catch (err) {
      throw new Error(this.app.friendly(err));
    }
  }

  async setOutput(port, action, durationS) {
    try {
      if (action === 'pulse') await this.client.setOutput(port, { pulseMs: (durationS || 1) * 1000 });
      else await this.client.setOutput(port, { active: action === 'activate' });
    } catch (err) {
      throw new Error(this.app.friendly(err));
    }
  }

  // ---- Flow card lists ----

  async scenarioChoices(query) {
    const q = String(query || '').toLowerCase();
    const list = [{ id: 'any', name: this.homey.__('flow.anyScenario') }]
      .concat(events.analyticsScenarios(this.instances).filter((sc) => !sc.counting && !sc.occupancy).map((sc) => ({ id: sc.topic, name: sc.name })));
    return list.filter((s) => s.name.toLowerCase().includes(q));
  }

  // Number in an occupancy area now (its capability).
  occupancyOf(arg) {
    const topic = arg && arg.id ? arg.id : String(arg || '');
    const sc = events.analyticsScenarios(this.instances).find((x) => x.topic === topic && x.occupancy);
    return sc ? Number(this.getCapabilityValue(`axis_occupancy.${sc.id}`)) || 0 : 0;
  }

  async occupancyChoices(query) {
    const q = String(query || '').toLowerCase();
    return [{ id: 'any', name: this.homey.__('flow.anyScenario') }]
      .concat(events.analyticsScenarios(this.instances).filter((sc) => sc.occupancy).map((sc) => ({ id: sc.topic, name: sc.name })))
      .filter((sc) => sc.name.toLowerCase().includes(q));
  }

  // Object Analytics scenarios for actions (all kinds, or only counting ones).
  async aoaChoices(query, countingOnly) {
    const q = String(query || '').toLowerCase();
    return events.analyticsScenarios(this.instances)
      .filter((sc) => sc.aoaId && (!countingOnly || sc.counting))
      .map((sc) => ({ id: sc.topic, name: sc.name }))
      .filter((sc) => sc.name.toLowerCase().includes(q));
  }

  async clipChoices(query) {
    const q = String(query || '').toLowerCase();
    const clips = await this.client.mediaClips().catch(() => []);
    return clips.map((c) => ({ id: String(c.id), name: c.name || `Clip ${c.id}` })).filter((c) => c.name.toLowerCase().includes(q));
  }

  async sirenChoices(query) {
    const q = String(query || '').toLowerCase();
    const profiles = await this.client.sirenProfiles().catch(() => []);
    return profiles.map((p) => ({ id: p.name, name: p.name, description: p.description })).filter((p) => p.name.toLowerCase().includes(q));
  }

  // ---- Actions added from the VAPIX audit ----

  async _act(what, fn) {
    try {
      return await fn();
    } catch (err) {
      this.app.diagError(this.tag, `${what} failed:`, err.message);
      throw new Error(this.app.friendly(err));
    }
  }

  // The privacy mode switch on the device tile (only on cameras that have privacy masks).
  _listenPrivacy() {
    if (this.privacyListening || !this.hasCapability('axis_privacy')) return;
    this.privacyListening = true;
    this.registerCapabilityListener('axis_privacy', (on) => this.setPrivacy(on));
  }

  async setPrivacy(on) {
    const sizes = ((this.features && this.features.resolutions) || []).map((r) => r.split('x').map(Number)).filter((r) => r[0] && r[1]);
    const largest = sizes.sort((a, b) => b[0] * b[1] - a[0] * a[1])[0];
    await this._act('privacy mode', () => this.client.setPrivacyMode(on, largest ? largest.join('x') : undefined));
    if (this.hasCapability('axis_privacy')) await this.setCapabilityValue('axis_privacy', on).catch(this.error);
    this._remember('privacy', this.homey.__(on ? 'widget.privacyOn' : 'widget.privacyOff'));
  }

  async playClip(clip, volume) {
    const id = Number(clip && clip.id !== undefined ? clip.id : clip);
    const opts = this.features && this.features.clipVolume && Number.isFinite(volume) ? { volume } : {};
    await this._act('play sound', () => this.client.playClip(id, opts));
  }

  async stopClip() {
    await this._act('stop sound', () => this.client.stopClip());
  }

  async startSiren(profile) {
    await this._act('siren and light', () => this.client.startSiren(profile && profile.id ? profile.id : String(profile)));
  }

  async stopSiren() {
    await this._act('siren and light', () => this.client.stopSiren());
  }

  async restartCamera() {
    this.diag('restarting the camera (flow)');
    await this._act('restart', () => this.client.restart());
  }

  // Text on the picture; the overlay id is kept to change or remove it later.
  async showText(text, position) {
    const dynamic = Boolean(this.features && this.features.dynamicOverlay);
    // Older cameras: the text goes into the camera's own text field; keep what was there.
    if (!dynamic && !this.getStoreValue('text_backup')) {
      const backup = await this.client.textSettings().catch(() => null);
      if (backup) await this.setStoreValue('text_backup', backup).catch(this.error);
    }
    const id = await this._act('text on the picture', () => this.client.showText(String(text || ''), {
      position: position || 'topLeft', id: this.getStoreValue('overlay_id'), dynamic,
    }));
    await this.setStoreValue('overlay_id', id).catch(this.error);
  }

  async removeText() {
    const dynamic = Boolean(this.features && this.features.dynamicOverlay);
    const backup = this.getStoreValue('text_backup');
    if (!dynamic && backup) await this._act('remove text', () => this.client.restoreTextSettings(backup));
    else await this._act('remove text', () => this.client.removeText({ id: this.getStoreValue('overlay_id'), dynamic }));
    await this.setStoreValue('overlay_id', null).catch(this.error);
    await this.setStoreValue('text_backup', null).catch(this.error);
  }

  _aoaScenario(arg) {
    const topic = arg && arg.id ? arg.id : String(arg || '');
    const sc = events.analyticsScenarios(this.instances).find((x) => x.topic === topic);
    if (!sc || !sc.aoaId) throw new Error(this.homey.__('errors.no_scenario'));
    return sc;
  }

  async resetCounts(arg) {
    const sc = this._aoaScenario(arg);
    await this._act('reset counts', () => this.client.aoa('resetAccumulatedCounts', { scenario: Number(sc.aoaId) }));
    await this._scenarioCounts(sc, { total: 0, human: 0, car: 0, truck: 0, bus: 0, bike: 0, otherVehicle: 0, reason: '' }, false);
  }

  async testScenario(arg) {
    const sc = this._aoaScenario(arg);
    await this._act('test alarm', () => this.client.aoa('sendAlarmEvent', { scenario: Number(sc.aoaId) }));
  }

  // Every STATUS_MS: camera temperature, memory card, privacy mode and the Object
  // Analytics counts (also right after start, so the numbers are right at once).
  async _pollStatus() {
    const f = this.features || {};
    if (f.temperature) {
      const t = await this.client.temperatures().catch(() => null);
      const main = t && (t.sensors.find((x) => /main|system|housing/i.test(x.name || '')) || t.sensors[0]);
      if (main && this.hasCapability('measure_temperature')) await this.setCapabilityValue('measure_temperature', main.celsius).catch(this.error);
    }
    if (f.disks) {
      const disks = await this.client.disks().catch(() => null);
      const sd = disks && disks.find((d) => d.id === 'SD_DISK' && d.totalKB > 0);
      // Only a successful answer changes what we know (a failed request says nothing).
      if (disks && Boolean(sd) !== Boolean(this.hasMemoryCard)) {
        this.hasMemoryCard = Boolean(sd);
        await this.setStoreValue('memory_card', this.hasMemoryCard).catch(this.error);
        await this._syncCapabilities();
      }
      if (sd && this.hasCapability('axis_storage')) {
        await this.setCapabilityValue('axis_storage', Math.round(((sd.totalKB - sd.freeKB) / sd.totalKB) * 100)).catch(this.error);
      }
    }
    if (f.privacyMask && this.hasCapability('axis_privacy')) {
      const on = await this.client.privacyMode().catch((err) => {
        if (!this.privacyLogged) this.diag(`could not read privacy mode: ${err.code || ''} ${err.message}`);
        this.privacyLogged = true;
        return null;
      });
      if (on !== null) await this.setCapabilityValue('axis_privacy', on).catch(this.error);
    }
    for (const sc of events.analyticsScenarios(this.instances).filter((x) => x.aoaId && (x.counting || x.occupancy))) {
      const data = await this.client.aoa(sc.occupancy ? 'getOccupancy' : 'getAccumulatedCounts', { scenario: Number(sc.aoaId) }).catch(() => null);
      if (data) await this._scenarioCounts(sc, events.countsOf(sc.occupancy ? data : this._countsAsEvent(data), sc.occupancy), false);
    }
  }

  // Every POWER_MS: the camera's own power use (Power settings API) and, on a recorder,
  // the power on each PoE port (NVR PoE API).
  async _pollPower() {
    const f = this.features || {};
    if (f.power) {
      const p = await this.client.powerStatus().catch((err) => {
        if (!this.powerLogged) this.diag(`could not read power use: ${err.code || ''} ${err.message}`);
        this.powerLogged = true;
        return null;
      });
      const readable = Boolean(p && p.current !== null);
      if (p && readable !== Boolean(this.powerReadable)) {
        this.powerReadable = readable;
        await this.setStoreValue('power_readable', readable).catch(this.error);
        if (p) this.diag(`power: ${readable ? `${p.current} W now, PoE class ${p.poeClass === null ? '?' : p.poeClass}` : 'this camera cannot measure its power use'}`);
        await this._syncCapabilities();
      }
      if (readable && this.hasCapability('measure_power')) await this.setCapabilityValue('measure_power', Math.round(p.current * 10) / 10).catch(this.error);
    }
    if (f.recorderPoe) {
      const ports = await this.client.poePorts().catch((err) => {
        if (!this.poeLogged) this.diag(`could not read PoE ports: ${err.code || ''} ${err.message}`);
        this.poeLogged = true;
        return null;
      });
      if (!ports) return;
      const numbers = ports.map((x) => x.port).sort((a, b) => a - b);
      if (numbers.join(',') !== (this.poePortNumbers || []).join(',')) {
        this.poePortNumbers = numbers;
        await this.setStoreValue('poe_ports', numbers).catch(this.error);
        this.diag(`PoE ports: ${ports.map((x) => `${x.port}: ${x.status || '?'}${x.watts !== null ? ` ${x.watts} W` : ''}`).join('; ')}`);
        await this._syncCapabilities();
      }
      let total = 0;
      for (const x of ports) {
        const w = x.watts || 0;
        total += w;
        const cap = `axis_poe.port${x.port}`;
        if (this.hasCapability(cap)) await this.setCapabilityValue(cap, Math.round(w * 10) / 10).catch(this.error);
      }
      if (this.hasCapability('axis_poe')) await this.setCapabilityValue('axis_poe', Math.round(total * 10) / 10).catch(this.error);
    }
  }

  // getAccumulatedCounts answers { total, human, car, ... }; events use totalHuman etc.
  _countsAsEvent(data) {
    const out = { total: data.total };
    for (const c of events.COUNT_CLASSES) out[`total${c[0].toUpperCase()}${c.slice(1)}`] = data[c];
    return out;
  }

  // ---- Homey lifecycle ----

  // Repair: new username/password, checked before it is saved.
  async changeLogin(username, password) {
    const settings = this.getSettings();
    const test = new VapixClient({
      host: settings.address, secure: settings.use_https !== false, username, password, pin: this.getStoreValue('pin'),
    });
    try {
      await test.deviceInfo();
    } catch (err) {
      throw new Error(this.app.friendly(err));
    } finally {
      test.close();
    }
    await this.setStoreValue('username', username);
    await this.setStoreValue('password', password);
    this._restart();
  }

  _restart() {
    this.app.getRelay().closeCamera(this.getData().id);
    this._makeClient();
    this._start();
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('address') && !/^[\w.-]+$/.test(String(newSettings.address || ''))) {
      throw new Error(this.homey.__('errors.bad_address'));
    }
    if (changedKeys.some((k) => ['address', 'use_https', 'rtsp_port'].includes(k))) {
      if (changedKeys.includes('address') || changedKeys.includes('use_https')) {
        // A different device may answer there: check its certificate again.
        await this.setStoreValue('pin', null);
      }
      this.homey.setTimeout(() => this._restart(), 500);
    }
    if (changedKeys.includes('quality')) this.app.getRelay().closeCamera(this.getData().id);
    if (changedKeys.includes('scene_counts')) {
      this.homey.setTimeout(async () => {
        await this._syncCapabilities().catch(this.error);
        this._startScene();
      }, 500);
    }
  }

  // Homey's discovery (mDNS) found this camera, possibly at a new address.
  onDiscoveryResult(result) {
    return String((result.txt && result.txt.macaddress) || result.id || '').toUpperCase() === this.getData().id;
  }

  async onDiscoveryAvailable(result) {
    await this._addressSeen(result.address);
  }

  async onDiscoveryAddressChanged(result) {
    await this._addressSeen(result.address);
  }

  async _addressSeen(address) {
    if (!usableAddress(address) || address === this.getSetting('address')) return;
    this.diag(`camera moved to ${address}`);
    await this.setSettings({ address });
    this._restart();
  }

  statusSummary() {
    return {
      name: this.getName(),
      address: this.client ? this.client.host : this.getSetting('address'),
      model: this.getSetting('model'),
      firmware: this.getSetting('firmware'),
      available: this.getAvailable(),
      events: Boolean(this.stream && this.stream.connected),
    };
  }

  async onUninit() {
    this._stop();
  }

  async onDeleted() {
    this._stop();
    await this.timeline.clear();
  }

  _stop() {
    this.homey.clearTimeout(this.startTimer);
    this.homey.clearTimeout(this.saveSoonTimer);
    this.homey.clearInterval(this.statusTimer);
    this.homey.clearInterval(this.powerTimer);
    this._saveTraffic();
    this.homey.clearInterval(this.trafficTimer);
    this.homey.clearInterval(this.todayTimer);
    this.homey.clearInterval(this.trackSummaryTimer);
    this.homey.clearInterval(this.trackTickTimer);
    this.homey.clearTimeout(this.minuteTimer);
    this.homey.clearInterval(this.healthTimer);
    this.homey.clearInterval(this.appsTimer);
    this.homey.clearTimeout(this.tamperTimer);
    this.homey.clearTimeout(this.motionOffTimer);
    if (this.stream) this.stream.stop();
    this._stopScene();
    if (this.app.relay) this.app.relay.closeCamera(this.getData().id);
    if (this.client) this.client.close();
  }
}

module.exports = CameraDevice;

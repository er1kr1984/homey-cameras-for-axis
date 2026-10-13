'use strict';

const Homey = require('homey');
const { VapixClient, usableAddress } = require('../../lib/vapix');
const { EventStream } = require('../../lib/event-stream');
const { RtspEventStream } = require('../../lib/rtsp-events');
const events = require('../../lib/events-map');

const FEATURES_REFRESH_MS = 6 * 60 * 60 * 1000; // re-read what the camera supports
const FEATURES_VERSION = 3; // bump to re-read after an app update that uses more
const SOUND_LEVEL_MS = 10 * 1000; // sound level reading updated at most this often
const AUDIO_CLASS_GAP_MS = 10 * 1000; // per sound type
const SCENE_CHANGE_SAMPLES = 2; // a new people/vehicle count must hold this many frames
const HEALTH_MS = 5 * 60 * 1000;
const TAMPER_HOLD_MS = 60 * 1000;
const EVENT_IMAGES = 10; // flow pictures kept per camera (oldest reused)
const EVENT_SNAPSHOT_TIMEOUT_MS = 4000;
const MAX_VIEWERS = 4;
const AUDIO_TRIGGER_GAP_MS = 30 * 1000; // sound detection can flip every second
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
    this.features = this.getStoreValue('features') || null;
    this.instances = this.getStoreValue('event_instances') || [];
    for (const cap of ['alarm_motion', 'alarm_tamper', 'axis_night', 'alarm_problem', 'axis_problem']) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }
    this._makeClient();
    await this._attachImage().catch((err) => this.error('image:', err.message));
    await this._attachVideo().catch((err) => this.error('video:', err.message));
    this._start();
    this.healthTimer = this.homey.setInterval(() => this._healthCheck(), HEALTH_MS);
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
    this._startEvents();
    this._startScene();
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
    const has = (re) => this.instances.some((i) => re.test(events.bare(i.topic)));
    const wanted = new Map(); // capability id -> options or null
    if (has(/^SoundPressureLevel\/Metrics$/)) wanted.set('measure_noise', null);
    if (has(/^Storage\/Recording$/)) wanted.set('axis_recording', null);
    if (has(/^Device\/Light\/Status$|^LightControl\/LightStatusChanged\/Status$/)) wanted.set('axis_ir', null);
    if (has(/^VideoSource\/LiveStreamAccessed$/)) wanted.set('axis_watched', null);
    for (const sc of events.analyticsScenarios(this.instances)) {
      if (sc.counting) wanted.set(`axis_count.${sc.id}`, { title: { en: sc.name } });
      else if (sc.stateful) wanted.set(`alarm_generic.${sc.id}`, { title: { en: sc.name } });
    }
    if (this.getSetting('scene_counts')) {
      wanted.set('axis_people', null);
      wanted.set('axis_vehicles', null);
    }
    const dynamic = /^(measure_noise|axis_recording|axis_ir|axis_watched|axis_people|axis_vehicles)$|^axis_count\.|^alarm_generic\.(oa|mg|fg|lg|cl|an)_/;
    for (const cap of this.getCapabilities()) {
      if (dynamic.test(cap) && !wanted.has(cap)) await this.removeCapability(cap).catch(this.error);
    }
    for (const [cap, options] of wanted) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
      if (options) await this.setCapabilityOptions(cap, options).catch(this.error);
    }
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
    this.diag(`event ${topic} ${JSON.stringify(details)}`);
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
      this.driver.triggers.tampering.trigger(this, { image: await this._eventImage() }).catch(this.error);
    }
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
        this.driver.triggers.sound.trigger(this, {
          sound: this.homey.__(`sounds.${sound}`) || sound, image: await this._eventImage(),
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
    if (scenario && scenario.counting) {
      const total = Number(details.total);
      const humans = Number(details.totalHuman);
      if (Number.isFinite(total)) await this.setCapabilityValue(`axis_count.${scenario.id}`, total).catch(this.error);
      this.driver.triggers.counted.trigger(this, {
        scenario: name, total: Number.isFinite(total) ? total : 0, humans: Number.isFinite(humans) ? humans : 0,
      }, { topic }).catch(this.error);
      return;
    }
    if (scenario && state !== null) await this.setCapabilityValue(`alarm_generic.${scenario.id}`, state).catch(this.error);
    if (state === false) return;
    const object = details.classTypes || details.objectClass || details.ObjectClass || '';
    this.driver.triggers.analytics.trigger(this, {
      scenario: name,
      object: String(object),
      image: await this._eventImage(),
    }, { topic }).catch(this.error);
  }

  // Camera health: the problem alarm is on while any problem is active; pulses (an action
  // that failed, a PTZ error) only show as the last problem and run the flow.
  _health(ev, key, state, initial) {
    const problem = events.problemOf(ev.topic);
    if (!problem) return;
    const where = ev.source.disk_id || ev.source.Name || ev.source.interface || '';
    const extra = ev.data.description ? `: ${ev.data.description}` : '';
    const text = `${this.homey.__(`problems.${problem}`) || problem}${where ? ` (${where})` : ''}${extra}`;
    // A missing SD card or unused network share reports "disruption" from the start; only
    // a disruption that appears while running counts.
    if (initial && problem === 'storage') return;
    if (state === false) {
      if (!this.problems.has(key)) return;
      this.problems.delete(key);
      if (!initial) this.driver.triggers.problemSolved.trigger(this, { problem: text }).catch(this.error);
    } else {
      if (state === true) this.problems.set(key, text);
      if (!initial) this.driver.triggers.problem.trigger(this, { problem: text }).catch(this.error);
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

  // ---- People and vehicles in view (analytics scene description, opt-in) ----

  _startScene() {
    this._stopScene();
    if (!this.getSetting('scene_counts')) return;
    this.scene = new RtspEventStream({ camera: this.liveCamera(), mode: 'scene', log: (...args) => this.diag(...args) });
    this.sceneSamples = [];
    this.scene.on('connected', () => {
      this.diag('reading the scene description (people and vehicles in view)');
      this.homey.clearTimeout(this.sceneCheckTimer);
      this.sceneCheckTimer = this.homey.setTimeout(() => {
        if (!this.scene || this.scene.lastFrameAt) return;
        this.diag('no scene description received in 30 s; the camera may need AXIS Object Analytics or a newer AXIS OS');
      }, 30000);
    });
    this.scene.on('frame', (frame) => this._onSceneFrame(frame));
    this.scene.start();
  }

  _stopScene() {
    this.homey.clearTimeout(this.sceneCheckTimer);
    if (this.scene) this.scene.stop();
    this.scene = null;
  }

  _onSceneFrame(frame) {
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
        this._eventImage().then((image) => this.driver.triggers.motionStarted.trigger(this, { image })).catch(this.error);
      }
    } else if (this.getCapabilityValue('alarm_motion') === true && !this.motionOffTimer) {
      // Keep the alarm on a little longer so short gaps don't flap it.
      this.motionOffTimer = this.homey.setTimeout(() => {
        this.motionOffTimer = null;
        if (this.motionSources.size) return;
        this.setCapabilityValue('alarm_motion', false).catch(this.error);
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

  async _attachImage() {
    const image = await this.homey.images.createImage();
    image.setStream(async (stream) => {
      const jpeg = await this.client.snapshot({ resolution: this._snapshotResolution() });
      stream.end(jpeg);
    });
    await this.setCameraImage('snapshot', this.homey.__('device.snapshot'), image);
    this.image = image;
  }

  // A picture of this moment for a flow token (images are reused round-robin).
  async _eventImage() {
    let jpeg = null;
    try {
      jpeg = await Promise.race([
        this.client.snapshot({ resolution: this._snapshotResolution() }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('snapshot timeout')), EVENT_SNAPSHOT_TIMEOUT_MS)),
      ]);
    } catch (err) {
      this.diag(`event picture failed: ${err.message}`);
    }
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

  async _onOffer(offerSdp) {
    this.diag(`viewer offer (${this.viewers.size} already watching)`);
    if (this.viewers.size >= MAX_VIEWERS) this.viewers.values().next().value.close();
    const mode = this.getSetting('quality') || 'medium';
    try {
      const { viewer, answerSdp } = await this.app.getRelay().openViewer({
        camera: this.liveCamera(),
        mode,
        startProfile: 'medium',
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
      .concat(events.analyticsScenarios(this.instances).filter((sc) => !sc.counting).map((sc) => ({ id: sc.topic, name: sc.name })));
    return list.filter((s) => s.name.toLowerCase().includes(q));
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
  }

  _stop() {
    this.homey.clearInterval(this.healthTimer);
    this.homey.clearTimeout(this.tamperTimer);
    this.homey.clearTimeout(this.motionOffTimer);
    if (this.stream) this.stream.stop();
    this._stopScene();
    if (this.app.relay) this.app.relay.closeCamera(this.getData().id);
    if (this.client) this.client.close();
  }
}

module.exports = CameraDevice;

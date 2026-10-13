'use strict';

const Homey = require('homey');
const { VapixClient } = require('../../lib/vapix');
const { EventStream } = require('../../lib/event-stream');
const events = require('../../lib/events-map');

const FEATURES_REFRESH_MS = 6 * 60 * 60 * 1000; // re-read what the camera supports
const HEALTH_MS = 5 * 60 * 1000;
const TAMPER_HOLD_MS = 60 * 1000;
const EVENT_IMAGES = 10; // flow pictures kept per camera (oldest reused)
const EVENT_SNAPSHOT_TIMEOUT_MS = 4000;
const MAX_VIEWERS = 4;
const SNAPSHOT_SIZES = { small: 640, medium: 1280, full: Infinity };

class CameraDevice extends Homey.Device {

  async onInit() {
    this.app = this.homey.app;
    this.tag = `[${this.getName()}]`;
    this.motionSources = new Map(); // source key -> pulse timer or true
    this.inputs = new Map(); // port -> active
    this.viewers = new Map();
    this.eventImages = [];
    this.features = this.getStoreValue('features') || null;
    this.instances = this.getStoreValue('event_instances') || [];
    for (const cap of ['alarm_motion', 'alarm_tamper', 'axis_night']) {
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
  }

  async _loadFeatures(force) {
    const fresh = this.features && this.features.at && Date.now() - this.features.at < FEATURES_REFRESH_MS;
    if (fresh && !force && this.instances.length) return;
    const [info, caps] = await Promise.all([this.client.deviceInfo(), this.client.capabilities()]);
    let instances = [];
    try {
      instances = await this.client.eventInstances();
    } catch (err) {
      this.diag(`could not list event types: ${err.message}`);
    }
    this.features = { ...caps, at: Date.now() };
    this.instances = instances.map((i) => ({ topic: i.topic, name: i.name, stateful: i.stateful }));
    await this.setStoreValue('features', this.features);
    await this.setStoreValue('event_instances', this.instances);
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

  _startEvents() {
    if (this.stream) this.stream.stop();
    const filter = events.topicFilter(this.instances);
    if (!filter) {
      this.diag('no events to listen to (none listed by the camera)');
      return;
    }
    this.stream = new EventStream({
      client: this.client,
      filters: [{ topicFilter: filter }],
      log: (...args) => this.diag(...args),
    });
    this.stream.on('connected', () => {
      this.diag('listening for events');
      if (!this.getAvailable()) this.setAvailable().catch(this.error);
    });
    this.stream.on('error', (err) => {
      if (['login_failed', 'cert_changed', 'forbidden'].includes(err.code)) this._connectionProblem(err);
    });
    this.stream.on('event', (ev) => this._onEvent(ev).catch((err) => this.error('event:', err.message)));
    this.stream.start();
  }

  async _onEvent(ev) {
    const kind = events.classify(ev.topic);
    const state = events.stateOf(ev);
    const topic = events.bare(ev.topic);
    const details = { ...ev.source, ...ev.data };
    this.homey.app.diag(this.tag, `event ${topic} ${JSON.stringify(details)}`);
    this.driver.triggers.event.trigger(this, {
      topic, active: state !== false, details: JSON.stringify(details),
    }).catch(this.error);

    if (kind === 'motion' || (kind === 'analytics' && this.getSetting('analytics_motion') !== false)) {
      this._setMotionSource(events.sourceKey(ev), state);
    }
    if (kind === 'analytics' && state !== false) {
      const scenario = this.instances.find((i) => events.bare(i.topic) === topic);
      const object = details.classTypes || details.objectClass || details.ObjectClass || '';
      this.driver.triggers.analytics.trigger(this, {
        scenario: (scenario && scenario.name) || topic.split('/').pop(),
        object: String(object),
        image: await this._eventImage(),
      }, { topic }).catch(this.error);
    }
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
    if (kind === 'audio' && state !== false) {
      this.driver.triggers.audio.trigger(this, {}).catch(this.error);
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
      .concat(events.analyticsScenarios(this.instances).map((s) => ({ id: s.topic, name: s.name })));
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
    if (!address || address === this.getSetting('address')) return;
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
    if (this.app.relay) this.app.relay.closeCamera(this.getData().id);
    if (this.client) this.client.close();
  }
}

module.exports = CameraDevice;

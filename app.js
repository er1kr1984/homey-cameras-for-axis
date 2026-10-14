'use strict';

const Homey = require('homey');
const { applyWeriftTuning } = require('./lib/werift-tuning');

const tuningFailures = applyWeriftTuning();
const LiveRelay = require('./lib/live-relay');
const { RtspUpstream } = require('./lib/rtsp-upstream');

const LOG_LINES = 300;
const LOG_PERSIST_MS = 60 * 1000;

const ERROR_CODES = ['unreachable', 'login_failed', 'forbidden', 'cert_changed', 'not_supported', 'bad_response', 'too_many_streams'];

class AxisApp extends Homey.App {

  async onInit() {
    this.recentLogs = [];
    this.logsDirty = false;
    // With diagnostics on, keep the log of a run that crashed so it can be read after the restart.
    const crashed = this.homey.settings.get('diag_running_logs');
    if (crashed && crashed.length) this.homey.settings.set('diag_previous_logs', crashed);
    this.homey.settings.unset('diag_running_logs');
    process.on('uncaughtException', (err) => {
      this.diagError('UNCAUGHT', err && err.stack);
      this._persistLogs(true);
    });
    process.on('unhandledRejection', (err) => {
      this.diagError('UNHANDLED REJECTION', (err && err.stack) || err);
      this._persistLogs(true);
    });
    this.homey.setInterval(() => this._persistLogs(false), LOG_PERSIST_MS);
    if (!this.homey.settings.get('diagnostics')) this.homey.settings.unset('diag_previous_logs');
    this.relay = null;
    // Homey stops an app after a few CPU warnings; live video is what costs the most.
    this.homey.on('cpuwarn', ({ count, limit } = {}) => {
      this.diagError(`Homey CPU warning ${count}/${limit}`);
      if (this.relay) this.relay.onCpuWarning(count, limit);
    });
    this._registerWidgets();
    this.diag('Axis cameras app started');
    if (tuningFailures.length) this.diagError('Running without some speed-ups:', tuningFailures.join('; '));
  }

  async onUninit() {
    if (this.relay) this.relay.closeAll();
  }

  // ---- Live video ----

  getRelay() {
    if (!this.relay) {
      this.relay = new LiveRelay({
        openUpstream: (opts) => new RtspUpstream(opts),
        log: (...args) => this.diag(...args),
        knownBFrames: this.homey.settings.get('bframe_cameras') || [],
        onBFrames: (id) => {
          const known = new Set(this.homey.settings.get('bframe_cameras') || []);
          known.add(id);
          this.homey.settings.set('bframe_cameras', [...known]);
        },
      });
    }
    return this.relay;
  }

  // ---- Dashboard widgets ----

  _cameras() {
    return this.homey.drivers.getDriver('camera').getDevices();
  }

  _registerWidgets() {
    const cameras = async (query) => {
      const q = String(query || '').toLowerCase();
      return this._cameras()
        .map((d) => ({ id: d.getId(), name: d.getName(), description: d.getSetting('model') || '' }))
        .filter((c) => c.name.toLowerCase().includes(q));
    };
    for (const id of ['analytics', 'traffic', 'visitors', 'heatmap']) {
      this.homey.dashboards.getWidget(id).registerSettingAutocompleteListener('camera', cameras);
    }
  }

  widgetTraffic({ camera, period, show }) {
    return this._widgetCamera(camera).trafficSeries(['week', 'month'].includes(period) ? period : 'day', ['objects', 'motion'].includes(show) ? show : 'auto');
  }

  widgetTimeline({ camera, kind, limit }) {
    return this._widgetCamera(camera).timelineList(['people', 'vehicles'].includes(kind) ? kind : 'all', Math.min(40, Number(limit) || 12));
  }

  async widgetPicture({ camera, key }) {
    return this._widgetCamera(camera).timelinePicture(String(key || ''));
  }

  async widgetHeatmap({ camera, kind }) {
    return this._widgetCamera(camera).heatmap(['people', 'vehicles'].includes(kind) ? kind : 'all');
  }

  _widgetCamera(camera) {
    const id = camera && (camera.id || camera);
    const device = this._cameras().find((d) => d.getId() === id);
    if (!device) throw new Error(this.homey.__('widget.missing'));
    return device;
  }

  widgetState({ camera }) {
    return this._widgetCamera(camera).widgetState();
  }

  widgetScene({ camera }) {
    return this._widgetCamera(camera).widgetScene();
  }

  async widgetSnapshot({ camera }) {
    const device = this._widgetCamera(camera);
    try {
      const jpeg = await device.client.snapshot({ resolution: device._snapshotResolution() });
      return { jpeg: jpeg.toString('base64') };
    } catch (err) {
      throw new Error(this.friendly(err));
    }
  }

  async widgetOffer({ camera, sdp, quality }) {
    const device = this._widgetCamera(camera);
    const mode = ['low', 'medium', 'auto'].includes(quality) ? quality : 'low';
    device.diag(`widget viewer offer (${mode})`);
    try {
      const { answerSdp } = await this.getRelay().openViewer({
        camera: device.liveCamera(), mode, startProfile: 'low', viewerOfferSdp: sdp,
      });
      return { answerSdp };
    } catch (err) {
      if (err.code === 'too_many_streams') throw new Error('Too many live streams');
      throw new Error(this.friendly(err));
    }
  }

  widgetOverview() {
    return { cameras: this._cameras().map((d) => d.widgetState()), updated: Date.now() };
  }

  // ---- Messages ----

  // A plain-language sentence for an error (locales errors.<code>), else its own message.
  friendly(err) {
    const code = err && ERROR_CODES.includes(err.code) ? err.code : null;
    if (!code) return (err && err.message) || String(err);
    const key = `errors.${code}`;
    const text = this.homey.__(key);
    return text && text !== key ? text : err.message;
  }

  // ---- Diagnostics (app settings page) ----

  diag(...args) {
    this._remember('', args);
    this.log(...args);
  }

  diagError(...args) {
    this._remember('ERROR ', args);
    this.error(...args);
  }

  _remember(prefix, args) {
    this.recentLogs.push(`${new Date().toISOString()} ${prefix}${args.map(String).join(' ')}`);
    if (this.recentLogs.length > LOG_LINES) this.recentLogs.shift();
    this.logsDirty = true;
  }

  _persistLogs(force) {
    if (!this.homey.settings.get('diagnostics')) return;
    if (!this.logsDirty && !force) return;
    try {
      this.homey.settings.set('diag_running_logs', this.recentLogs.slice(-150));
      this.logsDirty = false;
    } catch (e) { /* ignore */ }
  }

  settingsState() {
    const cameras = this.homey.drivers.getDriver('camera').getDevices().map((d) => d.statusSummary());
    return { cameras, diagnostics: Boolean(this.homey.settings.get('diagnostics')) };
  }

  settingsSetDiagnostics(on) {
    this.homey.settings.set('diagnostics', Boolean(on));
    if (!on) {
      this.homey.settings.unset('diag_running_logs');
      this.homey.settings.unset('diag_previous_logs');
    } else {
      this._persistLogs(true);
    }
    return { diagnostics: Boolean(on) };
  }

  diagnosticsLogs(previous) {
    if (!this.homey.settings.get('diagnostics')) throw new Error('Switch on Diagnostics in the app settings first');
    return previous ? (this.homey.settings.get('diag_previous_logs') || []) : this.recentLogs;
  }
}

module.exports = AxisApp;

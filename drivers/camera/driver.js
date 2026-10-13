'use strict';

const Homey = require('homey');
const { VapixClient } = require('../../lib/vapix');
const { scanSubnet } = require('../../lib/scan');

// Product types offered as cameras; speakers, recorders and door controllers come later.
const CAMERA_TYPES = /camera|door station|encoder|video|intercom|thermal/i;

class CameraDriver extends Homey.Driver {

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
    };
    this.triggers.analytics.registerRunListener(async (args, state) => !args.scenario || args.scenario.id === 'any' || args.scenario.id === state.topic);
    this.triggers.analytics.registerArgumentAutocompleteListener('scenario', async (query, args) => args.device.scenarioChoices(query));
    this.triggers.input.registerRunListener(async (args, state) => !args.port || Number(args.port) === state.port);

    flow.getConditionCard('is_night').registerRunListener(async (args) => args.device.getCapabilityValue('axis_night') === true);
    flow.getConditionCard('input_active').registerRunListener(async (args) => args.device.isInputActive(Number(args.port)));

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
    session.setHandler('login', async ({ username, password }) => {
      login = { username: String(username || '').trim(), password: String(password || '') };
      if (!login.username) throw new Error(this.homey.__('pair.noUsername'));
      return true;
    });
    session.setHandler('list_devices', async () => {
      if (!login) throw new Error(this.homey.__('pair.noUsername'));
      return this._camerasForLogin(login);
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
      if (serial && r.address) found.set(serial, { host: r.address, secure: true, info: { SerialNumber: serial }, needsLogin: true });
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
      this.log(`pairing: ${results.length} by mDNS, ${scanned.length} by network scan`);
    } catch (err) {
      this.error('network scan failed:', err.message);
    }
    return [...found.entries()].map(([serial, c]) => ({ serial, ...c }));
  }

  async _camerasForLogin({ username, password }) {
    const existing = new Set(this.getDevices().map((d) => d.getData().id));
    const candidates = (await this._candidates()).filter((c) => !existing.has(c.serial));
    const loginFailed = [];
    const devices = [];
    await Promise.all(candidates.map(async (c) => {
      // Recorders, speakers, etc. say what they are without a login: skip them here.
      if (c.info && c.info.ProdType && !CAMERA_TYPES.test(c.info.ProdType)) return;
      let pin = null;
      const client = new VapixClient({
        host: c.host, secure: c.secure, username, password, onNewPin: (fp) => { pin = fp; },
      });
      try {
        const info = await client.deviceInfo();
        if (info.ProdType && !CAMERA_TYPES.test(info.ProdType)) return;
        const model = info.ProdNbr || info.ProdShortName || 'Axis camera';
        devices.push({
          name: `AXIS ${model}`.replace(/^AXIS AXIS /, 'AXIS '),
          data: { id: c.serial },
          store: {
            host: c.host, secure: c.secure, username, password, pin,
          },
          settings: { address: c.host, use_https: c.secure },
        });
      } catch (err) {
        if (err.code === 'login_failed') loginFailed.push(c.host);
        this.log(`pairing: ${c.host} skipped (${err.code || err.message})`);
      } finally {
        client.close();
      }
    }));
    if (!devices.length && loginFailed.length) {
      throw new Error(this.homey.__('pair.loginRefused', { n: loginFailed.length }));
    }
    devices.sort((a, b) => a.store.host.localeCompare(b.store.host, undefined, { numeric: true }));
    return devices;
  }
}

module.exports = CameraDriver;

'use strict';

// VAPIX client for one Axis device (https://developer.axis.com/vapix/).
//
// Talks HTTPS by default (Basic or Digest, the camera's certificate pinned) and plain
// HTTP with Digest for old devices without HTTPS. Every method maps to a documented
// VAPIX API; see the comments for the page each one comes from.

const http = require('node:http');
const https = require('node:https');
const { AxisError } = require('./errors');
const {
  parseChallenges, pickChallenge, basicHeader, DigestSession,
} = require('./digest');
const { PinnedAgent } = require('./tls-pin');
const { parseXml, findAll } = require('./xml');

const TIMEOUT_MS = 10000;

const plainAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
// Used only before a camera is added (no login is sent over it).
const anonymousTlsAgent = new https.Agent({ keepAlive: false, rejectUnauthorized: false });

function wwwAuthenticate(res) {
  const values = [];
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    if (res.rawHeaders[i].toLowerCase() === 'www-authenticate') values.push(res.rawHeaders[i + 1]);
  }
  return values;
}

function netError(err) {
  if (err instanceof AxisError) return err;
  return new AxisError('unreachable', err.message || String(err));
}

// One HTTP(S) request without authentication logic: resolves { status, headers, body, res }.
function rawRequest({
  secure, host, port, method, path, headers, body, agent, timeoutMs,
}) {
  return new Promise((resolve, reject) => {
    const lib = secure ? https : http;
    let req;
    // A hard limit for the whole request, connecting included (the socket timeout alone
    // does not cover a connection that never opens, e.g. an unreachable address).
    const timer = setTimeout(() => {
      if (req) req.destroy(new AxisError('unreachable', `No answer from ${host}`));
    }, timeoutMs);
    const done = (fn, value) => {
      clearTimeout(timer);
      fn(value);
    };
    req = lib.request({
      host, port, method, path, headers, agent, timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done(resolve, {
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), res,
      }));
      res.on('error', (err) => done(reject, netError(err)));
    });
    req.on('timeout', () => req.destroy(new AxisError('unreachable', `No answer from ${host}`)));
    req.on('error', (err) => done(reject, netError(err)));
    if (body) req.write(body);
    req.end();
  });
}

// Addresses Homey can use: IPv4, not link-local (169.254.x.x, which Axis devices also
// announce over mDNS but which is unreachable from another network interface).
function usableAddress(address) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(String(address || '')) && !String(address).startsWith('169.254.');
}

// Name of the full-picture mask the app uses for privacy mode.
const PRIVACY_MASK = 'Homey privacy mode';

class VapixClient {
  // pin: the certificate fingerprint saved when the camera was added (null = not yet);
  // onNewPin(fingerprint) is called the first time a certificate is seen.
  constructor({
    host, port, secure = true, username, password, pin = null, onNewPin, timeoutMs = TIMEOUT_MS,
  }) {
    this.host = host;
    this.secure = secure;
    this.port = Number(port) || (secure ? 443 : 80);
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.pin = pin;
    this.digest = null; // DigestSession, reused until the camera sends a new challenge
    this.useBasic = false;
    this.agent = secure
      ? new PinnedAgent({
        getPin: () => this.pin,
        onNewPin: (fp) => {
          this.pin = fp;
          if (onNewPin) onNewPin(fp);
        },
      })
      : plainAgent;
  }

  close() {
    if (this.agent !== plainAgent) this.agent.destroy();
  }

  _authHeader(method, path) {
    if (this.digest) return this.digest.header(method, path);
    if (this.useBasic) return basicHeader(this.username, this.password);
    return null;
  }

  // Any request with login: answers the camera's challenge and retries once.
  // Returns { status, headers, body } for 2xx; throws AxisError otherwise.
  async request(method, path, { body, contentType, timeoutMs } = {}) {
    const send = () => {
      const headers = {};
      const auth = this._authHeader(method, path);
      if (auth) headers.Authorization = auth;
      if (body) {
        headers['Content-Type'] = contentType || 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      return rawRequest({
        secure: this.secure,
        host: this.host,
        port: this.port,
        method,
        path,
        headers,
        body,
        agent: this.agent,
        timeoutMs: timeoutMs || this.timeoutMs,
      });
    };
    const step = (text) => { if (this.onStep) this.onStep(`${method} ${path.split('?')[0]}: ${text}`); };
    let res = await send();
    step(`HTTP ${res.status}`);
    if (res.status === 401) {
      const challenges = parseChallenges(wwwAuthenticate(res.res));
      const challenge = pickChallenge(challenges, this.secure);
      if (!challenge) throw new AxisError('login_failed', 'The camera asks for a login method this app does not support');
      const stale = challenge.scheme === 'digest' && String(challenge.params.stale).toLowerCase() === 'true';
      // Only retry when we haven't just sent the same credentials (or the nonce merely expired).
      const hadAuth = this.digest || this.useBasic;
      if (challenge.scheme === 'digest') {
        this.digest = new DigestSession(challenge, this.username, this.password);
        this.useBasic = false;
      } else {
        this.digest = null;
        this.useBasic = true;
      }
      if (!hadAuth || stale || challenge.scheme === 'digest') {
        res = await send();
        step(`HTTP ${res.status} with ${challenge.scheme} login`);
      }
    }
    if (res.status === 401) {
      this.digest = null;
      this.useBasic = false;
      throw new AxisError('login_failed', 'Username or password not accepted');
    }
    if (res.status === 403) throw new AxisError('forbidden', 'This user may not do that');
    if (res.status === 404) throw new AxisError('not_supported', `${path.split('?')[0]} is not available on this camera`);
    if (res.status < 200 || res.status >= 300) throw new AxisError('bad_response', `HTTP ${res.status} from ${path.split('?')[0]}`);
    return res;
  }

  async getText(path) {
    return (await this.request('GET', path)).body.toString('utf8');
  }

  // JSON-style VAPIX APIs: { apiVersion, method, params } -> data, or AxisError.
  async jsonApi(path, method, params, apiVersion = '1.0') {
    const payload = { apiVersion, context: 'homey', method };
    if (params) payload.params = params;
    const res = await this.request('POST', path, { body: JSON.stringify(payload) });
    let json;
    try {
      json = JSON.parse(res.body.toString('utf8'));
    } catch (err) {
      throw new AxisError('bad_response', `Unreadable answer from ${path}`);
    }
    if (json.error) {
      const { code, message } = json.error;
      if (code === 2001 || code === 2105 || code === 2106) throw new AxisError('forbidden', message || 'Not allowed');
      if (code === 2002 || code === 2102 || code === 1001) throw new AxisError('not_supported', message || 'Not supported');
      throw new AxisError('bad_response', `${method}: ${message || code}`);
    }
    return json.data || {};
  }

  // ---- Device information --------------------------------------------------------

  // Basic device information: getAllProperties needs an operator; a viewer gets the
  // unrestricted subset (model, serial number, AXIS OS version), which is all we need.
  async deviceInfo() {
    try {
      return (await this.jsonApi('/axis-cgi/basicdeviceinfo.cgi', 'getAllProperties')).propertyList || {};
    } catch (err) {
      if (err.code !== 'forbidden' && err.code !== 'bad_response') throw err;
      return (await this.jsonApi('/axis-cgi/basicdeviceinfo.cgi', 'getAllUnrestrictedProperties')).propertyList || {};
    }
  }

  // API discovery: { 'light-control': '1.1', ... }. Empty on devices before AXIS OS 8.50.
  async apiList() {
    try {
      const data = await this.jsonApi('/axis-cgi/apidiscovery.cgi', 'getApiList');
      const out = {};
      for (const api of data.apiList || []) out[api.id] = api.version;
      return out;
    } catch (err) {
      if (err.code === 'not_supported' || err.code === 'bad_response') return {};
      throw err;
    }
  }

  // Installed camera apps (ACAP): [{ name, niceName, version, status, license }].
  async applications() {
    const text = await this.getText('/axis-cgi/applications/list.cgi');
    return [...text.matchAll(/<application\b([^>]*?)\/?>/g)].map((m) => {
      const attrs = {};
      for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
      return {
        name: attrs.Name || '', niceName: attrs.NiceName || attrs.Name || '', version: attrs.Version || '', status: attrs.Status || '', license: attrs.License || '',
      };
    });
  }

  // Parameter management: param.cgi?action=list&group=... -> { 'Properties.PTZ.PTZ': 'yes', ... }
  async params(group) {
    const text = await this.getText(`/axis-cgi/param.cgi?action=list&group=${encodeURIComponent(group)}`);
    if (/^#\s*Error/m.test(text) || /^Error/m.test(text)) return {};
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0) out[line.slice(0, i).replace(/^root\./, '')] = line.slice(i + 1);
    }
    return out;
  }

  // What the camera can do, in one object. Missing parts are simply false.
  async capabilities() {
    const [apis, props] = await Promise.all([
      this.apiList().catch(() => ({})),
      this.params('Properties').catch(() => ({})),
    ]);
    const io = await this.params('Input,Output').catch(() => ({}));
    const yes = (k) => String(props[k] || '').toLowerCase() === 'yes';
    const list = (k) => String(props[k] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return {
      ptz: yes('Properties.PTZ.PTZ'),
      light: Boolean(apis['light-control']) || yes('Properties.LightControl.LightControl2'),
      virtualInputs: yes('Properties.VirtualInput.VirtualInput'),
      inputs: Number(io['Input.NbrOfInputs']) || 0,
      outputs: Number(io['Output.NbrOfOutputs']) || 0,
      resolutions: list('Properties.Image.Resolution'),
      formats: list('Properties.Image.Format'),
      h264: list('Properties.Image.Format').includes('h264'),
      eventStream: Boolean(apis['event-streaming-over-websocket']) || Boolean(apis['ws-data-stream']),
      audio: yes('Properties.Audio.Audio'),
      privacyMask: Boolean(apis['privacy-mask']) || yes('Properties.PrivacyMask.PrivacyMask'),
      mediaClips: Boolean(apis.mediaclip),
      clipVolume: /volume/.test(String(props['Properties.MediaClip.PlayOptions'] || '')),
      siren: Boolean(apis['siren-and-light']),
      dynamicOverlay: Boolean(apis.dynamicoverlay),
      temperature: Boolean(apis.temperaturecontrol) || yes('Properties.TemperatureSensor.TemperatureControl'),
      firmware: Boolean(apis.fwmgr),
      disks: Boolean(apis['disk-management'] || apis['disk-properties']),
      metadataConfig: Boolean(apis['analytics-metadata-config']),
    };
  }

  // ---- Pictures ------------------------------------------------------------------

  // Video streaming: /axis-cgi/jpg/image.cgi. resolution like '1280x720' (optional).
  async snapshot({ resolution, compression = 30, camera = 1 } = {}) {
    const q = new URLSearchParams({ camera: String(camera), compression: String(compression) });
    if (resolution) q.set('resolution', resolution);
    const res = await this.request('GET', `/axis-cgi/jpg/image.cgi?${q}`, { timeoutMs: 15000 });
    const type = String(res.headers['content-type'] || '');
    if (!type.startsWith('image/jpeg')) throw new AxisError('bad_response', 'The camera did not send a picture');
    return res.body;
  }

  // ---- Events --------------------------------------------------------------------

  // Event and action services, GetEventInstances: every event the device can send.
  // Returns [{ topic, name, stateful, source: [names], data: [names], values }].
  async eventInstances() {
    const envelope = '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope">'
      + '<SOAP-ENV:Body><m:GetEventInstances xmlns:m="http://www.axis.com/vapix/ws/event1"/>'
      + '</SOAP-ENV:Body></SOAP-ENV:Envelope>';
    const res = await this.request('POST', '/vapix/services', {
      body: envelope,
      contentType: 'application/soap+xml; action=http://www.axis.com/vapix/ws/event1/GetEventInstances; Charset=UTF-8',
      timeoutMs: 20000,
    });
    return parseEventInstances(res.body.toString('utf8'));
  }

  // Event streaming over WebSocket: a token for wss://.../vapix/ws-data-stream, valid 15 s.
  async wsSessionToken() {
    const text = (await this.getText('/axis-cgi/wssession.cgi')).trim();
    try {
      const json = JSON.parse(text);
      const token = (json.data && (json.data.wssession || json.data.token || json.data.session)) || json.wssession;
      if (token) return String(token);
    } catch (err) { /* plain text token */ }
    if (!text || /\s/.test(text)) throw new AxisError('bad_response', 'No event session token');
    return text;
  }

  // ---- PTZ (Pan/tilt/zoom API) -------------------------------------------------

  async ptzPresets(camera = 1) {
    const text = await this.getText(`/axis-cgi/com/ptz.cgi?query=presetposcam&camera=${camera}`);
    if (/^Error/m.test(text)) throw new AxisError('not_supported', text.trim());
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^presetposno(\d+)=(.*)$/.exec(line.trim());
      if (m) out.push({ number: Number(m[1]), name: m[2] });
    }
    return out;
  }

  async _ptz(query) {
    const res = await this.request('GET', `/axis-cgi/com/ptz.cgi?${query}`);
    const text = res.body.toString('utf8');
    if (/^Error/m.test(text)) throw new AxisError(/privilege|not allowed/i.test(text) ? 'forbidden' : 'bad_response', text.trim());
  }

  ptzGotoPreset(name, camera = 1) {
    return this._ptz(new URLSearchParams({ gotoserverpresetname: name, camera: String(camera) }).toString());
  }

  ptzHome(camera = 1) {
    return this._ptz(`move=home&camera=${camera}`);
  }

  // ---- Light control -------------------------------------------------------------

  async lights() {
    const data = await this.jsonApi('/axis-cgi/lightcontrol.cgi', 'getLightInformation', {});
    return data.items || [];
  }

  // on: true = light on now, false = off. Needs an operator account.
  async setLight(lightID, on) {
    await this.jsonApi('/axis-cgi/lightcontrol.cgi', on ? 'activateLight' : 'deactivateLight', { lightID });
  }

  // Automatic: the light follows day/night mode again.
  async setLightAutomatic(lightID, enabled) {
    await this.jsonApi('/axis-cgi/lightcontrol.cgi', 'setLightSynchronizeDayNightMode', { lightID, enabled });
  }

  // ---- Inputs and outputs ----------------------------------------------------------

  // Virtual inputs start the camera's own action rules. durationS: back to inactive after.
  async virtualInput(port, active, durationS) {
    const q = new URLSearchParams({ schemaversion: '1', port: String(port) });
    if (active && durationS) q.set('duration', String(durationS));
    const text = await this.getText(`/axis-cgi/virtualinput/${active ? 'activate' : 'deactivate'}.cgi?${q}`);
    if (/<GeneralError>|<Error/i.test(text)) throw new AxisError('bad_response', 'The camera refused the virtual input');
  }

  // Digital output: active, inactive, or a pulse of pulseMs (port numbers start at 1).
  async setOutput(port, { active, pulseMs }) {
    let action;
    if (pulseMs) action = `${port}:/${Math.round(pulseMs)}\\`;
    else action = `${port}:${active ? '/' : '\\'}`;
    const text = await this.getText(`/axis-cgi/io/port.cgi?action=${encodeURIComponent(action)}`);
    if (/error/i.test(text)) throw new AxisError('bad_response', text.trim());
  }

  // ---- Privacy mask (Overlay API, privacymask.cgi; administrator) -------------------

  // The whole picture covered by one mask the app owns ("privacy mode").
  async privacyMode() {
    if (this.privacyByParams) return Boolean(await this._paramMask(true));
    let text;
    try {
      text = await this.getText('/axis-cgi/privacymask.cgi?query=listpxjson');
    } catch (err) {
      if (err.code !== 'not_supported') throw err;
      // Cameras without privacymask.cgi (most fixed cameras on older AXIS OS): parameters.
      this.privacyByParams = true;
      return Boolean(await this._paramMask(true));
    }
    let list = [];
    try {
      list = JSON.parse(text).listpx || [];
    } catch (err) {
      throw new AxisError('bad_response', text.trim().slice(0, 120));
    }
    const mask = list.find((m) => m.name === PRIVACY_MASK);
    return Boolean(mask && mask.enabled !== false);
  }

  // The app's mask in Image.I0.Overlay.MaskWindows: its group name ('M0') or null.
  // enabledOnly: only when it is switched on.
  async _paramMask(enabledOnly) {
    const p = await this.params('Image.I0.Overlay.MaskWindows');
    for (const [k, v] of Object.entries(p)) {
      const m = /^Image\.I0\.Overlay\.MaskWindows\.(M\d+)\.Name$/.exec(k);
      if (m && v === PRIVACY_MASK) {
        if (enabledOnly && p[`Image.I0.Overlay.MaskWindows.${m[1]}.Enabled`] !== 'yes') return null;
        return m[1];
      }
    }
    return null;
  }

  // size: the camera's largest resolution ('1920x1080'); the mask is in its pixels.
  async _setParamMask(on, size) {
    const group = await this._paramMask(false);
    const base = 'Image.I0.Overlay.MaskWindows';
    if (!on) {
      if (group) await this._paramCall({ action: 'remove', group: `${base}.${group}` });
      return;
    }
    const [w, h] = String(size || '1920x1080').split('x').map(Number);
    const values = {
      Enabled: 'yes', XPos: '0', YPos: '0', Width: String(w), Height: String(h), Name: PRIVACY_MASK,
    };
    if (group) {
      await this.setParams(Object.fromEntries(Object.entries(values).map(([k, v]) => [`${base}.${group}.${k}`, v])));
      return;
    }
    await this._paramCall({
      action: 'add', template: '0_maskwindows', group: base, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [`${base}.M.${k}`, v])),
    });
  }

  async _paramCall(query) {
    const text = await this.getText(`/axis-cgi/param.cgi?${new URLSearchParams(query)}`);
    if (!/OK/.test(text) || /Error/i.test(text)) {
      throw new AxisError(/privilege|not authorized|permission/i.test(text) ? 'forbidden' : 'bad_response', text.trim().slice(0, 160));
    }
  }

  async setPrivacyMode(on, size) {
    if (this.privacyByParams) {
      await this._setParamMask(on, size);
      return;
    }
    const run = async (q) => {
      const text = await this.getText(`/axis-cgi/privacymask.cgi?${new URLSearchParams(q)}`);
      if (/^Error/im.test(text)) throw new AxisError(/privilege|permission|not allowed/i.test(text) ? 'forbidden' : 'bad_response', text.trim());
    };
    let exists = false;
    try {
      exists = (JSON.parse(await this.getText('/axis-cgi/privacymask.cgi?query=listpxjson')).listpx || []).some((m) => m.name === PRIVACY_MASK);
    } catch (err) {
      if (err.code === 'not_supported') {
        this.privacyByParams = true;
        await this._setParamMask(on, size);
        return;
      }
    }
    if (!on) {
      if (exists) await run({ action: 'remove', name: PRIVACY_MASK });
      return;
    }
    const mask = {
      name: PRIVACY_MASK, width: '100.0', height: '100.0', center: '50.0,50.0',
    };
    await run({ action: exists ? 'update' : 'add', ...mask });
  }

  // ---- Media clips (Media clip API) ------------------------------------------------

  // [{ id, name }] from the MediaClip parameter group.
  async mediaClips() {
    const params = await this.params('MediaClip');
    const out = [];
    for (const [k, v] of Object.entries(params)) {
      const m = /^MediaClip\.M(\d+)\.Name$/.exec(k);
      if (m) out.push({ id: Number(m[1]), name: v });
    }
    return out.sort((a, b) => a.id - b.id);
  }

  // volume 0..100 (only sent when the camera supports it: Properties PlayOptions).
  async playClip(id, { volume, repeat } = {}) {
    const q = new URLSearchParams({ action: 'play', clip: String(id) });
    if (Number.isFinite(volume)) q.set('volume', String(Math.max(0, Math.min(100, Math.round(volume)))));
    if (Number.isFinite(repeat) && repeat > 0) q.set('repeat', String(repeat));
    try {
      const text = await this.getText(`/axis-cgi/mediaclip.cgi?${q}`);
      if (/^Error/im.test(text)) throw new AxisError('bad_response', text.trim());
    } catch (err) {
      // Viewers may only use playclip.cgi.
      if (err.code !== 'forbidden') throw err;
      await this.getText(`/axis-cgi/playclip.cgi?clip=${id}`);
    }
  }

  async stopClip() {
    await this.getText('/axis-cgi/mediaclip.cgi?action=stop').catch(() => this.getText('/axis-cgi/stopclip.cgi'));
  }

  // ---- Siren and light (siren_and_light.cgi) ------------------------------------------

  async sirenProfiles() {
    const data = await this.jsonApi('/axis-cgi/siren_and_light.cgi', 'getProfiles');
    return (data.profiles || []).map((p) => ({ name: p.name, description: p.description || '' }));
  }

  async startSiren(profile) {
    await this.jsonApi('/axis-cgi/siren_and_light.cgi', 'start', { profile });
  }

  async stopSiren() {
    await this.jsonApi('/axis-cgi/siren_and_light.cgi', 'stop', { all: ['siren', 'light'] });
  }

  // ---- Restart (Firmware management API; administrator) -------------------------------

  async restart() {
    try {
      await this.jsonApi('/axis-cgi/firmwaremanagement.cgi', 'reboot');
    } catch (err) {
      if (err.code === 'forbidden' || err.code === 'login_failed') throw err;
      await this.getText('/axis-cgi/restart.cgi'); // older AXIS OS
    }
  }

  // ---- Text on the picture (Dynamic overlay API, or the Image.I0.Text parameters) -----

  // Returns the overlay id to change or remove it later (null for the parameter way).
  async showText(text, { position = 'topLeft', id = null, dynamic = true } = {}) {
    if (dynamic) {
      const params = {
        camera: 1, text, position, textColor: 'white', textBGColor: 'semiTransparent',
      };
      if (id !== null && id !== undefined) {
        try {
          await this.jsonApi('/axis-cgi/dynamicoverlay/dynamicoverlay.cgi', 'setText', { identity: id, text, position });
          return id;
        } catch (err) {
          if (err.code === 'forbidden') throw err; // else: gone (camera restarted?), add again
        }
      }
      const data = await this.jsonApi('/axis-cgi/dynamicoverlay/dynamicoverlay.cgi', 'addText', params);
      return data.identity;
    }
    await this.setParams({ 'Image.I0.Text.TextEnabled': 'yes', 'Image.I0.Text.String': text });
    return null;
  }

  async removeText({ id = null, dynamic = true } = {}) {
    if (dynamic && id !== null && id !== undefined) {
      await this.jsonApi('/axis-cgi/dynamicoverlay/dynamicoverlay.cgi', 'remove', { identity: id }).catch(() => {});
      return;
    }
    if (!dynamic) await this.setParams({ 'Image.I0.Text.TextEnabled': 'no' });
  }

  // param.cgi?action=update&<name>=<value>...
  async setParams(values) {
    const q = new URLSearchParams({ action: 'update', ...values });
    const text = await this.getText(`/axis-cgi/param.cgi?${q}`);
    if (!/^OK/m.test(text)) throw new AxisError(/privilege|not authorized|permission/i.test(text) ? 'forbidden' : 'bad_response', text.trim().slice(0, 160));
  }

  // ---- Temperature (Temperature control API) -------------------------------------------

  // { sensors: [{ name, celsius }], heaters: [{ id, running }], fans: [{ id, running }] }
  async temperatures() {
    const text = await this.getText('/axis-cgi/temperaturecontrol.cgi?action=statusall');
    const out = { sensors: [], heaters: [], fans: [] };
    const sensors = {};
    for (const line of text.split(/\r?\n/)) {
      let m = /^Sensor\.S(\d+)\.(Name|Celsius)=(.*)$/.exec(line.trim());
      if (m) {
        const s = sensors[m[1]] || (sensors[m[1]] = { id: Number(m[1]) });
        if (m[2] === 'Name') s.name = m[3];
        else s.celsius = Number(m[3]);
        continue;
      }
      m = /^(Heater|Fan)\.[HF](\d+)\.Status=(.*)$/.exec(line.trim());
      if (m) out[m[1] === 'Heater' ? 'heaters' : 'fans'].push({ id: Number(m[2]), running: /running|started/i.test(m[3]) });
    }
    out.sensors = Object.values(sensors).filter((x) => Number.isFinite(x.celsius)).sort((a, b) => a.id - b.id);
    return out;
  }

  // ---- Storage (Edge storage API: disks/list.cgi) --------------------------------------

  // [{ id, name, status, totalKB, freeKB, full, readonly }] for mounted disks.
  async disks() {
    const text = await this.getText('/axis-cgi/disks/list.cgi?diskid=all');
    return [...text.matchAll(/<disk\b([^>]*?)\/?>/g)].map((m) => {
      const a = {};
      for (const x of m[1].matchAll(/(\w+)="([^"]*)"/g)) a[x[1]] = x[2];
      return {
        id: a.diskid, name: a.name || a.diskid, status: a.status || '', totalKB: Number(a.totalsize) || 0, freeKB: Number(a.freesize) || 0, full: a.full === 'yes', readonly: a.readonly === 'yes',
      };
    });
  }

  // ---- AXIS Object Analytics (/local/objectanalytics/control.cgi) ----------------------

  aoa(method, params) {
    return this.jsonApi('/local/objectanalytics/control.cgi', method, params, '1.2');
  }

  // ---- Analytics metadata producers (analyticsmetadataconfig.cgi) ----------------------

  async metadataProducers() {
    const data = await this.jsonApi('/axis-cgi/analyticsmetadataconfig.cgi', 'listProducers', {});
    return data.producers || [];
  }

  async enableMetadataProducer(name, channel = 1) {
    await this.jsonApi('/axis-cgi/analyticsmetadataconfig.cgi', 'setEnabledProducers', {
      producers: [{ name, videochannels: [{ channel, enabled: true }] }],
    });
  }

  // { 1: true, 2: false }: true = circuit closed.
  async inputStates(ports) {
    if (!ports.length) return {};
    const text = await this.getText(`/axis-cgi/io/port.cgi?check=${ports.join(',')}`);
    const out = {};
    for (const m of text.matchAll(/port(\d+)=(\d)/g)) out[Number(m[1])] = m[2] === '1';
    return out;
  }
}

// Unauthenticated identity of whatever answers at host (used while searching).
// Tries HTTPS first, then HTTP. Resolves { secure, info } or null.
async function probe(host, timeoutMs = 3000) {
  const body = JSON.stringify({ apiVersion: '1.0', method: 'getAllUnrestrictedProperties' });
  for (const secure of [true, false]) {
    try {
      const res = await rawRequest({
        secure,
        host,
        port: secure ? 443 : 80,
        method: 'POST',
        path: '/axis-cgi/basicdeviceinfo.cgi',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        body,
        agent: secure ? anonymousTlsAgent : undefined,
        timeoutMs,
      });
      if (res.status === 200) {
        const json = JSON.parse(res.body.toString('utf8'));
        const info = json.data && json.data.propertyList;
        if (info && info.SerialNumber) return { secure, info, needsLogin: false };
      }
      // Older AXIS OS asks for a login even here; still an Axis device if it says so.
      // Their login realm is "AXIS_<serial number>".
      const realm = /realm="?AXIS_([0-9A-F]{12})/i.exec(String(res.headers['www-authenticate'] || ''));
      if (res.status === 401 && realm) {
        return { secure, info: { SerialNumber: realm[1].toUpperCase() }, needsLogin: true };
      }
      if (res.status === 302 || res.status === 301) continue; // HTTP redirecting to HTTPS
    } catch (err) {
      // try the next protocol
    }
  }
  return null;
}

// GetEventInstances response -> flat list of leaf topics.
function parseEventInstances(xml) {
  const root = parseXml(xml);
  const topicSet = findAll(root, (n) => n.local === 'TopicSet')[0];
  if (!topicSet) return [];
  const out = [];
  const walk = (node, path) => {
    for (const child of node.children) {
      if (!child.name) continue;
      if (child.local === 'MessageInstance') continue;
      const p = path.concat(child.name);
      const isTopic = Object.entries(child.attrs).some(([k, v]) => k.endsWith(':topic') && v === 'true');
      if (isTopic) {
        const msg = child.children.find((c) => c.local === 'MessageInstance');
        const items = (kind) => (msg ? findAll(msg, (n) => n.local === kind)
          .flatMap((s) => findAll(s, (n) => n.local === 'SimpleItemInstance')) : []);
        const data = items('DataInstance');
        const values = {};
        for (const d of data) {
          values[d.attrs.Name] = findAll(d, (n) => n.local === 'Value').map((v) => v.text);
        }
        out.push({
          topic: p.join('/'),
          name: Object.entries(child.attrs).find(([k]) => k.endsWith(':NiceName'))?.[1]
            || (msg && Object.entries(msg.attrs).find(([k]) => k.endsWith(':NiceName'))?.[1]) || null,
          stateful: Boolean(msg && Object.entries(msg.attrs).some(([k, v]) => k.endsWith(':isProperty') && v === 'true')),
          source: items('SourceInstance').map((s) => s.attrs.Name),
          data: data.map((d) => d.attrs.Name),
          values,
        });
      }
      walk(child, p);
    }
  };
  walk(topicSet, []);
  return out;
}

module.exports = {
  VapixClient, probe, parseEventInstances, rawRequest, usableAddress,
};

'use strict';

// A fake Axis camera for tests, written from the VAPIX documentation:
//   HTTP  basicdeviceinfo, apidiscovery, param.cgi, jpg/image.cgi, ptz.cgi,
//         lightcontrol.cgi, virtualinput, io/port.cgi, /vapix/services (GetEventInstances),
//         wssession.cgi, and the WebSocket event stream /vapix/ws-data-stream
//   RTSP  DESCRIBE/SETUP/PLAY/GET_PARAMETER/SET_PARAMETER/TEARDOWN with RTP over TCP
// Everything except the anonymous calls needs Digest login (MD5, qop=auth).

const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const REALM = 'AXIS_ACCC8E000001';
const SERIAL = 'ACCC8E000001';
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// Parameter sets of a 640x360 Baseline stream (any valid-looking bytes do for the tests).
const SPS = Buffer.from('6742c01e95a02805bb011000003e90000ea60e8c008aa', 'hex');
const PPS = Buffer.from('68ce3c80', 'hex');

const EVENT_INSTANCES = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wstop="http://docs.oasis-open.org/wsn/t-1" xmlns:aev="http://www.axis.com/vapix/ws/event1" xmlns:tns1="http://www.onvif.org/ver10/topics" xmlns:tnsaxis="http://www.axis.com/2009/event/topics">
<SOAP-ENV:Body><aev:GetEventInstancesResponse><wstop:TopicSet>
<tns1:VideoSource>
  <MotionAlarm wstop:topic="true"><aev:MessageInstance aev:isProperty="true">
    <aev:SourceInstance><aev:SimpleItemInstance Type="tt:ReferenceToken" Name="Source"><aev:Value>0</aev:Value></aev:SimpleItemInstance></aev:SourceInstance>
    <aev:DataInstance><aev:SimpleItemInstance Type="xsd:boolean" Name="State" isPropertyState="true"/></aev:DataInstance>
  </aev:MessageInstance></MotionAlarm>
  <tnsaxis:Tampering wstop:topic="true" aev:NiceName="Camera tampering"><aev:MessageInstance>
    <aev:DataInstance><aev:SimpleItemInstance Type="xsd:int" Name="tampering"/></aev:DataInstance>
  </aev:MessageInstance></tnsaxis:Tampering>
  <tnsaxis:DayNightVision wstop:topic="true" aev:NiceName="Day night vision"><aev:MessageInstance aev:isProperty="true">
    <aev:DataInstance><aev:SimpleItemInstance Type="xsd:boolean" Name="day" isPropertyState="true"/></aev:DataInstance>
  </aev:MessageInstance></tnsaxis:DayNightVision>
</tns1:VideoSource>
<tnsaxis:CameraApplicationPlatform>
  <ObjectAnalytics aev:NiceName="Object Analytics">
    <Device1Scenario1 wstop:topic="true" aev:NiceName="Driveway"><aev:MessageInstance aev:isProperty="true">
      <aev:DataInstance><aev:SimpleItemInstance Type="xsd:boolean" Name="active" isPropertyState="true"/></aev:DataInstance>
    </aev:MessageInstance></Device1Scenario1>
    <Device1ScenarioANY wstop:topic="true" aev:NiceName="Any scenario"><aev:MessageInstance aev:isProperty="true">
      <aev:DataInstance><aev:SimpleItemInstance Type="xsd:boolean" Name="active" isPropertyState="true"/></aev:DataInstance>
    </aev:MessageInstance></Device1ScenarioANY>
  </ObjectAnalytics>
</tnsaxis:CameraApplicationPlatform>
<tns1:Device>
  <tnsaxis:IO>
    <Port wstop:topic="true" aev:NiceName="Digital input port"><aev:MessageInstance aev:isProperty="true">
      <aev:SourceInstance><aev:SimpleItemInstance Type="xsd:int" Name="port"><aev:Value>1</aev:Value></aev:SimpleItemInstance></aev:SourceInstance>
      <aev:DataInstance><aev:SimpleItemInstance Type="xsd:boolean" Name="state" isPropertyState="true"/></aev:DataInstance>
    </aev:MessageInstance></Port>
  </tnsaxis:IO>
  <tnsaxis:Status><SystemReady wstop:topic="true"><aev:MessageInstance aev:isProperty="true">
    <aev:DataInstance><aev:SimpleItemInstance Type="xsd:boolean" Name="ready" isPropertyState="true"/></aev:DataInstance>
  </aev:MessageInstance></SystemReady></tnsaxis:Status>
</tns1:Device>
</wstop:TopicSet></aev:GetEventInstancesResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

function parseAuth(header) {
  const m = /^Digest\s+(.*)$/i.exec(header || '');
  if (!m) return null;
  const out = {};
  for (const p of m[1].matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) out[p[1]] = p[2] !== undefined ? p[2] : p[3];
  return out;
}

class FakeCamera {
  constructor({
    username = 'homey', password = 'secret', rtspFps = 25, packetsPerFrame = 1,
  } = {}) {
    this.packetsPerFrame = packetsPerFrame; // > 1: P frames as FU-A of 1200-byte packets (load tests)
    this.username = username;
    this.password = password;
    this.rtspFps = rtspFps;
    this.nonce = crypto.randomBytes(8).toString('hex');
    this.calls = [];
    this.wsTokens = new Set();
    this.wsClients = new Set();
    this.lastConfigure = null;
    this.keyframeRequests = 0;
    this.rtspSessions = new Set();
  }

  _authorized(method, uri, header) {
    const a = parseAuth(header);
    if (!a || a.username !== this.username || a.nonce !== this.nonce) return false;
    const ha1 = md5(`${a.username}:${REALM}:${this.password}`);
    const ha2 = md5(`${method}:${a.uri}`);
    const expected = a.qop
      ? md5(`${ha1}:${a.nonce}:${a.nc}:${a.cnonce}:${a.qop}:${ha2}`)
      : md5(`${ha1}:${a.nonce}:${ha2}`);
    return a.response === expected && a.uri === uri;
  }

  _challenge() {
    return `Digest realm="${REALM}", nonce="${this.nonce}", algorithm=MD5, qop="auth"`;
  }

  async start() {
    this.http = http.createServer((req, res) => this._onHttp(req, res));
    this.wss = new WebSocket.Server({ noServer: true });
    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://x');
      const token = url.searchParams.get('wssession');
      if (url.pathname !== '/vapix/ws-data-stream' || !this.wsTokens.has(token)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      this.wsTokens.delete(token);
      this.wss.handleUpgrade(req, socket, head, (ws) => this._onWs(ws));
    });
    await new Promise((r) => this.http.listen(0, '127.0.0.1', r));
    this.httpPort = this.http.address().port;
    this.rtsp = net.createServer((s) => this._onRtsp(s));
    await new Promise((r) => this.rtsp.listen(0, '127.0.0.1', r));
    this.rtspPort = this.rtsp.address().port;
    return this;
  }

  async stop() {
    for (const ws of this.wsClients) ws.terminate();
    for (const s of this.rtspSessions) s.destroy();
    this.http.closeAllConnections();
    await new Promise((r) => this.wss.close(r));
    await new Promise((r) => this.http.close(r));
    await new Promise((r) => this.rtsp.close(r));
  }

  // ---- HTTP ----

  _onHttp(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://x');
      this.calls.push(`${req.method} ${url.pathname}${url.search}`);
      const json = () => { try { return JSON.parse(body); } catch (e) { return {}; } };
      // Anonymous calls.
      if (url.pathname === '/axis-cgi/basicdeviceinfo.cgi' && json().method === 'getAllUnrestrictedProperties') {
        return this._json(res, { propertyList: { ProdNbr: 'M1065-L', ProdFullName: 'AXIS M1065-L Network Camera', ProdType: 'Network Camera', SerialNumber: SERIAL, Version: '11.11.1' } });
      }
      if (!this._authorized(req.method, req.url, req.headers.authorization)) {
        res.writeHead(401, { 'WWW-Authenticate': this._challenge() });
        return res.end();
      }
      switch (url.pathname) {
        case '/axis-cgi/basicdeviceinfo.cgi':
          return this._json(res, { propertyList: { ProdNbr: 'M1065-L', ProdFullName: 'AXIS M1065-L Network Camera', ProdType: 'Network Camera', SerialNumber: SERIAL, Version: '11.11.1', Architecture: 'armv7hf' } });
        case '/axis-cgi/apidiscovery.cgi':
          return this._json(res, { apiList: [{ id: 'light-control', version: '1.1' }, { id: 'basic-device-info', version: '1.2' }] });
        case '/axis-cgi/param.cgi': {
          const group = url.searchParams.get('group');
          // Privacy masks as parameters (cameras without privacymask.cgi).
          this.maskParams = this.maskParams || {};
          const action = url.searchParams.get('action');
          if (action === 'add' && group === 'Image.I0.Overlay.MaskWindows') {
            const n = Object.keys(this.maskParams).filter((k) => k.endsWith('.Name')).length;
            for (const [k, v] of url.searchParams) {
              if (k.startsWith('Image.I0.Overlay.MaskWindows.M.')) this.maskParams[k.replace('.M.', `.M${n}.`)] = v;
            }
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end(`M${n} OK`);
          }
          if (action === 'remove') {
            for (const k of Object.keys(this.maskParams)) if (k.startsWith(`${group}.`)) delete this.maskParams[k];
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end('OK');
          }
          if (group === 'Image.I0.Text') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end('root.Image.I0.Text.TextEnabled=yes\nroot.Image.I0.Text.String=Garage\n');
          }
          if (group === 'Image.I0.Overlay.MaskWindows') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end(Object.entries(this.maskParams).map(([k, v]) => `root.${k}=${v}\n`).join(''));
          }
          if (url.searchParams.get('action') === 'update') {
            this.lastParamUpdate = Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'action'));
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end('OK');
          }
          if (group === 'MediaClip') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end('root.MediaClip.M0.Name=Warning\nroot.MediaClip.M0.Location=/etc/audioclips/MediaClip.M0.au\nroot.MediaClip.M0.Type=audio\n'
              + 'root.MediaClip.M1.Name=Dog barking\nroot.MediaClip.M1.Location=/etc/audioclips/MediaClip.M1.au\nroot.MediaClip.M1.Type=audio\n');
          }
          if (group === 'Properties') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end('root.Properties.PTZ.PTZ=yes\nroot.Properties.Image.Resolution=1920x1080,1280x720,800x450,640x360,320x180\n'
              + 'root.Properties.Image.Format=jpeg,mjpeg,h264\nroot.Properties.VirtualInput.VirtualInput=yes\nroot.Properties.LightControl.LightControl2=yes\n');
          }
          if (group === 'Input,Output') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end('root.Input.NbrOfInputs=1\nroot.Output.NbrOfOutputs=1\n');
          }
          res.writeHead(200);
          return res.end('# Error: Error -1 getting param in group');
        }
        case '/axis-cgi/jpg/image.cgi':
          this.lastSnapshot = url.searchParams.get('resolution');
          res.writeHead(200, { 'Content-Type': 'image/jpeg' });
          return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0xff, 0xd9]));
        case '/vapix/services':
          res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
          return res.end(EVENT_INSTANCES);
        case '/axis-cgi/wssession.cgi': {
          const token = crypto.randomBytes(6).toString('hex');
          this.wsTokens.add(token);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ apiVersion: '1.0', method: 'wssession', data: { wssession: token } }));
        }
        case '/axis-cgi/com/ptz.cgi':
          if (url.searchParams.get('query') === 'presetposcam') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end('Preset Positions for camera 1\npresetposno1=Home\npresetposno2=Gate\n');
          }
          this.lastPtz = url.search;
          res.writeHead(204);
          return res.end();
        case '/axis-cgi/lightcontrol.cgi': {
          const { method, params } = json();
          this.lastLight = { method, params };
          if (method === 'getLightInformation') return this._json(res, { items: [{ lightID: 'led0', lightType: 'IR', enabled: true }] });
          return this._json(res, {});
        }
        case '/axis-cgi/virtualinput/activate.cgi':
        case '/axis-cgi/virtualinput/deactivate.cgi':
          this.lastVirtual = url.pathname + url.search;
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          return res.end('<?xml version="1.0"?><VirtualInputResponse SchemaVersion="1.1"><Success><ActivateSuccess><StateChanged>true</StateChanged></ActivateSuccess></Success></VirtualInputResponse>');
        case '/axis-cgi/io/port.cgi':
          this.lastPort = url.search;
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end(url.searchParams.get('check') ? 'port1=1\n' : 'OK');
        // Documented answers (VAPIX) for the newer features.
        case '/axis-cgi/privacymask.cgi': {
          if (this.noPrivacyCgi) {
            res.writeHead(404);
            return res.end();
          }
          this.masks = this.masks || [];
          const action = url.searchParams.get('action');
          const name = url.searchParams.get('name');
          res.writeHead(200, { 'Content-Type': url.searchParams.get('query') ? 'application/json' : 'text/plain' });
          if (url.searchParams.get('query') === 'listpxjson') {
            return res.end(JSON.stringify({ listpx: this.masks.map((m, id) => ({ id, name: m, enabled: true, position: [] })) }));
          }
          if (action === 'add') this.masks.push(name);
          if (action === 'remove') this.masks = this.masks.filter((m) => m !== name);
          this.lastMask = url.search;
          return res.end('OK');
        }
        case '/axis-cgi/mediaclip.cgi':
          this.lastClip = url.search;
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end('OK');
        case '/axis-cgi/siren_and_light.cgi': {
          const { method, params } = json();
          this.lastSiren = { method, params };
          if (method === 'getProfiles') return this._json(res, { profiles: [{ name: 'Profile 1', description: 'Intruder' }, { name: 'Profile 2' }] });
          return this._json(res, method === 'start' ? { sirenId: 1, lightId: 1 } : {});
        }
        case '/axis-cgi/firmwaremanagement.cgi':
          this.lastFirmware = json().method;
          return this._json(res, {});
        case '/axis-cgi/dynamicoverlay/dynamicoverlay.cgi': {
          const { method, params } = json();
          this.lastOverlay = { method, params };
          return this._json(res, method === 'addText' ? { camera: 1, identity: 7 } : {});
        }
        case '/axis-cgi/temperaturecontrol.cgi':
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end('Sensor.S0.Name=Main\nSensor.S0.Celsius=43.50\nSensor.S0.Fahrenheit=110.30\nSensor.S1.Name=CPU\nSensor.S1.Celsius=50.44\n'
            + 'Heater.H0.Status=Running\nHeater.H0.TimeUntilStop=0\nFan.F0.Status=Stopped\nFan.F0.TimeUntilStop=0\n');
        case '/axis-cgi/disks/list.cgi':
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          return res.end('<?xml version="1.0" ?><root><disks numberofdisks="1"><disk diskid="SD_DISK" name="" totalsize="31154688" freesize="7788672" '
            + 'cleanuplevel="95" cleanupmaxage="7" cleanuppolicy="fifo" locked="no" full="no" readonly="no" status="OK" filesystem="ext4" group="S0" requiredfilesystem="none"/></disks></root>');
        case '/local/objectanalytics/control.cgi': {
          const { method, params } = json();
          this.lastAoa = { method, params };
          if (method === 'getAccumulatedCounts') return this._json(res, { resetTime: '2026-10-14T00:00:00Z', timeStamp: '2026-10-14T12:00:00Z', total: 7, human: 5, car: 2 });
          if (method === 'getOccupancy') return this._json(res, { timeStamp: '2026-10-14T12:00:00Z', total: 3, human: 1, car: 2 });
          return this._json(res, {});
        }
        case '/axis-cgi/analyticsmetadataconfig.cgi': {
          const { method, params } = json();
          this.lastProducers = { method, params };
          if (method === 'listProducers') {
            return this._json(res, { producers: [{ name: 'AnalyticsSceneDescription', niceName: 'Analytics Scene Description', videochannels: [{ channel: 1, enabled: false }] }] });
          }
          return this._json(res, {});
        }
        default:
          res.writeHead(404);
          return res.end();
      }
    });
  }

  _json(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ apiVersion: '1.0', context: 'homey', data }));
  }

  // ---- WebSocket events ----

  _onWs(ws) {
    this.wsClients.add(ws);
    ws.on('close', () => this.wsClients.delete(ws));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'events:configure') {
        this.lastConfigure = msg.params;
        ws.send(JSON.stringify({ apiVersion: '1.0', context: msg.context, method: 'events:configure', data: {} }));
      }
    });
  }

  // Sends an event to every connected event stream.
  emitEvent(topic, { source = {}, data = {} } = {}) {
    const msg = JSON.stringify({
      apiVersion: '1.0',
      method: 'events:notify',
      params: { notification: { timestamp: Date.now(), topic, message: { source, key: {}, data } } },
    });
    for (const ws of this.wsClients) ws.send(msg);
  }

  // ---- RTSP ----

  // An ONVIF metadata document over every RTSP event stream, split over two RTP packets.
  emitMetadata(topic, source, data, operation = 'Changed') {
    const items = (o) => Object.entries(o).map(([k, v]) => `<tt:SimpleItem Name="${k}" Value="${v}"/>`).join('');
    const xml = '<?xml version="1.0" encoding="UTF-8"?><tt:MetadataStream xmlns:tt="http://www.onvif.org/ver10/schema">'
      + '<tt:Event><wsnt:NotificationMessage xmlns:tns1="http://www.onvif.org/ver10/topics" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2">'
      + `<wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">${topic}</wsnt:Topic>`
      + `<wsnt:Message><tt:Message UtcTime="${new Date().toISOString()}" PropertyOperation="${operation}">`
      + `<tt:Source>${items(source)}</tt:Source><tt:Key></tt:Key><tt:Data>${items(data)}</tt:Data>`
      + '</tt:Message></wsnt:Message></wsnt:NotificationMessage></tt:Event></tt:MetadataStream>';
    const buf = Buffer.from(xml);
    const half = Math.floor(buf.length / 2);
    for (const socket of this.metadataSockets || []) {
      [buf.subarray(0, half), buf.subarray(half)].forEach((part, i) => {
        const h = Buffer.alloc(12);
        h[0] = 0x80;
        h[1] = (i === 1 ? 0x80 : 0) | 98;
        h.writeUInt16BE(i, 2);
        const pkt = Buffer.concat([h, part]);
        const head = Buffer.from([0x24, 0, 0, 0]);
        head.writeUInt16BE(pkt.length, 2);
        socket.write(Buffer.concat([head, pkt]));
      });
    }
  }

  _onRtsp(socket) {
    this.rtspSessions.add(socket);
    socket.on('close', () => this.rtspSessions.delete(socket));
    socket.on('error', () => {});
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      for (;;) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.slice(0, end);
        const lines = head.split('\r\n');
        const headers = {};
        for (const l of lines.slice(1)) {
          const i = l.indexOf(':');
          headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
        }
        const len = Number(headers['content-length'] || 0);
        if (buf.length < end + 4 + len) return;
        const body = buf.slice(end + 4, end + 4 + len);
        buf = buf.slice(end + 4 + len);
        this._rtspRequest(socket, lines[0], headers, body);
      }
    });
  }

  _rtspRequest(socket, line, headers, body) {
    const [method, uri] = line.split(' ');
    const cseq = headers.cseq;
    const reply = (status, extra = {}, content = '') => {
      const out = [`RTSP/1.0 ${status}`, `CSeq: ${cseq}`];
      for (const [k, v] of Object.entries(extra)) out.push(`${k}: ${v}`);
      if (content) out.push(`Content-Length: ${Buffer.byteLength(content)}`);
      socket.write(`${out.join('\r\n')}\r\n\r\n${content}`);
    };
    if (!this._authorized(method, uri, headers.authorization)) {
      reply('401 Unauthorized', { 'WWW-Authenticate': this._challenge() });
      return;
    }
    const base = uri.split('?')[0];
    if (method === 'DESCRIBE' && /event=on/.test(uri)) {
      this.lastEventDescribe = uri;
      socket.metadata = true;
      const sdp = ['v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=Metadata', 't=0 0', 'a=control:*',
        'm=application 0 RTP/AVP 98', 'a=rtpmap:98 vnd.onvif.metadata/90000', 'a=control:stream=0'].join('\r\n');
      reply('200 OK', { 'Content-Base': `${uri}/`, 'Content-Type': 'application/sdp' }, `${sdp}\r\n`);
    } else if (method === 'DESCRIBE' && this.refuseBitrateCap && this.refuseBitrateCap.test(uri)) {
      reply('400 Bad Request');
    } else if (method === 'DESCRIBE') {
      this.lastDescribe = uri;
      const sdp = [
        'v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=Session streamed with GStreamer', 't=0 0', 'a=control:*',
        'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000',
        `a=fmtp:96 packetization-mode=1;profile-level-id=42c01e;sprop-parameter-sets=${SPS.toString('base64')},${PPS.toString('base64')}`,
        'a=control:stream=0',
      ].join('\r\n');
      reply('200 OK', { 'Content-Base': `${uri}/`, 'Content-Type': 'application/sdp' }, `${sdp}\r\n`);
    } else if (method === 'SETUP') {
      this.lastSetup = { uri, transport: headers.transport };
      reply('200 OK', { Session: '12345678;timeout=60', Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1' });
    } else if (method === 'PLAY') {
      reply('200 OK', { Session: '12345678' });
      if (socket.metadata) {
        this.metadataSockets = this.metadataSockets || new Set();
        this.metadataSockets.add(socket);
        socket.on('close', () => this.metadataSockets.delete(socket));
        this.emitMetadata('tns1:VideoSource/MotionAlarm', { Source: '0' }, { State: 'false' }, 'Initialized');
      } else {
        this._startRtp(socket);
      }
    } else if (method === 'SET_PARAMETER') {
      if (/Renew-Stream:\s*yes/i.test(body)) {
        this.keyframeRequests += 1;
        socket.forceKeyframe = true;
      }
      reply('200 OK', { Session: '12345678' });
    } else if (method === 'GET_PARAMETER' || method === 'OPTIONS') {
      reply('200 OK', { Session: '12345678' });
    } else if (method === 'TEARDOWN') {
      this.teardowns = (this.teardowns || 0) + 1;
      reply('200 OK');
      clearInterval(socket.rtpTimer);
    } else {
      reply('405 Method Not Allowed');
    }
    void base;
  }

  // H.264 over RTP: a keyframe (IDR, FU-A in 3 fragments, NO SPS/PPS in-band, like many
  // Axis streams) every 25 frames, P slices in between. One frame per tick.
  _startRtp(socket) {
    let seq = 1000;
    let ts = 0;
    let frame = 0;
    const ssrc = 0x11223344;
    const send = (payload, marker) => {
      const h = Buffer.alloc(12);
      h[0] = 0x80;
      h[1] = (marker ? 0x80 : 0) | 96;
      h.writeUInt16BE(seq & 0xffff, 2);
      h.writeUInt32BE(ts >>> 0, 4);
      h.writeUInt32BE(ssrc, 8);
      seq += 1;
      const pkt = Buffer.concat([h, payload]);
      const frameHead = Buffer.from([0x24, 0, 0, 0]);
      frameHead.writeUInt16BE(pkt.length, 2);
      if (!socket.destroyed) socket.write(Buffer.concat([frameHead, pkt]));
    };
    socket.rtpTimer = setInterval(() => {
      const key = frame % 25 === 0 || socket.forceKeyframe;
      socket.forceKeyframe = false;
      if (key) {
        const nal = Buffer.concat([Buffer.from([0x65]), crypto.randomBytes(2400)]);
        const body = nal.subarray(1);
        const parts = [body.subarray(0, 800), body.subarray(800, 1600), body.subarray(1600)];
        parts.forEach((part, i) => {
          const fuHeader = (i === 0 ? 0x80 : 0) | (i === parts.length - 1 ? 0x40 : 0) | 5;
          send(Buffer.concat([Buffer.from([0x7c, fuHeader]), part]), i === parts.length - 1);
        });
      } else if (this.packetsPerFrame > 1) {
        const n = this.packetsPerFrame;
        for (let i = 0; i < n; i++) {
          const fuHeader = (i === 0 ? 0x80 : 0) | (i === n - 1 ? 0x40 : 0) | 1;
          send(Buffer.concat([Buffer.from([0x5c, fuHeader]), crypto.randomBytes(1200)]), i === n - 1);
        }
      } else {
        send(Buffer.concat([Buffer.from([0x41]), crypto.randomBytes(300)]), true);
      }
      frame += 1;
      ts += 90000 / this.rtspFps;
    }, 1000 / this.rtspFps);
    socket.on('close', () => clearInterval(socket.rtpTimer));
  }
}

module.exports = {
  FakeCamera, SERIAL, SPS, PPS, EVENT_INSTANCES,
};

'use strict';

// HTTP authentication for VAPIX and RTSP (RFC 7616 Digest, RFC 7617 Basic).
// Axis devices ask for Digest over HTTP and RTSP and accept Basic over HTTPS; some are set
// to Digest only. The device names what it accepts in WWW-Authenticate, possibly several
// challenges at once (e.g. Digest with SHA-256 and with MD5).

const crypto = require('node:crypto');

// All challenges in the WWW-Authenticate header values: [{ scheme, params }].
function parseChallenges(values) {
  const out = [];
  for (const value of [].concat(values || [])) {
    const re = /(Basic|Digest)\s*/gi;
    const starts = [];
    let m;
    while ((m = re.exec(value))) {
      // A scheme name only counts at the start or after a comma (not inside a quoted value).
      const before = value.slice(0, m.index).replace(/"[^"]*"/g, '');
      if (m.index === 0 || /,\s*$/.test(before) || before.trim() === '') starts.push({ scheme: m[1], at: m.index, end: re.lastIndex });
    }
    starts.forEach((s, i) => {
      const text = value.slice(s.end, i + 1 < starts.length ? starts[i + 1].at : value.length);
      const params = {};
      const pr = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g;
      let p;
      while ((p = pr.exec(text))) params[p[1].toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : p[3];
      out.push({ scheme: s.scheme.toLowerCase(), params });
    });
  }
  return out;
}

const HASHES = { md5: 'md5', 'md5-sess': 'md5', 'sha-256': 'sha256', 'sha-256-sess': 'sha256' };

// Picks the strongest challenge we can answer: Digest SHA-256, Digest MD5, then Basic
// (Basic only when allowBasic, i.e. over an encrypted connection).
function pickChallenge(challenges, allowBasic) {
  const digest = challenges.filter((c) => c.scheme === 'digest' && HASHES[(c.params.algorithm || 'md5').toLowerCase()]);
  digest.sort((a, b) => ((b.params.algorithm || '').toLowerCase().startsWith('sha-256') ? 1 : 0)
    - ((a.params.algorithm || '').toLowerCase().startsWith('sha-256') ? 1 : 0));
  if (digest.length) return digest[0];
  if (allowBasic) return challenges.find((c) => c.scheme === 'basic') || null;
  return null;
}

function basicHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

// Keeps one Digest challenge and answers requests with it (nonce count goes up per use).
class DigestSession {
  constructor(challenge, username, password) {
    this.params = challenge.params;
    this.username = username;
    this.password = password;
    this.nc = 0;
    const alg = (this.params.algorithm || 'MD5').toLowerCase();
    this.hash = HASHES[alg];
    this.sess = alg.endsWith('-sess');
    this.cnonce = crypto.randomBytes(8).toString('hex');
  }

  h(text) {
    return crypto.createHash(this.hash).update(text).digest('hex');
  }

  header(method, uri) {
    const p = this.params;
    this.nc += 1;
    const nc = this.nc.toString(16).padStart(8, '0');
    let ha1 = this.h(`${this.username}:${p.realm}:${this.password}`);
    if (this.sess) ha1 = this.h(`${ha1}:${p.nonce}:${this.cnonce}`);
    const ha2 = this.h(`${method}:${uri}`);
    const qops = (p.qop || '').split(',').map((q) => q.trim());
    const qop = qops.includes('auth') ? 'auth' : null;
    const response = qop
      ? this.h(`${ha1}:${p.nonce}:${nc}:${this.cnonce}:${qop}:${ha2}`)
      : this.h(`${ha1}:${p.nonce}:${ha2}`);
    const parts = [
      `username="${this.username.replace(/(["\\])/g, '\\$1')}"`,
      `realm="${p.realm}"`,
      `nonce="${p.nonce}"`,
      `uri="${uri}"`,
      `response="${response}"`,
    ];
    if (p.algorithm) parts.push(`algorithm=${p.algorithm}`);
    if (p.opaque !== undefined) parts.push(`opaque="${p.opaque}"`);
    if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${this.cnonce}"`);
    return `Digest ${parts.join(', ')}`;
  }
}

module.exports = {
  parseChallenges, pickChallenge, basicHeader, DigestSession,
};

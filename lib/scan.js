'use strict';

// Finds Axis devices on Homey's own network when mDNS discovery doesn't (some networks
// block multicast). A quick TCP check on ports 443 and 80 first, then the anonymous
// Basic device information call on whatever answered. No login is sent.

const net = require('node:net');
const { probe } = require('./vapix');

function tcpOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Runs fn over items, size at a time. After deadline (ms since epoch) no new item is started.
async function pool(items, size, fn, deadline = Infinity) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length && Date.now() < deadline) {
      const item = items[i++];
      out.push(await fn(item));
    }
  });
  await Promise.all(workers);
  return out;
}

// localAddress: Homey's own IPv4 address. Resolves [{ host, secure, info, needsLogin }].
// timeoutMs: stop starting new checks after this long, so the search always ends in time.
async function scanSubnet(localAddress, { skip = [], timeoutMs = Infinity } = {}) {
  const deadline = Date.now() + timeoutMs;
  const m = /^(\d+\.\d+\.\d+)\.(\d+)$/.exec(localAddress || '');
  if (!m) return [];
  const hosts = [];
  for (let n = 1; n < 255; n++) {
    const host = `${m[1]}.${n}`;
    if (host !== localAddress && !skip.includes(host)) hosts.push(host);
  }
  const open = (await pool(hosts, 64, async (host) => (
    (await tcpOpen(host, 443, 800)) || (await tcpOpen(host, 80, 800)) ? host : null
  ), deadline)).filter(Boolean);
  const found = await pool(open, 16, async (host) => {
    const r = await probe(host, 3000);
    return r ? { host, ...r } : null;
  }, deadline);
  return found.filter(Boolean);
}

// An IPv4 address or a host name, as typed when the search can't find a camera.
const ADDRESS = /^(\d{1,3}(\.\d{1,3}){3}|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i;

// "192.168.2.10, 192.168.2.11" (commas, spaces or new lines) -> ['192.168.2.10', '192.168.2.11']
function parseAddresses(text) {
  const list = String(text || '').split(/[\s,;]+/)
    .map((a) => a.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''))
    .filter(Boolean);
  return [...new Set(list)];
}

module.exports = {
  scanSubnet, tcpOpen, pool, parseAddresses, ADDRESS,
};

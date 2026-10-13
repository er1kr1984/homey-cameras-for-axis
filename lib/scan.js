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

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      out.push(await fn(item));
    }
  });
  await Promise.all(workers);
  return out;
}

// localAddress: Homey's own IPv4 address. Resolves [{ host, secure, info, needsLogin }].
async function scanSubnet(localAddress, { skip = [] } = {}) {
  const m = /^(\d+\.\d+\.\d+)\.(\d+)$/.exec(localAddress || '');
  if (!m) return [];
  const hosts = [];
  for (let n = 1; n < 255; n++) {
    const host = `${m[1]}.${n}`;
    if (host !== localAddress && !skip.includes(host)) hosts.push(host);
  }
  const open = (await pool(hosts, 64, async (host) => (
    (await tcpOpen(host, 443, 800)) || (await tcpOpen(host, 80, 800)) ? host : null
  ))).filter(Boolean);
  const found = await pool(open, 16, async (host) => {
    const r = await probe(host, 3000);
    return r ? { host, ...r } : null;
  });
  return found.filter(Boolean);
}

module.exports = { scanSubnet, tcpOpen };

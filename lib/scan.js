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

// Checks these hosts for Axis devices. Resolves [{ host, secure, info, needsLogin }].
// timeoutMs: stop starting new checks after this long, so the search always ends in time.
async function scanHosts(hosts, { timeoutMs = Infinity } = {}) {
  const deadline = Date.now() + timeoutMs;
  const open = (await pool(hosts, 64, async (host) => (
    (await tcpOpen(host, 443, 800)) || (await tcpOpen(host, 80, 800)) ? host : null
  ), deadline)).filter(Boolean);
  const found = await pool(open, 16, async (host) => {
    const r = await probe(host, 3000);
    return r ? { host, ...r } : null;
  }, deadline);
  return found.filter(Boolean);
}

// "192.168.40" -> the 254 host addresses of that /24 network, without skip.
function subnetHosts(prefix, skip = []) {
  const hosts = [];
  for (let n = 1; n < 255; n++) {
    const host = `${prefix}.${n}`;
    if (!skip.includes(host)) hosts.push(host);
  }
  return hosts;
}

// The /24 network of an IPv4 address: "192.168.40.12" -> "192.168.40" (else null).
function prefixOf(address) {
  const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(String(address || ''));
  return m ? m[1] : null;
}

// localAddress: Homey's own IPv4 address.
async function scanSubnet(localAddress, { skip = [], timeoutMs = Infinity } = {}) {
  const prefix = prefixOf(localAddress);
  if (!prefix) return [];
  return scanHosts(subnetHosts(prefix, [localAddress, ...skip]), { timeoutMs });
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const MAX_RANGE = 1024; // hosts in one typed network (a /22)

const ipToInt = (ip) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const intToIp = (n) => [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');
const validIp = (ip) => IPV4.test(ip) && ip.split('.').every((part) => Number(part) <= 255);

// One typed entry -> { host, port } for one camera, { hosts: [...] } for a network, or null.
// Networks: 192.168.40.0/24, 192.168.40.10-40, 192.168.40.*
function parseEntry(text) {
  const t = String(text || '').trim();
  let m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/.exec(t);
  if (m) {
    const bits = Number(m[2]);
    if (!validIp(m[1]) || bits > 32 || 2 ** (32 - bits) > MAX_RANGE) return null;
    const size = 2 ** (32 - bits);
    const start = Math.floor(ipToInt(m[1]) / size) * size;
    const hosts = [];
    // Leave out the network and broadcast addresses of real ranges.
    for (let i = size > 2 ? 1 : 0; i < (size > 2 ? size - 1 : size); i++) hosts.push(intToIp(start + i));
    return { hosts };
  }
  m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})-(\d{1,3})$/.exec(t);
  if (m) {
    const from = Number(m[2]);
    const to = Number(m[3]);
    if (!validIp(`${m[1]}.${from}`) || to > 255 || to < from) return null;
    const hosts = [];
    for (let n = from; n <= to; n++) hosts.push(`${m[1]}.${n}`);
    return { hosts };
  }
  m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\*$/.exec(t);
  if (m) return validIp(`${m[1]}.1`) ? { hosts: subnetHosts(m[1]) } : null;
  m = /^(.+?)(?::(\d{1,5}))?$/.exec(t);
  const host = m[1];
  const port = m[2] ? Number(m[2]) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  if (IPV4.test(host) ? !validIp(host) : !HOSTNAME.test(host)) return null;
  return { host, port };
}

// "192.168.2.10, 192.168.2.11" (commas, spaces or new lines) -> ['192.168.2.10', '192.168.2.11']
function parseAddresses(text) {
  const list = String(text || '').split(/[\s,;]+/)
    .map((a) => a.trim().replace(/^https?:\/\//i, '').replace(/\/(?!\d{1,2}$).*$/, ''))
    .filter(Boolean);
  return [...new Set(list)];
}

// "cam.local:8443" -> { host: 'cam.local', port: 8443 }; no port -> port null.
function splitHostPort(address) {
  const m = /^(.+?)(?::(\d{1,5}))?$/.exec(String(address || '').trim());
  return { host: m ? m[1] : '', port: m && m[2] ? Number(m[2]) : null };
}

module.exports = {
  scanSubnet, scanHosts, subnetHosts, prefixOf, tcpOpen, pool, parseAddresses, parseEntry, splitHostPort,
};

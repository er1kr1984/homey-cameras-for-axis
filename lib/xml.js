'use strict';

// A small XML reader for the few XML answers VAPIX gives (GetEventInstances, applications).
// Builds a tree of { name, local, attrs, children, text }. No DTDs, no entities beyond the
// five standard ones; enough for well-formed device output.

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e] !== undefined ? ENTITIES[e] : m;
  });
}

function node(name) {
  return {
    name, local: name ? name.slice(name.indexOf(':') + 1) : null, attrs: {}, children: [], text: '',
  };
}

function parseXml(xml) {
  const root = node(null);
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!(?:[^>"']|"[^"]*"|'[^']*')*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (stack.length > 1) stack.pop();
    } else if (m[3]) {
      const n = node(m[3]);
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        n.attrs[a[1]] = decode(a[2] !== undefined ? a[2] : a[3]);
      }
      top.children.push(n);
      if (!m[5]) stack.push(n);
    } else if (m[6]) {
      top.text += decode(m[6]).trim();
    }
  }
  return root;
}

function findAll(n, test, out = []) {
  for (const c of n.children) {
    if (test(c)) out.push(c);
    findAll(c, test, out);
  }
  return out;
}

module.exports = { parseXml, findAll };

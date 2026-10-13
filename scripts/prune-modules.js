'use strict';

// Removes files from node_modules that are only needed for development (source maps,
// TypeScript sources and type definitions). The Homey CLI packs node_modules as-is, so
// this keeps them out of the app archive. Runs after every npm install.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'node_modules');
const drop = /\.(map|ts|mts|cts)$/; // includes .d.ts
let files = 0;
let bytes = 0;

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && drop.test(entry.name)) {
      bytes += fs.statSync(full).size;
      fs.unlinkSync(full);
      files++;
    }
  }
}

walk(root);
console.log(`prune-modules: removed ${files} development files (${(bytes / 1048576).toFixed(1)} MB)`);

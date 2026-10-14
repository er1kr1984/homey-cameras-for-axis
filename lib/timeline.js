'use strict';

// The latest people and vehicles a camera counted, each with a picture, for the
// "Recent visitors" widget. Pictures are JPEG files in the app's /userdata folder; the
// list itself is small and saved by the device (getEntries / dirty).
//
// A picture is either the camera's own close-up of the object ('crop'), or a picture
// of the whole scene with the object's box ('scene'), which the widget zooms into.

const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTRIES = 40;

class Timeline {
  // dir: folder for this camera's pictures; entries: the saved list (newest first).
  constructor({ dir, entries = [], max = MAX_ENTRIES }) {
    this.dir = dir;
    this.entries = entries;
    this.max = max;
    this.byObject = new Map(); // camera's ObjectId -> entry, while the object is tracked
    this.dirty = false;
    this.seq = 0;
  }

  // entry: { objectId, category, type, colors }. Returns the new entry.
  add({
    objectId, category, type, colors,
  }) {
    this.seq += 1;
    const at = Date.now();
    const entry = {
      key: `${at.toString(36)}${this.seq.toString(36)}`,
      at,
      category,
      type: type || null,
      colors: colors || [],
      direction: null,
      seconds: null,
      picture: null, // 'crop' | 'scene'
      box: null,
      v: 0,
    };
    this.entries.unshift(entry);
    if (objectId) this.byObject.set(objectId, entry);
    for (const old of this.entries.splice(this.max)) this._removeFile(old.key);
    if (this.byObject.size > this.max) this.byObject.delete(this.byObject.keys().next().value);
    this.dirty = true;
    return entry;
  }

  forObject(objectId) {
    return this.byObject.get(objectId) || null;
  }

  // Save a picture for an entry. A close-up replaces a scene picture, never the reverse.
  async setPicture(entry, jpeg, kind, box = null) {
    if (!jpeg || !entry || !this.entries.includes(entry)) return;
    if (entry.picture === 'crop' && kind !== 'crop') return;
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.writeFile(this._file(entry.key), jpeg);
    Object.assign(entry, { picture: kind, box: kind === 'scene' ? box : null, v: entry.v + 1 });
    this.dirty = true;
  }

  // The object left the picture: which way it went and how long it stayed.
  finish(objectId, { direction, seconds }) {
    const entry = this.byObject.get(objectId);
    if (!entry) return;
    this.byObject.delete(objectId);
    Object.assign(entry, { direction, seconds });
    this.dirty = true;
  }

  // kind: 'all', 'people' or 'vehicles'
  list(kind = 'all', limit = this.max) {
    return this.entries
      .filter((e) => kind === 'all' || (kind === 'people') === (e.category === 'person'))
      .slice(0, limit);
  }

  async picture(key) {
    const entry = this.entries.find((e) => e.key === key);
    if (!entry || !entry.picture) return null;
    try {
      return { jpeg: await fs.promises.readFile(this._file(key)), kind: entry.picture, box: entry.box };
    } catch (err) {
      return null;
    }
  }

  // Remove everything (the camera was deleted).
  async clear() {
    this.entries = [];
    this.byObject.clear();
    await fs.promises.rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }

  _file(key) {
    return path.join(this.dir, `${key.replace(/[^a-z0-9]/gi, '')}.jpg`);
  }

  _removeFile(key) {
    fs.promises.unlink(this._file(key)).catch(() => {});
  }
}

module.exports = { Timeline };

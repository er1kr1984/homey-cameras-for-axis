'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Timeline } = require('../lib/timeline');

test('timeline keeps the latest objects with their pictures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-'));
  const tl = new Timeline({ dir: path.join(dir, 'cam'), max: 3 });
  const a = tl.add({
    objectId: '1', category: 'person', type: 'Human', colors: ['red'],
  });
  await tl.setPicture(a, Buffer.from('scene'), 'scene', {
    x: 0.1, y: 0.2, w: 0.1, h: 0.3,
  });
  assert.strictEqual((await tl.picture(a.key)).kind, 'scene');
  // The close-up replaces the scene picture, and not the other way round.
  await tl.setPicture(tl.forObject('1'), Buffer.from('crop'), 'crop');
  await tl.setPicture(a, Buffer.from('scene2'), 'scene');
  const p = await tl.picture(a.key);
  assert.strictEqual(p.kind, 'crop');
  assert.strictEqual(p.jpeg.toString(), 'crop');
  assert.strictEqual(p.box, null);
  tl.finish('1', { direction: 'left', seconds: 9 });
  assert.strictEqual(a.direction, 'left');
  assert.strictEqual(tl.forObject('1'), null);
  for (let i = 2; i <= 4; i++) tl.add({ objectId: String(i), category: i % 2 ? 'car' : 'person' });
  assert.strictEqual(tl.entries.length, 3, 'oldest dropped');
  assert.strictEqual(await tl.picture(a.key), null);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(fs.readdirSync(path.join(dir, 'cam')).length, 0, 'its picture file removed');
  assert.deepStrictEqual(tl.list('vehicles').map((e) => e.category), ['car']);
  assert.strictEqual(tl.list('people').length, 2);
  await tl.clear();
  assert.ok(!fs.existsSync(path.join(dir, 'cam')));
  fs.rmSync(dir, { recursive: true, force: true });
});

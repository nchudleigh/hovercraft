const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const bridge = readFileSync(require.resolve('../bridge.js'), 'utf8');
const sounds = [
  'double_kill', 'triple_kill', 'overkill', 'killtacular', 'killtrocity',
  'killimanjaro', 'killtastrophe', 'killpocalypse', 'killionaire',
];

function loadBridge() {
  const document = new EventTarget();
  document.documentElement = { dataset: {} };
  const played = [];
  let now = 0;
  let setEnabled;

  class Audio extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
    }

    play() {
      played.push(this);
      return Promise.resolve();
    }

    pause() {
      this.paused = true;
    }
  }

  runInNewContext(bridge, {
    Audio, document, performance: { now: () => now }, console,
    chrome: {
      runtime: { getURL: (path) => path },
      storage: {
        local: { get: (_, callback) => callback({}) },
        onChanged: { addListener: (listener) => { setEnabled = listener; } },
      },
    },
  });

  return {
    played,
    names: () => played.map(({ url }) => url.split('/').pop().slice(0, -4)),
    blockAt: (time) => {
      now = time;
      document.dispatchEvent(new Event('hovercraft:skull-blocked'));
    },
    party: () => document.dispatchEvent(new Event('hovercraft:party')),
    enable: (enabled) => setEnabled({ enabled: { newValue: enabled } }),
  };
}

test('announces each Halo 3 tier once, through Killionaire', () => {
  const { blockAt, names, played } = loadBridge();
  blockAt(0);
  assert.deepEqual(names(), []);
  for (let kill = 2; kill <= 12; kill++) {
    blockAt((kill - 1) * 1500);
    played.at(-1).dispatchEvent(new Event('ended'));
  }
  assert.deepEqual(names(), sounds);
});

test('uses a rolling four-second window; birthday events do not count', () => {
  const { blockAt, names, party, played } = loadBridge();
  blockAt(0);
  party();
  blockAt(4000);
  played.at(-1).dispatchEvent(new Event('ended'));
  blockAt(8000);
  played.at(-1).dispatchEvent(new Event('ended'));
  blockAt(12001);
  assert.deepEqual(names(), ['party', 'double_kill', 'triple_kill']);
  blockAt(12002);
  assert.deepEqual(names(), ['party', 'double_kill', 'triple_kill', 'double_kill']);
});

test('plays queued announcements serially and skips an errored clip', () => {
  const { blockAt, names, played } = loadBridge();
  [0, 1000, 2000, 3000].forEach(blockAt);
  assert.deepEqual(names(), ['double_kill']);
  played[0].dispatchEvent(new Event('error'));
  assert.deepEqual(names(), ['double_kill', 'triple_kill']);
  played[1].dispatchEvent(new Event('ended'));
  assert.deepEqual(names(), ['double_kill', 'triple_kill', 'overkill']);
});

test('disabling stops audio and clears pending clips and streak progress', () => {
  const { blockAt, enable, names, played } = loadBridge();
  [0, 1000, 2000].forEach(blockAt);
  enable(false);
  assert.equal(played[0].paused, true);
  blockAt(3000);
  played[0].dispatchEvent(new Event('ended'));
  enable(true);
  blockAt(4000);
  assert.deepEqual(names(), ['double_kill']);
  blockAt(5000);
  assert.deepEqual(names(), ['double_kill', 'double_kill']);
});

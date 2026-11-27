// Frederik Pohl's Gateway: the original DOS program runs in engine/legend.
// A short play through the first day checks the text, the questions, the
// game's own screens (the PV commset, the DataMan, the lecture), the world
// view the app reads, and undo.
//
//   node tests/legend.test.mjs
import assert from 'node:assert/strict';
import { setCurrentGame } from '../web/src/engine/current.js';
import * as code from '../web/src/games/gateway/game.js';
import * as story from '../web/src/games/gateway/story-data.js';
import { runGame, snapshot } from '../web/src/engine/game.js';
import * as LG from '../web/src/engine/legend/host.js';

setCurrentGame({ id: 'gateway' }, code, story);

// Each step: what to type, then a check on what came back.
const steps = [
  ['take card', (t) => assert.match(t, /You take the debit card/)],
  ['put card in commset', (t, s) => { assert.match(t, /insert your debit card/); assert.equal(s.mode, 'screen'); }],
  ['1', (t, s) => assert.equal(s.mode, 'screen')],
  ['n', (t, s) => assert.equal(s.mode, 'screen')],
  ['0', (t, s) => assert.equal(s.mode, 'screen')],
  ['0', (t, s) => { assert.match(t, /take your debit card from the slot/); assert.equal(s.mode, 'line'); }],
  ['!snap'],
  ['open drawer', (t) => assert.match(t, /discover a book/)],
  ['!undo', (t) => assert.match(t, /undone/)],
  ['look', (t) => { assert.match(t, /desk has one drawer, which is closed/); }],
  ['open drawer', (t) => assert.match(t, /discover a book/)],
  ['take book', (t) => assert.match(t, /score has just gone up by 3/)],
  ['e', (t, s) => { assert.match(t, /Heecheetown/); assert.equal(s.status.room, 'Heecheetown'); }],
  ['nw', (t) => assert.match(t, /receptionist/)],
  ['give book to receptionist', (t) => assert.match(t, /DataMan/)],
  ['turn on dataman', (t, s) => assert.equal(s.mode, 'screen')],
  ['0', (t, s) => assert.equal(s.mode, 'line')],
  ['wait until 20:00', (t) => assert.match(t, /Time passes/)],
  ['wait until 9:00', (t) => assert.match(t, /Time passes/)],
  ['wait until 9:00', (t, s) => { assert.match(t, /sleepy/); assert.match(s.question, /continue waiting/); }],
  ['no', (t, s) => assert.equal(s.mode, 'line')],
];

const out = [];
let snap = null;
let step = 0;
let mode = 'line';
let lastStatus = {};
let question = '';

function check() {
  const [, test] = steps[step - 1] ?? [];
  const text = out.join('');
  out.length = 0;
  if (test) {
    try { test(text, { mode, status: lastStatus, question }); } catch (e) {
      console.error(`Step ${step} (${steps[step - 1][0]}) failed (${mode}, ${lastStatus.clock}):\n${text}`);
      throw e;
    }
  }
  question = '';
}

const next = (kind) => {
  mode = kind;
  check();
  if (step >= steps.length) {
    console.log(`legend: ${steps.length} steps OK; world: ${LG.sceneNouns().map((x) => x.word).join(', ')}`);
    process.exit(0);
  }
  const [cmd] = steps[step++];
  if (cmd === '!snap') { snap = snapshot(); return next(kind); }
  if (cmd === '!undo') return Promise.resolve({ snapshot: snap, notice: '(undone)\n' });
  return Promise.resolve(cmd);
};

await runGame({
  output: (t) => { out.push(t); if (/\?\s*$/.test(t)) question = t; },
  status: (s) => { lastStatus = s; },
  picture: () => {},
  input: () => next('line'),
  inputChar: () => next('screen'),
  save: async () => true,
  restore: async () => null,
});

// Builds a compact description of what the player can currently refer to,
// using the game's own object tree and vocabulary.  This is what lets the AI
// translate "grab the shiny thing" into "take key".

import { g, inspect } from '../engine/runtime.js';
import { current } from '../engine/current.js';

const G = () => current.code;
// A flag the current game doesn't define is treated as never set.
const flag = (o, f) => f != null && inspect.hasFlag(o, f);

function describe(o) {
  const words = inspect.objectWords(o).filter((w) => !/^(it|that|this|him|zzmgck)$/.test(w));
  return {
    name: inspect.objectName(o),
    nouns: [...new Set(words)],
    adjectives: [...new Set(inspect.objectAdjectives(o))].slice(0, 8),
  };
}

function visibleChildren(container, depth, out, { includeActor = false } = {}) {
  for (const o of inspect.children(container)) {
    if (o === G().ADVENTURER && !includeActor) continue;
    if (flag(o, G().INVISIBLE)) continue;
    out.push({ obj: o, inside: container });
    const open = flag(o, G().OPENBIT) || flag(o, G().TRANSBIT) || flag(o, G().SURFACEBIT);
    if (depth < 3 && open && !flag(o, G().ACTORBIT)) visibleChildren(o, depth + 1, out);
  }
  return out;
}

/** Snapshot of the current scene for the AI prompt. */
export function currentScene() {
  const here = g.HERE;
  const lit = !!g.LIT;
  const scene = {
    location: inspect.objectName(here),
    dark: !lit,
    inventory: [],
    visible: [],
    scenery: [],
  };
  for (const { obj } of visibleChildren(G().ADVENTURER, 0, [])) {
    const d = describe(obj);
    if (d.nouns.length) scene.inventory.push(d);
  }
  if (lit) {
    for (const { obj, inside } of visibleChildren(here, 0, [])) {
      if (inspect.loc(obj) === G().ADVENTURER) continue;
      const d = describe(obj);
      if (!d.nouns.length) continue;
      if (inside !== here) d.in = inspect.objectName(inside);
      scene.visible.push(d);
    }
    // Room-specific scenery: local globals and pseudo-objects of this room.
    const gp = inspect.getPropAddr(here, G().P.GLOBAL);
    if (gp) {
      const mem = inspect.memory;
      for (let i = 0; i < inspect.propSize(gp); i++) {
        const d = describe(mem[gp + i]);
        if (d.nouns.length) scene.scenery.push(d);
      }
    }
    const pp = inspect.getPropAddr(here, G().P.PSEUDO);
    if (pp) {
      for (let i = 0; i < inspect.propSize(pp) / 4; i++) scene.scenery.push({ nouns: [inspect.pseudoWord(pp, i)] });
    }
  }
  return scene;
}

/** Render the scene as compact text for the prompt. */
export function sceneText(scene) {
  const fmt = (d) => {
    const n = d.nouns.join('/');
    const a = d.adjectives && d.adjectives.length ? ` [adj: ${d.adjectives.join(', ')}]` : '';
    const where = d.in ? ` (in/on ${d.in})` : '';
    return `- ${d.name ? d.name + ' — ' : ''}words: ${n}${a}${where}`;
  };
  const lines = [`Location: ${scene.location}${scene.dark ? ' (it is dark; nothing can be seen)' : ''}`];
  lines.push('Carrying:', ...(scene.inventory.length ? scene.inventory.map(fmt) : ['- nothing']));
  if (!scene.dark) {
    lines.push('Things here:', ...(scene.visible.length ? scene.visible.map(fmt) : ['- nothing notable']));
    if (scene.scenery.length) lines.push('Scenery mentioned in this location:', ...scene.scenery.map(fmt));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Quick actions (buttons): exits and sensible verbs for things in view
// ---------------------------------------------------------------------------

const DIRECTIONS = ['north', 'ne', 'east', 'se', 'south', 'sw', 'west', 'nw', 'up', 'down', 'in', 'out'];
const DIR_PROP = { north: 'NORTH', ne: 'NE', east: 'EAST', se: 'SE', south: 'SOUTH', sw: 'SW', west: 'WEST', nw: 'NW', up: 'UP', down: 'DOWN', in: 'IN', out: 'OUT' };

/** Directions with an exit defined for the current room (excluding plain "you can't go" messages). */
function exits() {
  const out = [];
  for (const d of DIRECTIONS) {
    const a = inspect.getPropAddr(g.HERE, G().P[DIR_PROP[d]]);
    if (a && inspect.propSize(a) !== 2) out.push(d); // size 2 = message-only exit
  }
  return out;
}

function shortLabel(name) {
  if (name.length <= 22) return name;
  return name.split(/\s+/).slice(-2).join(' ');
}

function verbsFor(o, held) {
  const f = (fl) => flag(o, fl);
  const words = inspect.objectWords(o);
  const v = ['examine'];
  if (f(G().ACTORBIT)) v.push('talk');
  if (held) v.push('drop');
  else if (f(G().TAKEBIT)) v.push('take');
  if (f(G().CONTBIT) || f(G().DOORBIT)) v.push(f(G().OPENBIT) ? 'close' : 'open');
  if (f(G().CONTBIT) && f(G().OPENBIT)) v.push('lookin');
  if (f(G().READBIT)) v.push('read');
  if (f(G().FOODBIT)) v.push('eat');
  if (f(G().WEARBIT)) v.push(f(G().WORNBIT) ? 'remove' : 'wear');
  if (f(G().LIGHTBIT)) v.push(f(G().ONBIT) ? 'turnoff' : 'turnon');
  if (words.some((w) => /^(button|switch|lever)$/.test(w))) v.push('push');
  return v;
}

/** What the action buttons can offer right now. */
export function actionContext() {
  const scene = { dark: !g.LIT, exits: g.LIT ? exits() : [], objects: [] };
  if (!g.LIT) {
    // Still allow handling what you carry.
    for (const { obj } of visibleChildren(G().ADVENTURER, 0, [])) addObject(scene, obj, true);
    return scene;
  }
  for (const { obj } of visibleChildren(g.HERE, 0, [])) addObject(scene, obj, inspect.loc(obj) === G().ADVENTURER);
  const gp = inspect.getPropAddr(g.HERE, G().P.GLOBAL);
  if (gp) for (let i = 0; i < inspect.propSize(gp); i++) addObject(scene, inspect.memory[gp + i], false, true);
  for (const { obj } of visibleChildren(G().ADVENTURER, 0, [])) addObject(scene, obj, true);
  // Disambiguate commands for objects sharing a noun ("red button" / "blue button").
  const byNoun = new Map();
  for (const o of scene.objects) byNoun.set(o.noun, (byNoun.get(o.noun) || 0) + 1);
  for (const o of scene.objects) o.cmd = byNoun.get(o.noun) > 1 && o.adjective ? `${o.adjective} ${o.noun}` : o.noun;
  return scene;
}

function addObject(scene, obj, held, scenery = false) {
  if (scene.objects.some((o) => o.obj === obj)) return;
  if (obj === G().ADVENTURER || flag(obj, G().INVISIBLE)) return;
  const nouns = inspect.objectWords(obj).filter((w) => !/^(it|that|this|him|zzmgck)$/.test(w));
  if (!nouns.length) return;
  const name = inspect.objectName(obj);
  // Prefer a noun that appears in the object's name ("scrub brush" -> "brush").
  const noun = nouns.find((n) => name.toLowerCase().includes(n)) || nouns[0];
  const adjs = inspect.objectAdjectives(obj);
  const adjective = adjs.find((a) => name.toLowerCase().includes(a) && a !== noun) || adjs[0];
  scene.objects.push({ obj, name, label: shortLabel(name), noun, adjective, held, scenery, verbs: verbsFor(obj, held) });
}

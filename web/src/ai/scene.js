// Builds a compact description of what the player can currently refer to,
// using the game's own object tree and vocabulary.  This is what lets the AI
// translate "grab the shiny thing" into "take key".

import { g, inspect } from '../engine/runtime.js';
import * as G from '../game/planetfall.js';

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
    if (o === G.ADVENTURER && !includeActor) continue;
    if (inspect.hasFlag(o, G.INVISIBLE)) continue;
    out.push({ obj: o, inside: container });
    const open = inspect.hasFlag(o, G.OPENBIT) || inspect.hasFlag(o, G.TRANSBIT) || inspect.hasFlag(o, G.SURFACEBIT);
    if (depth < 3 && open && !inspect.hasFlag(o, G.ACTORBIT)) visibleChildren(o, depth + 1, out);
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
  for (const { obj } of visibleChildren(G.ADVENTURER, 0, [])) {
    const d = describe(obj);
    if (d.nouns.length) scene.inventory.push(d);
  }
  if (lit) {
    for (const { obj, inside } of visibleChildren(here, 0, [])) {
      if (inspect.loc(obj) === G.ADVENTURER) continue;
      const d = describe(obj);
      if (!d.nouns.length) continue;
      if (inside !== here) d.in = inspect.objectName(inside);
      scene.visible.push(d);
    }
    // Room-specific scenery: local globals and pseudo-objects of this room.
    const gp = inspect.getPropAddr(here, G.P.GLOBAL);
    if (gp) {
      const mem = inspect.memory;
      for (let i = 0; i < inspect.propSize(gp); i++) {
        const d = describe(mem[gp + i]);
        if (d.nouns.length) scene.scenery.push(d);
      }
    }
    const pp = inspect.getPropAddr(here, G.P.PSEUDO);
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

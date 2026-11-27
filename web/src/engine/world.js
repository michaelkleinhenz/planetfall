// The games whose world the app reads from the running original program
// (Magnetic Scrolls and Legend Entertainment) rather than from a translation:
// both engines' hosts offer the same views (room, things in view, dictionary).

import { current } from './current.js';
import * as MS from './ms/host.js';
import * as LG from './legend/host.js';

/** Does the current game run as its original program (with a world view from its host)? */
export const hasWorld = () => current.code?.ENGINE === 'magnetic' || current.code?.ENGINE === 'legend';

/** The current game's host (engine/ms or engine/legend). */
export const W = () => (current.code?.ENGINE === 'legend' ? LG : MS);

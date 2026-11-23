// Immersive mode (optional, per game): where the original game has nothing to
// say, the AI adds a few sentences of atmosphere in the game's own voice. The
// game's answer always stays; the addition is shown as AI-written text after
// it. It describes only what is already there (scenery a room description
// mentions, the look and feel of things) and never invents anything usable:
// no objects to take, exits, characters, clues or solutions.

import { chat } from './openrouter.js';
import { current } from '../engine/current.js';
import { sceneText } from './scene.js';
import { hintContext } from './hints.js';
import { g } from '../engine/runtime.js';

// The game's stock answers when it has nothing particular to say.
const STOCK = [
  /^(There's|There is|There seems to be) nothing (special|unusual|remarkable|interesting|of interest)/i,
  /^You see nothing (special|unusual|remarkable|interesting|of interest)/i,
  /^You (find|see|notice) nothing\b/i,
  /^(It|That) looks? (like )?(an? )?(perfectly )?(ordinary|normal|typical|mundane)\b/i,
  /^There is nothing (on|in|under|behind|beneath) /i,
  /^There's nothing (on|in|under|behind|beneath) /i,
  /^(It's|That's|It is|That is) (just )?(an? )?(perfectly )?(ordinary|normal|typical) /i,
  /^Nothing (special|interesting|unusual)\b/i,
  /^You can't see any .* here[.!]/i,
  /^I don't know the word/i,
  /^I can't use the word/i,
  /^You don't (see|need) /i,
  /^(Sorry, but )?this story doesn't recognize/i,
  /^\[?(This story|The word) .*(isn't|hasn't been) (allowed|approved)/i,
  /^That's not something you need to refer to/i,
  /^You can't see that here/i,
];

/** Is this the game's "nothing to say" answer (short, and a stock phrase)? */
export function needsAtmosphere(output) {
  const text = String(output ?? '').trim();
  if (!text || text.length > 220) return false;
  const first = text.split('\n')[0].trim();
  return STOCK.some((re) => re.test(first));
}

/** Rule for the command interpreter when immersive mode is on. */
export const INTERPRETER_RULE =
  'IMMERSIVE MODE is on: if the player wants to look at, examine, read, smell, listen to or touch something that the ' +
  'transcript or scene describes but the parser has no word for (scenery such as posters on a wall), do not refuse and ' +
  'do not describe it yourself: return no commands, no reply, and "describe": "<that thing, in English, e.g. the posters>". ' +
  'Things nobody has mentioned do not exist: answer those as before, without "describe".';

const systemPrompt = () => `You add atmosphere to ${current.meta.title}, the ${current.meta.year} Infocom text adventure by ${current.meta.author}, in "immersive mode".
The original game runs unchanged and has just given a terse stock answer (such as "There's nothing special about the posters." or "I don't know the word ..."). Write what the player perceives instead, so that the world feels alive.

RULES
- One to three sentences, second person, present tense, in the exact voice and tone of ${current.meta.title}'s narrator (its humour, its dread, its era). No markdown, no emoji, no quotation of commands.
- Stay consistent with everything the game has said: the room description, objects, characters, time, mood. Build on details the game mentions; enrich them, don't contradict them.
- Never invent anything the player could use: no objects to take, no hidden compartments, exits, characters or codes that the game does not have, and never state a command or an outright solution.
- CLUES THAT ARE TRUE: you receive the ACTUAL GAME CODE for the player's situation (the JavaScript translation of the original routines for this location, its exits and the objects in view or carried, with the current values of the variables they test), and you may use your knowledge of ${current.meta.title}. When what the player is looking at genuinely connects to a step they can take now or soon, weave in ONE subtle in-world detail that turns their attention the right way, like a level-1 InvisiClue told as description (a worn spot, a remark on a poster, the way something catches the eye). It must be true to the code: never a false lead, never anything that would send the player after something that does not exist or does not help, never the solution itself, and nothing about places or things the player has not encountered.
- When nothing relevant connects, write pure atmosphere (mood, history, wear, humour) and avoid anything that reads like a clue (something loose, hidden, out of place, behind or under something, an odd sound to follow): the player would waste time on it. If the game said there is nothing special, it must still be clear that the thing itself holds nothing more.
- If the thing the player refers to is not mentioned anywhere in the transcript or scene (they made it up), or the action makes no sense here, return an empty text: the game's own answer stands.
- Never repeat the game's answer, never apologise, never sound like an assistant.
- Output ONLY a JSON object: {"text": "..."} (or {"text": ""}).`;

function historyText(history) {
  const parts = [];
  let budget = 4500;
  for (let i = history.length - 1; i >= 0 && budget > 0; i--) {
    const h = history[i];
    const block = `${h.input ? `PLAYER: ${h.input}\n` : ''}${h.output?.trim() ? `GAME: ${h.output.trim()}` : ''}${h.reply ? `\nAI: ${h.reply}` : ''}`;
    budget -= block.length;
    parts.unshift(block.length > 1600 ? block.slice(0, 1600) + ' …' : block);
  }
  return parts.join('\n---\n');
}

/**
 * Atmosphere for an action the game answered with a stock phrase.
 * @returns {Promise<string>} the text, or '' to leave the game's answer alone
 */
export async function immerse({ apiKey, model, language, input, command, output, scene, history, signal }) {
  // The same knowledge the hint system works from: the code and state of this situation.
  let situation = '';
  try {
    const { code, vars } = hintContext();
    situation = `SCORE: ${g.SCORE ?? '-'}${current.meta.maxScore ? ` of ${current.meta.maxScore}` : ''}\n\n` +
      `GAME VARIABLES USED BY THE CODE BELOW:\n${vars.join('\n') || '(none)'}\n\n` +
      `GAME CODE FOR THIS SITUATION:\n${code || '(none)'}\n\n`;
  } catch { /* games without HERE (Sherlock): atmosphere only */ }
  const messages = [
    { role: 'system', content: systemPrompt(), cache: true },
    {
      role: 'user',
      content:
        `RECENT TRANSCRIPT (oldest first):\n${historyText(history) || '(game just started)'}\n\n` +
        `CURRENT SCENE (from the game state):\n${sceneText(scene)}\n\n` +
        situation +
        `THE PLAYER ${input && input !== command ? `WROTE: ${input}\nCOMMAND SENT: ${command}` : `TYPED: ${command}`}\n` +
        (output.trim()
          ? `THE GAME ANSWERED: ${output.trim()}\n\n`
          : 'THE GAME HAS NO WORD FOR THIS: a description mentions it, but the game does not implement it.\n\n') +
        (language ? `Write the text in ${language}.\n` : '') +
        'Your JSON:',
    },
  ];
  const raw = await chat({ apiKey, model, messages, signal, temperature: 0.4, maxTokens: 600 });
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return '';
  try {
    const text = JSON.parse(raw.slice(start, end + 1)).text;
    return typeof text === 'string' ? text.trim().slice(0, 700) : '';
  } catch {
    return '';
  }
}

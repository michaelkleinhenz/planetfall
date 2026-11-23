// Immersive mode (optional, per game): where the original game has nothing to
// say, the AI adds a few sentences of atmosphere in the game's own voice. The
// game's answer always stays; the addition is shown as AI-written text after
// it. It describes only what is already there (scenery a room description
// mentions, the look and feel of things) and never invents anything usable:
// no objects to take, exits, characters, clues or solutions.

import { chat } from './openrouter.js';
import { current } from '../engine/current.js';
import { sceneText } from './scene.js';

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
  'IMMERSIVE MODE is on: if the player wants to look at, examine, smell, listen to or touch something that the ' +
  'transcript or scene describes but the parser has no word for (scenery such as posters on a wall), do not refuse: ' +
  'return no commands and a "reply" of one to three sentences that describes it vividly in the game\'s narrator voice, ' +
  'consistent with everything the game has said. Never invent anything usable (objects to take, exits, characters, ' +
  'clues, solutions); it is atmosphere only. Things nobody has mentioned do not exist: answer those as before.';

const systemPrompt = () => `You add atmosphere to ${current.meta.title}, the ${current.meta.year} Infocom text adventure by ${current.meta.author}, in "immersive mode".
The original game runs unchanged and has just given a terse stock answer (such as "There's nothing special about the posters." or "I don't know the word ..."). Write what the player perceives instead, so that the world feels alive.

RULES
- One to three sentences, second person, present tense, in the exact voice and tone of ${current.meta.title}'s narrator (its humour, its dread, its era). No markdown, no emoji, no quotation of commands.
- Stay consistent with everything the game has said: the room description, objects, characters, time, mood. Build on details the game mentions; enrich them, don't contradict them.
- Atmosphere only. Never invent anything the player could use: no objects to take, no hidden compartments, exits, characters, codes, clues, hints or solutions, and never suggest an action. If the game said there is nothing special, what you add is texture, and it must still be clear that nothing useful is to be found.
- Avoid details that read like a clue (something loose, hidden, out of place, freshly disturbed, behind or under something, an odd smell or sound to follow): the player would waste time on them. Prefer mood, history, wear, humour.
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
  const messages = [
    { role: 'system', content: systemPrompt(), cache: true },
    {
      role: 'user',
      content:
        `RECENT TRANSCRIPT (oldest first):\n${historyText(history) || '(game just started)'}\n\n` +
        `CURRENT SCENE (from the game state):\n${sceneText(scene)}\n\n` +
        `THE PLAYER ${input && input !== command ? `WROTE: ${input}\nCOMMAND SENT: ${command}` : `TYPED: ${command}`}\n` +
        `THE GAME ANSWERED: ${output.trim()}\n\n` +
        (language ? `Write the text in ${language}.\n` : '') +
        'Your JSON:',
    },
  ];
  const raw = await chat({ apiKey, model, messages, signal, maxTokens: 400 });
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

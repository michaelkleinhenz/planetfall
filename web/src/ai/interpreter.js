// The AI interpreter: replaces the original two-step "type exactly what the
// parser understands" interaction.  The player writes anything; the model
// translates it into one or more commands in the game's own vocabulary, which
// the original (translated) parser and game logic then execute.  All story text
// still comes from the original game.

import { chat } from './openrouter.js';
import { SYNTAX_HELP, VERB_SYNONYMS } from '../game/story-data.js';
import { sceneText } from './scene.js';

// Debugging/meta syntaxes the AI should never produce.
const HIDDEN = /^(#|\$|script|unscript|verify)/;

function verbReference() {
  const lines = SYNTAX_HELP.filter((s) => !HIDDEN.test(s))
    .map((s) => s.replace(/^restar\b/, 'restart').replace(/^restor\b/, 'restore'));
  const syn = Object.entries(VERB_SYNONYMS)
    .filter(([v]) => !HIDDEN.test(v))
    .map(([v, list]) => `${v} = ${list.filter((w) => !/^(shit|fuck|damn)$/.test(w)).join(', ')}`);
  return { patterns: [...new Set(lines)].join(' | '), synonyms: syn.join('; ') };
}

const REF = verbReference();

const SYSTEM_PROMPT = `You are the command interpreter for PLANETFALL, the 1983 Infocom science-fiction text adventure.
The original game logic and its original text parser run unchanged. Your only job is to translate what the player types (free natural language, any phrasing, typos, other languages) into commands the original parser understands.

HOW THE ORIGINAL PARSER WORKS
- Commands are short imperative sentences: VERB [OBJECT] [PREPOSITION OBJECT], e.g. "take key", "put canteen in niche", "slide kitchen card through slot", "push blue button", "unlock padlock with key", "set dial to 42".
- Movement: north, south, east, west, ne, nw, se, sw, up, down, in, out (also "enter X", "exit").
- Objects are named with the nouns (and optional adjectives) listed in the scene. Prefer an adjective + noun when several things share a noun ("red button").
- "it" refers to the last object mentioned. "all" works with take/drop ("take all").
- Talking to characters: "floyd, go north" or "tell floyd to follow me" -> "floyd, follow me"; "say hello to floyd" -> "hello floyd" / "talk to floyd".
- Useful commands: look, examine X, inventory, wait, again, score, time, diagnose, sleep, read X, open/close X, turn on/off X, wear/remove X, eat/drink X, give X to Y, show X to Y, throw X at Y, save, restore, restart, verbose, brief.
- Known verb patterns (OBJ = object): ${REF.patterns}
- Verb synonyms: ${REF.synonyms}

RULES
1. Output ONLY a JSON object, no prose, no code fences:
   {"commands": ["cmd1", "cmd2"], "reply": "optional short note to the player"}
2. Use as few commands as needed (normally 1; at most 6 for an explicit sequence like "go north twice then open the door").
3. Only use words from the verb list, the scene, directions, or the recent transcript. Never invent objects that are not mentioned anywhere.
4. Never solve puzzles or add actions the player did not ask for. Do not reveal anything the player has not seen. If the player asks for a hint, give a gentle, spoiler-light nudge in "reply" and return no commands.
5. If the game just asked a question (e.g. "Which button do you mean...", "What do you want to put...?", a yes/no question, or RESTART/RESTORE/QUIT after death), answer it with a complete command or the expected word.
6. If the input is already a valid command, pass it through unchanged (fix obvious typos).
7. If the player is chatting, asking about the story so far, or asking what something means, answer briefly in "reply" (in the player's language) using only the transcript, and return no commands. Never narrate game outcomes yourself — the game does that.
8. If you cannot map the request to the game at all, return {"commands": [], "reply": "<short explanation and a suggestion>"}.`;

function transcriptText(history) {
  const parts = [];
  let budget = 5000;
  for (let i = history.length - 1; i >= 0 && budget > 0; i--) {
    const h = history[i];
    const block = `${h.input ? `PLAYER: ${h.input}\n` : ''}${h.commands?.length ? `COMMANDS: ${h.commands.join(' / ')}\n` : ''}GAME: ${h.output.trim()}`;
    budget -= block.length;
    parts.unshift(block.length > 1800 ? block.slice(0, 1800) + ' …' : block);
  }
  return parts.join('\n---\n');
}

function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The AI did not return JSON.');
  const obj = JSON.parse(text.slice(start, end + 1));
  const commands = Array.isArray(obj.commands) ? obj.commands.map(String).map((c) => c.trim()).filter(Boolean).slice(0, 6) : [];
  return { commands, reply: typeof obj.reply === 'string' ? obj.reply.trim() : '' };
}

/**
 * Translate player input into game commands.
 * @returns {Promise<{commands: string[], reply: string}>}
 */
export async function interpret({ apiKey, model, input, scene, history, repair, signal }) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `RECENT TRANSCRIPT (oldest first):\n${transcriptText(history) || '(game just started)'}\n\n` +
        `CURRENT SCENE (from the game state):\n${sceneText(scene)}\n\n` +
        (repair
          ? `Your previous command "${repair.command}" was rejected by the parser with: "${repair.error.trim()}". ` +
            `Rephrase it using only known words, or return no commands with a reply if it cannot be expressed.\n\n`
          : '') +
        `PLAYER INPUT: ${input}`,
    },
  ];
  const raw = await chat({ apiKey, model, messages, signal });
  return parseJson(raw);
}

// Responses produced by the parser itself (no game time passes).
const PARSER_ERRORS = [
  /^I don't know the word/,
  /^I can't use the word/,
  /^I don't understand that sentence/,
  /^I can't find a verb/,
  /^I couldn't find a noun/,
  /^I found too many nouns/,
  /^I beg your pardon/,
  /^I can't use multiple/,
  /^Please consult your manual/,
  /^That sentence isn't one I recognize/,
];

export function isParserError(output) {
  const t = output.trim();
  return PARSER_ERRORS.some((re) => re.test(t));
}

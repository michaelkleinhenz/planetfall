// The AI interpreter: replaces the original two-step "type exactly what the
// parser understands" interaction.  The player writes anything; the model
// translates it into one or more commands in the game's own vocabulary, which
// the original (translated) parser and game logic then execute.  All story text
// still comes from the original game.

import { chat } from './openrouter.js';
import { current } from '../engine/current.js';
import { sceneText } from './scene.js';
import { INTERPRETER_RULE } from './immersive.js';

// Debugging/meta syntaxes the AI should never produce.
const HIDDEN = /^(#|\$|script|unscript|verify)/;

function verbReference() {
  const { SYNTAX_HELP, VERB_SYNONYMS } = current.story;
  const lines = SYNTAX_HELP.filter((s) => !HIDDEN.test(s))
    .map((s) => s.replace(/^restar\b/, 'restart').replace(/^restor\b/, 'restore'));
  const syn = Object.entries(VERB_SYNONYMS)
    .filter(([v]) => !HIDDEN.test(v))
    .map(([v, list]) => `${v} = ${list.filter((w) => !/^(shit|fuck|damn)$/.test(w)).join(', ')}`);
  return { patterns: [...new Set(lines)].join(' | '), synonyms: syn.join('; ') };
}


// Every word the original parser knows (full spellings; it compares only the first 6 letters).
const vocabulary = () => [...new Set(Object.values(current.story.FULL_WORDS).flat())]
  .filter((w) => /^[a-z][a-z-]*$/.test(w) && !/^(zzmgck|intnum|shit|fuck|damn)$/.test(w))
  .sort()
  .join(' ');

const buildSystemPrompt = (REF, VOCABULARY, GAME) => `You are the command interpreter for ${GAME}, the ${current.meta.year} Infocom text adventure.
The original game logic and its original text parser run unchanged. Your only job is to translate what the player types (free natural language, any phrasing, typos, other languages) into commands the original parser understands.

HOW THE ORIGINAL PARSER WORKS
- Commands are short imperative sentences: VERB [OBJECT] [PREPOSITION OBJECT], e.g. "take key", "put canteen in niche", "slide kitchen card through slot", "push blue button", "unlock padlock with key", "set dial to 42".
- Movement: north, south, east, west, ne, nw, se, sw, up, down, in, out (also "enter X", "exit").
- Objects are named with the nouns (and optional adjectives) listed in the scene. Prefer an adjective + noun when several things share a noun ("red button").
- "it" refers to the last object mentioned. "all" works with take/drop ("take all").
- Talking to characters: "NAME, go north" or "tell NAME to follow me" -> "NAME, follow me"; "say hello to NAME" -> "hello NAME" / "talk to NAME" (NAME = a character in the scene).
- Useful commands: look, examine X, inventory, wait, again, score, time, diagnose, sleep, read X, open/close X, turn on/off X, wear/remove X, eat/drink X, give X to Y, show X to Y, throw X at Y, save, restore, restart, verbose, brief.
- Known verb patterns (OBJ = object): ${REF.patterns}
- Verb synonyms: ${REF.synonyms}
- The parser knows ONLY these words (plus numbers like 4600); any other word makes it fail with "I don't know the word". Rephrase with these words: ${VOCABULARY}

RULES
1. Output ONLY a JSON object, no prose, no code fences:
   {"commands": ["cmd1", "cmd2"], "reply": "optional short note to the player"}
2. Use as few commands as needed (normally 1; at most 6 for an explicit sequence like "go north twice then open the door").
3. Only use words from the verb list, the scene, directions, or the recent transcript. Never invent objects that are not mentioned anywhere.
4. Never solve puzzles or add actions the player did not ask for. Do not reveal anything the player has not seen.
5. If the game just asked a question (e.g. "Which button do you mean...", "What do you want to put...?", a yes/no question, or RESTART/RESTORE/QUIT after death), answer it with a complete command or the expected word.
6. If the input is already a valid command, pass it through unchanged (fix obvious typos).
7. If the player is chatting, asking about the story so far, or asking what something means, answer briefly in "reply" using only the transcript, and return no commands. Never narrate game outcomes yourself — the game does that.
8. If you cannot map the request to the game at all, return {"commands": [], "reply": "..."} with an in-character response (see VOICE).
9. Resolve references using the transcript: "it", "them", "that one", "the other one", "again", "do the same with X", "go back", and short answers to a question that you (AI:) or the game asked in the previous turn (e.g. you asked for a number and the player replies "4600" -> combine both into one full command). Always write the resolved, explicit command.
10. Never promise what a command will do. Only suggest commands built from the known words and verb patterns.
11. Your whole answer is always the JSON object, even when you only reply to the player.

VOICE OF "reply"
Every "reply" is shown to the player as if the game itself had said it, so it must sound exactly like ${GAME}'s narrator and parser:
- Second person, present tense, dry and wry Infocom humour, short (usually one sentence, at most two).
- Never sound like an assistant or chatbot: no "I can't help with that", "As an AI", "Sure!", "Let me", no apologies, no emoji, no markdown, no quoting of commands like "type X".
- For things the game cannot do, answer like Infocom would, e.g. "You can't do that to a chronometer, no matter how much you'd like to.", "That's not a verb I recognize.", "Your training didn't cover that.", "Time is not something you can adjust."
- For questions about the story, answer briefly in the same narrator voice, using only what the transcript shows.
- Use the player's language if a language is given; otherwise English.`;

// Built once per game (the long, unchanging part of every request).
const promptCache = new Map();
function systemPrompt() {
  if (!promptCache.has(current.id)) {
    promptCache.set(current.id, buildSystemPrompt(verbReference(), vocabulary(), current.meta.title.toUpperCase()));
  }
  return promptCache.get(current.id);
}

function transcriptText(history) {
  const parts = [];
  let budget = 5000;
  for (let i = history.length - 1; i >= 0 && budget > 0; i--) {
    const h = history[i];
    const block = `${h.input ? `PLAYER: ${h.input}\n` : ''}${h.reply ? `AI: ${h.reply}\n` : ''}` +
      `${h.commands?.length ? `COMMANDS: ${h.commands.join(' / ')}\n` : ''}${h.output?.trim() ? `GAME: ${h.output.trim()}` : '(no game command was sent)'}`;
    budget -= block.length;
    parts.unshift(block.length > 1800 ? block.slice(0, 1800) + ' …' : block);
  }
  return parts.join('\n---\n');
}

function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The AI did not return JSON.');
  let obj;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch { throw new Error('The AI did not return valid JSON.'); }
  const commands = Array.isArray(obj.commands) ? obj.commands.map(String).map((c) => c.trim()).filter(Boolean).slice(0, 6) : [];
  return {
    commands,
    reply: typeof obj.reply === 'string' ? obj.reply.trim() : '',
    // Immersive mode: scenery the parser has no word for, to be described.
    describe: typeof obj.describe === 'string' ? obj.describe.trim() : '',
  };
}

/**
 * Translate player input into game commands.
 * @returns {Promise<{commands: string[], reply: string}>}
 */
export async function interpret({ apiKey, model, input, language, scene, history, repair, immersive, signal }) {
  const messages = [
    { role: 'system', content: systemPrompt(), cache: true },
    {
      role: 'user',
      content:
        `RECENT TRANSCRIPT (oldest first):\n${transcriptText(history) || '(game just started)'}\n\n` +
        `CURRENT SCENE (from the game state):\n${sceneText(scene)}\n\n` +
        (repair
          ? `Your previous command "${repair.command}" was rejected by the parser with: "${repair.error.trim()}". ` +
            `Rephrase it using only known words, or return no commands with a reply if it cannot be expressed.\n\n`
          : '') +
        (immersive ? `${INTERPRETER_RULE}\n\n` : '') +
        (language
          ? `LANGUAGE: The player is playing in ${language}. Their input may be in ${language} or English (map it to the English game vocabulary). ` +
            `Write every "reply" in ${language}, always — even if the player writes in English. Commands stay in English.\n\n`
          : '') +
        `PLAYER INPUT: ${input}`,
    },
  ];
  const raw = await chat({ apiKey, model, messages, signal, maxTokens: 1000 });
  try {
    return parseJson(raw);
  } catch {
    // One more try, reminding the model of the format.
    const again = await chat({
      apiKey, model, signal,
      messages: [...messages, { role: 'assistant', content: raw },
        { role: 'user', content: 'Answer again, as the JSON object only: {"commands": [...], "reply": "..."}' }],
    });
    try {
      return parseJson(again);
    } catch {
      // Still prose: treat it as a message to the player rather than a failure.
      const text = (again || raw).trim();
      return { commands: [], reply: text.length > 600 ? text.slice(0, 600) + ' …' : text };
    }
  }
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

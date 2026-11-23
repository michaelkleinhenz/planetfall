# Planetfall AI

Infocom's classic text adventures, **translated line by line from their original ZIL source
into modern JavaScript** and playable in the browser. **An AI model takes the place of
the strict old parser's input rules.** Type what you mean, in English or German, with
typos and all. The AI turns it into commands in the game's own vocabulary, and the
original game logic runs them. Every word of the story, every puzzle and every joke is
Infocom's.

**Play:** https://michaelkleinhenz.github.io/planetfall/

| Game | Year | Source | License of the source |
|---|---|---|---|
| Planetfall | 1983 | `games/planetfall/` | none: shared for education and research |
| Zork I: The Great Underground Empire | 1980 | `games/zork1/` | MIT, © 2025 Microsoft |

## Features

- **AI interpreter (optional):** it uses an [OpenRouter](https://openrouter.ai/keys) API
  key you enter in the settings. Without a key the games run with their original parser.
  - Free-form input: "grab the brush and head up the stairs", "ask Floyd to come along",
    "öffne den Briefkasten".
  - The AI understands references to earlier turns ("it", "the other one", answers to the
    game's questions).
  - If the parser rejects a command, the AI gets one chance to rephrase it. Parser errors
    take no game time, so this is safe.
  - Replies for things the game can't do are written in the game's own narrator voice and
    marked ✦.
- **English or German:** German switches the whole interface. With the AI on, the
  story is translated as you play (tap a passage for the original English), and you can
  type in German.
- **Hints:** the 💡 button, or typing "hint" / "Tipp", gives InvisiClues-style hints
  generated from the game's actual code for your situation. They come at three levels:
  nudge, direction, then solution.
- **Play with buttons:** a quick-action row shows the room's exits, Look / Inventory /
  Wait, and everything in view. Each thing offers only the verbs that fit it. Buttons talk
  to the game directly, without the AI.
- **Built for phones:** the keyboard stays open, and each reply starts at the top of the
  screen. Long replies page with a "More" button instead of scrolling.
- Undo, named save slots, autosave and resume, and a main menu to switch games.
- **Your data stays in your browser:** settings, progress and saves live in
  localStorage, per game, and nothing is sent to any server except your AI requests to
  OpenRouter. There are no cookies, analytics or third-party scripts. The menu can
  download a backup of all your data and restore it, in this or another browser. The API
  key is included only if you tick the box.

## Run locally

```sh
npm start              # serves web/ on http://localhost:8000
npm run play           # Planetfall in the terminal (original parser)
npm run play -- --game zork1
```

There's no build step for the web app: `web/` is plain HTML, CSS and ES modules.
Node.js 18+ is needed for the tools and tests.

```sh
npm run build          # regenerate web/src/games/* from the ZIL sources
npm test               # vocabulary/object-tree check + transcript comparison with the originals
```

## How it works

| Part | Location | What it does |
|---|---|---|
| Original sources | `games/<game>/` | Unmodified ZIL source archives plus the original compiled story files (see `games/README.md`). |
| ZIL → JS compiler | `tools/zil2js/` | Reads the ZIL source and translates every routine (516 in Planetfall, 440 in Zork I) into readable async JavaScript. It also builds each game's data image: object tree, property tables, vocabulary and syntax tables. Per-game settings are in `games.mjs`. |
| Generated games | `web/src/games/<game>/` | `game.js` (the code) and `story-data.js` (the data), plus `registry.js` with per-game metadata for the app. |
| Runtime | `web/src/engine/` | The Z-machine-style primitives the translated code calls: objects, properties, tables, text, the tokenizer, save/restore and a seeded RNG. Also the session that turns the game's input loop into request/response. |
| AI | `web/src/ai/` | OpenRouter client (with prompt caching), command interpreter, live translation, scene description and hints. |
| Web app | `web/` | Menu, transcript, quick actions, settings, storage and backups. Fonts are self-hosted (SIL OFL, `web/fonts/`). |
| Tests | `tests/` | Recorded command sequences with the original games' output. |

### Faithfulness

The translated games behave exactly like the original releases. `npm test` replays about
11,000 recorded commands, a walkthrough plus random play from several checkpoints per
game, through the JavaScript version. It compares the output line for line with
transcripts from the original story files (Planetfall release 39, Zork I release 119),
run in the [ifvms](https://github.com/curiousdannii/ifvms.js) Z-machine interpreter. Both
sides seed the random number generator through the games' own `#random` command.

The compiler reproduces several details of the original ZILCH compiler, each confirmed
against the originals:
- `<RETURN value>` inside a loop returns from the routine;
- object numbers come from the original story file or compiler listing;
- tables can mix byte and word entries;
- sentence spacing is collapsed.

The recorded runs cover roughly the first half of each game. The rest went through the same
compiler but hasn't been compared transcript by transcript yet.

## Deployment

`.github/workflows/pages.yml` runs on every push to `master`. It rebuilds the games from
source, runs the tests, and publishes `web/` to GitHub Pages. Before upload,
`tools/stamp.mjs` adds the commit id to every script and stylesheet URL, so a normal
reload always picks up a new release despite GitHub Pages' ten-minute caching. The site
is fully static and needs no secrets.

## Licenses and credits

- **Planetfall** © 1983 Infocom, Inc. The source comes from
  [historicalsource/planetfall](https://github.com/historicalsource/planetfall), which
  shares it for education and research and states that it is not under an open license.
- **Zork I** © Infocom, Inc. The source is under the MIT License, © 2025 Microsoft
  ([historicalsource/zork1](https://github.com/historicalsource/zork1)). The license is
  reproduced in `games/zork1/LICENSE` and next to the generated code.
- The box art in `web/img/covers/` is the original packaging artwork (© Infocom/Activision,
  now Microsoft). It isn't covered by any license in this repository.
- Fonts: Literata, Inter and JetBrains Mono, under the SIL Open Font License.
- The converter, runtime, AI layer and web app in `tools/`, `web/` (except the generated
  games, fonts and covers) and `tests/` were written for this project.

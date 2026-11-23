# Planetfall AI

Infocom's classic text adventures, **translated line by line from their original ZIL source
into modern JavaScript** and playable in the browser. **An AI model takes the place of
the strict old parser's input rules.** Type what you mean, in English or German, with
typos and all. The AI turns it into commands in the game's own vocabulary, and the
original game logic runs them. Every word of the story, every puzzle and every joke is
Infocom's.

**Play:** https://michaelkleinhenz.github.io/planetfall/

All 27 Infocom games whose ZIL source is public and that ran on version 3 of the
Z-machine are included:

| Game | Year | Author | Source | Compared with | Result |
|---|---|---|---|---|---|
| Zork I: The Great Underground Empire | 1980 | Marc Blank & Dave Lebling | `games/zork1/` | r119 | identical |
| Zork II: The Wizard of Frobozz | 1981 | Marc Blank & Dave Lebling | `games/zork2/` | r63 | identical |
| Deadline | 1982 | Marc Blank | `games/deadline/` | r28 | identical except the banner |
| Starcross | 1982 | Dave Lebling | `games/starcross/` | r18 | identical except the banner |
| Zork III: The Dungeon Master | 1982 | Marc Blank & Dave Lebling | `games/zork3/` | r25 | identical |
| Enchanter | 1983 | Marc Blank & Dave Lebling | `games/enchanter/` | r29 | identical except one banner line |
| Infidel | 1983 | Michael Berlyn & Patricia Fogleman | `games/infidel/` | r22 | source is a later revision: some messages differ |
| Planetfall | 1983 | Steve Meretzky | `games/planetfall/` | r39 | identical |
| Suspended | 1983 | Michael Berlyn | `games/suspended/` | r8 | source is a later revision (1985): parser messages differ |
| The Witness | 1983 | Stu Galley | `games/witness/` | r21 | source is a later revision: vocabulary and messages differ |
| Cutthroats | 1984 | Michael Berlyn & Jerry Wolper | `games/cutthroats/` | r25 | identical except the banner |
| Infocom Sampler | 1984 | Infocom | `games/infocom-sampler/` | — | the archive's story file is an earlier sampler |
| Seastalker | 1984 | Stu Galley & Jim Lawrence | `games/seastalker/` | r16 | identical except the banner |
| Sorcerer | 1984 | Steve Meretzky | `games/sorcerer/` | r18 | identical |
| Suspect | 1984 | Dave Lebling | `games/suspect/` | r18 | identical except the banner (until the first restart) |
| The Hitchhiker's Guide to the Galaxy | 1984 | Douglas Adams & Steve Meretzky | `games/hitchhikersguide/` | r60 | identical |
| Spellbreaker | 1985 | Dave Lebling | `games/spellbreaker/` | r87 | identical |
| Wishbringer: The Magick Stone of Dreams | 1985 | Brian Moriarty | `games/wishbringer/` | r69 | identical except one banner line |
| Ballyhoo | 1986 | Jeff O'Neill | `games/ballyhoo/` | r99 | identical |
| Hollywood Hijinx | 1986 | Dave Anderson & Liz Cyr-Jones | `games/hollywoodhijinx/` | r37 | identical |
| Leather Goddesses of Phobos | 1986 | Steve Meretzky | `games/leathergoddesses/` | r59 | identical |
| Moonmist | 1986 | Stu Galley & Jim Lawrence | `games/moonmist/` | r13 | identical |
| Mini-Zork I | 1987 | Marc Blank & Dave Lebling | `games/minizork-1987/` | r34 | identical |
| Plundered Hearts | 1987 | Amy Briggs | `games/plunderedhearts/` | r26 | identical |
| Stationfall | 1987 | Steve Meretzky | `games/stationfall/` | — | no original story file in the archive |
| The Lurking Horror | 1987 | Dave Lebling | `games/lurkinghorror/` | r221 | identical |
| Mini-Zork II | 1988 | Marc Blank & Dave Lebling | `games/minizork2-1988/` | r2 | identical |

"Compared with" is the original release in the source archive; "identical" means a
300–600 command random play-through gives exactly the same transcript in the original
and the translation (see *Faithfulness*). Where the archived source is a later revision
than the only surviving story file, the differences are that revision's changes.

Not included yet: the games written for later versions of the Z-machine (A Mind Forever
Voyaging, Trinity, Bureaucracy, Border Zone, Sherlock, Nord and Bert, Beyond Zork, the
Solid Gold editions, and the graphical Zork Zero, Shōgun, Journey and Arthur), and the
original mainframe Zork, which is written in MDL rather than ZIL.

Licenses: only the Zork I, II and III sources are under an open license (MIT, © 2025
Microsoft). All others are shared by historicalsource for education and research and are
"not considered to be under an open license". The menu shows each game's license.

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
npm run play -- --game zork1   # any id from tools/zil2js/games.mjs
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

The translated games behave like the original releases. To check that, the original story
files are run in the [ifvms](https://github.com/curiousdannii/ifvms.js) Z-machine
interpreter with the same commands, and the transcripts are compared line by line: a
walkthrough plus random play from several checkpoints for Planetfall and Zork I (about
11,000 commands), and 300–600 commands of random play for every other game (results in
the table above). Both sides seed the random number generator the same way, through the
games' own `#random` command or directly in the interpreter. `npm test` replays all
recorded runs (about 18,000 commands) against the recorded transcripts.

The compiler reproduces the details of the original ZILCH compiler these comparisons
turned up, among them:
- `<RETURN value>` inside a loop returns from the routine, except in games built with an
  older compiler (Infidel, Deadline, Starcross, Cutthroats, Suspect, the Sampler), where it
  leaves the loop;
- object numbers, attribute numbers and the order of syntax entries come from the original
  story file; the game's own macros (TELL, VERB?, PSEUDO, ...) run in a small MDL
  interpreter at compile time;
- later compiler features: compact syntax tables, TELL-TOKENS, MAP-CONTENTS, DO loops,
  LOWCORE, BIT-SYNONYM and the like.

Random play covers a part of each game. The rest went through the same compiler but hasn't
been compared transcript by transcript.

## Deployment

`.github/workflows/pages.yml` runs on every push to `master`. It rebuilds the games from
source, runs the tests, and publishes `web/` to GitHub Pages. Before upload,
`tools/stamp.mjs` adds the commit id to every script and stylesheet URL, so a normal
reload always picks up a new release despite GitHub Pages' ten-minute caching. The site
is fully static and needs no secrets.

## Licenses and credits

- The games are © Infocom, Inc. (now Microsoft). Their sources come from the
  [historicalsource](https://github.com/historicalsource) collections. Zork I, II and III
  are under the MIT License, © 2025 Microsoft (reproduced in `games/zork*/LICENSE` and next
  to the generated code). All other sources are shared for education and research and are
  stated not to be under an open license.
- The box art in `web/img/covers/` is the original packaging artwork (© Infocom/Activision,
  now Microsoft). It isn't covered by any license in this repository.
- Fonts: Literata, Inter and JetBrains Mono, under the SIL Open Font License.
- The converter, runtime, AI layer and web app in `tools/`, `web/` (except the generated
  games, fonts and covers) and `tests/` were written for this project.

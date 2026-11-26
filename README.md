# Planetfall AI

Infocom's classic text adventures, **translated line by line from their original ZIL source
into modern JavaScript** and playable in the browser. **An AI model takes the place of
the strict old parser's input rules.** Type what you mean, in English or German, with
typos and all. The AI turns it into commands in the game's own vocabulary, and the
original game logic runs them. Every word of the story, every puzzle and every joke is
Infocom's.

**Play:** https://michaelkleinhenz.github.io/planetfall/

All 31 Infocom text games whose ZIL source is public and that ran on versions 3 to 5 of
the Z-machine are included (the demos, Mini-Zork I and II and the Sampler, are left out):

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
| Plundered Hearts | 1987 | Amy Briggs | `games/plunderedhearts/` | r26 | identical |
| Stationfall | 1987 | Steve Meretzky | `games/stationfall/` | — | no original story file in the archive |
| The Lurking Horror | 1987 | Dave Lebling | `games/lurkinghorror/` | r221 | identical |
| A Mind Forever Voyaging | 1985 | Steve Meretzky | `games/amfv/` | r77 | identical except the indentation of one list |
| Trinity | 1986 | Brian Moriarty | `games/trinity/` | r15 | identical except one line about the bird woman |
| Bureaucracy | 1987 | Douglas Adams & Michael Bywater | `games/bureaucracy/` | r160 | not compared: the reference interpreter can't show the licence form |
| Nord and Bert Couldn't Make Head or Tail of It | 1987 | Jeff O'Neill | `games/nordandbert/` | r20 | identical |
| Beyond Zork: The Coconut of Quendor | 1987 | Brian Moriarty | `games/beyondzork/` | r60 | not compared: the reference interpreter stops at the character setup |
| Border Zone | 1987 | Marc Blank | `games/borderzone/` | r9 | identical |
| Sherlock: The Riddle of the Crown Jewels | 1987 | Bob Bates | `games/sherlock/` | — | no original story file in the archive |

"Compared with" is the original release in the source archive; "identical" means a
300–600 command random play-through gives exactly the same transcript in the original
and the translation (see *Faithfulness*). Where the archived source is a later revision
than the only surviving story file, the differences are that revision's changes.

Not included: the Solid Gold editions (re-releases of games above), the graphical
version 6 games (Zork Zero, Shōgun, Journey and Arthur), and the original mainframe Zork,
which is written in MDL rather than ZIL.

The version 4 and 5 games draw in an upper window: status lines, Bureaucracy's forms,
Beyond Zork's room box, map and character sheet. The app shows it as a panel above the
transcript; Beyond Zork's graphics font becomes Unicode box and block characters, and the
arrow keys work in its menus. Border Zone's real-time clock is not used: the AI may take a
few seconds per command, so time passes per turn, as in interpreters without timer support.

Licenses: only the Zork I, II and III sources are under an open license (MIT, © 2025
Microsoft). All others are shared by historicalsource for education and research and are
"not considered to be under an open license". The menu shows each game's license.

### Magnetic Scrolls games

Six Magnetic Scrolls adventures are included too. Three are built from the 68000 assembly
source that Strand Games released with their remasters:

| Game | Year | Author | Source | Compared with |
|---|---|---|---|---|
| The Pawn | 1985 | Rob Steggles | `games/magnetic/src/pawn/` | v2.3 (`pa23pc.mag`) |
| The Guild of Thieves | 1987 | Rob Steggles | `games/magnetic/src/guild/` | v1.1 (`gu11pc.mag`) |
| Jinxter | 1987 | Georgina Sinclair & Michael Bywater | `games/magnetic/src/jinxter/` | v1.1 (`ji11pc.mag`) |

These are not translated: `npm run build:magnetic` compiles Magnetic Scrolls' own
assembler and linker (C, from the same release; needs a C compiler, make and flex),
assembles and links each game exactly as its makefile says, and the browser runs the
resulting 68000 program in a small JavaScript 68000 core (`web/src/engine/ms/`), with the
game's host calls (text, input, save, restore) answered by the app. The noun table,
dictionary and symbol table of the program give the app what it needs for the status
line, the map, the quick actions and the AI parser. The source is the remastered one, so
the games differ from the 1980s releases where Strand Games changed them: room
descriptions list their exits, some messages were reworded, and Jinxter has 215 points
instead of 205. The original releases in `games/magnetic/original/` are only used for
comparison.

The pictures come from the original releases' picture files (`web/img/pictures/*.gfx`)
and are decoded in the browser (`web/src/engine/ms/pictures.js`). The game itself says
which picture belongs to a room (its `PICTURE_INDEX` table and the `LOAD_PIC` host call),
and the app shows it in the transcript above the text, at the original resolution scaled
up without smoothing. The settings can turn them off.

The source is under the Voidware Public Source Licence 1.0, for non-commercial use only
(see `games/magnetic/README.md`).

Corruption, Fish! and Myth have no released source, so they run from their original
game files (`games/magnetic/original/*.mag`), unchanged:

| Game | Year | Author | Game file |
|---|---|---|---|
| Corruption | 1988 | Rob Steggles & Hugh Steers | v1.11 (`corrupt.mag`) |
| Fish! | 1988 | John Molloy, Pete Kemp, Phil South & Rob Steggles | v1.07 (`fish.mag`) |
| Myth | 1989 | Paul Findley | v1.0 (`myth.mag`) |

Without a symbol table, the build finds what the app needs by playing the game:
`tools/magnetic/probe.mjs` walks every exit from the start, finds the word that holds the
room number and the table of exits (the map), and `tools/magnetic/games.mjs` records them.
The status line (room, score and moves, or Corruption's clock) is the one the game prints,
and a room's picture is the one the game draws there. The noun table has no adjectives in
these releases, so things with the same name (Fish!'s three warps) get one action button.
Wonderland (a later game format with animated pictures) is not included yet.

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
- **Immersive mode (optional, per game):** switched on in the settings for the game you
  are playing. Where the game has nothing to say ("You see nothing special about it" for
  the posters The Lurking Horror's terminal room mentions), the AI adds a few sentences of
  atmosphere in the game's voice, consistent with what the game described. Like the hints,
  it reads the game code for the current situation: when the thing you look at really
  connects to a next step, it may slip in one subtle, true detail that turns your attention
  the right way (never the solution, never a false lead). It never invents objects or
  exits; the text is set apart and marked ✦, and the same thing is described the same way
  each time.
- **English or German:** German switches the whole interface. With the AI on, the
  story is translated as you play (tap a passage for the original English), and you can
  type in German.
- **Hints:** the 💡 button, or typing "hint" / "Tipp", gives InvisiClues-style hints
  generated from the game's actual code for your situation. They come at three levels:
  nudge, direction, then solution.
- **Play with buttons:** a quick-action row shows the room's exits, Look / Inventory /
  Wait, and everything in view. Each thing offers only the verbs that fit it. Buttons talk
  to the game directly, without the AI.
- **Installable app:** the main game list offers *Install as an app* (Chrome, Edge,
  Android; on iPhone and iPad it shows how to add it to the home screen). The installed
  app opens full screen from its icon, starts fast, and plays offline: the app is cached
  at install, and all 31 games (about 4.5 MB) download in the background right after
  (the menu shows the progress; skipped when the browser asks to save data). Every file
  is versioned by its content, so an update downloads only what changed.
- **Built for phones:** the keyboard stays open, and each reply starts at the top of the
  screen. Long replies page with a "More" button instead of scrolling.
- **Automap (desktop):** a panel beside the story draws the rooms you have visited and
  the ways between them as you play, with stubs for exits you haven't taken yet. Drag to
  move it, scroll or use +/− to zoom; the 🗺 button in the toolbar shows or hides it. It
  isn't shown on phones and tablets. It only knows what you have seen, so it gives
  nothing away.
- **80s mode:** a switch on the main game list (and in the settings) turns the whole app
  into a 1984 TV ident: phosphor glow on black, scanlines and an aperture grille, sliced
  neon lettering, slanted rainbow stripes, terminal type and a CRT that powers on. Optional
  soundscapes, synthesized live in the browser (no audio files): a synthwave track, or a
  1980s computer room whose floppy drive chatters while the game or the AI is thinking;
  plus key clicks and blips, with a volume control.
- **Title sequence:** a new game opens with its original box cover as a 3D card that
  flips in, tilts with the pointer and catches the light, over a backdrop and sparkles in
  the cover's own colours; the title is set letter by letter. *Begin* (or Enter) sends the
  card flying and the story fades in. Respects reduced-motion settings.
- Undo, named save slots, autosave and resume, and a main menu to switch games.
- **Debug reports:** Settings → *Report a problem* downloads a file that describes the
  current state: the inputs sent to the game with its raw replies, the full game state
  before each of the last turns, the scene, the transcript (with the commands the AI
  sent) and any errors. The API key is never included. `node tools/debug-report.mjs
  report.json` replays it exactly and shows where the result differs.
- **Manuals and feelies:** several games need items from their original package to be
  played (maps, codes, documents). Each game links to its page in the
  [Infocom Gallery](https://gallery.guetech.org/greybox.html) (Magnetic Scrolls games: the
  [Magnetic Scrolls Memorial](https://msmemorial.if-legends.org/)), on the menu card and
  with the 📖 button in the game's toolbar.
- **Pictures:** the Magnetic Scrolls games show their original pictures in the transcript,
  decoded from the original picture files.
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
npm run build:magnetic # rebuild the Magnetic Scrolls games from their 68000 source
npm test               # vocabulary/object-tree check + transcript comparison with the originals
```

## How it works

| Part | Location | What it does |
|---|---|---|
| Original sources | `games/<game>/` | Unmodified ZIL source archives plus the original compiled story files (see `games/README.md`). |
| ZIL → JS compiler | `tools/zil2js/` | Reads the ZIL source and translates every routine (516 in Planetfall, 440 in Zork I) into readable async JavaScript. It also builds each game's data image: object tree, property tables, vocabulary and syntax tables. Per-game settings are in `games.mjs`. |
| Generated games | `web/src/games/<game>/` | `game.js` (the code) and `story-data.js` (the data), plus `registry.js` with per-game metadata for the app. |
| Magnetic Scrolls | `tools/magnetic/`, `web/src/engine/ms/` | Builds The Pawn, The Guild of Thieves and Jinxter from their 68000 source, prepares Corruption, Fish! and Myth from their original game files, and runs them in a JavaScript 68000 core. |
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
recorded runs (about 20,000 commands) against the recorded transcripts.

The compiler reproduces the details of the original ZILCH compiler these comparisons
turned up, among them:
- `<RETURN value>` inside a loop returns from the routine, except in games built with an
  older compiler (Infidel, Deadline, Starcross, Cutthroats, Suspect, Suspended, The Witness), where it
  leaves the loop;
- object numbers, attribute numbers and the order of syntax entries come from the original
  story file; the game's own macros (TELL, VERB?, PSEUDO, ...) run in a small MDL
  interpreter at compile time;
- later compiler features: compact syntax tables, TELL-TOKENS, MAP-CONTENTS, DO loops,
  LOWCORE, BIT-SYNONYM and the like.
- flags that no object has (so they can't be matched by object) take their numbers from
  the original syntax tables: GWIM compares a syntax's FIND flag with RMUNGBIT, and a
  syntax without FIND has 0, so a wrong number made a bare verb ("open") act on nothing;
- the version 4/5 data formats (14-byte objects, 9-letter dictionary words, compact
  vocabularies) and MDL-ZIL, the Lisp-like dialect Bureaucracy is written in (DEFINE,
  DEFSTRUCT, DEFINE-GLOBALS and compile-time code that builds its forms).

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
- The Magnetic Scrolls games are © Magnetic Scrolls; the source of The Pawn, The Guild of
  Thieves and Jinxter was released by Strand Games under the Voidware Public Source
  Licence 1.0, for non-commercial use only (`games/magnetic/README.md`). The game files of
  Corruption, Fish! and Myth are the original releases and are not covered by any license
  in this repository.
- The box art in `web/img/covers/` is the original packaging artwork (© Infocom/Activision,
  now Microsoft; The Pawn, The Guild of Thieves, Jinxter, Corruption, Fish! and Myth © Magnetic Scrolls/Rainbird).
  The Magnetic Scrolls pictures in `web/img/pictures/` are from the original releases
  (© Magnetic Scrolls). Neither is covered by any license in this repository.
- The manuals and feelies are linked, not included: the
  [Infocom Gallery](https://gallery.guetech.org/greybox.html) and the
  [Magnetic Scrolls Memorial](https://msmemorial.if-legends.org/).
- Fonts: Literata, Inter and JetBrains Mono, plus Orbitron and VT323 for the 80s mode, all under the SIL Open Font License.
- The converter, runtime, AI layer and web app in `tools/`, `web/` (except the generated
  games, fonts and covers) and `tests/` were written for this project.

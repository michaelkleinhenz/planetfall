# Planetfall AI — the 1983 classic in modern JavaScript, with an AI interpreter

This fork adds a playable web version of Planetfall in which **an AI model replaces the
original text parser's strict input requirements**. Type whatever you like ("grab the brush
and head up the stairs", "ask Floyd to come along", typos, even other languages). The model
translates it into commands in the game's own vocabulary, and **the original game logic and
parser, translated to JavaScript, execute them**. Every line of story text, every puzzle and
every riddle is Infocom's original.

## Play

```sh
npm start            # serves web/ on http://localhost:8000
```

Any static file server works (`web/` uses plain ES modules, no build step). Open the
settings (⚙) and paste an [OpenRouter](https://openrouter.ai/keys) API key to turn on the
AI interpreter. Without a key, the game runs with the classic parser.

- The key is stored only in your browser (localStorage) and sent only to openrouter.ai.
- Pick any OpenRouter model. Left empty, one is chosen from a preference list.
- Start a line with `>` to bypass the AI and talk to the original parser directly.
- The UI also has undo (Ctrl+Z), named save slots, autosave/resume, and optionally shows
  the commands the AI sent to the game.

Terminal play (classic parser): `npm run play`.

## How it works

| Part | Location | What it does |
|---|---|---|
| ZIL → JS compiler | `tools/zil2js/` | Reads the original `.zil` sources and translates all 516 routines into readable async JavaScript. It also builds the game's data image: object tree, property tables, vocabulary and syntax tables. |
| Generated game | `web/src/game/planetfall.js`, `story-data.js` | The translated game. Regenerate with `npm run build`. |
| Runtime | `web/src/engine/` | The Z-machine-style primitives the code relies on (objects, properties, tables, text, tokenizer, save/restore, seeded RNG) and a session wrapper. |
| AI interpreter | `web/src/ai/` | Builds a scene description from the live game state (location, inventory, visible objects with their nouns and adjectives) plus the recent transcript. It asks the model for JSON `{commands, reply}`. If the original parser rejects a command, it gives the model one chance to rephrase, which is safe because parser errors take no game time. |
| Web app | `web/index.html`, `web/src/app.js` | The browser front end. |

### Faithfulness

The translation keeps the original ZILCH compiler's semantics: for example `<RETURN value>`
inside a loop returns from the routine. Object numbering and the vocabulary/object-tree
layout are cross-checked against the original compiler's data listing
(`planetfalldat.zap`; run `npm run verify`).

`npm test` replays about 5,500 recorded commands through the JavaScript version. These are
one walkthrough plus random play from several checkpoints, including deaths, restarts,
sleeping and dreams. The test compares the output line for line with transcripts recorded
from the original compiled story file `COMPILED/planetfall.z3` (release 39). Both runs seed
the RNG via the game's own `#random` command. The recorded paths cover the first half of
the game: the Feinstein, the escape pod, the Kalamontee complex, Floyd, the elevators and
the tower. The rest uses the same compiler but has not been compared transcript by
transcript yet.

Source fix-ups applied at compile time (documented in `tools/zil2js/compile.mjs`):
`comptwo.zil` is truncated in the last object definition, and its ending is restored from
`comptwo.zabstr`. A stray `Y` atom in `SLOT-F` is ignored.

---

# Planetfall Source Code Collection

Planetfall is a 1983 interactive fiction game written by Steve Meretzky and published by Infocom.

Further information on Planetfall:

* [Wikipedia](https://en.wikipedia.org/wiki/Planetfall)
* [The Digital Antiquarian](https://www.filfre.net/2013/03/planetfall/)
* [The Interactive Fiction Database](https://ifdb.tads.org/viewgame?id=xe6kb3cuqwie2q38)
* [The Infocom Gallery](http://infocom.elsewhere.org/gallery/planetfall/planetfall.html)
* [IFWiki](http://www.ifwiki.org/index.php/Planetfall)

__What is this Repository?__

This repository is a directory of source code for the Infocom game "Planetfall", including a variety of files both used and discarded in the production of the game. It is written in ZIL (Zork Implementation Language), a refactoring of MDL (Muddle), itself a dialect of LISP created by MIT students and staff.

The source code was contributed anonymously and represents a snapshot of the Infocom development system at time of shutdown - there is no remaining way to compare it against any official version as of this writing, and so it should be considered canonical, but not necessarily the exact source code arrangement for production.

__Basic Information on the Contents of This Repository__

It is mostly important to note that there is currently no known way to compile the source code in this repository into a final "Z-machine Interpreter Program" (ZIP) file. There are .ZIP files in some of the Infocom Source Code repositories but they were there as of final spin-down of the Infocom Drive and the means to create them is currently lost.

Throughout its history, Infocom used a TOPS20 mainframe with a compiler (ZILCH) to create and edit language files - this repository is a mirror of the source code directory archive of Infocom but could represent years of difference from what was originally released.

In general, Infocom games were created by taking previous Infocom source code, copying the directory, and making changes until the game worked the way the current Implementor needed. Structure, therefore, tended to follow from game to game and may or may not accurately reflect the actual function of the code.

There are also multiple versions of the "Z-Machine" and code did change notably between the first years of Infocom and a decade later. Addition of graphics, sound and memory expansion are all slowly implemented over time.

__What is the Purpose of this Repository__

This collection is meant for education, discussion, and historical work, allowing researchers and students to study how code was made for these interactive fiction games and how the system dealt with input and processing. It is not considered to be under an open license.

Researchers are encouraged to share their discoveries about the information in this source code and the history of Infocom and its many innovative employees.

__Some Trivia and Notes on this Repository__

* First game created by Steve Meretzky after working as a tester for Infocom.

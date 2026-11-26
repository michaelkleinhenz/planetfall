# Magnetic Scrolls sources

`src/` holds the 68000 assembly source of The Pawn, The Guild of Thieves and Jinxter, as
released by Strand Games with their remasters (repository `strandgames/brahman`, commit
c65909352f77af300de5e2d8ec72d58705ce5eb6), together with what is needed to build them:

- `nonalterable/`: the shared adventure system used by The Pawn and The Guild of Thieves;
- `newcommonlast/`: the later shared system used by Jinxter;
- `pawn/`, `guild/`, `jinxter/`: each game's own code, text and noun data;
- `tools/as68`, `tools/lnk`: Magnetic Scrolls' assembler and linker (C);
- `tools/fred23jr`: their noun-table compiler (not needed for the build: the generated
  tables are part of the release).

Two files of the release were left out: a Windows binary (`kl.exe`) and a map image.

`original/` holds the original PC releases (`pa23pc.mag`, `gu11pc.mag`, `ji11pc.mag`),
which are only used to compare transcripts.

`npm run build:magnetic` builds the games into `web/src/games/<id>/`
(see `tools/magnetic/build.mjs`).

## License

The source is © Magnetic Scrolls and was released by Strand Games under the
Voidware Public Source Licence 1.0, which allows use, modification and redistribution for
non-commercial purposes only. The text of the licence is not yet included here: it could
not be downloaded when these files were added, and should be added as `LICENSE`.

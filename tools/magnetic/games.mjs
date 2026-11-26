// The Magnetic Scrolls games built by tools/magnetic/build.mjs.
//   dir       - the game's folder in games/magnetic/src
//   makefile  - true: built by its makefile; false: from its link list (lfile)
//   search    - include/source folders (relative to games/magnetic/src)
//   text      - the game's message file (one message per line)
//   netSize   - bytes per room in the NETWORK (exits) table: N NE E SE S SW W NW U D [IN OUT]
//   scoreScale- the status line shows SCORE_ times this
//   original  - the original release in games/magnetic/original (reference for tests)
//
// Games whose program source was never released run from their original
// release instead ("mag": the .mag file in games/magnetic/original).  Without
// a symbol table, the few addresses the app reads were found with
// tools/magnetic/probe.mjs:
//   room      - the word holding the player's room number (ROOM)
//   network   - the exits table (NETWORK), netSize bytes per room
//   rooms     - number of rooms (the largest room noun location)
//   clock     - the status line shows a time of day instead of score/moves

export const GAMES = {
  pawn: {
    id: 'pawn', title: 'The Pawn', year: '1985, 1986', dir: 'pawn', makefile: true,
    search: ['pawn/last', 'nonalterable'], text: 'pawn/text/pawn.text',
    netSize: 10, scoreScale: 5, original: 'pa23pc.mag', pictureIndex: 'rooms',
  },
  guild: {
    id: 'guild', title: 'The Guild of Thieves', year: '1987', dir: 'guild', makefile: true,
    search: ['guild/last', 'nonalterable'], text: 'guild/text/guild.text',
    netSize: 12, original: 'gu11pc.mag',
  },
  jinxter: {
    id: 'jinxter', title: 'Jinxter', year: '1987', dir: 'jinxter', makefile: false,
    search: ['jinxter/last', 'newcommonlast'], text: 'jinxter/text/magic.text',
    netSize: 12, original: 'ji11pc.mag',
  },
  corruption: {
    id: 'corruption', title: 'Corruption', year: '1988', mag: 'corrupt.mag',
    room: 0x29a, network: 0x1a0c, netSize: 12, clock: true,
  },
  fish: {
    id: 'fish', title: 'Fish!', year: '1988', mag: 'fish.mag',
    room: 0x4a4, network: 0x198e, netSize: 12,
  },
  myth: {
    id: 'myth', title: 'Myth', year: '1989', mag: 'myth.mag',
    room: 0x28a, network: 0xfd4, netSize: 12,
  },
};

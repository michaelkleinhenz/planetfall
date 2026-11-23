// Per-game configuration for the ZIL -> JavaScript compiler.
//
// Each entry describes where a game's ZIL source lives, in which order the
// files are inserted (as the game's main .zil file does), which compile-time
// switches are on, and which original story file to take object numbering and
// release information from.

export const GAMES = {
  planetfall: {
    title: 'Planetfall',
    srcDir: '.',
    files: ['syntax', 'misc', 'globals', 'parser', 'verbs', 'compone', 'comptwo', 'planetfall'],
    fixups: {
      // comptwo.zil is truncated in the middle of the last object (TRIFFID);
      // comptwo.zabstr shows the intended ending.
      comptwo: (text) => text.replace(/\(FLAGS ACTORBIL M\s*$/, '(FLAGS ACTORBIT)>\n'),
    },
    assigned: ['PREDGEN', 'ZILCH'],
    values: {},
    // <PROB n>: Planetfall's macro is <NOT <L? n <RANDOM 100>>>, i.e. random <= n.
    prob: 'le',
    // ZILCH's data listing (object numbers). Planetfall ships one.
    objectOrder: { zap: 'planetfalldat.zap' },
    storyFile: 'COMPILED/planetfall.z3',
  },
  zork1: {
    title: 'Zork I',
    licenseNotice: 'Zork I source: MIT License, Copyright (c) 2025 Microsoft. See LICENSE in this directory.',
    srcDir: 'games/zork1',
    files: ['gmacros', 'gsyntax', '1dungeon', 'gglobals', 'gclock', 'gmain', 'gparser', 'gverbs', '1actions', 'zork1'],
    fixups: {},
    assigned: ['PREDGEN', 'ZILCH'],
    values: { 'ZORK-NUMBER': 1 },
    // <PROB n> is <G? n <RANDOM 100>>, i.e. random < n; <PROB n T> calls ZPROB.
    prob: 'lt',
    // This ZILCH version stores 1 as the value of a noun (its WT? reads it).
    nounValue: 1,
    objectOrder: { story: 'COMPILED/zork1.z3' },
    storyFile: 'COMPILED/zork1.z3',
  },
};

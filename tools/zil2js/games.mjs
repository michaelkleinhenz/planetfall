// Per-game configuration for the ZIL -> JavaScript compiler.
//
// Each entry describes where a game's ZIL source lives, in which order the
// files are inserted (as the game's main .zil file does), which compile-time
// switches are on, and which original story file to take object numbering and
// release information from.

export const GAMES = {
  planetfall: {
    title: 'Planetfall',
    srcDir: 'games/planetfall',
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
    main: 'zork1',
    objectOrder: { story: 'COMPILED/zork1.z3' },
    storyFile: 'COMPILED/zork1.z3',
  },

  'ballyhoo': {
    title: "Ballyhoo",
    srcDir: 'games/ballyhoo',
    main: 'm4',
    objectOrder: { story: 'COMPILED/m4.z3' },
    storyFile: 'COMPILED/m4.z3',
  },
  'cutthroats': {
    title: "Cutthroats",
    srcDir: 'games/cutthroats',
    main: 'toa',
    objectOrder: { story: 'COMPILED/toa.z3' },
    oldReturn: true,
    storyFile: 'COMPILED/toa.z3',
  },
  'deadline': {
    title: "Deadline",
    srcDir: 'games/deadline',
    main: 'deadline',
    objectOrder: { story: 'COMPILED/dead-deadline.z3' },
    oldReturn: true,
    storyFile: 'COMPILED/dead-deadline.z3',
  },
  'enchanter': {
    title: "Enchanter",
    srcDir: 'games/enchanter',
    main: 'enchanter',
    objectOrder: { story: 'COMPILED/enchanter.z3' },
    storyFile: 'COMPILED/enchanter.z3',
  },
  'hitchhikersguide': {
    title: "The Hitchhiker's Guide to the Galaxy",
    srcDir: 'games/hitchhikersguide',
    main: 's4',
    objectOrder: { story: 'COMPILED/s4.z3' },
    storyFile: 'COMPILED/s4.z3',
  },
  'hollywoodhijinx': {
    title: "Hollywood Hijinx",
    srcDir: 'games/hollywoodhijinx',
    main: 'anthill',
    objectOrder: { story: 'COMPILED/anthill.z3' },
    storyFile: 'COMPILED/anthill.z3',
  },
  'infidel': {
    title: "Infidel",
    srcDir: 'games/infidel',
    main: 'infidel',
    objectOrder: { story: 'COMPILED/infidel.z3' },
    // Compiled with an older ZILCH: <RETURN value> leaves the loop.
    oldReturn: true,
    storyFile: 'COMPILED/infidel.z3',
  },
  'leathergoddesses': {
    title: "Leather Goddesses of Phobos",
    srcDir: 'games/leathergoddesses',
    main: 'x1',
    objectOrder: { story: 'COMPILED/x1.z3' },
    storyFile: 'COMPILED/x1.z3',
  },
  'lurkinghorror': {
    title: "The Lurking Horror",
    srcDir: 'games/lurkinghorror',
    main: 'h1',
    objectOrder: { story: 'COMPILED/h1.z3' },
    storyFile: 'COMPILED/h1.z3',
  },
  'moonmist': {
    title: "Moonmist",
    srcDir: 'games/moonmist',
    main: 'm5',
    objectOrder: { story: 'COMPILED/m5.z3' },
    storyFile: 'COMPILED/m5.z3',
  },
  'plunderedhearts': {
    title: "Plundered Hearts",
    srcDir: 'games/plunderedhearts',
    main: 'r1',
    objectOrder: { story: 'COMPILED/r1.z3' },
    storyFile: 'COMPILED/r1.z3',
  },
  'seastalker': {
    title: "Seastalker",
    srcDir: 'games/seastalker',
    main: 'seastalker',
    objectOrder: { story: 'COMPILED/seastalker.z3' },
    storyFile: 'COMPILED/seastalker.z3',
  },
  'sorcerer': {
    title: "Sorcerer",
    srcDir: 'games/sorcerer',
    main: 'sorcerer',
    objectOrder: { story: 'COMPILED/sorcerer.z3' },
    storyFile: 'COMPILED/sorcerer.z3',
  },
  'spellbreaker': {
    title: "Spellbreaker",
    srcDir: 'games/spellbreaker',
    main: 'z6',
    objectOrder: { story: 'COMPILED/z6.z3' },
    storyFile: 'COMPILED/z6.z3',
  },
  'starcross': {
    title: "Starcross",
    srcDir: 'games/starcross',
    main: 'starcross',
    objectOrder: { story: 'COMPILED/starcross.z3' },
    oldReturn: true,
    storyFile: 'COMPILED/starcross.z3',
  },
  'suspect': {
    title: "Suspect",
    srcDir: 'games/suspect',
    main: 'suspect',
    objectOrder: { story: 'COMPILED/dm3.z3' },
    oldReturn: true,
    storyFile: 'COMPILED/dm3.z3',
  },
  'suspended': {
    title: "Suspended",
    srcDir: 'games/suspended',
    main: 'suspended',
    objectOrder: { story: 'COMPILED/suspended.z3' },
    oldReturn: true,
    // A stray character in the original source.
    fixups: { people: (t) => t.replace('<SET-GOAL ,PEOPLE ,INNER-CORE>>>\n\n<ROUTINE PEOPLE-GIVEN-BAG', '<SET-GOAL ,PEOPLE ,INNER-CORE>>\n\n<ROUTINE PEOPLE-GIVEN-BAG') },
    storyFile: 'COMPILED/suspended.z3',
  },
  'wishbringer': {
    title: "Wishbringer",
    srcDir: 'games/wishbringer',
    main: 'wishbringer',
    objectOrder: { story: 'COMPILED/j2.z3' },
    storyFile: 'COMPILED/j2.z3',
  },
  'witness': {
    title: "The Witness",
    srcDir: 'games/witness',
    main: 'witness',
    objectOrder: { story: 'COMPILED/r21.z3' },
    oldReturn: true,
    // A stray character in the original source.
    fixups: { places: (t) => t.replace('"Inside the house"\n)>[\n', '"Inside the house"\n').replace(/^\s*\]?\[?\s*$/gm, '') },
    storyFile: 'COMPILED/r21.z3',
  },
  'zork2': {
    title: "Zork II",
    licenseNotice: 'Source: MIT License, Copyright (c) 2025 Microsoft. See LICENSE in this directory.',
    srcDir: 'games/zork2',
    main: 'zork2',
    objectOrder: { story: 'COMPILED/zork2.z3' },
    storyFile: 'COMPILED/zork2.z3',
  },
  'zork3': {
    title: "Zork III",
    licenseNotice: 'Source: MIT License, Copyright (c) 2025 Microsoft. See LICENSE in this directory.',
    srcDir: 'games/zork3',
    main: 'zork3',
    objectOrder: { story: 'COMPILED/zork3.z3' },
    storyFile: 'COMPILED/zork3.z3',
  },
  'stationfall': {
    title: "Stationfall",
    srcDir: 'games/stationfall',
    main: 's6',
  },
  'minizork-1987': {
    title: "Mini-Zork (1987)",
    srcDir: 'games/minizork-1987',
    main: 'mini',
    objectOrder: { story: 'COMPILED/mini.z3' },
    storyFile: 'COMPILED/mini.z3',
  },
  'minizork2-1988': {
    title: "Mini-Zork II (1988)",
    srcDir: 'games/minizork2-1988',
    main: 'mini2',
    objectOrder: { story: 'COMPILED/mini2.z3' },
    storyFile: 'COMPILED/mini2.z3',
  },
  'infocom-sampler': {
    title: "Infocom Sampler",
    srcDir: 'games/infocom-sampler',
    main: 'sampler',
    objectOrder: { story: 'COMPILED/demo-r15.z3' },
    oldReturn: true,
    storyFile: 'COMPILED/demo-r15.z3',
  },
};

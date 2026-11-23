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
  // Version 4 (EZIP) and version 5 (XZIP) games
  'amfv': { title: 'A Mind Forever Voyaging', srcDir: 'games/amfv', main: 's5', objectOrder: { story: 'COMPILED/s5.z4' }, storyFile: 'COMPILED/s5.z4' },
  'trinity': { title: 'Trinity', srcDir: 'games/trinity', main: 'trinity', objectOrder: { story: 'COMPILED/tr.z4' }, storyFile: 'COMPILED/tr.z4' },
  'bureaucracy': {
    title: 'Bureaucracy',
    srcDir: 'games/bureaucracy',
    main: 'b',
    objectOrder: { story: 'COMPILED/b.z4' },
    storyFile: 'COMPILED/b.z4',
    // Written in the later ZIL dialect: DEFINE declares routines.
    defineRoutines: true,
  },
  'nordandbert': {
    title: "Nord and Bert Couldn't Make Head or Tail of It",
    srcDir: 'games/nordandbert',
    main: 'j3',
    objectOrder: { story: 'COMPILED/j3.z4' },
    storyFile: 'COMPILED/j3.z4',
    // The archive lacks the file with PICK-NEXT, PICK-ONE and DPRINT (TELLS.ZIL
    // replaced MISC.ZIL without them). PICK-NEXT as in Trinity, PICK-ONE from the
    // game's older MISC.ZIL, DPRINT without MISC.ZIL's Leather Goddesses leftovers,
    // and MISC.ZIL's TELL-TOKENS.
    fixups: {
      tells: (t) => t + `
<TELL-TOKENS (CRLF CR)   <CRLF>
	     D ,SIDEKICK <DPRINT-SIDEKICK>
	     D *	 <DPRINT .X>
	     A *	 <APRINT .X>
	     T ,PRSO 	 <TPRINT-PRSO>
	     T ,PRSI	 <TPRINT-PRSI>
	     T *	 <TPRINT .X>
	     AR *	 <ARPRINT .X>
	     TR *	 <TRPRINT .X>
	     N *	 <PRINTN .X>
	     C *         <PRINTC .X>>

<ROUTINE DPRINT-SIDEKICK ()
	 <DPRINT ,SIDEKICK>>

<ROUTINE PICK-NEXT (TBL "AUX" CNT STR)
	 <SET CNT <GET .TBL 1>>
	 <SET STR <GET .TBL .CNT>>
	 <INC CNT>
	 <COND (<G? .CNT <GET .TBL 0>>
		<SET CNT 2>)>
	 <PUT .TBL 1 .CNT>
	 <RETURN .STR>>

<ROUTINE PICK-ONE (TBL "AUX" LENGTH CNT RND MSG RFROB)
	 <SET LENGTH <GET .TBL 0>>
	 <SET CNT <GET .TBL 1>>
	 <SET LENGTH <- .LENGTH 1>>
	 <SET TBL <REST .TBL 2>>
	 <SET RFROB <REST .TBL <* .CNT 2>>>
	 <SET RND <RANDOM <- .LENGTH .CNT>>>
	 <SET MSG <GET .RFROB .RND>>
	 <PUT .RFROB .RND <GET .RFROB 1>>
	 <PUT .RFROB 1 .MSG>
	 <SET CNT <+ .CNT 1>>
	 <COND (<==? .CNT .LENGTH>
		<SET CNT 0>)>
	 <PUT .TBL 0 .CNT>
	 .MSG>

<ROUTINE DPRINT (OBJ)
	 <COND (<GETP .OBJ ,P?SDESC>
		<TELL <GETP .OBJ ,P?SDESC>>)
	       (T
		<PRINTD .OBJ>)>>
`,
    },
  },
  'beyondzork': { title: 'Beyond Zork', srcDir: 'games/beyondzork', main: 'z', objectOrder: { story: 'COMPILED/z.z5' }, storyFile: 'COMPILED/z.z5' },
  'borderzone': { title: 'Border Zone', srcDir: 'games/borderzone', main: 'spy', objectOrder: { story: 'COMPILED/spy.z5' }, storyFile: 'COMPILED/spy.z5' },
  'sherlock': { title: 'Sherlock: The Riddle of the Crown Jewels', srcDir: 'games/sherlock', main: 'gamesound' },
};

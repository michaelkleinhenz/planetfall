// The games available in the app, with the per-game details the shared
// engine, AI interpreter and user interface need.
//
// Loaders use literal import paths so that deploy-time versioning
// (tools/stamp.mjs) also covers them.

export const GAMES = {
  planetfall: {
    id: 'planetfall',
    title: 'Planetfall',
    year: 1983,
    author: 'Steve Meretzky',
    blurb: {
      en: 'A lowly Ensign Seventh Class, a doomed starship, a deserted planet, and Floyd, the most lovable robot in gaming.',
      de: 'Ein kleiner Fähnrich siebter Klasse, ein dem Untergang geweihtes Raumschiff, ein verlassener Planet – und Floyd, der liebenswerteste Roboter der Spielegeschichte.',
    },
    // The status line's second number: Planetfall shows the time of day.
    statusSecond: 'time',
    example: { en: 'grab the brush and head up the stairs', de: 'nimm die Bürste und geh die Treppe hoch' },
    // Original box art, provided by the site owner.
    cover: 'img/covers/planetfall.jpg',
    // First line of the title/copyright block (opening text and VERSION).
    bannerTitle: 'PLANETFALL',
    maxScore: 80,
    // Names the translator must keep as they are.
    names: 'Floyd, Blather, Feinstein, Kalamontee, Lawanda, Stellar Patrol, Blow\'k-bibben-Gordo',
    // Hints about the game's peculiarities for the translator.
    translatorNotes: 'The in-game "phonetic" spellings on signs and labels (e.g. "Akmee Portabul Laazur", "kitcin akses kard", "Tranzportaashun Suplii") are part of a puzzle: keep them exactly as written, and you may add a short translation in parentheses.',
    license: 'Source shared by historicalsource for education and research; not under an open license.',
    load: () => Promise.all([import('./planetfall/game.js'), import('./planetfall/story-data.js')]),
  },
  zork1: {
    id: 'zork1',
    title: 'Zork I',
    subtitle: 'The Great Underground Empire',
    year: 1980,
    author: 'Marc Blank & Dave Lebling',
    blurb: {
      en: 'West of a white house lies the entrance to the Great Underground Empire: nineteen treasures, a troll, a thief, and a lurking grue.',
      de: 'Westlich eines weißen Hauses beginnt das Große Unterirdische Reich: neunzehn Schätze, ein Troll, ein Dieb – und ein lauernder Grue.',
    },
    statusSecond: 'moves',
    example: { en: 'open the mailbox and read what is inside', de: 'öffne den Briefkasten und lies, was drin ist' },
    cover: 'img/covers/zork1.jpg',
    bannerTitle: 'ZORK I: The Great Underground Empire',
    maxScore: 350,
    names: 'Zork, Great Underground Empire, Flood Control Dam #3, Frigid River, Aragain Falls, Hades',
    translatorNotes: 'Keep the word "grue" as it is.',
    license: 'MIT License, (c) 2025 Microsoft.',
    load: () => Promise.all([import('./zork1/game.js'), import('./zork1/story-data.js')]),
  },
};

export const GAME_IDS = Object.keys(GAMES);

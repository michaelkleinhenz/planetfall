// User-interface strings (English and German).  The game's own text is
// translated separately by the AI (see ai/translator.js).

export const LANGUAGES = { en: 'English', de: 'Deutsch' };
// Name of each language as passed to the AI (game-text translation and replies).
export const AI_LANGUAGE_NAME = { en: '', de: 'German' };

const STRINGS = {
  en: {
    score: 'Score',
    time: 'Time',
    undoTitle: 'Undo last turn (Ctrl+Z)',
    undo: 'Undo',
    saveTitle: 'Save game',
    save: 'Save',
    loadTitle: 'Restore a saved game',
    load: 'Restore',
    settingsTitle: 'Settings',
    commandLabel: 'Your command',
    send: 'Send',
    modeTitle: 'Interpreter mode',
    badgeAi: 'AI',
    badgeClassic: 'CLASSIC',

    settingsHeading: 'Settings',
    languageLabel: 'Language',
    languageHelp: 'Switches the whole interface. In German, the AI also translates the story text as you play and understands what you type in German (needs an OpenRouter key). Click any passage to see the original English.',
    aiHeading: 'AI interpreter',
    aiIntro: 'The original parser only understands its own vocabulary. With an <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">OpenRouter</a> API key, an AI model translates whatever you type into commands the game understands. All story text still comes from the original game.',
    keyLabel: 'OpenRouter API key',
    modelLabel: 'Model',
    modelPlaceholder: 'Leave empty to pick automatically',
    useAi: 'Use the AI interpreter',
    showCommands: 'Show the commands the AI sends to the game',
    privacy: 'Your key is stored only in this browser (localStorage) and sent only to openrouter.ai. Prefix a command with <code>&gt;</code> to send it straight to the original parser.',
    cancel: 'Cancel',
    saveSettings: 'Save settings',

    saveGameTitle: 'Save game',
    restoreGameTitle: 'Restore a saved game',
    saveName: 'Save name',
    saveNamePlaceholder: 'e.g. before the bio-lab',
    saveButton: 'Save',
    restoreButton: 'Restore',
    noSaves: 'No saved games yet.',
    delete: 'Delete',
    defaultSaveName: 'Game',

    placeholderAi: 'Say anything… e.g. "grab the brush and head up the stairs"',
    placeholderClassic: 'Type a command, e.g. "examine brush"',
    hintAi: 'AI interpreter on — start a line with ">" to talk to the original parser directly.',
    hintAiTranslated: 'AI interpreter on · story translated — click a passage to see the original English.',
    hintClassic: 'Classic parser. ',
    hintTurnOnAi: 'Turn on the AI interpreter',
    hintAddKey: 'Add an OpenRouter key',
    hintPlainLanguage: ' to type in plain language.',
    hintNeededForTranslation: ' (Needed to translate the story.)',
    badgeTitleAi: 'AI interpreter ({model}) — click to switch to the classic parser',
    badgeTitleClassicKey: 'Classic parser — click to switch on the AI interpreter',
    badgeTitleClassicNoKey: 'Classic parser — add an OpenRouter key to use the AI',

    showOriginal: 'Click to show the original English text',
    showTranslation: 'Original text — click to show the translation',
    gameEnded: 'The game has ended. Type anything to start a new game.',
    undone: 'Undone — back to the previous turn.',
    welcomeBack: 'Welcome back — your game was restored. (Type "restart" to begin again.)',
    translationFailed: 'Translation failed ({error}); showing the original text.',
    aiFailed: '{error} — sent your input to the original parser instead.',
    cantMap: "I couldn't turn that into a game command.",
    hintTitle: 'Hint',
    hintRequest: 'Hint, please',
    hintStronger: 'Stronger hint',
    hintLabel1: 'HINT · NUDGE', hintLabel2: 'HINT · DIRECTION', hintLabel3: 'HINT · SOLUTION',
    hintNeedsKey: 'Hints are written by the AI from the game code: add your OpenRouter API key in the settings (⚙) to use them.',
    hintFailed: 'No hint this time ({error}).',
    more: 'More',
    moreTitle: 'Show the rest of this reply (or press Enter on an empty line)',
    actionsLabel: 'Quick actions',
    back: 'Back',
    dir_north: 'N', dir_ne: 'NE', dir_east: 'E', dir_se: 'SE', dir_south: 'S', dir_sw: 'SW', dir_west: 'W', dir_nw: 'NW',
    dir_up: 'Up', dir_down: 'Down', dir_in: 'In', dir_out: 'Out',
    dirname_north: 'Go north', dirname_ne: 'Go northeast', dirname_east: 'Go east', dirname_se: 'Go southeast',
    dirname_south: 'Go south', dirname_sw: 'Go southwest', dirname_west: 'Go west', dirname_nw: 'Go northwest',
    dirname_up: 'Go up', dirname_down: 'Go down', dirname_in: 'Go in', dirname_out: 'Go out',
    act_look: 'Look', act_inventory: 'Inventory', act_wait: 'Wait', act_yes: 'Yes', act_no: 'No',
    act_restart: 'Restart', act_restore: 'Restore', act_quit: 'Quit',
    verb_examine: 'Examine', verb_take: 'Take', verb_drop: 'Drop', verb_open: 'Open', verb_close: 'Close',
    verb_lookin: 'Look inside', verb_read: 'Read', verb_eat: 'Eat', verb_wear: 'Wear', verb_remove: 'Take off',
    verb_turnon: 'Turn on', verb_turnoff: 'Turn off', verb_push: 'Push', verb_talk: 'Talk to',
    heldMark: 'carried',
    nowEnglish: 'Interface switched to English. Story text is shown in the original English.',
    nowGerman: '',
    needsKey: '',
    needsAi: '',
  },
  de: {
    score: 'Punkte',
    time: 'Zeit',
    undoTitle: 'Letzten Zug rückgängig machen (Strg+Z)',
    undo: 'Rückgängig',
    saveTitle: 'Spiel speichern',
    save: 'Speichern',
    loadTitle: 'Gespeichertes Spiel laden',
    load: 'Laden',
    settingsTitle: 'Einstellungen',
    commandLabel: 'Dein Befehl',
    send: 'Senden',
    modeTitle: 'Interpreter-Modus',
    badgeAi: 'KI',
    badgeClassic: 'KLASSISCH',

    settingsHeading: 'Einstellungen',
    languageLabel: 'Sprache',
    languageHelp: 'Stellt die gesamte Oberfläche um. Auf Deutsch übersetzt die KI außerdem den Spieltext während des Spielens und versteht deutsche Eingaben (dafür ist ein OpenRouter-Schlüssel nötig). Ein Klick auf einen Abschnitt zeigt das englische Original.',
    aiHeading: 'KI-Interpreter',
    aiIntro: 'Der ursprüngliche Parser versteht nur sein eigenes Vokabular. Mit einem <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">OpenRouter</a>-API-Schlüssel übersetzt ein KI-Modell alles, was du eingibst, in Befehle, die das Spiel versteht. Die Geschichte selbst stammt weiterhin vollständig aus dem Originalspiel.',
    keyLabel: 'OpenRouter-API-Schlüssel',
    modelLabel: 'Modell',
    modelPlaceholder: 'Leer lassen für automatische Auswahl',
    useAi: 'KI-Interpreter verwenden',
    showCommands: 'Befehle anzeigen, die die KI an das Spiel sendet',
    privacy: 'Dein Schlüssel wird nur in diesem Browser gespeichert (localStorage) und nur an openrouter.ai gesendet. Mit <code>&gt;</code> am Zeilenanfang geht ein Befehl direkt an den Original-Parser.',
    cancel: 'Abbrechen',
    saveSettings: 'Einstellungen speichern',

    saveGameTitle: 'Spiel speichern',
    restoreGameTitle: 'Gespeichertes Spiel laden',
    saveName: 'Name des Spielstands',
    saveNamePlaceholder: 'z. B. vor dem Bio-Labor',
    saveButton: 'Speichern',
    restoreButton: 'Laden',
    noSaves: 'Noch keine gespeicherten Spiele.',
    delete: 'Löschen',
    defaultSaveName: 'Spiel',

    placeholderAi: 'Sag einfach, was du tun willst … z. B. „nimm die Bürste und geh die Treppe hoch“',
    placeholderClassic: 'Gib einen Befehl ein, z. B. "examine brush"',
    hintAi: 'KI-Interpreter an — mit ">" am Zeilenanfang sprichst du direkt mit dem Original-Parser.',
    hintAiTranslated: 'KI-Interpreter an · Geschichte wird übersetzt — Klick auf einen Abschnitt zeigt das englische Original.',
    hintClassic: 'Klassischer Parser (nur englische Befehle). ',
    hintTurnOnAi: 'KI-Interpreter einschalten',
    hintAddKey: 'OpenRouter-Schlüssel hinzufügen',
    hintPlainLanguage: ', um frei auf Deutsch zu spielen.',
    hintNeededForTranslation: '',
    badgeTitleAi: 'KI-Interpreter ({model}) — klicken für den klassischen Parser',
    badgeTitleClassicKey: 'Klassischer Parser — klicken, um den KI-Interpreter einzuschalten',
    badgeTitleClassicNoKey: 'Klassischer Parser — für die KI einen OpenRouter-Schlüssel hinzufügen',

    showOriginal: 'Klicken, um den englischen Originaltext zu zeigen',
    showTranslation: 'Originaltext — klicken, um die Übersetzung zu zeigen',
    gameEnded: 'Das Spiel ist beendet. Gib irgendetwas ein, um ein neues Spiel zu beginnen.',
    undone: 'Rückgängig gemacht — zurück zum vorherigen Zug.',
    welcomeBack: 'Willkommen zurück — dein Spiel wurde wiederhergestellt. („restart“ beginnt von vorn.)',
    translationFailed: 'Übersetzung fehlgeschlagen ({error}); der Originaltext wird angezeigt.',
    aiFailed: '{error} — deine Eingabe wurde stattdessen an den Original-Parser geschickt.',
    cantMap: 'Daraus konnte ich keinen Spielbefehl machen.',
    hintTitle: 'Tipp',
    hintRequest: 'Einen Tipp, bitte',
    hintStronger: 'Deutlicherer Tipp',
    hintLabel1: 'TIPP · ANSTOSS', hintLabel2: 'TIPP · RICHTUNG', hintLabel3: 'TIPP · LÖSUNG',
    hintNeedsKey: 'Tipps schreibt die KI anhand des Spielcodes: Trage dafür in den Einstellungen (⚙) deinen OpenRouter-API-Schlüssel ein.',
    hintFailed: 'Diesmal gibt es keinen Tipp ({error}).',
    more: 'Weiter',
    moreTitle: 'Den Rest dieser Antwort zeigen (oder Enter in einer leeren Zeile)',
    actionsLabel: 'Schnellaktionen',
    back: 'Zurück',
    dir_north: 'N', dir_ne: 'NO', dir_east: 'O', dir_se: 'SO', dir_south: 'S', dir_sw: 'SW', dir_west: 'W', dir_nw: 'NW',
    dir_up: 'Hoch', dir_down: 'Runter', dir_in: 'Rein', dir_out: 'Raus',
    dirname_north: 'Nach Norden', dirname_ne: 'Nach Nordosten', dirname_east: 'Nach Osten', dirname_se: 'Nach Südosten',
    dirname_south: 'Nach Süden', dirname_sw: 'Nach Südwesten', dirname_west: 'Nach Westen', dirname_nw: 'Nach Nordwesten',
    dirname_up: 'Nach oben', dirname_down: 'Nach unten', dirname_in: 'Hinein', dirname_out: 'Hinaus',
    act_look: 'Umsehen', act_inventory: 'Inventar', act_wait: 'Warten', act_yes: 'Ja', act_no: 'Nein',
    act_restart: 'Neu starten', act_restore: 'Laden', act_quit: 'Beenden',
    verb_examine: 'Untersuchen', verb_take: 'Nehmen', verb_drop: 'Ablegen', verb_open: 'Öffnen', verb_close: 'Schließen',
    verb_lookin: 'Hineinschauen', verb_read: 'Lesen', verb_eat: 'Essen', verb_wear: 'Anziehen', verb_remove: 'Ausziehen',
    verb_turnon: 'Einschalten', verb_turnoff: 'Ausschalten', verb_push: 'Drücken', verb_talk: 'Ansprechen',
    heldMark: 'dabei',
    nowEnglish: '',
    nowGerman: 'Oberfläche auf Deutsch umgestellt. Der Spieltext wird übersetzt … (Klick auf einen Abschnitt zeigt das Original.)',
    needsKey: 'Oberfläche auf Deutsch umgestellt. Damit auch der Spieltext übersetzt wird, trage in den Einstellungen (⚙) deinen OpenRouter-API-Schlüssel ein.',
    needsAi: 'Oberfläche auf Deutsch umgestellt. Damit auch der Spieltext übersetzt wird, schalte in den Einstellungen (⚙) „KI-Interpreter verwenden“ ein.',
  },
};

let current = 'en';

export function setLanguage(lang) { current = STRINGS[lang] ? lang : 'en'; document.documentElement.lang = current; }
export function getLanguage() { return current; }

/** Look up a UI string, substituting {name} placeholders. */
export function t(key, vars = {}) {
  const s = STRINGS[current][key] ?? STRINGS.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

/** Apply translations to static markup (data-i18n* attributes). */
export function applyStatic(root = document) {
  for (const e of root.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
  for (const e of root.querySelectorAll('[data-i18n-html]')) e.innerHTML = t(e.dataset.i18nHtml);
  for (const e of root.querySelectorAll('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle);
  for (const e of root.querySelectorAll('[data-i18n-aria]')) e.setAttribute('aria-label', t(e.dataset.i18nAria));
  for (const e of root.querySelectorAll('[data-i18n-placeholder]')) e.placeholder = t(e.dataset.i18nPlaceholder);
}

/** Map older free-text language settings to a supported code. */
export function normalizeLanguage(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['de', 'deutsch', 'german', 'ger'].includes(v)) return 'de';
  return 'en';
}

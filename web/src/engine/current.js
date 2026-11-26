// The game currently loaded in this page: its metadata, its translated code
// module and its story data. Set once at start-up (switching games reloads
// the page with a different game selected).

export const current = { id: null, meta: null, code: null, story: null };

/** Who made the current game ("Infocom", "Magnetic Scrolls"). */
export const publisher = () => current.meta?.publisher ?? 'Infocom';

export function setCurrentGame(meta, code, story) {
  current.id = meta.id;
  current.meta = meta;
  current.code = code;
  current.story = story;
}

/** Load a game by id (see games/registry.js) and make it current. */
export async function loadGame(meta) {
  const [code, story] = await meta.load();
  setCurrentGame(meta, code, story);
  return current;
}

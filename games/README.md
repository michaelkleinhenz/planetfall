# Original game sources

Each folder holds the unmodified source archive of one game, as published in the
[historicalsource](https://github.com/historicalsource) collections. The converter in
`tools/zil2js/` reads them (see `tools/zil2js/games.mjs`), and `COMPILED/*.z3` in each
folder is the original release used as the reference in the transcript tests.

| Folder | Game | Origin | License |
|---|---|---|---|
| `planetfall/` | Planetfall, release 39 | historicalsource/planetfall | None: shared for education and research, "not considered to be under an open license" |
| `zork1/` | Zork I, release 119 | historicalsource/zork1 (commit in `SOURCE-COMMIT`) | MIT License, (c) 2025 Microsoft (`zork1/LICENSE`) |

Known defects in the sources are fixed at compile time, not in these files. They are
documented in `tools/zil2js/games.mjs`: Planetfall's `comptwo.zil` is truncated in the last
object definition, and its ending is restored from `comptwo.zabstr`.

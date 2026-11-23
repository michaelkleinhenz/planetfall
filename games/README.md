# Original game sources

Each folder holds the unmodified source archive of one game, as published in the
[historicalsource](https://github.com/historicalsource) collections. The converter in
`tools/zil2js/` reads them (see `tools/zil2js/games.mjs`), and `COMPILED/*.z3` in each
folder is the original release used as the reference in the transcript tests.

| Folder | Game | Reference story file | License |
|---|---|---|---|
| `zork1/` | Zork I | r119 | MIT License, (c) 2025 Microsoft (`LICENSE`) |
| `zork2/` | Zork II | r63 | MIT License, (c) 2025 Microsoft (`LICENSE`) |
| `deadline/` | Deadline | r28 | None: shared for education and research |
| `starcross/` | Starcross | r18 | None: shared for education and research |
| `zork3/` | Zork III | r25 | MIT License, (c) 2025 Microsoft (`LICENSE`) |
| `enchanter/` | Enchanter | r29 | None: shared for education and research |
| `infidel/` | Infidel | r22 | None: shared for education and research |
| `planetfall/` | Planetfall | r39 | None: shared for education and research |
| `suspended/` | Suspended | r8 | None: shared for education and research |
| `witness/` | The Witness | r21 | None: shared for education and research |
| `cutthroats/` | Cutthroats | r25 | None: shared for education and research |
| `infocom-sampler/` | Infocom Sampler | — | None: shared for education and research |
| `seastalker/` | Seastalker | r16 | None: shared for education and research |
| `sorcerer/` | Sorcerer | r18 | None: shared for education and research |
| `suspect/` | Suspect | r18 | None: shared for education and research |
| `hitchhikersguide/` | The Hitchhiker's Guide to the Galaxy | r60 | None: shared for education and research |
| `spellbreaker/` | Spellbreaker | r87 | None: shared for education and research |
| `wishbringer/` | Wishbringer | r69 | None: shared for education and research |
| `ballyhoo/` | Ballyhoo | r99 | None: shared for education and research |
| `hollywoodhijinx/` | Hollywood Hijinx | r37 | None: shared for education and research |
| `leathergoddesses/` | Leather Goddesses of Phobos | r59 | None: shared for education and research |
| `moonmist/` | Moonmist | r13 | None: shared for education and research |
| `minizork-1987/` | Mini-Zork I | r34 | None: shared for education and research |
| `plunderedhearts/` | Plundered Hearts | r26 | None: shared for education and research |
| `stationfall/` | Stationfall | — | None: shared for education and research |
| `lurkinghorror/` | The Lurking Horror | r221 | None: shared for education and research |
| `minizork2-1988/` | Mini-Zork II | r2 | None: shared for education and research |

Each folder's `SOURCE-COMMIT` (where present) names the commit of the historicalsource
repository it was copied from.

Known defects in the sources are fixed at compile time, not in these files. They are
documented in `tools/zil2js/games.mjs`: Planetfall's `comptwo.zil` is truncated in the last
object definition (its ending is restored from `comptwo.zabstr`), Suspended's `people.zil`
has a stray `>`, and The Witness's `places.zil` has stray brackets.

# Sokoban level survey: Microban 1–10

Research date: 2026-08-25

## Selected source

The first release uses levels 1–10 from **Microban**, a 155-puzzle set by
David W. Skinner (revised April 2000). The layouts were copied from the
following GitHub snapshot rather than fetched at runtime:

- Repository: [`tiennm99/sokoban`](https://github.com/tiennm99/sokoban)
- Fixed commit: [`45fbd9b1716e49d74ffa34872a862dcaa97a6d79`](https://github.com/tiennm99/sokoban/commit/45fbd9b1716e49d74ffa34872a862dcaa97a6d79)
- Level file: [`src/lib/data/microban-levels.js`](https://github.com/tiennm99/sokoban/blob/45fbd9b1716e49d74ffa34872a862dcaa97a6d79/src/lib/data/microban-levels.js)
- Level-data terms: [`LICENSE-LEVELS.md`](https://github.com/tiennm99/sokoban/blob/45fbd9b1716e49d74ffa34872a862dcaa97a6d79/LICENSE-LEVELS.md)

The repository's Apache-2.0 license covers its code, **not** the Microban
layouts. `LICENSE-LEVELS.md` says the layouts may be freely redistributed
provided David W. Skinner is properly credited. The game page therefore keeps
the attribution visible, and this document records it with the immutable
source URL. The layouts are not relicensed as part of this project's code.

## Verification

The ten XSB strings were independently compared with
[`rkirov/sokoban-ai/levels/microban1.txt`](https://github.com/rkirov/sokoban-ai/blob/main/levels/microban1.txt).
After normalizing only line endings, levels 1–10 matched byte for byte.

Each selected board contains exactly one player and the same number of boxes
and targets. Box/target counts by level are `2, 3, 2, 3, 4, 3, 6, 2, 2, 3`.
Leading spaces and ragged rows are meaningful XSB void cells and must not be
trimmed into walkable floor.

## Why these ten

Microban's opening puzzles are compact, recognizable beginner Sokoban boards
and increase gradually in size. Keeping the catalog in a standalone level-data
module means a later release can append more credited Microban puzzles—or a
separately licensed collection—without changing the movement engine or page
route.

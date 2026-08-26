/**
 * The first twenty puzzles from the Microban level set.
 *
 * The layouts are XSB notation.  The parser and game engine are original
 * code; only the puzzle layouts are reproduced here.  Microban was created
 * by David W. Skinner and is freely distributable with attribution.
 *
 * Source snapshot (the commit is kept so that adding later levels remains
 * reproducible):
 * https://github.com/tiennm99/sokoban/blob/45fbd9b1716e49d74ffa34872a862dcaa97a6d79/src/lib/data/microban-levels.js
 */

export interface SokobanSourceMetadata {
  readonly collection: string;
  readonly author: string;
  readonly attribution: string;
  readonly url: string;
  readonly rawUrl: string;
  readonly commit: string;
}

export const SOKOBAN_LEVEL_SOURCE: SokobanSourceMetadata = Object.freeze({
  collection: "Microban",
  author: "David W. Skinner",
  attribution: "Puzzle layouts from the Microban level set by David W. Skinner; freely distributable with credit.",
  url: "https://github.com/tiennm99/sokoban/blob/45fbd9b1716e49d74ffa34872a862dcaa97a6d79/src/lib/data/microban-levels.js",
  rawUrl: "https://raw.githubusercontent.com/tiennm99/sokoban/45fbd9b1716e49d74ffa34872a862dcaa97a6d79/src/lib/data/microban-levels.js",
  commit: "45fbd9b1716e49d74ffa34872a862dcaa97a6d79",
});

export interface SokobanLevelDefinition {
  readonly id: string;
  readonly name: string;
  readonly layout: string;
  readonly source: SokobanSourceMetadata;
}

/** The source layouts in their original XSB form, in Microban order. */
export const SOKOBAN_LEVELS: readonly SokobanLevelDefinition[] = Object.freeze([
  {
    id: "microban-001",
    name: "Microban 1",
    layout: `####
# .#
#  ###
#*@  #
#  $ #
#  ###
####`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-002",
    name: "Microban 2",
    layout: `######
#    #
# #@ #
# $* #
# .* #
#    #
######`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-003",
    name: "Microban 3",
    layout: `  ####
###  ####
#     $ #
# #  #$ #
# . .#@ #
#########`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-004",
    name: "Microban 4",
    layout: `########
#      #
# .**$@#
#      #
#####  #
    ####`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-005",
    name: "Microban 5",
    layout: ` #######
 #     #
 # .$. #
## $@$ #
#  .$. #
#      #
########`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-006",
    name: "Microban 6",
    layout: `###### #####
#    ###   #
# $$     #@#
# $ #...   #
#   ########
#####`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-007",
    name: "Microban 7",
    layout: `#######
#     #
# .$. #
# $.$ #
# .$. #
# $.$ #
#  @  #
#######`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-008",
    name: "Microban 8",
    layout: `  ######
  # ..@#
  # $$ #
  ## ###
   # #
   # #
#### #
#    ##
# #   #
#   # #
###   #
  #####`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-009",
    name: "Microban 9",
    layout: `#####
#.  ##
#@$$ #
##   #
 ##  #
  ##.#
   ###`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-010",
    name: "Microban 10",
    layout: `      #####
      #.  #
      #.# #
#######.# #
# @ $ $ $ #
# # # # ###
#       #
#########`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-011",
    name: "Microban 11",
    layout: `  ######
  #    #
  # ##@##
### # $ #
# ..# $ #
#       #
#  ######
####`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-012",
    name: "Microban 12",
    layout: `#####
#   ##
# $  #
## $ ####
 ###@.  #
  #  .# #
  #     #
  #######`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-013",
    name: "Microban 13",
    layout: `####
#. ##
#.@ #
#. $#
##$ ###
 # $  #
 #    #
 #  ###
 ####`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-014",
    name: "Microban 14",
    layout: `#######
#     #
# # # #
#. $*@#
#   ###
#####`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-015",
    name: "Microban 15",
    layout: `     ###
######@##
#    .* #
#   #   #
#####$# #
    #   #
    #####`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-016",
    name: "Microban 16",
    layout: ` ####
 #  ####
 #     ##
## ##   #
#. .# @$##
#   # $$ #
#  .#    #
##########`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-017",
    name: "Microban 17",
    layout: `#####
# @ #
#...#
#$$$##
#    #
#    #
######`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-018",
    name: "Microban 18",
    layout: `#######
#     #
#. .  #
# ## ##
#  $ #
###$ #
  #@ #
  #  #
  ####`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-019",
    name: "Microban 19",
    layout: `########
#   .. #
#  @$$ #
##### ##
   #  #
   #  #
   #  #
   ####`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
  {
    id: "microban-020",
    name: "Microban 20",
    layout: `#######
#     ###
#  @$$..#
#### ## #
  #     #
  #  ####
  #  #
  ####`,
    source: SOKOBAN_LEVEL_SOURCE,
  },
] as const);

/** Alias useful to callers that only need the raw source layouts. */
export const MICROBAN_LEVELS: readonly string[] = Object.freeze(
  SOKOBAN_LEVELS.map((level) => level.layout),
);

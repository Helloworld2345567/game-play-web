import { describe, expect, it } from "vitest";
import {
  CHINESE_CHECKERS_HOLES,
  createChineseCheckers,
  finishChineseCheckersHop,
  getChineseCheckersCamp,
  getChineseCheckersLegalMoves,
  moveChineseCheckers,
  type ChineseCheckersPlayerCount,
} from "./engine";

describe("Chinese Checkers engine", () => {
  const expectedHomeCamps = {
    2: [0, 3],
    3: [0, 2, 4],
    4: [5, 1, 2, 4],
  } as const;

  it.each([2, 3, 4] as const)(
    "creates the standard 121-hole board for %i players",
    (playerCount: ChineseCheckersPlayerCount) => {
      const game = createChineseCheckers(playerCount);

      expect(CHINESE_CHECKERS_HOLES).toHaveLength(121);
      expect(game.playerCount).toBe(playerCount);
      expect(game.players).toHaveLength(playerCount);
      expect(Object.keys(game.pieces)).toHaveLength(playerCount * 10);
      expect(game.players.map((player) => player.id)).toEqual(
        Array.from({ length: playerCount }, (_, index) => index),
      );
      expect(game.players.map((player) => player.homeCamp)).toEqual(
        expectedHomeCamps[playerCount],
      );
      for (const player of game.players) {
        expect(
          Object.entries(game.pieces)
            .filter(([, owner]) => owner === player.id)
            .map(([position]) => position)
            .sort(),
        ).toEqual([...getChineseCheckersCamp(player.homeCamp)].sort());
        expect(player.targetCamp).toBe((player.homeCamp + 3) % 6);
      }
      expect(game).toMatchObject({
        currentPlayer: 0,
        status: "playing",
        winner: null,
        turnNumber: 1,
        activeHop: null,
        lastMove: null,
      });
    },
  );

  it("moves one step into an adjacent hole and passes the turn", () => {
    const before = createChineseCheckers(2);

    expect(getChineseCheckersLegalMoves(before, "-3,-5")).toEqual({
      steps: ["-4,-4", "-2,-4"],
      jumps: [],
    });

    const result = moveChineseCheckers(before, "-3,-5", "-4,-4");

    expect(result).toMatchObject({ moved: true, kind: "step" });
    expect(result.state).toMatchObject({
      currentPlayer: 1,
      turnNumber: 2,
      activeHop: null,
      lastMove: {
        player: 0,
        from: "-3,-5",
        to: "-4,-4",
        path: ["-3,-5", "-4,-4"],
      },
    });
    expect(result.state.pieces["-3,-5"]).toBeUndefined();
    expect(result.state.pieces["-4,-4"]).toBe(0);
    expect(before.pieces["-3,-5"]).toBe(0);
    expect(before.pieces["-4,-4"]).toBeUndefined();
  });

  it("keeps the turn while one piece makes an optional multi-hop", () => {
    const opening = createChineseCheckers(2);
    const before = {
      ...opening,
      pieces: {
        ...opening.pieces,
        "0,0": 0 as const,
        "1,1": 1 as const,
        "3,3": 0 as const,
      },
    };

    const first = moveChineseCheckers(before, "0,0", "2,2");

    expect(first).toMatchObject({ moved: true, kind: "jump" });
    expect(first.state).toMatchObject({
      currentPlayer: 0,
      turnNumber: 1,
      activeHop: { origin: "0,0", path: ["0,0", "2,2"] },
    });
    expect(first.state.pieces["0,0"]).toBeUndefined();
    expect(first.state.pieces["1,1"]).toBe(1);
    expect(first.state.pieces["2,2"]).toBe(0);
    expect(getChineseCheckersLegalMoves(first.state, "2,2")).toEqual({
      steps: [],
      jumps: ["4,4"],
    });

    const second = moveChineseCheckers(first.state, "2,2", "4,4");
    expect(second.state.activeHop).toEqual({
      origin: "0,0",
      path: ["0,0", "2,2", "4,4"],
    });
    expect(
      getChineseCheckersLegalMoves(second.state, "4,4").jumps,
    ).not.toContain("2,2");

    const after = finishChineseCheckersHop(second.state);
    expect(after).toMatchObject({
      currentPlayer: 1,
      turnNumber: 2,
      activeHop: null,
      lastMove: {
        player: 0,
        from: "0,0",
        to: "4,4",
        path: ["0,0", "2,2", "4,4"],
      },
    });
  });

  it("wins when the final piece steps into the opposite camp", () => {
    const opening = createChineseCheckers(2);
    const target = getChineseCheckersCamp(opening.players[0]!.targetCamp);
    const destination = "-3,5";
    const pieces = Object.fromEntries([
      ...target
        .filter((position) => position !== destination)
        .map((position) => [position, 0] as const),
      ["-4,4", 0] as const,
      ["0,-8", 1] as const,
    ]);
    const before = { ...opening, pieces };

    const result = moveChineseCheckers(before, "-4,4", destination);

    expect(result).toMatchObject({ moved: true, kind: "step" });
    expect(result.state).toMatchObject({
      status: "won",
      winner: 0,
      currentPlayer: 0,
      activeHop: null,
      lastMove: {
        player: 0,
        from: "-4,4",
        to: destination,
      },
    });
  });

  it("waits for a player to finish a hop before declaring victory", () => {
    const opening = createChineseCheckers(2);
    const target = getChineseCheckersCamp(opening.players[0]!.targetCamp);
    const destination = "-3,5";
    const pieces = Object.fromEntries([
      ...target
        .filter((position) => position !== destination)
        .map((position) => [position, 0] as const),
      ["-5,3", 0] as const,
      ["-4,4", 1] as const,
    ]);

    const hop = moveChineseCheckers(
      { ...opening, pieces },
      "-5,3",
      destination,
    ).state;

    expect(hop).toMatchObject({
      status: "playing",
      winner: null,
      currentPlayer: 0,
      activeHop: { path: ["-5,3", destination] },
    });
    expect(finishChineseCheckersHop(hop)).toMatchObject({
      status: "won",
      winner: 0,
      currentPlayer: 0,
      activeHop: null,
    });
  });

  it("rejects occupied, off-board, opponent, and piece-switching moves", () => {
    const opening = createChineseCheckers(2);
    expect(moveChineseCheckers(opening, "0,-8", "1,-7")).toEqual({
      state: opening,
      moved: false,
      kind: null,
    });
    expect(moveChineseCheckers(opening, "0,8", "0,7").state).toBe(opening);
    expect(moveChineseCheckers(opening, "-3,-5", "-4,-6").state).toBe(
      opening,
    );

    const jumpSetup = {
      ...opening,
      pieces: {
        ...opening.pieces,
        "0,0": 0 as const,
        "1,1": 1 as const,
      },
    };
    const hopping = moveChineseCheckers(jumpSetup, "0,0", "2,2").state;
    expect(moveChineseCheckers(hopping, "-3,-5", "-4,-4").state).toBe(
      hopping,
    );
  });
});

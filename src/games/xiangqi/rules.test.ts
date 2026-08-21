import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  listLegalXiangqiMoves,
  NO_PROGRESS_PLY_LIMIT,
  readXiangqiPosition,
  xiangqiRules,
  type XiangqiPiece,
  type XiangqiPosition,
} from "./rules";
import type { JsonValue, RulePosition } from "../../core/game-rules";

function move(
  position: RulePosition,
  seat: string,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): RulePosition {
  const result = xiangqiRules.apply(position, {
    seat,
    payload: { type: "move", fromX, fromY, toX, toY },
  });
  if (!result.ok) {
    throw new Error(`${result.code} (${fromX},${fromY})->(${toX},${toY})`);
  }
  return result.next;
}

function customPosition(
  boardEntries: Array<[number, number, XiangqiPiece]>,
  turn: "red" | "black" = "red",
  extras: Partial<XiangqiPosition> = {},
): RulePosition {
  const board: Array<XiangqiPiece | null> = Array(
    BOARD_WIDTH * BOARD_HEIGHT,
  ).fill(null);
  for (const [x, y, piece] of boardEntries) {
    board[y * BOARD_WIDTH + x] = { ...piece };
  }
  const redSeat = extras.redSeat ?? "red";
  const blackSeat = extras.blackSeat ?? "black";
  const position: XiangqiPosition = {
    board,
    redSeat,
    blackSeat,
    moveCount: extras.moveCount ?? 0,
    lastMove: extras.lastMove ?? null,
    repetition: extras.repetition ?? {},
    reversiblePlyCount: extras.reversiblePlyCount ?? 0,
    inCheck: extras.inCheck ?? { red: false, black: false },
  };
  return {
    data: position as unknown as JsonValue,
    turn: turn === "red" ? redSeat : blackSeat,
    outcome: null,
  };
}

const red = (kind: XiangqiPiece["kind"]): XiangqiPiece => ({
  side: "red",
  kind,
});
const black = (kind: XiangqiPiece["kind"]): XiangqiPiece => ({
  side: "black",
  kind,
});

describe("xiangqi rules", () => {
  it("creates the standard 9x10 starting position with Red to move", () => {
    const position = xiangqiRules.create(["seat-a", "seat-b"]);
    const data = readXiangqiPosition(position);

    expect(xiangqiRules.definition).toEqual({
      gameType: "xiangqi",
      ruleSetId: "xiangqi.casual.v1",
      actionConsistency: "strict_revision",
      openingRoleIds: ["red", "black"],
    });
    expect(data.board).toHaveLength(90);
    expect(data.redSeat).toBe("seat-a");
    expect(data.blackSeat).toBe("seat-b");
    expect(position.turn).toBe("seat-a");
    expect(data.reversiblePlyCount).toBe(0);
    expect(data.board[0]).toEqual(black("rook"));
    expect(data.board[4]).toEqual(black("general"));
    expect(data.board[8]).toEqual(black("rook"));
    expect(data.board[2 * BOARD_WIDTH + 1]).toEqual(black("cannon"));
    expect(data.board[3 * BOARD_WIDTH]).toEqual(black("pawn"));
    expect(data.board[6 * BOARD_WIDTH]).toEqual(red("pawn"));
    expect(data.board[7 * BOARD_WIDTH + 1]).toEqual(red("cannon"));
    expect(data.board[9 * BOARD_WIDTH + 4]).toEqual(red("general"));
    expect(data.board[9 * BOARD_WIDTH + 8]).toEqual(red("rook"));
    expect(data.repetition).toBeTruthy();
  });

  it("exposes the standard opening's 44 server-valid moves for UI hints", () => {
    const position = xiangqiRules.create(["seat-a", "seat-b"]);
    const data = readXiangqiPosition(position);
    let moveCount = 0;

    for (let index = 0; index < data.board.length; index += 1) {
      if (data.board[index]?.side !== "red") continue;
      const fromX = index % BOARD_WIDTH;
      const fromY = Math.floor(index / BOARD_WIDTH);
      const targets = listLegalXiangqiMoves(data.board, fromX, fromY);
      moveCount += targets.length;
      for (const target of targets) {
        expect(
          xiangqiRules.apply(position, {
            seat: "seat-a",
            payload: {
              type: "move",
              fromX,
              fromY,
              toX: target.x,
              toY: target.y,
            },
          }).ok,
        ).toBe(true);
      }
    }

    expect(moveCount).toBe(44);
  });

  it("accepts a forward pawn move and passes the turn", () => {
    const initial = xiangqiRules.create(["red-seat", "black-seat"]);
    const next = move(initial, "red-seat", 0, 6, 0, 5);
    const data = readXiangqiPosition(next);

    expect(data.board[5 * BOARD_WIDTH]).toEqual(red("pawn"));
    expect(data.board[6 * BOARD_WIDTH]).toBeNull();
    expect(next.turn).toBe("black-seat");
    expect(data.moveCount).toBe(1);
    expect(data.lastMove).toMatchObject({
      fromX: 0,
      fromY: 6,
      toX: 0,
      toY: 5,
    });
  });

  it("allows a pawn to move sideways only after crossing the river", () => {
    const position = customPosition([
      [4, 9, red("general")],
      [0, 0, black("general")],
      [0, 4, red("pawn")],
    ]);
    const next = move(position, "red", 0, 4, 1, 4);
    expect(readXiangqiPosition(next).board[4 * BOARD_WIDTH + 1]).toEqual(
      red("pawn"),
    );

    const beforeRiver = customPosition([
      [4, 9, red("general")],
      [0, 0, black("general")],
      [0, 5, red("pawn")],
    ]);
    expect(
      xiangqiRules.apply(beforeRiver, {
        seat: "red",
        payload: { type: "move", fromX: 0, fromY: 5, toX: 1, toY: 5 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.illegal_move" });
  });

  it("applies the mirrored forward and river rules to Black pawns", () => {
    const beforeRiver = customPosition(
      [
        [4, 9, red("general")],
        [0, 0, black("general")],
        [8, 4, black("pawn")],
      ],
      "black",
    );
    const forward = move(beforeRiver, "black", 8, 4, 8, 5);
    expect(readXiangqiPosition(forward).board[5 * BOARD_WIDTH + 8]).toEqual(
      black("pawn"),
    );

    const afterRiver = customPosition(
      [
        [4, 9, red("general")],
        [0, 0, black("general")],
        [8, 5, black("pawn")],
      ],
      "black",
    );
    expect(
      xiangqiRules.apply(afterRiver, {
        seat: "black",
        payload: { type: "move", fromX: 8, fromY: 5, toX: 7, toY: 5 },
      }).ok,
    ).toBe(true);
    expect(
      xiangqiRules.apply(afterRiver, {
        seat: "black",
        payload: { type: "move", fromX: 8, fromY: 5, toX: 8, toY: 4 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.illegal_move" });
  });

  it("enforces palace, elephant river, elephant eye, and horse leg rules", () => {
    const palace = customPosition([
      [4, 9, red("general")],
      [0, 0, black("general")],
    ]);
    expect(
      xiangqiRules.apply(palace, {
        seat: "red",
        payload: { type: "move", fromX: 4, fromY: 9, toX: 4, toY: 6 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.illegal_move" });

    const blockedElephant = customPosition([
      [4, 9, red("general")],
      [0, 0, black("general")],
      [2, 9, red("elephant")],
      [3, 8, red("pawn")],
    ]);
    expect(
      xiangqiRules.apply(blockedElephant, {
        seat: "red",
        payload: { type: "move", fromX: 2, fromY: 9, toX: 4, toY: 7 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.illegal_move" });

    const riverElephant = customPosition([
      [4, 9, red("general")],
      [0, 0, black("general")],
      [2, 5, red("elephant")],
    ]);
    expect(
      xiangqiRules.apply(riverElephant, {
        seat: "red",
        payload: { type: "move", fromX: 2, fromY: 5, toX: 4, toY: 3 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.illegal_move" });

    const blockedHorse = customPosition([
      [4, 9, red("general")],
      [0, 0, black("general")],
      [3, 8, red("pawn")],
      [3, 9, red("horse")],
    ]);
    expect(
      xiangqiRules.apply(blockedHorse, {
        seat: "red",
        payload: { type: "move", fromX: 3, fromY: 9, toX: 4, toY: 7 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.illegal_move" });
  });

  it("accepts each standard piece's characteristic legal move", () => {
    const position = customPosition([
      [4, 9, red("general")],
      [0, 0, black("general")],
      [3, 9, red("advisor")],
      [2, 9, red("elephant")],
      [1, 9, red("horse")],
      [8, 9, red("rook")],
      [7, 7, red("cannon")],
    ]);

    for (const [fromX, fromY, toX, toY] of ([
      [4, 9, 4, 8], // general: one orthogonal palace step
      [3, 9, 4, 8], // advisor: diagonal palace step
      [2, 9, 4, 7], // elephant: two diagonal steps
      [1, 9, 2, 7], // horse: unblocked L
      [8, 9, 8, 5], // rook: unobstructed ray
      [7, 7, 7, 5], // cannon: non-capture without a screen
    ] as const)) {
      expect(
        xiangqiRules.apply(position, {
          seat: "red",
          payload: { type: "move", fromX, fromY, toX, toY },
        }).ok,
      ).toBe(true);
    }
  });

  it("lets a rook capture, and a cannon cannot jump without capturing", () => {
    const rookCapture = customPosition([
      [4, 9, red("general")],
      [0, 0, black("general")],
      [8, 9, red("rook")],
      [8, 2, black("pawn")],
    ]);
    const captured = xiangqiRules.apply(rookCapture, {
      seat: "red",
      payload: { type: "move", fromX: 8, fromY: 9, toX: 8, toY: 2 },
    });
    expect(captured.ok).toBe(true);
    if (captured.ok) {
      expect(readXiangqiPosition(captured.next).lastMove?.captured).toEqual(
        black("pawn"),
      );
    }

    const cannonJump = customPosition([
      [4, 9, red("general")],
      [0, 0, black("general")],
      [8, 9, red("cannon")],
      [8, 7, red("pawn")],
    ]);
    expect(
      xiangqiRules.apply(cannonJump, {
        seat: "red",
        payload: { type: "move", fromX: 8, fromY: 9, toX: 8, toY: 5 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.illegal_move" });
  });

  it("checks cannon screens and refuses to capture a general", () => {
    const position = customPosition([
      [0, 9, red("general")],
      [8, 0, black("general")],
      [0, 0, red("cannon")],
      [1, 0, black("pawn")],
      [2, 0, black("rook")],
    ]);
    const capture = xiangqiRules.apply(position, {
      seat: "red",
      payload: { type: "move", fromX: 0, fromY: 0, toX: 2, toY: 0 },
    });
    expect(capture.ok).toBe(true);

    const noScreen = customPosition([
      [0, 9, red("general")],
      [8, 0, black("general")],
      [0, 0, red("cannon")],
      [2, 0, black("rook")],
    ]);
    expect(
      xiangqiRules.apply(noScreen, {
        seat: "red",
        payload: { type: "move", fromX: 0, fromY: 0, toX: 2, toY: 0 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.illegal_move" });

    const generalTarget = customPosition([
      [0, 9, red("general")],
      [4, 0, black("general")],
      [4, 9, red("rook")],
    ]);
    expect(
      xiangqiRules.apply(generalTarget, {
        seat: "red",
        payload: { type: "move", fromX: 4, fromY: 9, toX: 4, toY: 0 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.cannot_capture_general" });
  });

  it("rejects moves that expose the moving side's general (including flying generals)", () => {
    const pinned = customPosition([
      [4, 9, red("general")],
      [4, 5, red("rook")],
      [4, 0, black("rook")],
      [0, 0, black("general")],
    ]);
    expect(
      xiangqiRules.apply(pinned, {
        seat: "red",
        payload: { type: "move", fromX: 4, fromY: 5, toX: 3, toY: 5 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.self_check" });

    const flying = customPosition([
      [3, 9, red("general")],
      [4, 0, black("general")],
    ]);
    expect(
      xiangqiRules.apply(flying, {
        seat: "red",
        payload: { type: "move", fromX: 3, fromY: 9, toX: 4, toY: 9 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.self_check" });
  });

  it("ends in checkmate or stalemate when the side to move has no legal move", () => {
    const checkmate = customPosition([
      [4, 9, red("general")],
      [4, 0, black("general")],
      [0, 1, red("rook")],
      [4, 2, red("pawn")],
    ]);
    const mate = xiangqiRules.apply(checkmate, {
      seat: "red",
      payload: { type: "move", fromX: 0, fromY: 1, toX: 0, toY: 0 },
    });
    expect(mate).toMatchObject({
      ok: true,
      next: {
        outcome: { kind: "win", winner: "red", reason: "checkmate" },
        turn: null,
      },
    });

    const stalemate = customPosition(
      [
        [4, 9, red("general")],
        [4, 0, black("general")],
        [4, 5, red("pawn")],
        [3, 1, red("rook")],
        [5, 1, red("rook")],
        [3, 3, red("horse")],
        [3, 9, red("advisor")],
      ],
      "red",
    );
    const stale = xiangqiRules.apply(stalemate, {
      seat: "red",
      payload: { type: "move", fromX: 3, fromY: 9, toX: 4, toY: 8 },
    });
    expect(stale).toMatchObject({
      ok: true,
      next: {
        outcome: { kind: "win", winner: "red", reason: "stalemate" },
        turn: null,
      },
    });
  });

  it("keeps the game running when the checked general can escape", () => {
    const position = customPosition([
      [3, 9, red("general")],
      [4, 0, black("general")],
      [0, 1, red("rook")],
    ]);
    const checked = move(position, "red", 0, 1, 0, 0);

    expect(checked.outcome).toBeNull();
    expect(checked.turn).toBe("black");
    expect(readXiangqiPosition(checked).inCheck).toEqual({
      red: false,
      black: true,
    });
    const escaped = move(checked, "black", 4, 0, 4, 1);
    expect(escaped.outcome).toBeNull();
    expect(readXiangqiPosition(escaped).inCheck.black).toBe(false);
  });

  it("keeps the game running when the defender can block the check", () => {
    const position = customPosition([
      [4, 9, red("general")],
      [4, 0, black("general")],
      [0, 1, red("rook")],
      [4, 2, red("pawn")],
      [4, 1, black("advisor")],
    ]);
    const checked = move(position, "red", 0, 1, 0, 0);

    expect(checked.outcome).toBeNull();
    const blocked = move(checked, "black", 4, 1, 3, 0);
    expect(blocked.outcome).toBeNull();
    expect(readXiangqiPosition(blocked).inCheck.black).toBe(false);
  });

  it("keeps the game running when the defender can capture the checking piece", () => {
    const position = customPosition([
      [4, 9, red("general")],
      [4, 0, black("general")],
      [0, 1, red("rook")],
      [4, 2, red("pawn")],
      [0, 2, black("rook")],
    ]);
    const checked = move(position, "red", 0, 1, 0, 0);

    expect(checked.outcome).toBeNull();
    const captured = move(checked, "black", 0, 2, 0, 0);
    expect(captured.outcome).toBeNull();
    expect(readXiangqiPosition(captured).inCheck.black).toBe(false);
  });

  it("declares a serializable draw on the third repetition", () => {
    let position = xiangqiRules.create(["red", "black"]);

    // The initial position already counts as its first occurrence. Returning
    // both horses twice makes the same board and side to move occur three
    // times, so the second cycle's final move ends the game.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      position = move(position, "red", 1, 9, 2, 7);
      position = move(position, "black", 1, 0, 2, 2);
      position = move(position, "red", 2, 7, 1, 9);
      position = move(position, "black", 2, 2, 1, 0);
    }

    expect(position.outcome).toEqual({
      kind: "draw",
      reason: "threefold_repetition",
    });
    expect(() => JSON.stringify(position)).not.toThrow();
    expect(
      xiangqiRules.apply(position, {
        seat: "red",
        payload: { type: "move", fromX: 1, fromY: 9, toX: 2, toY: 7 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.game_finished" });
  });

  it("bounds repetition history with irreversible moves and a no-progress draw", () => {
    const almostDrawn = customPosition(
      [
        [4, 9, red("general")],
        [4, 0, black("general")],
        [4, 5, red("pawn")],
        [8, 9, red("rook")],
      ],
      "red",
      {
        moveCount: NO_PROGRESS_PLY_LIMIT - 1,
        reversiblePlyCount: NO_PROGRESS_PLY_LIMIT - 1,
      },
    );
    const drawn = move(almostDrawn, "red", 8, 9, 8, 8);
    expect(drawn.outcome).toEqual({ kind: "draw", reason: "no_progress" });
    expect(readXiangqiPosition(drawn).reversiblePlyCount).toBe(
      NO_PROGRESS_PLY_LIMIT,
    );

    const afterPawn = move(almostDrawn, "red", 4, 5, 4, 4);
    const pawnData = readXiangqiPosition(afterPawn);
    expect(afterPawn.outcome).toBeNull();
    expect(pawnData.reversiblePlyCount).toBe(0);
    expect(Object.values(pawnData.repetition)).toEqual([1]);

    const beforeCapture = customPosition(
      [
        [4, 9, red("general")],
        [4, 0, black("general")],
        [4, 5, red("pawn")],
        [8, 9, red("rook")],
        [8, 8, black("pawn")],
      ],
      "red",
      {
        moveCount: 7,
        reversiblePlyCount: 7,
        repetition: {
          [`${".".repeat(BOARD_WIDTH * BOARD_HEIGHT)}|r`]: 2,
        },
      },
    );
    const afterCapture = move(beforeCapture, "red", 8, 9, 8, 8);
    const captureData = readXiangqiPosition(afterCapture);
    expect(captureData.reversiblePlyCount).toBe(0);
    expect(Object.values(captureData.repetition)).toEqual([1]);
  });

  it("rejects malformed, out-of-turn, empty-source, and occupied-destination actions", () => {
    const initial = xiangqiRules.create(["red", "black"]);
    expect(
      xiangqiRules.apply(initial, {
        seat: "black",
        payload: { type: "move", fromX: 0, fromY: 6, toX: 0, toY: 5 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.not_your_turn" });
    expect(
      xiangqiRules.apply(initial, {
        seat: "red",
        payload: { type: "move", fromX: -1, fromY: 6, toX: 0, toY: 5 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.out_of_bounds" });
    expect(
      xiangqiRules.apply(initial, {
        seat: "red",
        payload: { type: "move", fromX: 4, fromY: 4, toX: 4, toY: 5 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.empty_source" });
    expect(
      xiangqiRules.apply(initial, {
        seat: "red",
        payload: { type: "move", fromX: 0, fromY: 6, toX: 0, toY: 7 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.illegal_move" });
    const afterPawn = move(initial, "red", 0, 6, 0, 5);
    expect(
      xiangqiRules.apply(afterPawn, {
        seat: "black",
        payload: { type: "move", fromX: 0, fromY: 3, toX: 0, toY: 5 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.illegal_move" });

    const malformed: RulePosition = {
      ...initial,
      data: {
        ...readXiangqiPosition(initial),
        board: readXiangqiPosition(initial).board.map((cell, index) =>
          index === 0 ? ({ side: "purple", kind: "rook" } as unknown as JsonValue) : cell,
        ),
      } as unknown as JsonValue,
    };
    expect(
      xiangqiRules.apply(malformed, {
        seat: "red",
        payload: { type: "move", fromX: 0, fromY: 6, toX: 0, toY: 5 },
      }),
    ).toEqual({ ok: false, code: "xiangqi.invalid_position" });

    expect(
      xiangqiRules.apply(
        { data: null, turn: "red", outcome: null },
        {
          seat: "red",
          payload: { type: "move", fromX: 0, fromY: 6, toX: 0, toY: 5 },
        },
      ),
    ).toEqual({ ok: false, code: "xiangqi.invalid_position" });

    for (const invalidMetadata of [
      { repetition: { corrupt: "2" } },
      {
        moveCount: NO_PROGRESS_PLY_LIMIT - 1,
        reversiblePlyCount: NO_PROGRESS_PLY_LIMIT - 1,
        repetition: Object.fromEntries(
          Array.from(
            { length: NO_PROGRESS_PLY_LIMIT + 1 },
            (_, index) => [`position-${index}`, 1],
          ),
        ),
      },
      {
        lastMove: {
          fromX: 99,
          fromY: 6,
          toX: 0,
          toY: 5,
          piece: red("pawn"),
          captured: null,
        },
      },
      { inCheck: { red: "yes", black: false } },
    ]) {
      const invalid: RulePosition = {
        ...initial,
        data: {
          ...readXiangqiPosition(initial),
          ...invalidMetadata,
        } as unknown as JsonValue,
      };
      expect(
        xiangqiRules.apply(invalid, {
          seat: "red",
          payload: { type: "move", fromX: 0, fromY: 6, toX: 0, toY: 5 },
        }),
      ).toEqual({ ok: false, code: "xiangqi.invalid_position" });
    }
  });

  it("does not mutate the current position when accepting or rejecting a move", () => {
    const initial = xiangqiRules.create(["red", "black"]);
    const before = JSON.stringify(initial);
    expect(
      xiangqiRules.apply(initial, {
        seat: "red",
        payload: { type: "move", fromX: 0, fromY: 6, toX: 0, toY: 5 },
      }).ok,
    ).toBe(true);
    expect(JSON.stringify(initial)).toBe(before);

    expect(
      xiangqiRules.apply(initial, {
        seat: "red",
        payload: { type: "move", fromX: 0, fromY: 6, toX: 1, toY: 6 },
      }).ok,
    ).toBe(false);
    expect(JSON.stringify(initial)).toBe(before);
  });
});

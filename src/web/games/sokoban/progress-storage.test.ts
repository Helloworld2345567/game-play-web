import { describe, expect, it } from "vitest";
import {
  bestSokobanPendingCompletions,
  queueSokobanPendingCompletion,
  readSokobanPendingCompletions,
  removeSokobanPendingCompletion,
  SOKOBAN_PENDING_STORAGE_KEY,
  type SokobanPendingCompletion,
  type SokobanProgressStorage,
} from "./progress-storage";

const SYNC_A = `v1.${"a".repeat(43)}`;
const SYNC_B = `v1.${"b".repeat(43)}`;
const OUTBOX_A = "00000000-0000-4000-8000-000000000001";
const OUTBOX_B = "00000000-0000-4000-8000-000000000002";
const OUTBOX_C = "00000000-0000-4000-8000-000000000003";

function memoryStorage(initial: Readonly<Record<string, string>> = {}): {
  storage: SokobanProgressStorage;
  keys(): readonly string[];
} {
  const stored = new Map(Object.entries(initial));
  return {
    storage: {
      get length() {
        return stored.size;
      },
      getItem: (key) => stored.get(key) ?? null,
      key: (index) => [...stored.keys()][index] ?? null,
      setItem: (key, value) => {
        stored.set(key, value);
      },
      removeItem: (key) => {
        stored.delete(key);
      },
    },
    keys: () => [...stored.keys()],
  };
}

function completion(
  overrides: Partial<SokobanPendingCompletion> = {},
): SokobanPendingCompletion {
  return {
    outboxId: OUTBOX_A,
    levelId: "microban-001",
    moves: 38,
    pushes: 7,
    syncId: SYNC_A,
    ...overrides,
  };
}

describe("Sokoban pending progress storage", () => {
  it("keeps same-level completions in independent immutable outbox keys", () => {
    const memory = memoryStorage();
    const oldCompletion = completion();
    const newerCompletion = completion({
      outboxId: OUTBOX_B,
      moves: 41,
      pushes: 8,
    });

    queueSokobanPendingCompletion(oldCompletion, memory.storage);
    queueSokobanPendingCompletion(newerCompletion, memory.storage);

    expect(readSokobanPendingCompletions(memory.storage)).toEqual([
      oldCompletion,
      newerCompletion,
    ]);
    expect(
      memory
        .keys()
        .filter((key) => key.startsWith(`${SOKOBAN_PENDING_STORAGE_KEY}.`)),
    ).toEqual([
      `${SOKOBAN_PENDING_STORAGE_KEY}.${OUTBOX_A}`,
      `${SOKOBAN_PENDING_STORAGE_KEY}.${OUTBOX_B}`,
    ]);

    removeSokobanPendingCompletion(oldCompletion.outboxId, memory.storage);
    expect(readSokobanPendingCompletions(memory.storage)).toEqual([
      newerCompletion,
    ]);
  });

  it("selects the smallest pending result per Guest and level", () => {
    const slower = completion({ outboxId: OUTBOX_A, moves: 41, pushes: 8 });
    const faster = completion({ outboxId: OUTBOX_B, moves: 17, pushes: 4 });
    const otherGuest = completion({
      outboxId: OUTBOX_C,
      moves: 9,
      pushes: 2,
      syncId: SYNC_B,
    });

    expect(bestSokobanPendingCompletions([slower, faster, otherGuest])).toEqual([
      faster,
      otherGuest,
    ]);
  });

  it("keeps separate levels composable across tabs", () => {
    const memory = memoryStorage();
    const first = completion();
    const second = completion({
      outboxId: OUTBOX_C,
      levelId: "microban-002",
      moves: 23,
      pushes: 8,
    });

    queueSokobanPendingCompletion(first, memory.storage);
    queueSokobanPendingCompletion(second, memory.storage);

    expect(readSokobanPendingCompletions(memory.storage)).toEqual([
      first,
      second,
    ]);
  });

  it("keeps a failed record until a later successful retry removes its exact key", () => {
    const memory = memoryStorage();
    const pending = completion({ outboxId: OUTBOX_C });
    queueSokobanPendingCompletion(pending, memory.storage);

    expect(readSokobanPendingCompletions(memory.storage)).toEqual([pending]);
    removeSokobanPendingCompletion(pending.outboxId, memory.storage);
    expect(readSokobanPendingCompletions(memory.storage)).toEqual([]);
  });

  it.each([
    "not-json",
    JSON.stringify({
      ruleVersion: "sokoban.microban-1-20.v2",
      outboxId: OUTBOX_A,
      levelId: "microban-001",
      moves: 1,
      pushes: 0,
      syncId: SYNC_A,
    }),
    JSON.stringify({
      ruleVersion: "sokoban.microban-1-20.v1",
      outboxId: "not-an-outbox-id",
      levelId: "microban-001",
      moves: 1,
      pushes: 0,
      syncId: SYNC_A,
    }),
    JSON.stringify({
      ruleVersion: "sokoban.microban-1-20.v1",
      outboxId: OUTBOX_A,
      levelId: "forged",
      moves: 1,
      pushes: 0,
      syncId: SYNC_A,
    }),
    JSON.stringify({
      ruleVersion: "sokoban.microban-1-20.v1",
      outboxId: OUTBOX_A,
      levelId: "microban-001",
      moves: 1_000_001,
      pushes: 1,
      syncId: SYNC_A,
    }),
    "x".repeat(513),
  ])("discards corrupt or untrusted pending data", (stored) => {
    const storage = memoryStorage({
      [`${SOKOBAN_PENDING_STORAGE_KEY}.${OUTBOX_A}`]: stored,
    }).storage;
    expect(readSokobanPendingCompletions(storage)).toEqual([]);
  });

  it("does not break the game when browser storage is unavailable", () => {
    const unavailable: SokobanProgressStorage = {
      length: 0,
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      key: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    };

    expect(readSokobanPendingCompletions(unavailable)).toEqual([]);
    expect(() =>
      queueSokobanPendingCompletion(completion(), unavailable)
    ).not.toThrow();
    expect(() =>
      removeSokobanPendingCompletion(OUTBOX_A, unavailable)
    ).not.toThrow();
  });

  it("retains outbox entries for every Guest while callers filter by sync id", () => {
    const memory = memoryStorage();
    const guestA = completion({ outboxId: OUTBOX_A, syncId: SYNC_A });
    const guestB = completion({ outboxId: OUTBOX_B, syncId: SYNC_B });
    queueSokobanPendingCompletion(guestA, memory.storage);
    queueSokobanPendingCompletion(guestB, memory.storage);

    expect(readSokobanPendingCompletions(memory.storage)).toEqual([
      guestA,
      guestB,
    ]);
  });
});

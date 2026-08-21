import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import type { GameRoom } from "../src/game-room";
import {
  getRecentActionReceipts,
  type StoredRoom,
} from "../src/core/room-state";
import {
  ROOM_DIRECTORY_NAME,
  type RoomDirectory,
} from "../src/room-directory";

interface TestEnv {
  ROOMS: DurableObjectNamespace<GameRoom>;
  ROOM_DIRECTORY: DurableObjectNamespace<RoomDirectory>;
}

type JsonMessage = Record<string, unknown>;

interface StoredRaceCell {
  mine: boolean;
  adjacentMines: number;
}

interface StoredRaceProgress {
  revealed: boolean[];
  flags: boolean[];
  exploded: number | null;
}

interface StoredRaceData {
  phase: "waiting_ready" | "countdown" | "playing" | "finished";
  countdownEndsAt: number | null;
  seed: string;
  field: { cells: StoredRaceCell[] } | null;
  progress: Record<string, StoredRaceProgress>;
}

class MessageInbox {
  private readonly queued: JsonMessage[] = [];
  private readonly waiters: Array<{
    predicate(message: JsonMessage): boolean;
    resolve(message: JsonMessage): void;
    reject(error: Error): void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as JsonMessage;
      const waiterIndex = this.waiters.findIndex((waiter) =>
        waiter.predicate(message),
      );
      if (waiterIndex < 0) {
        this.queued.push(message);
        return;
      }
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      if (waiter === undefined) return;
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    });
  }

  nextMatching(
    predicate: (message: JsonMessage) => boolean,
    timeoutMs = 2_000,
  ): Promise<JsonMessage> {
    const queuedIndex = this.queued.findIndex(predicate);
    if (queuedIndex >= 0) {
      return Promise.resolve(this.queued.splice(queuedIndex, 1)[0]!);
    }
    return new Promise((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("Timed out waiting for WebSocket message"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}

interface TestConnection {
  socket: WebSocket;
  inbox: MessageInbox;
  firstMessage: JsonMessage;
}

const liveSockets = new Set<WebSocket>();
const RACE_RULE_SET = "minesweeper.race.9x9x10.v1";

function fixtureRoomId(label: string): string {
  let first = 2_166_136_261;
  let second = 2_166_136_261 ^ 0x9e37_79b9;
  for (const character of label) {
    const codePoint = character.codePointAt(0) ?? 0;
    first = Math.imul(first ^ codePoint, 16_777_619);
    second = Math.imul(second ^ codePoint, 2_246_822_519);
  }
  return `r_${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")
    .slice(0, 6)}`;
}

async function initializeRoom(
  label: string,
  gameType = "minesweeper",
  ruleSetId = RACE_RULE_SET,
): Promise<DurableObjectStub<GameRoom>> {
  const testEnv = env as unknown as TestEnv;
  const roomId = fixtureRoomId(label);
  const directory = testEnv.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME);
  const reservation = await directory.reserve(roomId);
  if (!reservation.ok) throw new Error(reservation.reason);
  const stub = testEnv.ROOMS.get(testEnv.ROOMS.idFromName(roomId));
  const response = await stub.fetch(
    new Request("https://room.internal/initialize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Guest-Id": "guest-race-a",
      },
      body: JSON.stringify({
        roomId,
        gameType,
        ruleSetId,
        capacityLeaseId: reservation.leaseId,
      }),
    }),
  );
  expect(response.status).toBe(201);
  return stub;
}

async function connect(
  stub: DurableObjectStub<GameRoom>,
  guestId: string,
): Promise<TestConnection> {
  const response = await stub.fetch(
    new Request("https://room.internal/websocket", {
      headers: {
        Upgrade: "websocket",
        "X-Internal-Guest-Id": guestId,
      },
    }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const inbox = new MessageInbox(socket);
  liveSockets.add(socket);
  socket.addEventListener("close", () => liveSockets.delete(socket));
  socket.accept();
  return { socket, inbox, firstMessage: await inbox.nextMatching(() => true) };
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState >= WebSocket.CLOSING) return;
  socket.close(1000, "test complete");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function postRoomHttp(
  stub: DurableObjectStub<GameRoom>,
  path: "sync" | "command",
  guestId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; message: JsonMessage }> {
  const response = await stub.fetch(
    new Request(`https://room.internal/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Guest-Id": guestId,
      },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    message: (await response.json()) as JsonMessage,
  };
}

function raceCommand(
  baseRevision: number,
  actionId: string,
  clientSeq: number,
  payload: Record<string, unknown>,
) {
  return {
    v: 1,
    type: "game_action",
    gameType: "minesweeper",
    ruleSetId: RACE_RULE_SET,
    expectedRevision: baseRevision,
    actionId,
    clientSeq,
    baseRevision,
    payload,
  };
}

function publicData(message: JsonMessage): Record<string, unknown> {
  const position = message.position as Record<string, unknown> | undefined;
  const data = position?.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Expected a public race position");
  }
  return data as Record<string, unknown>;
}

function revealedIndices(message: JsonMessage): number[] {
  const revealed = publicData(message).revealed;
  if (!Array.isArray(revealed)) throw new Error("Expected revealed cells");
  return revealed.map((cell) => (cell as { index: number }).index);
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (typeof value !== "object" || value === null) return keys;
  for (const [key, item] of Object.entries(value)) {
    keys.add(key);
    collectKeys(item, keys);
  }
  return keys;
}

function expectNoRaceSecrets(message: JsonMessage): void {
  const keys = collectKeys(publicData(message));
  for (const forbidden of ["seed", "field", "cells", "mine", "mines"]) {
    expect(keys.has(forbidden), `public snapshot leaked ${forbidden}`).toBe(
      false,
    );
  }
}

async function readRaceData(
  stub: DurableObjectStub<GameRoom>,
): Promise<{ room: StoredRoom; data: StoredRaceData }> {
  const room = await runInDurableObject(stub, (_instance, state) =>
    state.storage.get<StoredRoom>("room"),
  );
  if (room?.position === null || room?.position === undefined) {
    throw new Error("Expected a stored race position");
  }
  return { room, data: room.position.data as unknown as StoredRaceData };
}

async function setRaceSeed(
  stub: DurableObjectStub<GameRoom>,
  seed: string,
): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    const room = await state.storage.get<StoredRoom>("room");
    if (room?.position === null || room?.position === undefined) {
      throw new Error("Expected a stored race position");
    }
    const next: StoredRoom = {
      ...room,
      position: {
        ...room.position,
        data: {
          ...(room.position.data as Record<string, unknown>),
          seed,
        },
      },
    };
    await (
      instance as unknown as { persist(nextRoom: StoredRoom): Promise<void> }
    ).persist(next);
  });
}

function point(index: number): { x: number; y: number } {
  return { x: index % 9, y: Math.floor(index / 9) };
}

function findHiddenSafeNumbers(data: StoredRaceData, count: number): number[] {
  return data.field!.cells.flatMap((cell, index) =>
    !cell.mine &&
    cell.adjacentMines > 0 &&
    !data.progress["seat-a"]!.revealed[index]
      ? [index]
      : [],
  ).slice(0, count);
}

interface StartedRace {
  stub: DurableObjectStub<GameRoom>;
  creator: TestConnection;
  invitee: TestConnection;
  spectator: TestConnection;
  countdown: {
    creator: JsonMessage;
    invitee: JsonMessage;
    spectator: JsonMessage;
  };
}

async function startRace(label: string): Promise<StartedRace> {
  const stub = await initializeRoom(label);
  const creator = await connect(stub, "guest-race-a");
  const invitee = await connect(stub, "guest-race-b");
  await creator.inbox.nextMatching(
    (message) => message.type === "snapshot" && message.revision === 1,
  );
  await setRaceSeed(stub, `fixed-${label}`);
  const spectator = await connect(stub, "guest-race-spectator");

  creator.socket.send(
    JSON.stringify(raceCommand(1, `${label}-a-ready`, 1, { type: "ready" })),
  );
  await creator.inbox.nextMatching(
    (message) => message.type === "snapshot" && message.revision === 2,
  );

  invitee.socket.send(
    JSON.stringify(raceCommand(1, `${label}-b-ready`, 1, { type: "ready" })),
  );
  const countdown = {
    creator: await creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 3,
    ),
    invitee: await invitee.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 3,
    ),
    spectator: await spectator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 3,
    ),
  };
  const countdownEndsAt = publicData(countdown.creator).countdownEndsAt;
  if (typeof countdownEndsAt !== "number") {
    throw new Error("Expected a countdown deadline");
  }
  vi.setSystemTime(countdownEndsAt + 1);
  return { stub, creator, invitee, spectator, countdown };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...liveSockets].map(closeSocket));
  liveSockets.clear();
  await reset();
});

describe("Minesweeper race through GameRoom", () => {
  it("accepts stale-base actions on independent boards and keeps projections private", async () => {
    const started = await startRace("race-independent");
    const initial = await readRaceData(started.stub);
    const [sameCell, creatorCell, inviteeCell, creatorFlag] =
      findHiddenSafeNumbers(initial.data, 4);
    expect([sameCell, creatorCell, inviteeCell, creatorFlag]).not.toContain(
      undefined,
    );
    const httpConnectionId = "race-independent-http-b";
    await postRoomHttp(started.stub, "sync", "guest-race-b", {
      v: 1,
      connectionId: httpConnectionId,
    });

    started.creator.socket.send(
      JSON.stringify(
        raceCommand(3, "race-a-same", 2, {
          type: "reveal",
          ...point(sameCell!),
        }),
      ),
    );
    await started.creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 4,
    );
    const inviteeSame = await postRoomHttp(
      started.stub,
      "command",
      "guest-race-b",
      {
        v: 1,
        connectionId: httpConnectionId,
        command: raceCommand(3, "race-b-same", 2, {
          type: "reveal",
          ...point(sameCell!),
        }),
      },
    );
    expect(inviteeSame.message).toMatchObject({
      type: "snapshot",
      revision: 5,
      actionReceipts: expect.arrayContaining([
        expect.objectContaining({
          actionId: "race-b-same",
          status: "applied",
          revision: 5,
        }),
      ]),
    });

    started.creator.socket.send(
      JSON.stringify(
        raceCommand(3, "race-a-own", 3, {
          type: "reveal",
          ...point(creatorCell!),
        }),
      ),
    );
    await started.creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 6,
    );
    const inviteeOwnCommand = raceCommand(3, "race-b-own", 3, {
      type: "reveal",
      ...point(inviteeCell!),
    });
    const inviteeOwn = await postRoomHttp(
      started.stub,
      "command",
      "guest-race-b",
      {
        v: 1,
        connectionId: httpConnectionId,
        command: inviteeOwnCommand,
      },
    );
    expect(inviteeOwn.message).toMatchObject({ revision: 7 });
    const beforeDuplicate = publicData(inviteeOwn.message).progress;

    const duplicate = await postRoomHttp(
      started.stub,
      "command",
      "guest-race-b",
      {
        v: 1,
        connectionId: httpConnectionId,
        command: inviteeOwnCommand,
      },
    );
    expect(duplicate.message).toMatchObject({ revision: 7 });
    expect(publicData(duplicate.message).progress).toEqual(beforeDuplicate);
    const storedAfterDuplicate = await readRaceData(started.stub);
    expect(storedAfterDuplicate.room.revision).toBe(7);
    expect(
      getRecentActionReceipts(storedAfterDuplicate.room, "seat-b").filter(
        (receipt) => receipt.actionId === "race-b-own",
      ),
    ).toHaveLength(1);

    started.creator.socket.send(
      JSON.stringify(
        raceCommand(3, "race-a-private-flag", 4, {
          type: "set_flag",
          flagged: true,
          ...point(creatorFlag!),
        }),
      ),
    );
    await started.creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 8,
    );
    const inviteeRevealFlaggedForOpponent = await postRoomHttp(
      started.stub,
      "command",
      "guest-race-b",
      {
        v: 1,
        connectionId: httpConnectionId,
        command: raceCommand(3, "race-b-opponent-flag", 4, {
          type: "reveal",
          ...point(creatorFlag!),
        }),
      },
    );
    expect(inviteeRevealFlaggedForOpponent.message).toMatchObject({
      revision: 9,
    });
    const creatorView = await started.creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 9,
    );
    const spectatorView = await started.spectator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 9,
    );
    const inviteeView = inviteeRevealFlaggedForOpponent.message;

    expect(revealedIndices(creatorView)).toEqual(
      expect.arrayContaining([sameCell!, creatorCell!]),
    );
    expect(revealedIndices(creatorView)).not.toContain(inviteeCell);
    expect(publicData(creatorView).flags).toEqual([creatorFlag]);
    expect(revealedIndices(inviteeView)).toEqual(
      expect.arrayContaining([sameCell!, inviteeCell!, creatorFlag!]),
    );
    expect(revealedIndices(inviteeView)).not.toContain(creatorCell);
    expect(publicData(inviteeView).flags).toEqual([]);
    expect(revealedIndices(spectatorView)).toEqual([]);
    expect(publicData(spectatorView).flags).toEqual([]);
    expect(publicData(creatorView).progress).toEqual(
      publicData(inviteeView).progress,
    );
    expect(publicData(spectatorView).progress).toEqual(
      publicData(inviteeView).progress,
    );
    for (const snapshot of [creatorView, inviteeView, spectatorView]) {
      expectNoRaceSecrets(snapshot);
    }
  });

  it("commits one terminal result and rejects every later action", async () => {
    const started = await startRace("race-single-terminal");
    const initial = await readRaceData(started.stub);
    const mine = initial.data.field!.cells.findIndex((cell) => cell.mine);
    const lateSafe = initial.data.field!.cells.findIndex(
      (cell, index) =>
        !cell.mine && !initial.data.progress["seat-b"]!.revealed[index],
    );
    expect(mine).toBeGreaterThanOrEqual(0);
    expect(lateSafe).toBeGreaterThanOrEqual(0);
    const httpConnectionId = "race-terminal-http-b";
    await postRoomHttp(started.stub, "sync", "guest-race-b", {
      v: 1,
      connectionId: httpConnectionId,
    });

    started.creator.socket.send(
      JSON.stringify(
        raceCommand(3, "race-a-hit-mine", 2, {
          type: "reveal",
          ...point(mine),
        }),
      ),
    );
    const terminal = await started.creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 4,
    );
    expect(terminal).toMatchObject({
      position: {
        outcome: {
          kind: "win",
          winner: "seat-b",
          reason: "opponent_hit_mine",
        },
        data: {
          phase: "finished",
          exploded: mine,
          mines: expect.arrayContaining([mine]),
        },
      },
    });
    expect(collectKeys(publicData(terminal)).has("seed")).toBe(false);

    const tooLate = await postRoomHttp(
      started.stub,
      "command",
      "guest-race-b",
      {
        v: 1,
        connectionId: httpConnectionId,
        command: raceCommand(3, "race-b-after-terminal", 2, {
          type: "reveal",
          ...point(lateSafe),
        }),
      },
    );
    expect(tooLate.message).toMatchObject({
      type: "error",
      code: "minesweeper.game_finished",
      actionId: "race-b-after-terminal",
      snapshot: {
        revision: 4,
        position: {
          outcome: {
            kind: "win",
            winner: "seat-b",
            reason: "opponent_hit_mine",
          },
          data: { phase: "finished", mines: expect.arrayContaining([mine]) },
        },
        actionReceipts: expect.arrayContaining([
          expect.objectContaining({
            actionId: "race-b-after-terminal",
            status: "rejected",
            code: "minesweeper.game_finished",
          }),
        ]),
      },
    });
    const final = await readRaceData(started.stub);
    expect(final.room.position?.outcome).toEqual({
      kind: "win",
      winner: "seat-b",
      reason: "opponent_hit_mine",
    });
    expect(final.data.progress["seat-a"]!.exploded).toBe(mine);
    expect(final.data.progress["seat-b"]!.exploded).toBeNull();
  });

  it("keeps legacy duel available and strict board games revision-gated", async () => {
    const duel = await initializeRoom(
      "legacy-duel-still-supported",
      "minesweeper",
      "minesweeper.duel.9x9x10.v1",
    );
    const duelCreator = await connect(duel, "guest-race-a");
    const duelInvitee = await connect(duel, "guest-legacy-b");
    await duelCreator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 1,
    );
    expect(duelInvitee.firstMessage).toMatchObject({
      ruleSetId: "minesweeper.duel.9x9x10.v1",
      actionConsistency: "concurrent_idempotent",
      position: { data: { phase: "waiting_ready" } },
    });

    const gomoku = await initializeRoom(
      "strict-gomoku-still-supported",
      "gomoku",
      "gomoku.freestyle15.v1",
    );
    const gomokuCreator = await connect(gomoku, "guest-race-a");
    await connect(gomoku, "guest-gomoku-b");
    await gomokuCreator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 1,
    );
    gomokuCreator.socket.send(
      JSON.stringify({
        v: 1,
        type: "game_action",
        gameType: "gomoku",
        ruleSetId: "gomoku.freestyle15.v1",
        expectedRevision: 0,
        payload: { type: "place", x: 7, y: 7 },
      }),
    );
    await expect(
      gomokuCreator.inbox.nextMatching((message) => message.type === "error"),
    ).resolves.toMatchObject({
      code: "room.revision_mismatch",
      snapshot: { revision: 1, position: { data: { moveCount: 0 } } },
    });
  });
});

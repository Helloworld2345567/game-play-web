import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import type { GameRoom } from "../src/game-room";
import {
  createRoom,
  getRecentActionReceipts,
  type StoredRoom,
} from "../src/core/room-state";
import { getGameRules } from "../src/games/registry";
import {
  ROOM_DIRECTORY_NAME,
  ROOM_PROVISIONAL_LEASE_MS,
  type RoomDirectory,
} from "../src/room-directory";

interface TestEnv {
  ROOMS: DurableObjectNamespace<GameRoom>;
  ROOM_DIRECTORY: DurableObjectNamespace<RoomDirectory>;
}

type JsonMessage = Record<string, unknown>;

class MessageInbox {
  readonly history: JsonMessage[] = [];
  private readonly queued: JsonMessage[] = [];
  private readonly waiters: Array<{
    predicate(message: JsonMessage): boolean;
    resolve(message: JsonMessage): void;
    reject(error: Error): void;
    timeout: number;
  }> = [];

  constructor(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as JsonMessage;
      this.history.push(message);
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

  next(timeoutMs = 2_000): Promise<JsonMessage> {
    return this.nextMatching(() => true, timeoutMs);
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

interface InitializedRoomFixture {
  stub: DurableObjectStub<GameRoom>;
  roomId: string;
  capacityLeaseId: string;
}

function fixtureRoomId(label: string): string {
  if (/^[A-Za-z0-9_-]{16}$/u.test(label)) return label;
  let first = 2_166_136_261;
  let second = 2_166_136_261 ^ 0x9e37_79b9;
  for (const character of label) {
    const codePoint = character.codePointAt(0) ?? 0;
    first = Math.imul(first ^ codePoint, 16_777_619);
    second = Math.imul(second ^ codePoint, 2_246_822_519);
  }
  return `t_${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")
    .slice(0, 6)}`;
}

async function connect(
  stub: DurableObjectStub<GameRoom>,
  guestId: string,
  displayName?: string,
  connectionId = crypto.randomUUID(),
): Promise<TestConnection> {
  const headers = new Headers({
    Upgrade: "websocket",
    "X-Internal-Guest-Id": guestId,
  });
  if (displayName !== undefined) {
    headers.set("X-Internal-Display-Name", encodeURIComponent(displayName));
  }
  const response = await stub.fetch(
    new Request(
      `https://room.internal/websocket?connectionId=${encodeURIComponent(connectionId)}`,
      {
        headers,
      },
    ),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const inbox = new MessageInbox(socket);
  liveSockets.add(socket);
  socket.addEventListener("close", () => liveSockets.delete(socket));
  socket.accept();
  return { socket, inbox, firstMessage: await inbox.next() };
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState >= WebSocket.CLOSING) return;
  socket.close(1000, "test reconnect");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function initializeManagedRoom(
  roomLabel: string,
  creatorGuestId = "guest-creator",
  gameType = "gomoku",
  ruleSetId = "gomoku.freestyle15.v1",
  creatorDisplayName?: string,
): Promise<InitializedRoomFixture> {
  const testEnv = env as unknown as TestEnv;
  const roomId = fixtureRoomId(roomLabel);
  const directory = testEnv.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME);
  const reservation = await directory.reserve(roomId);
  if (!reservation.ok) {
    throw new Error(`Unable to reserve test Room: ${reservation.reason}`);
  }
  const stub = testEnv.ROOMS.get(testEnv.ROOMS.idFromName(roomId));
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Internal-Guest-Id": creatorGuestId,
  });
  if (creatorDisplayName !== undefined) {
    headers.set(
      "X-Internal-Display-Name",
      encodeURIComponent(creatorDisplayName),
    );
  }
  const initialized = await stub.fetch(
    new Request("https://room.internal/initialize", {
      method: "POST",
      headers,
      body: JSON.stringify({
        roomId,
        gameType,
        ruleSetId,
        capacityLeaseId: reservation.leaseId,
      }),
    }),
  );
  expect(initialized.status).toBe(201);
  return { stub, roomId, capacityLeaseId: reservation.leaseId };
}

async function initializeRoom(
  roomLabel: string,
  creatorGuestId = "guest-creator",
  gameType = "gomoku",
  ruleSetId = "gomoku.freestyle15.v1",
  creatorDisplayName?: string,
): Promise<DurableObjectStub<GameRoom>> {
  return (
    await initializeManagedRoom(
      roomLabel,
      creatorGuestId,
      gameType,
      ruleSetId,
      creatorDisplayName,
    )
  ).stub;
}

/**
 * Legacy-only duel rooms are loaded for recovery but cannot be initialized
 * through the production boundary. Seed one directly so the projection and
 * concurrent-action tests continue to exercise the legacy reader.
 */
async function seedLegacyMinesweeperRoom(
  roomLabel: string,
  creatorGuestId = "guest-mine-creator",
): Promise<InitializedRoomFixture> {
  const testEnv = env as unknown as TestEnv;
  const roomId = fixtureRoomId(roomLabel);
  const directory = testEnv.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME);
  const reservation = await directory.reserve(roomId);
  if (!reservation.ok) {
    throw new Error(`Unable to reserve test Room: ${reservation.reason}`);
  }
  const rules = getGameRules(MINESWEEPER_SMALL_RULE_SET);
  if (rules === null) throw new Error("Missing legacy minesweeper rules");
  const now = Date.now();
  const room = createRoom({
    roomId,
    creatorGuestId,
    rules,
    now,
  });
  const stub = testEnv.ROOMS.get(testEnv.ROOMS.idFromName(roomId));
  const activated = await directory.activate(roomId, reservation.leaseId);
  if (!activated) throw new Error("Unable to activate test Room lease");
  await runInDurableObject(stub, async (instance, state) => {
    const target = instance as unknown as {
      room: StoredRoom | null;
      displayNames: Record<string, string>;
      snapshotRevision: number;
      capacityLeaseId: string | null;
      capacityPhase: "provisioning" | "active" | null;
      capacityProvisioningSince: number | null;
    };
    target.room = room;
    target.displayNames = { [creatorGuestId]: "测试玩家" };
    target.snapshotRevision = 0;
    target.capacityLeaseId = reservation.leaseId;
    target.capacityPhase = "active";
    target.capacityProvisioningSince = null;
    await state.storage.put("room", room);
    await state.storage.put("displayNames", target.displayNames);
    await state.storage.put("snapshotRevision", 0);
    await state.storage.put("capacityLeaseId", reservation.leaseId);
    await state.storage.put("capacityPhase", "active");
    await state.storage.delete("capacityProvisioningSince");
  });
  return { stub, roomId, capacityLeaseId: reservation.leaseId };
}

async function makeLegacyRoom(
  fixture: InitializedRoomFixture,
): Promise<void> {
  const testEnv = env as unknown as TestEnv;
  const directory = testEnv.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME);
  await directory.release(fixture.roomId, fixture.capacityLeaseId);
  await runInDurableObject(fixture.stub, async (instance, state) => {
    await state.storage.delete([
      "capacityLeaseId",
      "capacityPhase",
      "capacityProvisioningSince",
    ]);
    const target = instance as unknown as {
      capacityLeaseId: string | null;
      capacityPhase: "provisioning" | "active" | null;
      capacityProvisioningSince: number | null;
    };
    target.capacityLeaseId = null;
    target.capacityPhase = null;
    target.capacityProvisioningSince = null;
  });
}

async function postRoomHttp(
  stub: DurableObjectStub<GameRoom>,
  path: "sync" | "command" | "leave",
  guestId: string,
  body: Record<string, unknown>,
  displayName?: string,
): Promise<{ status: number; message: JsonMessage }> {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Internal-Guest-Id": guestId,
  });
  if (displayName !== undefined) {
    headers.set("X-Internal-Display-Name", encodeURIComponent(displayName));
  }
  const response = await stub.fetch(
    new Request(`https://room.internal/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    message: (await response.json()) as JsonMessage,
  };
}

async function postRoomHttpRaw(
  stub: DurableObjectStub<GameRoom>,
  path: "sync" | "command" | "leave",
  guestId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return stub.fetch(
    new Request(`https://room.internal/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Guest-Id": guestId,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function startRoom(
  roomLabel: string,
  creatorGuestId = "guest-creator",
  inviteeGuestId = "guest-invitee",
): Promise<{
  stub: DurableObjectStub<GameRoom>;
  roomId: string;
  capacityLeaseId: string;
  creator: TestConnection;
  invitee: TestConnection;
}> {
  const initialized = await initializeManagedRoom(roomLabel, creatorGuestId);
  const { stub } = initialized;
  const creator = await connect(stub, creatorGuestId);
  const invitee = await connect(stub, inviteeGuestId);
  // Turn-based rooms now expose an opening preparation phase. Keep this
  // helper's contract as a fully started room for the many lifecycle tests
  // below, but exercise the public role-selection commands rather than
  // mutating the Durable Object state behind the test seam.
  await creator.inbox.nextMatching(
    (message) => message.type === "snapshot" && message.revision === 1,
  );
  const creatorRoleSnapshot = creator.inbox.nextMatching(
    (message) => message.type === "snapshot" && message.revision === 2,
  );
  const inviteeRoleSnapshot = invitee.inbox.nextMatching(
    (message) => message.type === "snapshot" && message.revision === 2,
  );
  creator.socket.send(
    JSON.stringify(prepareRoleCommand(1, "black")),
  );
  await Promise.all([creatorRoleSnapshot, inviteeRoleSnapshot]);

  const creatorStarted = creator.inbox.nextMatching(
    (message) => message.type === "snapshot" && message.revision === 3,
  );
  const inviteeStarted = invitee.inbox.nextMatching(
    (message) => message.type === "snapshot" && message.revision === 3,
  );
  invitee.socket.send(
    JSON.stringify(prepareRoleCommand(2, "white")),
  );
  await Promise.all([creatorStarted, inviteeStarted]);
  return { ...initialized, creator, invitee };
}

function prepareRoleCommand(expectedRevision: number, roleId: string) {
  return {
    v: 1,
    type: "prepare_role",
    expectedRevision,
    roleId,
  };
}

function latestSnapshotRevision(connection: TestConnection): number {
  const snapshot = [...connection.inbox.history]
    .reverse()
    .find((message) => message.type === "snapshot");
  if (snapshot === undefined || typeof snapshot.revision !== "number") {
    throw new Error("Expected a latest Room snapshot revision");
  }
  return snapshot.revision;
}

const STARTED_TURN_ROOM_REVISION = 3;
const AFTER_FIRST_TURN_ACTION_REVISION = 4;

function placeCommand(expectedRevision: number, x: number, y: number) {
  return {
    v: 1,
    type: "game_action",
    gameType: "gomoku",
    ruleSetId: "gomoku.freestyle15.v1",
    expectedRevision,
    payload: { type: "place", x, y },
  };
}

function leaveCommand() {
  return {
    v: 1,
    type: "leave",
  };
}

function xiangqiMoveCommand(
  expectedRevision: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
) {
  return {
    v: 1,
    type: "game_action",
    gameType: "xiangqi",
    ruleSetId: "xiangqi.casual.v1",
    expectedRevision,
    payload: { type: "move", fromX, fromY, toX, toY },
  };
}

const MINESWEEPER_GAME_TYPE = "minesweeper";
const MINESWEEPER_SMALL_RULE_SET = "minesweeper.duel.9x9x10.v1";

interface StoredMinesweeperCell {
  mine: boolean;
  adjacentMines: number;
}

interface StoredMinesweeperData {
  phase: "waiting_ready" | "countdown" | "selecting" | "playing" | "finished";
  countdownEndsAt: number | null;
  field: { cells: StoredMinesweeperCell[] } | null;
  revealed: boolean[];
  revealedBy: Array<string | null>;
  privateFlags: Record<string, boolean[]>;
  scores: Record<string, number>;
  exploded: number | null;
}

interface StartedMinesweeperRoom {
  stub: DurableObjectStub<GameRoom>;
  creator: TestConnection;
  invitee: TestConnection;
  spectator: TestConnection;
  firstSelection: {
    creator: JsonMessage;
    invitee: JsonMessage;
    spectator: JsonMessage;
  };
  playing: {
    creator: JsonMessage;
    invitee: JsonMessage;
    spectator: JsonMessage;
  };
}

function minesweeperCommand(
  baseRevision: number,
  actionId: string,
  clientSeq: number,
  payload: Record<string, unknown>,
) {
  return {
    v: 1,
    type: "game_action",
    gameType: MINESWEEPER_GAME_TYPE,
    ruleSetId: MINESWEEPER_SMALL_RULE_SET,
    expectedRevision: baseRevision,
    actionId,
    clientSeq,
    baseRevision,
    payload,
  };
}

function minesweeperPublicData(message: JsonMessage): Record<string, unknown> {
  const position = message.position;
  if (
    typeof position !== "object" ||
    position === null ||
    Array.isArray(position)
  ) {
    throw new Error("Expected a minesweeper position");
  }
  const data = (position as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Expected public minesweeper data");
  }
  return data as Record<string, unknown>;
}

function collectObjectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectObjectKeys(entry, keys);
    return keys;
  }
  if (typeof value !== "object" || value === null) return keys;
  for (const [key, entry] of Object.entries(value)) {
    keys.add(key);
    collectObjectKeys(entry, keys);
  }
  return keys;
}

function expectPreFinishMinesweeperSnapshotToBePublic(
  message: JsonMessage,
): void {
  const data = minesweeperPublicData(message);
  const keys = collectObjectKeys(data);
  for (const forbidden of [
    "seed",
    "field",
    "cells",
    "mine",
    "privateFlags",
    "startSelections",
    "mines",
  ]) {
    expect(keys.has(forbidden), `public snapshot leaked ${forbidden}`).toBe(
      false,
    );
  }
}

async function readStoredMinesweeper(
  stub: DurableObjectStub<GameRoom>,
): Promise<{ room: StoredRoom; data: StoredMinesweeperData }> {
  const room = await runInDurableObject(stub, (_instance, state) =>
    state.storage.get<StoredRoom>("room"),
  );
  if (room?.position === null || room?.position === undefined) {
    throw new Error("Expected a stored minesweeper position");
  }
  return {
    room,
    data: room.position.data as unknown as StoredMinesweeperData,
  };
}

async function setStoredMinesweeperSeed(
  stub: DurableObjectStub<GameRoom>,
  seed: string,
): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    const room = await state.storage.get<StoredRoom>("room");
    if (room?.position === null || room?.position === undefined) {
      throw new Error("Expected a stored minesweeper position");
    }
    const data = room.position.data as unknown as StoredMinesweeperData & {
      seed: string;
    };
    const next: StoredRoom = {
      ...room,
      position: {
        ...room.position,
        data: { ...data, seed } as unknown as typeof room.position.data,
      },
    };
    await (
      instance as unknown as { persist(nextRoom: StoredRoom): Promise<void> }
    ).persist(next);
  });
}

function cellPoint(index: number): { x: number; y: number } {
  return { x: index % 9, y: Math.floor(index / 9) };
}

function findHiddenSafeNumber(
  data: StoredMinesweeperData,
  excluded: ReadonlySet<number> = new Set(),
): number {
  return (
    data.field?.cells.findIndex(
      (cell, index) =>
        !cell.mine &&
        cell.adjacentMines > 0 &&
        !data.revealed[index] &&
        !excluded.has(index),
    ) ?? -1
  );
}

async function startMinesweeperRoom(
  roomLabel: string,
  firstStart = { x: 1, y: 1 },
  secondStart = { x: 7, y: 7 },
): Promise<StartedMinesweeperRoom> {
  const initialized = await seedLegacyMinesweeperRoom(
    roomLabel,
    "guest-mine-creator",
  );
  const { stub } = initialized;
  const creator = await connect(stub, "guest-mine-creator");
  const invitee = await connect(stub, "guest-mine-invitee");
  await creator.inbox.nextMatching(
    (message) => message.type === "snapshot" && message.revision === 1,
  );
  await setStoredMinesweeperSeed(stub, "worker-minesweeper-fixed-seed");
  const spectator = await connect(stub, "guest-mine-spectator");

  creator.socket.send(
    JSON.stringify(
      minesweeperCommand(1, `${roomLabel}-a-ready`, 1, { type: "ready" }),
    ),
  );
  await creator.inbox.nextMatching(
    (message) => message.type === "snapshot" && message.revision === 2,
  );

  invitee.socket.send(
    JSON.stringify(
      minesweeperCommand(1, `${roomLabel}-b-ready`, 1, { type: "ready" }),
    ),
  );
  const countdown = await invitee.inbox.nextMatching(
    (message) => message.type === "snapshot" && message.revision === 3,
  );
  const countdownEndsAt = minesweeperPublicData(countdown).countdownEndsAt;
  if (typeof countdownEndsAt !== "number") {
    throw new Error("Expected a minesweeper countdown deadline");
  }
  vi.setSystemTime(countdownEndsAt + 1);

  creator.socket.send(
    JSON.stringify(
      minesweeperCommand(3, `${roomLabel}-a-start`, 2, {
        type: "select_start",
        ...firstStart,
      }),
    ),
  );
  const firstSelection = {
    creator: await creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 4,
    ),
    invitee: await invitee.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 4,
    ),
    spectator: await spectator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 4,
    ),
  };

  invitee.socket.send(
    JSON.stringify(
      minesweeperCommand(3, `${roomLabel}-b-start`, 2, {
        type: "select_start",
        ...secondStart,
      }),
    ),
  );
  const playing = {
    creator: await creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 5,
    ),
    invitee: await invitee.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 5,
    ),
    spectator: await spectator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 5,
    ),
  };

  return {
    ...initialized,
    creator,
    invitee,
    spectator,
    firstSelection,
    playing,
  };
}

afterEach(async () => {
  await Promise.all([...liveSockets].map(closeSocket));
  liveSockets.clear();
  await reset();
});

describe("GameRoom Durable Object", () => {
  it("admits four Chinese Checkers players before starting and keeps later guests spectators", async () => {
    const ruleset = "chinese-checkers.room.4p.v1";
    const stub = await initializeRoom(
      "room-checkers-4p",
      "guest-checkers-a",
      "chinese-checkers",
      ruleset,
    );
    const players = [] as TestConnection[];
    for (const guestId of [
      "guest-checkers-a",
      "guest-checkers-b",
      "guest-checkers-c",
      "guest-checkers-d",
    ]) {
      players.push(await connect(stub, guestId));
    }

    const started = players[3]!.firstMessage;
    expect(started).toMatchObject({
      type: "snapshot",
      revision: 3,
      seatOrder: ["seat-a", "seat-b", "seat-c", "seat-d"],
      selfSeat: "seat-d",
      position: { turn: "seat-a" },
    });
    expect(Object.keys(started.seats as Record<string, unknown>)).toEqual([
      "seat-a",
      "seat-b",
      "seat-c",
      "seat-d",
    ]);

    const spectator = await connect(stub, "guest-checkers-spectator");
    expect(spectator.firstMessage).toMatchObject({
      type: "snapshot",
      revision: 3,
      selfSeat: null,
      seatOrder: ["seat-a", "seat-b", "seat-c", "seat-d"],
      position: { turn: "seat-a" },
    });

    const revisionFour = Promise.all(
      [...players, spectator].map((connection) =>
        connection.inbox.nextMatching(
          (message) => message.type === "snapshot" && message.revision === 4,
        ),
      ),
    );
    players[0]!.socket.send(
      JSON.stringify({
        v: 1,
        type: "game_action",
        gameType: "chinese-checkers",
        ruleSetId: ruleset,
        expectedRevision: 3,
        payload: {
          type: "move",
          from: "-6,-4",
          to: "-5,-3",
        },
      }),
    );
    // Keep the assertion below independent of which connection receives the
    // broadcast first; every player and spectator must observe the revision.
    const snapshots = await revisionFour;
    expect(snapshots[0]).toMatchObject({
      selfSeat: "seat-a",
      position: { turn: "seat-b" },
    });
    expect(snapshots[3]).toMatchObject({
      selfSeat: "seat-d",
      position: { turn: "seat-b" },
    });
    expect(snapshots[4]).toMatchObject({
      selfSeat: null,
      position: { turn: "seat-b" },
    });
  });

  it("reserves independent player and spectator budgets in a four-player Room", async () => {
    const ruleset = "chinese-checkers.room.4p.v1";
    const stub = await initializeRoom(
      "room-checkers-4p-connection-cap",
      "guest-checkers-a",
      "chinese-checkers",
      ruleset,
    );
    const playerIds = [
      "guest-checkers-a",
      "guest-checkers-b",
      "guest-checkers-c",
      "guest-checkers-d",
    ];

    for (const guestId of playerIds) {
      expect((await connect(stub, guestId)).firstMessage).toMatchObject({
        type: "snapshot",
      });
    }
    for (const guestId of playerIds) {
      expect((await connect(stub, guestId)).firstMessage).toMatchObject({
        type: "snapshot",
      });
    }

    expect(
      (await connect(stub, "guest-checkers-a")).firstMessage,
    ).toEqual({
      v: 1,
      type: "error",
      code: "room.too_many_connections",
    });

    for (let index = 0; index < 8; index += 1) {
      expect(
        (await connect(stub, `guest-checkers-spectator-${index}`)).firstMessage,
      ).toMatchObject({ type: "snapshot", selfSeat: null });
    }
    expect(
      (await connect(stub, "guest-checkers-spectator-overflow")).firstMessage,
    ).toEqual({
      v: 1,
      type: "error",
      code: "room.too_many_connections",
    });
  });

  it("rejects initialization that attempts to bypass Room capacity", async () => {
    const testEnv = env as unknown as TestEnv;
    const roomId = "bypass-room-0001";
    const stub = testEnv.ROOMS.get(testEnv.ROOMS.idFromName(roomId));

    const response = await stub.fetch(
      new Request("https://room.internal/initialize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Guest-Id": "guest-bypass-creator",
        },
        body: JSON.stringify({
          roomId,
          gameType: "gomoku",
          ruleSetId: "gomoku.freestyle15.v1",
          capacityMode: "unmanaged-test-fixture",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get("room"),
      ),
    ).resolves.toBeUndefined();
  });

  it("requires a Room capacity lease for initialization", async () => {
    const testEnv = env as unknown as TestEnv;
    const roomId = "no-lease-room-01";
    const stub = testEnv.ROOMS.get(testEnv.ROOMS.idFromName(roomId));

    const response = await stub.fetch(
      new Request("https://room.internal/initialize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Guest-Id": "guest-no-lease-creator",
        },
        body: JSON.stringify({
          roomId,
          gameType: "gomoku",
          ruleSetId: "gomoku.freestyle15.v1",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get("room"),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects legacy-only rules at the Room initialization boundary", async () => {
    const testEnv = env as unknown as TestEnv;
    const roomId = "legacy-only-init-01";
    const stub = testEnv.ROOMS.get(testEnv.ROOMS.idFromName(roomId));

    const response = await stub.fetch(
      new Request("https://room.internal/initialize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Guest-Id": "guest-legacy-init-creator",
        },
        body: JSON.stringify({
          roomId,
          gameType: "minesweeper",
          ruleSetId: "minesweeper.duel.9x9x10.v1",
          capacityLeaseId: "00000000-0000-4000-8000-000000000000",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get("room"),
      ),
    ).resolves.toBeUndefined();
  });

  it("treats a retry with the same creator and capacity lease as one initialization", async () => {
    const roomId = "retry-room-00001";
    const testEnv = env as unknown as TestEnv;
    const directory = testEnv.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME);
    const reservation = await directory.reserve(roomId);
    if (!reservation.ok) throw new Error("Expected a Room lease");
    const stub = testEnv.ROOMS.get(testEnv.ROOMS.idFromName(roomId));
    const initialize = (guestId: string) =>
      stub.fetch(
        new Request("https://room.internal/initialize", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Guest-Id": guestId,
          },
          body: JSON.stringify({
            roomId,
            gameType: "gomoku",
            ruleSetId: "gomoku.freestyle15.v1",
            capacityLeaseId: reservation.leaseId,
          }),
        }),
      );

    await expect(initialize("guest-retry-creator")).resolves.toMatchObject({
      status: 201,
    });
    await expect(initialize("guest-retry-creator")).resolves.toMatchObject({
      status: 201,
    });
    await expect(initialize("guest-different-creator")).resolves.toMatchObject({
      status: 409,
    });
    await expect(
      runInDurableObject(stub, async (_instance, state) => ({
        phase: await state.storage.get("capacityPhase"),
        room: await state.storage.get<StoredRoom>("room"),
      })),
    ).resolves.toMatchObject({
      phase: "provisioning",
      room: { roomId, seats: { "seat-a": { guestId: "guest-retry-creator" } } },
    });
  });

  it("keeps an unconnected initialized Room provisional until its first connection", async () => {
    const roomId = "prov-room-000001";
    const testEnv = env as unknown as TestEnv;
    const directory = testEnv.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME);
    const reservation = await directory.reserve(roomId);
    if (!reservation.ok) throw new Error("Expected a Room lease");
    const stub = testEnv.ROOMS.get(testEnv.ROOMS.idFromName(roomId));

    await expect(
      stub.fetch(
        new Request("https://room.internal/initialize", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Guest-Id": "guest-provisional-creator",
          },
          body: JSON.stringify({
            roomId,
            gameType: "gomoku",
            ruleSetId: "gomoku.freestyle15.v1",
            capacityLeaseId: reservation.leaseId,
          }),
        }),
      ),
    ).resolves.toMatchObject({ status: 201 });

    await expect(directory.stats()).resolves.toMatchObject({ activeRooms: 0 });
    await expect(
      runInDurableObject(stub, async (_instance, state) => ({
        phase: await state.storage.get("capacityPhase"),
        provisioningSince: await state.storage.get("capacityProvisioningSince"),
      })),
    ).resolves.toMatchObject({
      phase: "provisioning",
      provisioningSince: expect.any(Number),
    });

    const connection = await connect(stub, "guest-provisional-creator");
    expect(connection.firstMessage).toMatchObject({
      type: "snapshot",
      roomId,
      selfSeat: "seat-a",
    });
    await expect(directory.stats()).resolves.toMatchObject({ activeRooms: 1 });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get("capacityPhase"),
      ),
    ).resolves.toBe("active");
    await closeSocket(connection.socket);
  });

  it("retires an initialized Room whose provisional lease expires before first connection", async () => {
    const roomId = "prov-room-000002";
    const testEnv = env as unknown as TestEnv;
    const directory = testEnv.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME);
    const reservation = await directory.reserve(roomId);
    if (!reservation.ok) throw new Error("Expected a Room lease");
    const stub = testEnv.ROOMS.get(testEnv.ROOMS.idFromName(roomId));

    await stub.fetch(
      new Request("https://room.internal/initialize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Guest-Id": "guest-provisional-expired",
        },
        body: JSON.stringify({
          roomId,
          gameType: "gomoku",
          ruleSetId: "gomoku.freestyle15.v1",
          capacityLeaseId: reservation.leaseId,
        }),
      }),
    );
    await runInDurableObject(stub, async (instance, state) => {
      const expiredAt = Date.now() - ROOM_PROVISIONAL_LEASE_MS - 1;
      const target = instance as unknown as {
        capacityPhase: "provisioning" | "active" | null;
        capacityProvisioningSince: number | null;
      };
      target.capacityPhase = "provisioning";
      target.capacityProvisioningSince = expiredAt;
      await state.storage.put("capacityProvisioningSince", expiredAt);
      await state.storage.put("vacantSince", expiredAt);
      await (instance as unknown as GameRoom).alarm();
    });

    await expect(
      runInDurableObject(stub, async (_instance, state) => ({
        room: await state.storage.get("room"),
        pending: await state.storage.get("pendingCapacityRelease"),
        alarm: await state.storage.getAlarm(),
      })),
    ).resolves.toEqual({ room: undefined, pending: undefined, alarm: null });
    await expect(directory.stats()).resolves.toMatchObject({ activeRooms: 0 });
    await expect(directory.reserve("prov-room-000003")).resolves.toMatchObject({
      ok: true,
    });
  });

  it("rejects a delayed initialize retry when the Directory lease expired", async () => {
    const roomId = "prov-room-000004";
    const testEnv = env as unknown as TestEnv;
    const directory = testEnv.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME);
    const reservation = await directory.reserve(roomId);
    if (!reservation.ok) throw new Error("Expected a Room lease");
    const stub = testEnv.ROOMS.get(testEnv.ROOMS.idFromName(roomId));
    const payload = {
      roomId,
      gameType: "gomoku",
      ruleSetId: "gomoku.freestyle15.v1",
      capacityLeaseId: reservation.leaseId,
    };
    const initialize = () =>
      stub.fetch(
        new Request("https://room.internal/initialize", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Guest-Id": "guest-provisional-delayed",
          },
          body: JSON.stringify(payload),
        }),
      );

    await expect(initialize()).resolves.toMatchObject({ status: 201 });
    await runInDurableObject(directory, async (_instance, state) => {
      const reservations = await state.storage.get<
        Record<string, { leaseId: string; expiresAt: number }>
      >("reservations");
      if (reservations?.[roomId] === undefined) {
        throw new Error("Missing provisional reservation");
      }
      reservations[roomId]!.expiresAt = Date.now() - 1;
      await state.storage.put("reservations", reservations);
    });

    await expect(initialize()).resolves.toMatchObject({ status: 503 });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get("room"),
      ),
    ).resolves.toBeUndefined();
    await expect(directory.reserve("prov-room-000005")).resolves.toMatchObject({
      ok: true,
    });
  });

  it("does not activate a provisional Room for an early HTTP leave", async () => {
    const initialized = await initializeManagedRoom("prov-room-leave");
    const directory = (env as unknown as TestEnv).ROOM_DIRECTORY.getByName(
      ROOM_DIRECTORY_NAME,
    );

    const response = await postRoomHttp(
      initialized.stub,
      "leave",
      "guest-creator",
      { v: 1, connectionId: "provisional-leave-client" },
    );

    expect(response).toEqual({
      status: 200,
      message: { v: 1, type: "left" },
    });
    await expect(directory.stats()).resolves.toMatchObject({ activeRooms: 0 });
    await expect(
      runInDurableObject(initialized.stub, (_instance, state) =>
        state.storage.get("capacityPhase"),
      ),
    ).resolves.toBe("provisioning");
  });

  it("does not activate a provisional Room for an invalid HTTP envelope", async () => {
    const initialized = await initializeManagedRoom("prov-room-invalid-envelope");
    const directory = (env as unknown as TestEnv).ROOM_DIRECTORY.getByName(
      ROOM_DIRECTORY_NAME,
    );

    const response = await postRoomHttp(
      initialized.stub,
      "sync",
      "guest-creator",
      { v: 1 },
    );

    expect(response.message).toMatchObject({
      v: 1,
      type: "error",
      code: "protocol.invalid_message",
    });
    await expect(directory.stats()).resolves.toMatchObject({ activeRooms: 0 });
    await expect(
      runInDurableObject(initialized.stub, (_instance, state) =>
        state.storage.get("capacityPhase"),
      ),
    ).resolves.toBe("provisioning");
  });

  it("registers a legacy production Room before allowing its first reconnect", async () => {
    const roomId = "legacy-room-0001";
    const initialized = await initializeManagedRoom(
      roomId,
      "guest-legacy-creator",
    );
    await makeLegacyRoom(initialized);
    await abortAllDurableObjects();
    const testEnv = env as unknown as TestEnv;
    const stub = testEnv.ROOMS.get(testEnv.ROOMS.idFromName(roomId));

    const connection = await connect(stub, "guest-legacy-creator");

    expect(connection.firstMessage).toMatchObject({
      type: "snapshot",
      roomId,
      selfSeat: "seat-a",
    });
    await expect(
      runInDurableObject(stub, async (_instance, state) => ({
        leaseId: await state.storage.get("capacityLeaseId"),
        phase: await state.storage.get("capacityPhase"),
      })),
    ).resolves.toMatchObject({
      leaseId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      phase: "active",
    });
  });

  it("retires a legacy Room instead of serving an eleventh accessible Room", async () => {
    const roomId = "legacy-full-0001";
    const initialized = await initializeManagedRoom(
      roomId,
      "guest-legacy-creator",
    );
    await makeLegacyRoom(initialized);
    await abortAllDurableObjects();
    const testEnv = env as unknown as TestEnv;
    const stub = testEnv.ROOMS.get(testEnv.ROOMS.idFromName(roomId));
    const directory = testEnv.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME);
    const reservations = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        directory.reserve(`full-room-${String(index).padStart(6, "0")}`),
      ),
    );
    expect(reservations.every((reservation) => reservation.ok)).toBe(true);

    const connection = await connect(stub, "guest-legacy-creator");

    expect(connection.firstMessage).toEqual({
      v: 1,
      type: "error",
      code: "room.expired",
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.get("room")),
    ).resolves.toBeUndefined();
  });

  it("does not let a legacy Room adopt a colliding creator reservation", async () => {
    const roomId = "legacy-aba-00001";
    const initialized = await initializeManagedRoom(
      roomId,
      "guest-legacy-creator",
    );
    await makeLegacyRoom(initialized);
    await abortAllDurableObjects();
    const testEnv = env as unknown as TestEnv;
    const stub = testEnv.ROOMS.get(testEnv.ROOMS.idFromName(roomId));
    const directory = testEnv.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME);
    const creatorReservation = await directory.reserve(roomId);
    if (!creatorReservation.ok) throw new Error("Expected creator reservation");

    const connection = await connect(stub, "guest-legacy-creator");

    expect(connection.firstMessage).toMatchObject({
      type: "error",
      code: "room.expired",
    });
    await expect(
      directory.activate(roomId, creatorReservation.leaseId),
    ).resolves.toBe(true);
  });

  it("capacity-checks a legacy hibernating WebSocket before accepting its next command", async () => {
    const fixture = await startRoom("legacy-live-room");
    const { stub, creator } = fixture;
    await makeLegacyRoom(fixture);
    const testEnv = env as unknown as TestEnv;
    const directory = testEnv.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME);
    const reservations = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        directory.reserve(`live-room-${String(index).padStart(6, "0")}`),
      ),
    );
    expect(reservations.every((reservation) => reservation.ok)).toBe(true);
    const closed = new Promise<void>((resolve) => {
      creator.socket.addEventListener("close", () => resolve(), { once: true });
    });

    creator.socket.send(
      JSON.stringify(placeCommand(latestSnapshotRevision(creator), 7, 7)),
    );

    await closed;
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.get("room")),
    ).resolves.toBeUndefined();
  });

  it("lets the creator enter through HTTP sync when WebSockets are unavailable", async () => {
    const stub = await initializeRoom("room-http-sync");

    const response = await postRoomHttp(
      stub,
      "sync",
      "guest-creator",
      { v: 1, connectionId: "http-client-creator-0001" },
    );

    expect(response).toMatchObject({
      status: 200,
      message: {
        v: 1,
        type: "snapshot",
        roomId: fixtureRoomId("room-http-sync"),
        revision: 0,
        selfSeat: "seat-a",
        seats: { "seat-a": { occupied: true, online: true } },
      },
    });
  });

  it("returns a lightweight heartbeat when HTTP fallback already has the latest snapshot", async () => {
    const stub = await initializeRoom("room-http-unchanged-sync");
    const connectionId = "http-unchanged-client-01";
    const initial = await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId,
    });
    const snapshotRevision = initial.message.snapshotRevision;
    expect(snapshotRevision).toEqual(expect.any(Number));

    const heartbeat = await postRoomHttpRaw(
      stub,
      "sync",
      "guest-creator",
      { v: 1, connectionId, sinceSnapshotRevision: snapshotRevision },
    );

    expect(heartbeat.status).toBe(204);
    expect(heartbeat.headers.get("X-Snapshot-Revision")).toBe(
      String(snapshotRevision),
    );
    await expect(heartbeat.text()).resolves.toBe("");
  });

  it("does not advance the snapshot for a second HTTP connection of the same Guest", async () => {
    const stub = await initializeRoom("room-http-duplicate-connection");
    const connectionId = "http-duplicate-client-01";
    const first = await postRoomHttp(
      stub,
      "sync",
      "guest-creator",
      { v: 1, connectionId },
    );
    const snapshotRevision = first.message.snapshotRevision;
    expect(snapshotRevision).toEqual(expect.any(Number));

    const second = await postRoomHttpRaw(
      stub,
      "sync",
      "guest-creator",
      {
        v: 1,
        connectionId: "http-duplicate-client-02",
        sinceSnapshotRevision: snapshotRevision,
      },
    );

    expect(second.status).toBe(204);
    expect(second.headers.get("X-Snapshot-Revision")).toBe(
      String(snapshotRevision),
    );
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get<number>("snapshotRevision"),
      ),
    ).resolves.toBe(snapshotRevision);
  });

  it("does not advance the snapshot when pruning an expired duplicate HTTP lease", async () => {
    const stub = await initializeRoom("room-http-expired-duplicate");
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    try {
      await postRoomHttp(stub, "sync", "guest-creator", {
        v: 1,
        connectionId: "http-expired-duplicate-a",
      });

      clock.mockReturnValue(startedAt + 5_000);
      const second = await postRoomHttp(stub, "sync", "guest-creator", {
        v: 1,
        connectionId: "http-expired-duplicate-b",
      });
      const snapshotRevision = second.message.snapshotRevision;
      expect(snapshotRevision).toEqual(expect.any(Number));

      // Lease A has expired, but Lease B still keeps this Guest visibly online.
      clock.mockReturnValue(startedAt + 16_000);
      const heartbeat = await postRoomHttpRaw(
        stub,
        "sync",
        "guest-creator",
        {
          v: 1,
          connectionId: "http-expired-duplicate-b",
          sinceSnapshotRevision: snapshotRevision,
        },
      );

      expect(heartbeat.status).toBe(204);
      expect(heartbeat.headers.get("X-Snapshot-Revision")).toBe(
        String(snapshotRevision),
      );
      await expect(
        runInDurableObject(stub, (_instance, state) =>
          state.storage.get<number>("snapshotRevision"),
        ),
      ).resolves.toBe(snapshotRevision);
    } finally {
      clock.mockRestore();
    }
  });

  it("applies an HTTP command and returns its authoritative snapshot", async () => {
    const stub = await initializeRoom("room-http-command");
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-command-creator-01",
    });
    const joined = await postRoomHttp(stub, "sync", "guest-invitee", {
      v: 1,
      connectionId: "http-command-invitee-01",
    });
    expect(joined.message).toMatchObject({ revision: 1, selfSeat: "seat-b" });

    const creatorChoice = await postRoomHttp(
      stub,
      "command",
      "guest-creator",
      {
        v: 1,
        connectionId: "http-command-creator-01",
        command: prepareRoleCommand(1, "black"),
      },
    );
    expect(creatorChoice.message).toMatchObject({
      revision: 2,
      position: null,
      preparation: {
        roleBySeat: { "seat-a": "black", "seat-b": null },
      },
    });
    const started = await postRoomHttp(
      stub,
      "command",
      "guest-invitee",
      {
        v: 1,
        connectionId: "http-command-invitee-01",
        command: prepareRoleCommand(2, "white"),
      },
    );
    expect(started.message).toMatchObject({
      revision: 3,
      preparation: null,
      position: { turn: "seat-a", outcome: null },
    });

    const response = await postRoomHttp(
      stub,
      "command",
      "guest-creator",
      {
        v: 1,
        connectionId: "http-command-creator-01",
        command: placeCommand(3, 7, 7),
      },
    );

    expect(response).toMatchObject({
      status: 200,
      message: {
        type: "snapshot",
        revision: 4,
        selfSeat: "seat-a",
        position: {
          turn: "seat-b",
          data: { moveCount: 1, lastMove: { x: 7, y: 7, stone: 1 } },
        },
      },
    });
    const inviteeView = await postRoomHttp(
      stub,
      "sync",
      "guest-invitee",
      { v: 1, connectionId: "http-command-invitee-01" },
    );
    expect(inviteeView.message).toMatchObject({
      revision: 4,
      position: { data: { lastMove: { x: 7, y: 7, stone: 1 } } },
    });
  });

  it("requires HTTP sync again after a connection lease expires", async () => {
    const stub = await initializeRoom("room-http-expired-command-lease");
    const connectionId = "http-expired-command-01";
    const syncedAt = Date.now();
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId,
    });
    await postRoomHttp(stub, "sync", "guest-invitee", {
      v: 1,
      connectionId: "http-expired-command-b",
    });
    await postRoomHttp(
      stub,
      "command",
      "guest-creator",
      {
        v: 1,
        connectionId,
        command: prepareRoleCommand(1, "black"),
      },
    );
    await postRoomHttp(
      stub,
      "command",
      "guest-invitee",
      {
        v: 1,
        connectionId: "http-expired-command-b",
        command: prepareRoleCommand(2, "white"),
      },
    );

    vi.setSystemTime(syncedAt + 16_000);
    try {
      const expired = await postRoomHttp(
        stub,
        "command",
        "guest-creator",
        {
          v: 1,
          connectionId,
          command: placeCommand(3, 7, 7),
        },
      );

      expect(expired.message).toMatchObject({
        type: "error",
        code: "room.connection_required",
        snapshot: { revision: 3, selfSeat: "seat-a" },
      });
      await expect(
        runInDurableObject(stub, (_instance, state) =>
          state.storage.get<StoredRoom>("room"),
        ),
      ).resolves.toMatchObject({ revision: 3 });

      const resynced = await postRoomHttp(stub, "sync", "guest-creator", {
        v: 1,
        connectionId,
      });
      expect(resynced.message).toMatchObject({
        type: "snapshot",
        revision: 3,
        selfSeat: "seat-a",
      });
      const accepted = await postRoomHttp(
        stub,
        "command",
        "guest-creator",
        {
          v: 1,
          connectionId,
          command: placeCommand(3, 7, 7),
        },
      );
      expect(accepted.message).toMatchObject({
        type: "snapshot",
        revision: 4,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a WebSocket command after Room TTL even when its alarm is delayed", async () => {
    const { stub, creator } = await startRoom("room-ws-expired-before-alarm");
    await runInDurableObject(stub, async (instance, state) => {
      const room = await state.storage.get<StoredRoom>("room");
      if (room === undefined) throw new Error("Expected a stored Room");
      const expiredRoom = { ...room, expiresAt: Date.now() - 1 };
      await state.storage.put("room", expiredRoom);
      await state.storage.setAlarm(Date.now() + 60_000);
      (instance as unknown as { room: StoredRoom }).room = expiredRoom;
    });

    const result = creator.inbox.nextMatching(
      (message) =>
        message.type === "error" ||
        (message.type === "snapshot" && message.revision === 4),
    );
    creator.socket.send(
      JSON.stringify(placeCommand(latestSnapshotRevision(creator), 7, 7)),
    );

    await expect(result).resolves.toMatchObject({
      type: "error",
      code: "room.expired",
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get("room"),
      ),
    ).resolves.toBeUndefined();
  });

  it("admits an HTTP client as a Spectator after both Seats are occupied", async () => {
    const { stub, creator } = await startRoom("room-http-spectator");

    const joined = await postRoomHttp(stub, "sync", "guest-spectator", {
      v: 1,
      connectionId: "http-spectator-client-01",
    });

    expect(joined).toMatchObject({
      status: 200,
      message: {
        type: "snapshot",
        revision: 3,
        selfSeat: null,
        seats: {
          "seat-a": { occupied: true },
          "seat-b": { occupied: true },
        },
      },
    });

    const accepted = creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 4,
    );
    creator.socket.send(
      JSON.stringify(placeCommand(latestSnapshotRevision(creator), 7, 7)),
    );
    await accepted;
    const observed = await postRoomHttp(stub, "sync", "guest-spectator", {
      v: 1,
      connectionId: "http-spectator-client-01",
    });
    expect(observed.message).toMatchObject({
      revision: 4,
      selfSeat: null,
      position: { data: { lastMove: { x: 7, y: 7, stone: 1 } } },
    });
  });

  it("rejects every player-only HTTP command from a Spectator", async () => {
    const { stub } = await startRoom("room-http-spectator-read-only");
    const connectionId = "http-spectator-readonly";
    await postRoomHttp(stub, "sync", "guest-spectator", {
      v: 1,
      connectionId,
    });

    const commands = [
      placeCommand(STARTED_TURN_ROOM_REVISION, 7, 7),
      { v: 1, type: "resign", expectedRevision: STARTED_TURN_ROOM_REVISION },
      {
        v: 1,
        type: "rematch_ready",
        expectedRevision: STARTED_TURN_ROOM_REVISION,
        ready: true,
      },
      {
        v: 1,
        type: "select_rematch_rule",
        expectedRevision: STARTED_TURN_ROOM_REVISION,
        ruleSetId: "chase.medium.v1",
      },
    ];
    for (const command of commands) {
      const response = await postRoomHttp(
        stub,
        "command",
        "guest-spectator",
        { v: 1, connectionId, command },
      );
      expect(response.message).toMatchObject({
        type: "error",
        code: "room.spectator_read_only",
        snapshot: { revision: STARTED_TURN_ROOM_REVISION, selfSeat: null },
      });
    }
  });

  it("discards the Room when its last HTTP client explicitly leaves", async () => {
    const stub = await initializeRoom("room-http-last-leave");
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-last-leave-client",
    });

    const response = await postRoomHttp(stub, "leave", "guest-creator", {
      v: 1,
      connectionId: "http-last-leave-client",
    });

    expect(response).toEqual({
      status: 200,
      message: { v: 1, type: "left" },
    });
    await expect(
      runInDurableObject(stub, async (_instance, state) => ({
        room: await state.storage.get("room"),
        alarm: await state.storage.getAlarm(),
      })),
    ).resolves.toEqual({ room: undefined, alarm: null });
  });

  it("keeps the Room when a WebSocket leaves but an HTTP client remains", async () => {
    const stub = await initializeRoom("room-ws-leave-http-remains");
    const creator = await connect(stub, "guest-creator");
    const inviteeOnline = creator.inbox.nextMatching(
      (message) =>
        message.type === "snapshot" &&
        (message.seats as Record<string, { online?: boolean }>)["seat-b"]
          ?.online === true,
    );
    await postRoomHttp(stub, "sync", "guest-invitee", {
      v: 1,
      connectionId: "http-remains-after-ws-leave",
    });
    await inviteeOnline;
    const left = creator.inbox.nextMatching(
      (message) => message.type === "left",
    );

    creator.socket.send(JSON.stringify(leaveCommand()));
    await left;

    const stillConnected = await postRoomHttp(
      stub,
      "sync",
      "guest-invitee",
      { v: 1, connectionId: "http-remains-after-ws-leave" },
    );
    expect(stillConnected.message).toMatchObject({
      type: "snapshot",
      roomId: fixtureRoomId("room-ws-leave-http-remains"),
      selfSeat: "seat-b",
    });
  });

  it("does not mark the Room vacant when a WebSocket drops but HTTP remains", async () => {
    const stub = await initializeRoom("room-ws-drops-http-remains");
    const creator = await connect(stub, "guest-creator");
    await postRoomHttp(stub, "sync", "guest-invitee", {
      v: 1,
      connectionId: "http-remains-after-ws-drop",
    });

    await closeSocket(creator.socket);

    await expect.poll(() =>
      runInDurableObject(stub, async (_instance, state) => ({
        room: await state.storage.get<StoredRoom>("room"),
        vacantSince: await state.storage.get("vacantSince"),
      })),
    ).toMatchObject({
      room: { roomId: fixtureRoomId("room-ws-drops-http-remains") },
      vacantSince: undefined,
    });
  });

  it("keeps an HTTP Seat online when only one of its browser tabs leaves", async () => {
    const stub = await initializeRoom("room-http-multiple-tabs");
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-creator-tab-one",
    });
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-creator-tab-two",
    });

    await postRoomHttp(stub, "leave", "guest-creator", {
      v: 1,
      connectionId: "http-creator-tab-one",
    });

    const remainingTab = await postRoomHttp(
      stub,
      "sync",
      "guest-creator",
      { v: 1, connectionId: "http-creator-tab-two" },
    );
    expect(remainingTab.message).toMatchObject({
      type: "snapshot",
      roomId: fixtureRoomId("room-http-multiple-tabs"),
      seats: { "seat-a": { online: true } },
    });
  });

  it("limits one Guest to four HTTP browser leases", async () => {
    const stub = await initializeRoom("room-http-lease-cap");
    for (let index = 1; index <= 4; index += 1) {
      const response = await postRoomHttp(stub, "sync", "guest-creator", {
        v: 1,
        connectionId: `http-cap-client-000${index}`,
      });
      expect(response.message).toMatchObject({ type: "snapshot" });
    }

    const rejected = await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-cap-client-0005",
    });

    expect(rejected.message).toEqual({
      v: 1,
      type: "error",
      code: "room.too_many_connections",
    });
  });

  it("caps one Room at sixteen HTTP connections without storing a rejected nickname", async () => {
    const stub = await initializeRoom("room-http-room-lease-cap");
    for (const guestId of [
      "guest-creator",
      "guest-invitee",
      "guest-spectator-one",
      "guest-spectator-two",
    ]) {
      for (let index = 1; index <= 4; index += 1) {
        const response = await postRoomHttp(
          stub,
          "sync",
          guestId,
          {
            v: 1,
            connectionId: `${guestId}-http-cap-000${index}`,
          },
          `昵称-${guestId}`,
        );
        expect(response.message).toMatchObject({ type: "snapshot" });
      }
    }

    const renewed = await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "guest-creator-http-cap-0001",
    });
    expect(renewed.message).toMatchObject({ type: "snapshot" });
    const rejected = await postRoomHttp(
      stub,
      "sync",
      "guest-overflow",
      { v: 1, connectionId: "http-room-overflow-0001" },
      "不应保存",
    );
    expect(rejected.message).toEqual({
      v: 1,
      type: "error",
      code: "room.too_many_connections",
    });

    const stored = await runInDurableObject(
      stub,
      async (_instance, state) => ({
        leaseCount: Object.keys(
          (await state.storage.get<Record<string, unknown>>("httpLeases")) ??
            {},
        ).length,
        displayNames:
          (await state.storage.get<Record<string, string>>("displayNames")) ??
          {},
      }),
    );
    expect(stored.leaseCount).toBe(16);
    expect(stored.displayNames).not.toHaveProperty("guest-overflow");
  });

  it("removes offline Spectator names instead of accumulating visitor history", async () => {
    const { stub } = await startRoom("room-spectator-name-prune");

    for (let index = 0; index < 12; index += 1) {
      const guestId = `guest-transient-${index}`;
      const connectionId = `spectator-churn-${String(index).padStart(2, "0")}`;
      const joined = await postRoomHttp(
        stub,
        "sync",
        guestId,
        { v: 1, connectionId },
        `临时观众${index}`,
      );
      expect(joined.message).toMatchObject({
        type: "snapshot",
        selfSeat: null,
      });
      await postRoomHttp(stub, "leave", guestId, {
        v: 1,
        connectionId,
      });
    }

    const storedNames = await runInDurableObject(
      stub,
      async (_instance, state) =>
        (await state.storage.get<Record<string, string>>("displayNames")) ?? {},
    );
    expect(Object.keys(storedNames).sort()).toEqual([
      "guest-creator",
      "guest-invitee",
    ]);
  });

  it("limits one Guest to four connections across WebSocket and HTTP", async () => {
    const stub = await initializeRoom("room-cross-transport-cap");
    for (let index = 0; index < 3; index += 1) {
      const connection = await connect(stub, "guest-creator");
      expect(connection.firstMessage).toMatchObject({ type: "snapshot" });
    }
    const http = await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "cross-transport-http-0001",
    });
    expect(http.message).toMatchObject({ type: "snapshot" });

    const rejected = await connect(stub, "guest-creator");

    expect(rejected.firstMessage).toEqual({
      v: 1,
      type: "error",
      code: "room.too_many_connections",
    });
  });

  it("caps a Room at sixteen WebSocket connections before storing the overflow Guest", async () => {
    const stub = await initializeRoom("room-websocket-room-cap");
    const guestIds = [
      ...Array(4).fill("guest-creator"),
      ...Array(4).fill("guest-invitee"),
      ...Array.from(
        { length: 8 },
        (_, index) => `guest-spectator-${index}`,
      ),
    ];
    const connections: TestConnection[] = [];
    for (const guestId of guestIds) {
      const connection = await connect(stub, guestId, `昵称-${guestId}`);
      expect(connection.firstMessage).toMatchObject({ type: "snapshot" });
      connections.push(connection);
    }

    const rejected = await connect(stub, "guest-overflow", "不应保存");

    expect(rejected.firstMessage).toEqual({
      v: 1,
      type: "error",
      code: "room.too_many_connections",
    });
    await expect(
      runInDurableObject(stub, async (_instance, state) =>
        (await state.storage.get<Record<string, string>>("displayNames")) ?? {},
      ),
    ).resolves.not.toHaveProperty("guest-overflow");

    await closeSocket(connections[4]!.socket);
    const spectatorStillRejected = await connect(
      stub,
      "guest-overflow-after-close",
    );
    expect(spectatorStillRejected.firstMessage).toMatchObject({
      type: "error",
      code: "room.too_many_connections",
    });
    const playerReconnect = await connect(stub, "guest-invitee");
    expect(playerReconnect.firstMessage).toMatchObject({
      type: "snapshot",
      selfSeat: "seat-b",
    });
  });

  it("rate limits HTTP commands across all connections of one Guest", async () => {
    const stub = await initializeRoom("room-http-guest-rate-limit");
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-rate-client-one",
    });
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-rate-client-two",
    });
    await postRoomHttp(stub, "sync", "guest-invitee", {
      v: 1,
      connectionId: "http-rate-invitee",
    });
    vi.setSystemTime(Date.now());
    try {
      for (let index = 0; index < 20; index += 1) {
        const response = await postRoomHttp(
          stub,
          "command",
          "guest-creator",
          {
            v: 1,
            connectionId: "http-rate-client-one",
            command: placeCommand(0, 7, 7),
          },
        );
        expect(response.message).toMatchObject({
          type: "error",
          code: "room.revision_mismatch",
        });
      }

      const rateLimited = await postRoomHttp(
        stub,
        "command",
        "guest-creator",
        {
          v: 1,
          connectionId: "http-rate-client-two",
          command: placeCommand(0, 7, 7),
        },
      );
      expect(rateLimited.message).toMatchObject({
        type: "error",
        code: "protocol.rate_limited",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rate limits WebSocket commands across all connections of one Guest", async () => {
    const stub = await initializeRoom("room-ws-guest-rate-limit");
    const firstSocket = await connect(stub, "guest-creator");
    const secondSocket = await connect(stub, "guest-creator");
    vi.setSystemTime(Date.now());
    try {
      for (let index = 0; index < 10; index += 1) {
        const firstResponse = firstSocket.inbox.nextMatching(
          (message) => message.type === "error",
        );
        firstSocket.socket.send(JSON.stringify(placeCommand(1, 7, 7)));
        await expect(firstResponse).resolves.toMatchObject({
          type: "error",
          code: "room.revision_mismatch",
        });

        const secondResponse = secondSocket.inbox.nextMatching(
          (message) => message.type === "error",
        );
        secondSocket.socket.send(JSON.stringify(placeCommand(1, 7, 7)));
        await expect(secondResponse).resolves.toMatchObject({
          type: "error",
          code: "room.revision_mismatch",
        });
      }

      const rateLimited = secondSocket.inbox.nextMatching(
        (message) => message.type === "error",
      );
      secondSocket.socket.send(JSON.stringify(placeCommand(1, 7, 7)));
      await expect(rateLimited).resolves.toMatchObject({
        type: "error",
        code: "protocol.rate_limited",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("charges oversized WebSocket frames to the connection rate bucket", async () => {
    const stub = await initializeRoom("room-ws-oversized-rate-limit");
    const creator = await connect(stub, "guest-creator");
    vi.setSystemTime(Date.now());
    try {
      const oversized = "x".repeat(4_097);
      for (let index = 0; index < 20; index += 1) {
        const response = creator.inbox.nextMatching(
          (message) => message.type === "error",
        );
        creator.socket.send(oversized);
        await expect(response).resolves.toMatchObject({
          code: "protocol.message_too_large",
        });
      }

      const rateLimited = creator.inbox.nextMatching(
        (message) => message.type === "error",
      );
      creator.socket.send(oversized);
      await expect(rateLimited).resolves.toMatchObject({
        code: "protocol.rate_limited",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules the next alarm for the earliest HTTP presence expiry", async () => {
    const stub = await initializeRoom("room-http-lease-alarm");
    const syncedAt = Date.now();

    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-lease-alarm-client",
    });

    const alarm = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).toBeGreaterThanOrEqual(syncedAt + 14_000);
    expect(alarm).toBeLessThanOrEqual(Date.now() + 16_000);
  });

  it("rejects a late HTTP reconnect even when the vacancy alarm is delayed", async () => {
    const stub = await initializeRoom("room-http-late-reconnect");
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("vacantSince", Date.now() - 61_000);
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const response = await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-late-reconnect-client",
    });

    expect(response).toEqual({
      status: 200,
      message: { v: 1, type: "error", code: "room.expired" },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get("room"),
      ),
    ).resolves.toBeUndefined();
  });

  it("uses the last persisted HTTP heartbeat when its expiry alarm is delayed", async () => {
    const stub = await initializeRoom("room-http-delayed-lease-alarm");
    const heartbeatAt = Date.now();
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-delayed-alarm-client",
    });
    vi.setSystemTime(heartbeatAt + 61_000);
    try {
      const response = await postRoomHttp(stub, "sync", "guest-creator", {
        v: 1,
        connectionId: "http-delayed-alarm-client",
      });

      expect(response.message).toEqual({
        v: 1,
        type: "error",
        code: "room.expired",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the Room when HTTP reconnects within the 60-second grace", async () => {
    const stub = await initializeRoom("room-http-grace-reconnect");
    const heartbeatAt = Date.now();
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-grace-reconnect-client",
    });
    vi.setSystemTime(heartbeatAt + 30_000);
    try {
      const response = await postRoomHttp(stub, "sync", "guest-creator", {
        v: 1,
        connectionId: "http-grace-reconnect-client",
      });

      expect(response.message).toMatchObject({
        type: "snapshot",
        roomId: fixtureRoomId("room-http-grace-reconnect"),
        selfSeat: "seat-a",
      });
      await expect(
        runInDurableObject(stub, (_instance, state) =>
          state.storage.get("vacantSince"),
        ),
      ).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a Room 60 seconds after the last persisted HTTP heartbeat", async () => {
    const stub = await initializeRoom("room-http-heartbeat-expired");
    const heartbeatAt = Date.now();
    await postRoomHttp(stub, "sync", "guest-creator", {
      v: 1,
      connectionId: "http-expired-heartbeat-client",
    });
    vi.setSystemTime(heartbeatAt + 61_000);
    try {
      expect(await runDurableObjectAlarm(stub)).toBe(true);

      await expect(
        runInDurableObject(stub, async (_instance, state) => ({
          room: await state.storage.get("room"),
          leases: await state.storage.get("httpLeases"),
          alarm: await state.storage.getAlarm(),
        })),
      ).resolves.toEqual({ room: undefined, leases: undefined, alarm: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules cleanup when a newly created Room never connects", async () => {
    const createdAt = Date.now();
    const stub = await initializeRoom("room-never-connected");

    const lifecycle = await runInDurableObject(
      stub,
      async (_instance, state) => ({
        vacantSince: await state.storage.get<number>("vacantSince"),
        alarm: await state.storage.getAlarm(),
      }),
    );
    expect(lifecycle.vacantSince).toBeGreaterThanOrEqual(createdAt);
    expect(lifecycle.alarm).toBeGreaterThanOrEqual(createdAt + 59_000);
    expect(lifecycle.alarm).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it("keeps the Room and broadcasts presence when one Guest leaves", async () => {
    const { stub, creator, invitee } = await startRoom("room-one-leaves");
    const left = creator.inbox.nextMatching(
      (message) => message.type === "left",
    );
    const presence = invitee.inbox.nextMatching(
      (message) =>
        message.type === "snapshot" &&
        (message.seats as Record<string, { online?: boolean }>)["seat-a"]
          ?.online === false,
    );

    const socketClosed = new Promise<void>((resolve) => {
      creator.socket.addEventListener("close", () => resolve(), { once: true });
    });
    creator.socket.send(JSON.stringify(leaveCommand()));

    await expect(left).resolves.toEqual({ v: 1, type: "left" });
    await socketClosed;
    await expect(presence).resolves.toMatchObject({
      revision: STARTED_TURN_ROOM_REVISION,
      seats: { "seat-a": { occupied: true, online: false } },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get<StoredRoom>("room"),
      ),
    ).resolves.toMatchObject({ roomId: fixtureRoomId("room-one-leaves") });
  });

  it("discards the Room immediately when the last Guest explicitly leaves", async () => {
    const { stub, creator, invitee } = await startRoom("room-all-leave");
    const creatorLeft = creator.inbox.nextMatching(
      (message) => message.type === "left",
    );
    const inviteeLeft = invitee.inbox.nextMatching(
      (message) => message.type === "left",
    );

    creator.socket.send(JSON.stringify(leaveCommand()));
    invitee.socket.send(JSON.stringify(leaveCommand()));
    await Promise.all([creatorLeft, inviteeLeft]);

    await expect.poll(() =>
      runInDurableObject(stub, async (_instance, state) => ({
        room: await state.storage.get("room"),
        alarm: await state.storage.getAlarm(),
      })),
    ).toEqual({ room: undefined, alarm: null });

    const staleConnection = await connect(stub, "guest-creator");
    expect(staleConnection.firstMessage).toEqual({
      v: 1,
      type: "error",
      code: "room.expired",
    });
  });

  it("retries a managed capacity release from a durable retirement tombstone", async () => {
    const roomId = "retire-room-0001";
    const creatorGuestId = "guest-retire-creator";
    const testEnv = env as unknown as TestEnv;
    const directory = testEnv.ROOM_DIRECTORY.getByName(ROOM_DIRECTORY_NAME);
    const reservation = await directory.reserve(roomId);
    if (!reservation.ok) throw new Error("Expected a managed Room lease");
    const stub = testEnv.ROOMS.get(testEnv.ROOMS.idFromName(roomId));
    const initialized = await stub.fetch(
      new Request("https://room.internal/initialize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Guest-Id": creatorGuestId,
        },
        body: JSON.stringify({
          roomId,
          gameType: "gomoku",
          ruleSetId: "gomoku.freestyle15.v1",
          capacityLeaseId: reservation.leaseId,
        }),
      }),
    );
    expect(initialized.status).toBe(201);
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as {
        roomDirectory(): DurableObjectStub<RoomDirectory>;
      };
      const actualDirectory = target.roomDirectory();
      let remainingFailures = 2;
      vi.spyOn(target, "roomDirectory").mockImplementation(
        () =>
          ({
            activate: async (activateRoomId: string, leaseId: string) =>
              actualDirectory.activate(activateRoomId, leaseId),
            release: async (releaseRoomId: string, leaseId: string) => {
              if (remainingFailures > 0) {
                remainingFailures -= 1;
                throw new Error("directory unavailable");
              }
              await actualDirectory.release(releaseRoomId, leaseId);
            },
          }) as DurableObjectStub<RoomDirectory>,
      );
    });
    const creator = await connect(stub, creatorGuestId);
    const left = creator.inbox.nextMatching((message) => message.type === "left");

    creator.socket.send(JSON.stringify(leaveCommand()));
    await left;

    await expect.poll(() =>
      runInDurableObject(stub, async (_instance, state) => ({
        room: await state.storage.get("room"),
        pending: await state.storage.get("pendingCapacityRelease"),
        alarm: await state.storage.getAlarm(),
      })),
    ).toMatchObject({
      room: undefined,
      pending: { roomId, leaseId: reservation.leaseId },
      alarm: expect.any(Number),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pending = await runInDurableObject(stub, (_instance, state) =>
        state.storage.get("pendingCapacityRelease"),
      );
      if (pending === undefined) break;
      expect(await runDurableObjectAlarm(stub)).toBe(true);
    }
    await expect(
      runInDurableObject(stub, async (_instance, state) => ({
        pending: await state.storage.get("pendingCapacityRelease"),
        alarm: await state.storage.getAlarm(),
      })),
    ).resolves.toEqual({ pending: undefined, alarm: null });
    await expect(directory.reserve("retire-room-0002")).resolves.toMatchObject({
      ok: true,
    });
  });

  it("starts a 60-second grace period after every browser disconnects", async () => {
    const { stub, creator, invitee } = await startRoom("room-vacant-grace");
    const disconnectedAt = Date.now();

    await Promise.all([
      closeSocket(creator.socket),
      closeSocket(invitee.socket),
    ]);

    await expect.poll(() =>
      runInDurableObject(stub, async (_instance, state) => ({
        room: await state.storage.get<StoredRoom>("room"),
        vacantSince: await state.storage.get<number>("vacantSince"),
        alarm: await state.storage.getAlarm(),
      })),
    ).toMatchObject({
      room: { roomId: fixtureRoomId("room-vacant-grace") },
      vacantSince: expect.any(Number),
      alarm: expect.any(Number),
    });

    const lifecycle = await runInDurableObject(
      stub,
      async (_instance, state) => ({
        vacantSince: await state.storage.get<number>("vacantSince"),
        alarm: await state.storage.getAlarm(),
      }),
    );
    expect(lifecycle.vacantSince).toBeGreaterThanOrEqual(disconnectedAt);
    expect(lifecycle.alarm).toBeGreaterThanOrEqual(disconnectedAt + 59_000);
    expect(lifecycle.alarm).toBeLessThanOrEqual(Date.now() + 61_000);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const afterPrematureAlarm = await runInDurableObject(
      stub,
      async (_instance, state) => ({
        room: await state.storage.get<StoredRoom>("room"),
        vacantSince: await state.storage.get<number>("vacantSince"),
        alarm: await state.storage.getAlarm(),
      }),
    );
    expect(afterPrematureAlarm.room).toMatchObject({
      roomId: fixtureRoomId("room-vacant-grace"),
    });
    expect(afterPrematureAlarm.vacantSince).toBe(lifecycle.vacantSince);
    expect(afterPrematureAlarm.alarm).toBe(
      lifecycle.vacantSince! + 60_000,
    );
  });

  it("does not let an HTTP Spectator keep a Room occupied", async () => {
    const { stub, creator, invitee } = await startRoom(
      "room-http-spectator-vacancy",
    );
    await postRoomHttp(stub, "sync", "guest-spectator", {
      v: 1,
      connectionId: "http-spectator-vacancy",
    });

    await Promise.all([
      closeSocket(creator.socket),
      closeSocket(invitee.socket),
    ]);

    await expect.poll(() =>
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get<number>("vacantSince"),
      ),
    ).toBeTypeOf("number");
    const vacantSince = await runInDurableObject(
      stub,
      (_instance, state) => state.storage.get<number>("vacantSince"),
    );
    await postRoomHttp(stub, "sync", "guest-spectator", {
      v: 1,
      connectionId: "http-spectator-vacancy",
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get<number>("vacantSince"),
      ),
    ).resolves.toBe(vacantSince);
  });

  it("keeps the player reconnect grace when the last HTTP Spectator leaves", async () => {
    const { stub, creator, invitee } = await startRoom(
      "room-http-spectator-leaves-vacant",
    );
    await postRoomHttp(stub, "sync", "guest-spectator", {
      v: 1,
      connectionId: "http-spectator-leaves-vacant",
    });
    await Promise.all([
      closeSocket(creator.socket),
      closeSocket(invitee.socket),
    ]);

    await expect.poll(() =>
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get<number>("vacantSince"),
      ),
    ).toBeTypeOf("number");
    const vacantSince = await runInDurableObject(
      stub,
      (_instance, state) => state.storage.get<number>("vacantSince"),
    );

    await postRoomHttp(stub, "leave", "guest-spectator", {
      v: 1,
      connectionId: "http-spectator-leaves-vacant",
    });

    await expect(
      runInDurableObject(stub, async (_instance, state) => ({
        room: await state.storage.get<StoredRoom>("room"),
        vacantSince: await state.storage.get<number>("vacantSince"),
        alarm: await state.storage.getAlarm(),
      })),
    ).resolves.toMatchObject({
      room: {
        roomId: fixtureRoomId("room-http-spectator-leaves-vacant"),
      },
      vacantSince,
      alarm: vacantSince! + 60_000,
    });

    const reconnected = await connect(stub, "guest-creator");
    expect(reconnected.firstMessage).toMatchObject({
      type: "snapshot",
      roomId: fixtureRoomId("room-http-spectator-leaves-vacant"),
      selfSeat: "seat-a",
    });
  });

  it("keeps the player reconnect grace when the last WebSocket Spectator leaves", async () => {
    const { stub, creator, invitee } = await startRoom(
      "room-ws-spectator-leaves-vacant",
    );
    const spectator = await connect(stub, "guest-spectator");
    await Promise.all([
      closeSocket(creator.socket),
      closeSocket(invitee.socket),
    ]);

    await expect.poll(() =>
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get<number>("vacantSince"),
      ),
    ).toBeTypeOf("number");
    const vacantSince = await runInDurableObject(
      stub,
      (_instance, state) => state.storage.get<number>("vacantSince"),
    );
    const left = spectator.inbox.nextMatching(
      (message) => message.type === "left",
    );

    spectator.socket.send(JSON.stringify(leaveCommand()));
    await left;

    await expect(
      runInDurableObject(stub, async (_instance, state) => ({
        room: await state.storage.get<StoredRoom>("room"),
        vacantSince: await state.storage.get<number>("vacantSince"),
        alarm: await state.storage.getAlarm(),
      })),
    ).resolves.toMatchObject({
      room: {
        roomId: fixtureRoomId("room-ws-spectator-leaves-vacant"),
      },
      vacantSince,
      alarm: vacantSince! + 60_000,
    });

    const reconnected = await connect(stub, "guest-creator");
    expect(reconnected.firstMessage).toMatchObject({
      type: "snapshot",
      roomId: fixtureRoomId("room-ws-spectator-leaves-vacant"),
      selfSeat: "seat-a",
    });
  });

  it("preserves a vacant Room when a Guest reconnects during the grace period", async () => {
    const { stub, creator, invitee } = await startRoom("room-grace-reconnect");
    await Promise.all([
      closeSocket(creator.socket),
      closeSocket(invitee.socket),
    ]);

    const reconnected = await connect(stub, "guest-creator");
    expect(reconnected.firstMessage).toMatchObject({
      type: "snapshot",
      roomId: fixtureRoomId("room-grace-reconnect"),
      selfSeat: "seat-a",
    });
    const lifecycle = await runInDurableObject(
      stub,
      async (_instance, state) => ({
        vacantSince: await state.storage.get<number>("vacantSince"),
        alarm: await state.storage.getAlarm(),
        room: await state.storage.get<StoredRoom>("room"),
      }),
    );
    expect(lifecycle.vacantSince).toBeUndefined();
    expect(lifecycle.alarm).toBe(lifecycle.room?.expiresAt);
  });

  it("discards a Room after its persisted vacancy grace period", async () => {
    const stub = await initializeRoom("room-vacant-expired");
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("vacantSince", Date.now() - 61_000);
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expect(
      runInDurableObject(stub, async (_instance, state) => ({
        room: await state.storage.get("room"),
        vacantSince: await state.storage.get("vacantSince"),
        alarm: await state.storage.getAlarm(),
      })),
    ).resolves.toEqual({
      room: undefined,
      vacantSince: undefined,
      alarm: null,
    });

    const staleConnection = await connect(stub, "guest-creator");
    expect(staleConnection.firstMessage).toMatchObject({
      type: "error",
      code: "room.expired",
    });
  });

  it("rejects a late reconnect even when the vacancy alarm is delayed", async () => {
    const stub = await initializeRoom("room-late-reconnect");
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("vacantSince", Date.now() - 61_000);
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    const lateConnection = await connect(stub, "guest-creator");

    expect(lateConnection.firstMessage).toMatchObject({
      type: "error",
      code: "room.expired",
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get("room"),
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps a Seat online when only one of its browser tabs leaves", async () => {
    const { stub, creator, invitee } = await startRoom("room-multiple-tabs");
    const creatorSecondTab = await connect(stub, "guest-creator");
    // A same-Guest reconnect only refreshes its lifecycle lease. It must not
    // manufacture a new public snapshot or broadcast an identical one.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(creator.inbox.history).toHaveLength(4);
    expect(invitee.inbox.history).toHaveLength(3);
    const creatorLeft = creator.inbox.nextMatching(
      (message) => message.type === "left",
    );

    creator.socket.send(JSON.stringify(leaveCommand()));

    await expect(creatorLeft).resolves.toMatchObject({ type: "left" });
    const lifecycle = await runInDurableObject(
      stub,
      async (_instance, state) => ({
        room: await state.storage.get<StoredRoom>("room"),
        vacantSince: await state.storage.get("vacantSince"),
        openSockets: state
          .getWebSockets()
          .filter((socket) => socket.readyState === WebSocket.OPEN).length,
      }),
    );
    expect(lifecycle).toMatchObject({
      room: { roomId: fixtureRoomId("room-multiple-tabs") },
      vacantSince: undefined,
      openSockets: 2,
    });
    expect(creatorSecondTab.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("keeps a turn room in preparation until both players choose different roles", async () => {
    const stub = await initializeRoom("room-1");

    const creator = await connect(stub, "guest-creator");
    expect(creator.firstMessage).toMatchObject({
      type: "snapshot",
      revision: 0,
      selfSeat: "seat-a",
      seats: {
        "seat-a": { occupied: true },
        "seat-b": { occupied: false },
      },
      position: null,
    });

    const invitee = await connect(stub, "guest-invitee");
    expect(invitee.firstMessage).toMatchObject({
      type: "snapshot",
      revision: 1,
      selfSeat: "seat-b",
      seats: {
        "seat-a": { occupied: true },
        "seat-b": { occupied: true },
      },
      preparation: {
        roleIds: ["black", "white"],
        roleBySeat: {
          "seat-a": null,
          "seat-b": null,
        },
      },
      position: null,
    });

    const creatorChoice = creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 2,
    );
    const inviteeChoice = invitee.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 2,
    );
    creator.socket.send(JSON.stringify(prepareRoleCommand(1, "black")));
    await expect(creatorChoice).resolves.toMatchObject({
      preparation: {
        roleIds: ["black", "white"],
        roleBySeat: {
          "seat-a": "black",
          "seat-b": null,
        },
      },
      position: null,
    });
    await expect(inviteeChoice).resolves.toMatchObject({
      preparation: {
        roleBySeat: {
          "seat-a": "black",
          "seat-b": null,
        },
      },
      position: null,
    });

    const creatorStarted = creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 3,
    );
    const inviteeStarted = invitee.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 3,
    );
    invitee.socket.send(JSON.stringify(prepareRoleCommand(2, "white")));
    await expect(creatorStarted).resolves.toMatchObject({
      preparation: null,
      position: { turn: "seat-a", outcome: null },
    });
    await expect(inviteeStarted).resolves.toMatchObject({
      preparation: null,
      position: { turn: "seat-a", outcome: null },
    });

    creator.socket.close(1000, "test complete");
    invitee.socket.close(1000, "test complete");
  });

  it("admits a third Guest as a Spectator without changing either Seat", async () => {
    const { stub } = await startRoom("room-spectator-third");

    const spectator = await connect(stub, "guest-spectator");

    expect(spectator.firstMessage).toMatchObject({
      type: "snapshot",
      revision: STARTED_TURN_ROOM_REVISION,
      selfSeat: null,
      seats: {
        "seat-a": { occupied: true },
        "seat-b": { occupied: true },
      },
      position: { turn: "seat-a", outcome: null },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get<StoredRoom>("room"),
      ),
    ).resolves.toMatchObject({
      revision: STARTED_TURN_ROOM_REVISION,
      seats: {
        "seat-a": { guestId: "guest-creator" },
        "seat-b": { guestId: "guest-invitee" },
      },
    });
  });

  it("shows each authenticated player's Display Name on their Seat", async () => {
    const stub = await initializeRoom(
      "room-display-names",
      "guest-creator",
      "gomoku",
      "gomoku.freestyle15.v1",
      "甲方",
    );
    const creator = await connect(stub, "guest-creator", "甲方");
    const invitee = await connect(stub, "guest-invitee", "乙方");

    expect(invitee.firstMessage).toMatchObject({
      type: "snapshot",
      seats: {
        "seat-a": { displayName: "甲方" },
        "seat-b": { displayName: "乙方" },
      },
    });
    await expect(
      creator.inbox.nextMatching(
        (message) =>
          message.type === "snapshot" &&
          (message.seats as Record<string, { displayName?: string }>)[
            "seat-b"
          ]?.displayName === "乙方",
      ),
    ).resolves.toMatchObject({
      seats: {
        "seat-a": { displayName: "甲方" },
        "seat-b": { displayName: "乙方" },
      },
    });
  });

  it("shows each online Spectator once without exposing their Guest ID", async () => {
    const { stub, creator } = await startRoom("room-spectator-names");
    const spectator = await connect(
      stub,
      "guest-private-spectator",
      "观众丙",
    );

    expect(spectator.firstMessage).toMatchObject({
      selfSeat: null,
      spectators: [{ displayName: "观众丙", isSelf: true }],
    });
    expect(JSON.stringify(spectator.firstMessage)).not.toContain(
      "guest-private-spectator",
    );
    await expect(
      creator.inbox.nextMatching(
        (message) =>
          Array.isArray(message.spectators) &&
          message.spectators.some(
            (spectator) =>
              typeof spectator === "object" &&
              spectator !== null &&
              (spectator as { displayName?: string }).displayName ===
                "观众丙",
          ),
      ),
    ).resolves.toMatchObject({
      spectators: [{ displayName: "观众丙", isSelf: false }],
    });

    const secondTab = await connect(
      stub,
      "guest-private-spectator",
      "观众丙",
    );
    expect(secondTab.firstMessage).toMatchObject({
      spectators: [{ displayName: "观众丙", isSelf: true }],
    });
  });

  it("rejects a game Action from a Spectator without changing the Game", async () => {
    const { stub } = await startRoom("room-spectator-read-only");
    const spectator = await connect(stub, "guest-spectator");
    const rejection = spectator.inbox.nextMatching(
      (message) => message.type === "error",
    );

    spectator.socket.send(
      JSON.stringify({
        ...placeCommand(STARTED_TURN_ROOM_REVISION, 7, 7),
        guestId: "guest-creator",
        seat: "seat-a",
      }),
    );

    await expect(rejection).resolves.toMatchObject({
      type: "error",
      code: "room.spectator_read_only",
      snapshot: {
        revision: STARTED_TURN_ROOM_REVISION,
        selfSeat: null,
      },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get<StoredRoom>("room"),
      ),
    ).resolves.toMatchObject({
      revision: STARTED_TURN_ROOM_REVISION,
      position: { data: { moveCount: 0 } },
    });
  });

  it("broadcasts each accepted Action to connected Spectators", async () => {
    const { stub, creator } = await startRoom("room-spectator-broadcast");
    const spectator = await connect(stub, "guest-spectator");
    const observed = spectator.inbox.nextMatching(
      (message) =>
        message.type === "snapshot" &&
        message.revision === AFTER_FIRST_TURN_ACTION_REVISION,
    );

    creator.socket.send(
      JSON.stringify(placeCommand(STARTED_TURN_ROOM_REVISION, 7, 7)),
    );

    await expect(observed).resolves.toMatchObject({
      type: "snapshot",
      revision: AFTER_FIRST_TURN_ACTION_REVISION,
      selfSeat: null,
      position: {
        turn: "seat-b",
        data: { moveCount: 1, lastMove: { x: 7, y: 7, stone: 1 } },
      },
    });
  });

  it("starts minesweeper only after both private starts and projects no secret field", async () => {
    try {
      const started = await startMinesweeperRoom("mine-private-starts");

      expect(minesweeperPublicData(started.firstSelection.creator)).toMatchObject(
        {
          phase: "selecting",
          ownStart: { x: 1, y: 1 },
        },
      );
      expect(minesweeperPublicData(started.firstSelection.invitee)).toMatchObject(
        {
          phase: "selecting",
          ownStart: null,
        },
      );
      expect(minesweeperPublicData(started.firstSelection.spectator)).toMatchObject(
        {
          phase: "selecting",
          ownStart: null,
        },
      );
      for (const snapshot of Object.values(started.firstSelection)) {
        expectPreFinishMinesweeperSnapshotToBePublic(snapshot);
      }

      expect(minesweeperPublicData(started.playing.creator)).toMatchObject({
        phase: "playing",
        ownStart: { x: 1, y: 1 },
        scores: { "seat-a": 0, "seat-b": 0 },
      });
      expect(minesweeperPublicData(started.playing.invitee)).toMatchObject({
        phase: "playing",
        ownStart: { x: 7, y: 7 },
        scores: { "seat-a": 0, "seat-b": 0 },
      });
      expect(minesweeperPublicData(started.playing.spectator)).toMatchObject({
        phase: "playing",
        ownStart: null,
        flags: [],
      });
      for (const snapshot of Object.values(started.playing)) {
        expectPreFinishMinesweeperSnapshotToBePublic(snapshot);
      }

      const authoritative = await readStoredMinesweeper(started.stub);
      expect(authoritative.data.field?.cells.filter((cell) => cell.mine)).toHaveLength(
        10,
      );
      expect(authoritative.data.revealedBy.every((seat) => seat === null)).toBe(
        true,
      );
      for (const center of [
        { x: 1, y: 1 },
        { x: 7, y: 7 },
      ]) {
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            const x = center.x + offsetX;
            const y = center.y + offsetY;
            expect(authoritative.data.field?.cells[y * 9 + x]?.mine).toBe(
              false,
            );
          }
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes simultaneous minesweeper actions across WebSocket and HTTPS without leaking private flags", async () => {
    try {
      const started = await startMinesweeperRoom(
        "mine-concurrent-actions",
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      );
      const httpConnectionId = "mine-http-invitee-01";
      const httpSync = await postRoomHttp(
        started.stub,
        "sync",
        "guest-mine-invitee",
        { v: 1, connectionId: httpConnectionId },
      );
      expect(httpSync.message).toMatchObject({
        type: "snapshot",
        revision: 5,
        selfSeat: "seat-b",
      });

      const initial = await readStoredMinesweeper(started.stub);
      expect(initial.data.phase).toBe("playing");
      const safeA = findHiddenSafeNumber(initial.data);
      const safeB = findHiddenSafeNumber(initial.data, new Set([safeA]));
      expect(safeA).toBeGreaterThanOrEqual(0);
      expect(safeB).toBeGreaterThanOrEqual(0);

      started.creator.socket.send(
        JSON.stringify(
          minesweeperCommand(5, "mine-a-safe-old-base", 3, {
            type: "reveal",
            ...cellPoint(safeA),
          }),
        ),
      );
      await started.creator.inbox.nextMatching(
        (message) => message.type === "snapshot" && message.revision === 6,
      );

      const safeBResponse = await postRoomHttp(
        started.stub,
        "command",
        "guest-mine-invitee",
        {
          v: 1,
          connectionId: httpConnectionId,
          command: minesweeperCommand(5, "mine-b-safe-old-base", 3, {
            type: "reveal",
            ...cellPoint(safeB),
          }),
        },
      );
      expect(safeBResponse.message).toMatchObject({
        type: "snapshot",
        revision: 7,
        actionReceipts: [
          expect.anything(),
          expect.anything(),
          {
            actionId: "mine-b-safe-old-base",
            status: "applied",
            revision: 7,
          },
        ],
      });
      const afterDifferentCells = await readStoredMinesweeper(started.stub);
      expect(afterDifferentCells.data.revealed[safeA]).toBe(true);
      expect(afterDifferentCells.data.revealed[safeB]).toBe(true);
      expect(afterDifferentCells.data.revealedBy[safeA]).toBe("seat-a");
      expect(afterDifferentCells.data.revealedBy[safeB]).toBe("seat-b");
      expect(afterDifferentCells.data.scores).toEqual({
        "seat-a": 1,
        "seat-b": 1,
      });

      const sameCell = findHiddenSafeNumber(afterDifferentCells.data);
      expect(sameCell).toBeGreaterThanOrEqual(0);
      const duplicateCommand = minesweeperCommand(
        7,
        "mine-b-same-cell",
        4,
        { type: "reveal", ...cellPoint(sameCell) },
      );
      started.creator.socket.send(
        JSON.stringify(
          minesweeperCommand(7, "mine-a-same-cell", 4, {
            type: "reveal",
            ...cellPoint(sameCell),
          }),
        ),
      );
      await started.creator.inbox.nextMatching(
        (message) => message.type === "snapshot" && message.revision === 8,
      );
      const sameCellResponse = await postRoomHttp(
        started.stub,
        "command",
        "guest-mine-invitee",
        {
          v: 1,
          connectionId: httpConnectionId,
          command: duplicateCommand,
        },
      );
      expect(sameCellResponse.message).toMatchObject({
        revision: 9,
        actionReceipts: expect.arrayContaining([
          {
            actionId: "mine-b-same-cell",
            clientSeq: 4,
            status: "already_revealed",
            revision: 9,
          },
        ]),
      });
      const afterSameCell = await readStoredMinesweeper(started.stub);
      expect(afterSameCell.data.scores).toEqual({
        "seat-a": 2,
        "seat-b": 1,
      });
      expect(afterSameCell.data.revealedBy[sameCell]).toBe("seat-a");

      const duplicateResponse = await postRoomHttp(
        started.stub,
        "command",
        "guest-mine-invitee",
        {
          v: 1,
          connectionId: httpConnectionId,
          command: duplicateCommand,
        },
      );
      expect(duplicateResponse.message).toMatchObject({ revision: 9 });
      const afterDuplicate = await readStoredMinesweeper(started.stub);
      expect(afterDuplicate.room.revision).toBe(9);
      expect(afterDuplicate.data.scores).toEqual(afterSameCell.data.scores);
      expect(
        getRecentActionReceipts(afterDuplicate.room, "seat-b").filter(
          (receipt) => receipt.actionId === "mine-b-same-cell",
        ),
      ).toHaveLength(1);

      const mines = afterDuplicate.data.field!.cells.flatMap((cell, index) =>
        cell.mine ? [index] : [],
      );
      expect(mines).toHaveLength(10);
      const [creatorFlag, inviteeFlag, lateMine] = mines;
      expect(creatorFlag).not.toBeUndefined();
      expect(inviteeFlag).not.toBeUndefined();
      expect(lateMine).not.toBeUndefined();

      started.creator.socket.send(
        JSON.stringify(
          minesweeperCommand(9, "mine-a-private-flag", 5, {
            type: "set_flag",
            flagged: true,
            ...cellPoint(creatorFlag!),
          }),
        ),
      );
      await started.creator.inbox.nextMatching(
        (message) => message.type === "snapshot" && message.revision === 10,
      );
      const inviteeFlagResponse = await postRoomHttp(
        started.stub,
        "command",
        "guest-mine-invitee",
        {
          v: 1,
          connectionId: httpConnectionId,
          command: minesweeperCommand(9, "mine-b-private-flag", 5, {
            type: "set_flag",
            flagged: true,
            ...cellPoint(inviteeFlag!),
          }),
        },
      );
      expect(inviteeFlagResponse.message).toMatchObject({ revision: 11 });
      const creatorPrivateView = await started.creator.inbox.nextMatching(
        (message) => message.type === "snapshot" && message.revision === 11,
      );
      const spectatorPrivateView = await started.spectator.inbox.nextMatching(
        (message) => message.type === "snapshot" && message.revision === 11,
      );
      expect(minesweeperPublicData(creatorPrivateView)).toMatchObject({
        flags: [creatorFlag],
      });
      expect(minesweeperPublicData(inviteeFlagResponse.message)).toMatchObject({
        flags: [inviteeFlag],
      });
      expect(minesweeperPublicData(spectatorPrivateView)).toMatchObject({
        flags: [],
      });
      for (const snapshot of [
        creatorPrivateView,
        inviteeFlagResponse.message,
        spectatorPrivateView,
      ]) {
        expectPreFinishMinesweeperSnapshotToBePublic(snapshot);
      }

      await closeSocket(started.creator.socket);
      const creatorAfterRefresh = await connect(
        started.stub,
        "guest-mine-creator",
      );
      expect(creatorAfterRefresh.firstMessage).toMatchObject({
        revision: 11,
        selfSeat: "seat-a",
      });
      expect(minesweeperPublicData(creatorAfterRefresh.firstMessage)).toMatchObject(
        { flags: [creatorFlag] },
      );

      const scoresBeforeMine = (await readStoredMinesweeper(started.stub)).data
        .scores;
      const exploded = await postRoomHttp(
        started.stub,
        "command",
        "guest-mine-invitee",
        {
          v: 1,
          connectionId: httpConnectionId,
          command: minesweeperCommand(11, "mine-b-hits-a-private-flag", 6, {
            type: "reveal",
            ...cellPoint(creatorFlag!),
          }),
        },
      );
      expect(exploded.message).toMatchObject({
        type: "snapshot",
        revision: 12,
        position: {
          outcome: {
            kind: "win",
            winner: "seat-a",
            reason: "opponent_hit_mine",
          },
          data: {
            phase: "finished",
            exploded: creatorFlag,
            scores: scoresBeforeMine,
            mines: expect.arrayContaining([creatorFlag]),
          },
        },
      });
      const terminalData = minesweeperPublicData(exploded.message);
      expect(terminalData.mines).toHaveLength(10);
      const terminalKeys = collectObjectKeys(terminalData);
      for (const forbidden of [
        "seed",
        "field",
        "cells",
        "mine",
        "privateFlags",
        "startSelections",
      ]) {
        expect(terminalKeys.has(forbidden)).toBe(false);
      }

      creatorAfterRefresh.socket.send(
        JSON.stringify(
          minesweeperCommand(11, "mine-a-arrives-after-finish", 6, {
            type: "reveal",
            ...cellPoint(lateMine!),
          }),
        ),
      );
      const tooLate = await creatorAfterRefresh.inbox.nextMatching(
        (message) =>
          message.type === "error" &&
          message.actionId === "mine-a-arrives-after-finish",
      );
      expect(tooLate).toMatchObject({
        code: "minesweeper.game_finished",
        actionId: "mine-a-arrives-after-finish",
        snapshot: {
          revision: 12,
          position: {
            outcome: { kind: "win", winner: "seat-a" },
            data: { exploded: creatorFlag, mines: expect.any(Array) },
          },
          actionReceipts: expect.arrayContaining([
            expect.objectContaining({
              actionId: "mine-a-arrives-after-finish",
              status: "rejected",
              code: "minesweeper.game_finished",
            }),
          ]),
        },
      });
      const final = await readStoredMinesweeper(started.stub);
      expect(final.room.revision).toBe(12);
      expect(final.room.position?.outcome).toEqual({
        kind: "win",
        winner: "seat-a",
        reason: "opponent_hit_mine",
      });
      expect(final.data.exploded).toBe(creatorFlag);
      expect(final.data.scores).toEqual(scoresBeforeMine);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Chinese chess on strict revisions while concurrent games accept stale bases", async () => {
    const stub = await initializeRoom(
      "room-xiangqi-stale",
      "guest-xiangqi-strict-creator",
      "xiangqi",
      "xiangqi.casual.v1",
    );
    const creator = await connect(stub, "guest-xiangqi-strict-creator");
    const invitee = await connect(stub, "guest-xiangqi-strict-invitee");
    const creatorChoice = creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 2,
    );
    const inviteeChoice = invitee.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 2,
    );
    creator.socket.send(JSON.stringify(prepareRoleCommand(1, "red")));
    await Promise.all([creatorChoice, inviteeChoice]);
    const creatorStarted = creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 3,
    );
    const inviteeStarted = invitee.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 3,
    );
    invitee.socket.send(JSON.stringify(prepareRoleCommand(2, "black")));
    await Promise.all([creatorStarted, inviteeStarted]);

    creator.socket.send(
      JSON.stringify(xiangqiMoveCommand(0, 4, 6, 4, 5)),
    );

    await expect(
      creator.inbox.nextMatching((message) => message.type === "error"),
    ).resolves.toMatchObject({
      code: "room.revision_mismatch",
      snapshot: {
        revision: STARTED_TURN_ROOM_REVISION,
        position: { data: { moveCount: 0, lastMove: null } },
      },
    });
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<StoredRoom>("room"),
    );
    expect(stored).toMatchObject({
      revision: STARTED_TURN_ROOM_REVISION,
      position: { data: { moveCount: 0, lastMove: null } },
    });
  });

  it("keeps each authenticated Guest and Seat in its hibernatable attachment", async () => {
    const { stub } = await startRoom("room-attachments");

    const attachments = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.getWebSockets().map((socket) => socket.deserializeAttachment()),
    );

    expect(attachments).toHaveLength(2);
    expect(attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ guestId: "guest-creator", seat: "seat-a" }),
        expect.objectContaining({ guestId: "guest-invitee", seat: "seat-b" }),
      ]),
    );
  });

  it("rejects an Action from an old revision and returns the current snapshot", async () => {
    const { stub, creator } = await startRoom("room-stale-revision");
    const rejection = creator.inbox.nextMatching(
      (message) => message.type === "error",
    );

    creator.socket.send(
      JSON.stringify(placeCommand(0, 7, 7)),
    );

    await expect(rejection).resolves.toMatchObject({
      type: "error",
      code: "room.revision_mismatch",
      snapshot: {
        revision: STARTED_TURN_ROOM_REVISION,
        position: { data: { moveCount: 0 } },
      },
    });
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<StoredRoom>("room"),
    );
    expect(stored).toMatchObject({
      revision: STARTED_TURN_ROOM_REVISION,
      position: { data: { moveCount: 0 } },
    });
  });

  it("uses the authenticated attachment instead of a forged Seat", async () => {
    const { stub, invitee } = await startRoom("room-forged-seat");
    const rejection = invitee.inbox.nextMatching(
      (message) => message.type === "error",
    );

    invitee.socket.send(
      JSON.stringify({
        ...placeCommand(STARTED_TURN_ROOM_REVISION, 7, 7),
        seat: "seat-a",
      }),
    );

    await expect(rejection).resolves.toMatchObject({
      type: "error",
      code: "gomoku.not_your_turn",
      snapshot: { revision: STARTED_TURN_ROOM_REVISION },
    });
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<StoredRoom>("room"),
    );
    expect(stored).toMatchObject({
      revision: STARTED_TURN_ROOM_REVISION,
      position: { data: { moveCount: 0 } },
    });
  });

  it("rejects a malformed game payload without changing the Room", async () => {
    const { stub, creator } = await startRoom("room-invalid-payload");
    const rejection = creator.inbox.nextMatching(
      (message) => message.type === "error",
    );

    creator.socket.send(
      JSON.stringify({
        ...placeCommand(STARTED_TURN_ROOM_REVISION, 7, 7),
        payload: { type: "place", x: "7", y: 7 },
      }),
    );

    await expect(rejection).resolves.toMatchObject({
      type: "error",
      code: "gomoku.invalid_action",
      snapshot: { revision: STARTED_TURN_ROOM_REVISION },
    });
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<StoredRoom>("room"),
    );
    expect(stored).toMatchObject({
      revision: STARTED_TURN_ROOM_REVISION,
      position: { data: { moveCount: 0 } },
    });
  });

  it("accepts only one of two concurrent Actions for the same point", async () => {
    const { stub, creator, invitee } = await startRoom("room-concurrent-point");
    const creatorSecondTab = await connect(stub, "guest-creator");
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as {
        persist(room: StoredRoom): Promise<void>;
      };
      const originalPersist = target.persist.bind(instance);
      let delayNextPersist = true;
      vi.spyOn(target, "persist").mockImplementation(async (room) => {
        if (delayNextPersist) {
          delayNextPersist = false;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await originalPersist(room);
      });
    });
    const revisionFourSnapshots = [creator, creatorSecondTab, invitee].map(
      ({ inbox }) =>
        inbox.nextMatching(
          (message) =>
            message.type === "snapshot" &&
            message.revision === AFTER_FIRST_TURN_ACTION_REVISION,
        ),
    );
    const command = JSON.stringify(
      placeCommand(STARTED_TURN_ROOM_REVISION, 7, 7),
    );

    creator.socket.send(command);
    creatorSecondTab.socket.send(command);

    await Promise.all(
      revisionFourSnapshots.map((snapshot) =>
        expect(snapshot).resolves.toMatchObject({
          revision: AFTER_FIRST_TURN_ACTION_REVISION,
          position: {
            data: { moveCount: 1, lastMove: { x: 7, y: 7, stone: 1 } },
          },
        }),
      ),
    );
    await expect
      .poll(() =>
        [creator, creatorSecondTab]
          .flatMap(({ inbox }) => inbox.history)
          .filter((message) => message.type === "error")
          .map((message) => message.code),
      )
      .toEqual(["room.revision_mismatch"]);
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<StoredRoom>("room"),
    );
    expect(stored).toMatchObject({
      revision: AFTER_FIRST_TURN_ACTION_REVISION,
      position: {
        data: { moveCount: 1, lastMove: { x: 7, y: 7, stone: 1 } },
      },
    });
  });

  it("starts five Games across ten simultaneous connections", async () => {
    const rooms = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        startRoom(
          `capacity-room-${index}`,
          `guest-capacity-creator-${index}`,
          `guest-capacity-invitee-${index}`,
        ),
      ),
    );
    const acknowledgements = rooms.flatMap(({ creator, invitee }) =>
      [creator, invitee].map(({ inbox }) =>
        inbox.nextMatching(
          (message) =>
            message.type === "snapshot" &&
            message.revision === AFTER_FIRST_TURN_ACTION_REVISION,
        ),
      ),
    );

    for (const { creator } of rooms) {
      creator.socket.send(
        JSON.stringify(placeCommand(STARTED_TURN_ROOM_REVISION, 7, 7)),
      );
    }

    await Promise.all(
      acknowledgements.map((acknowledgement) =>
        expect(acknowledgement).resolves.toMatchObject({
          revision: AFTER_FIRST_TURN_ACTION_REVISION,
          position: {
            turn: "seat-b",
            data: { moveCount: 1, lastMove: { x: 7, y: 7 } },
          },
        }),
      ),
    );
    const storedRooms = await Promise.all(
      rooms.map(({ stub }) =>
        runInDurableObject(stub, (_instance, state) =>
          state.storage.get<StoredRoom>("room"),
        ),
      ),
    );
    expect(storedRooms).toHaveLength(5);
    expect(
      storedRooms.every(
        (room) => room?.revision === AFTER_FIRST_TURN_ACTION_REVISION,
      ),
    ).toBe(true);
    expect(
      rooms
        .flatMap(({ creator, invitee }) => [creator, invitee])
        .flatMap(({ inbox }) => inbox.history)
        .some((message) => message.type === "error"),
    ).toBe(false);
  });

  it("broadcasts authoritative Actions and restores them on reconnect", async () => {
    const { stub, creator, invitee } = await startRoom("room-2");

    const blackSnapshot = invitee.inbox.next();
    const blackAck = creator.inbox.next();
    creator.socket.send(
      JSON.stringify({
        v: 1,
        type: "game_action",
        gameType: "gomoku",
        ruleSetId: "gomoku.freestyle15.v1",
        expectedRevision: STARTED_TURN_ROOM_REVISION,
        payload: { type: "place", x: 7, y: 7 },
      }),
    );
    await expect(blackSnapshot).resolves.toMatchObject({
      type: "snapshot",
      revision: AFTER_FIRST_TURN_ACTION_REVISION,
      position: {
        turn: "seat-b",
        data: {
          board: expect.arrayContaining([1]),
          lastMove: { x: 7, y: 7, stone: 1 },
        },
      },
    });
    await expect(blackAck).resolves.toMatchObject({
      revision: AFTER_FIRST_TURN_ACTION_REVISION,
    });
    const storedAfterBroadcast = await runInDurableObject(
      stub,
      (_instance, state) => state.storage.get<StoredRoom>("room"),
    );
    expect(storedAfterBroadcast).toMatchObject({
      revision: AFTER_FIRST_TURN_ACTION_REVISION,
      position: {
        data: { lastMove: { x: 7, y: 7, stone: 1 } },
      },
    });

    await Promise.all([
      closeSocket(creator.socket),
      closeSocket(invitee.socket),
    ]);
    const creatorAfterReconnect = await connect(stub, "guest-creator");
    const inviteeAfterReconnect = await connect(stub, "guest-invitee");

    expect(creatorAfterReconnect.firstMessage).toMatchObject({
      revision: AFTER_FIRST_TURN_ACTION_REVISION,
      selfSeat: "seat-a",
      position: { data: { lastMove: { x: 7, y: 7, stone: 1 } } },
    });
    const whiteSnapshot = creatorAfterReconnect.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 5,
    );
    const whiteAck = inviteeAfterReconnect.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 5,
    );
    inviteeAfterReconnect.socket.send(
      JSON.stringify({
        v: 1,
        type: "game_action",
        gameType: "gomoku",
        ruleSetId: "gomoku.freestyle15.v1",
        expectedRevision: AFTER_FIRST_TURN_ACTION_REVISION,
        payload: { type: "place", x: 8, y: 7 },
      }),
    );
    await expect(whiteAck).resolves.toMatchObject({ revision: 5 });
    await expect(whiteSnapshot).resolves.toMatchObject({
      type: "snapshot",
      revision: 5,
      position: {
        turn: "seat-a",
        data: {
          lastMove: { x: 8, y: 7, stone: 2 },
        },
      },
    });

    creatorAfterReconnect.socket.close(1000, "test complete");
    inviteeAfterReconnect.socket.close(1000, "test complete");
  });

  it("switches an allowed chase mode only at the atomic rematch boundary", async () => {
    const stub = await initializeRoom(
      "room-chase-rematch-mode",
      "guest-chase-creator",
      "chase",
      "chase.easy.v1",
    );
    const creator = await connect(stub, "guest-chase-creator");
    const invitee = await connect(stub, "guest-chase-invitee");
    await creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 1,
    );

    const creatorChoice = creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 2,
    );
    const inviteeChoice = invitee.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 2,
    );
    creator.socket.send(JSON.stringify(prepareRoleCommand(1, "thief")));
    await Promise.all([creatorChoice, inviteeChoice]);
    const creatorStarted = creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 3,
    );
    const inviteeStarted = invitee.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 3,
    );
    invitee.socket.send(JSON.stringify(prepareRoleCommand(2, "police")));
    await Promise.all([creatorStarted, inviteeStarted]);

    const creatorFinished = creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 4,
    );
    const inviteeFinished = invitee.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 4,
    );
    creator.socket.send(JSON.stringify({
      v: 1,
      type: "resign",
      expectedRevision: 3,
    }));
    await expect(creatorFinished).resolves.toMatchObject({
      ruleSetId: "chase.easy.v1",
      rematchOptions: {
        ruleSetIds: [
          "chase.easy.v1",
          "chase.medium.v1",
          "chase.hard.v1",
        ],
        selectedRuleSetId: "chase.easy.v1",
      },
    });
    await inviteeFinished;

    const rejected = creator.inbox.nextMatching(
      (message) => message.type === "error",
    );
    creator.socket.send(JSON.stringify({
      v: 1,
      type: "select_rematch_rule",
      expectedRevision: 4,
      ruleSetId: "minesweeper.race.9x9x10.v1",
    }));
    await expect(rejected).resolves.toMatchObject({
      code: "room.invalid_rematch_rule",
      snapshot: {
        revision: 4,
        ruleSetId: "chase.easy.v1",
      },
    });

    const creatorSelected = creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 5,
    );
    const inviteeSelected = invitee.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 5,
    );
    creator.socket.send(JSON.stringify({
      v: 1,
      type: "select_rematch_rule",
      expectedRevision: 4,
      ruleSetId: "chase.medium.v1",
    }));
    await expect(creatorSelected).resolves.toMatchObject({
      ruleSetId: "chase.easy.v1",
      rematchOptions: { selectedRuleSetId: "chase.medium.v1" },
    });
    await inviteeSelected;

    const creatorReady = creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 6,
    );
    const inviteeSeesReady = invitee.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 6,
    );
    creator.socket.send(JSON.stringify({
      v: 1,
      type: "rematch_ready",
      expectedRevision: 5,
      ready: true,
    }));
    await Promise.all([creatorReady, inviteeSeesReady]);

    const creatorRematch = creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 7,
    );
    const inviteeRematch = invitee.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 7,
    );
    invitee.socket.send(JSON.stringify({
      v: 1,
      type: "rematch_ready",
      expectedRevision: 6,
      ready: true,
    }));
    await expect(creatorRematch).resolves.toMatchObject({
      round: 2,
      ruleSetId: "chase.medium.v1",
      rematchOptions: null,
      position: {
        turn: "seat-b",
        data: {
          mapId: "medium",
          thiefSeat: "seat-b",
          policeSeat: "seat-a",
        },
      },
    });
    await expect(inviteeRematch).resolves.toMatchObject({
      ruleSetId: "chase.medium.v1",
    });

    creator.socket.close(1000, "test complete");
    invitee.socket.close(1000, "test complete");
  });

  it("runs a Chinese chess room through the same authoritative protocol", async () => {
    const stub = await initializeRoom(
      "room-xiangqi",
      "guest-xiangqi-creator",
      "xiangqi",
      "xiangqi.casual.v1",
    );
    const creator = await connect(stub, "guest-xiangqi-creator");
    const invitee = await connect(stub, "guest-xiangqi-invitee");
    const creatorChoice = creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 2,
    );
    const inviteeChoice = invitee.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 2,
    );
    creator.socket.send(JSON.stringify(prepareRoleCommand(1, "red")));
    await Promise.all([creatorChoice, inviteeChoice]);
    const creatorStarted = creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 3,
    );
    const inviteeStarted = invitee.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 3,
    );
    invitee.socket.send(JSON.stringify(prepareRoleCommand(2, "black")));
    await Promise.all([creatorStarted, inviteeStarted]);

    expect(invitee.firstMessage).toMatchObject({
      type: "snapshot",
      gameType: "xiangqi",
      ruleSetId: "xiangqi.casual.v1",
      revision: 1,
      preparation: {
        roleIds: ["red", "black"],
        roleBySeat: { "seat-a": null, "seat-b": null },
      },
      position: null,
    });

    expect(inviteeStarted).resolves.toMatchObject({
      position: {
        turn: "seat-a",
        data: {
          redSeat: "seat-a",
          blackSeat: "seat-b",
          moveCount: 0,
          board: expect.arrayContaining([
            { side: "red", kind: "pawn" },
            { side: "black", kind: "general" },
          ]),
        },
      },
    });

    const creatorAck = creator.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 4,
    );
    const inviteeAck = invitee.inbox.nextMatching(
      (message) => message.type === "snapshot" && message.revision === 4,
    );
    creator.socket.send(
      JSON.stringify(xiangqiMoveCommand(3, 4, 6, 4, 5)),
    );

    await expect(creatorAck).resolves.toMatchObject({
      gameType: "xiangqi",
      ruleSetId: "xiangqi.casual.v1",
      revision: 4,
      position: {
        turn: "seat-b",
        data: {
          moveCount: 1,
          lastMove: {
            fromX: 4,
            fromY: 6,
            toX: 4,
            toY: 5,
            piece: { side: "red", kind: "pawn" },
          },
        },
      },
    });
    await expect(inviteeAck).resolves.toMatchObject({ revision: 4 });

    creator.socket.close(1000, "test complete");
    invitee.socket.close(1000, "test complete");
  });
});

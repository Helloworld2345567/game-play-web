import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { JsonValue } from "../core/game-rules";
import {
  PROTOCOL_VERSION,
  type LeftMessage,
  type RoomCommand,
  type RoomSnapshot,
  type ServerError,
} from "../shared/protocol";
import { getGameAdapter } from "./games/registry";

export type ConnectionPhase =
  | "connecting"
  | "syncing"
  | "online"
  | "retrying"
  | "offline"
  | "fatal";

interface RoomClientView {
  phase: ConnectionPhase;
  snapshot: RoomSnapshot | null;
  pending: boolean;
  leaving: boolean;
  notice: string | null;
  fatalCode: string | null;
  sendGameAction(payload: JsonValue): boolean;
  resign(): boolean;
  setRematchReady(ready: boolean): boolean;
  leave(): Promise<void>;
  retryNow(): void;
}

const fatalCodes = new Set([
  "room.full",
  "room.expired",
  "room.rule_mismatch",
  "protocol.version_mismatch",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseServerMessage(
  value: unknown,
): RoomSnapshot | ServerError | LeftMessage | null {
  if (!isRecord(value) || value.v !== PROTOCOL_VERSION) return null;
  if (
    value.type === "snapshot" &&
    typeof value.roomId === "string" &&
    typeof value.gameType === "string" &&
    typeof value.ruleSetId === "string" &&
    Number.isSafeInteger(value.revision) &&
    Number.isSafeInteger(value.round) &&
    isRecord(value.seats)
  ) {
    return value as unknown as RoomSnapshot;
  }
  if (value.type === "error" && typeof value.code === "string") {
    return value as unknown as ServerError;
  }
  if (value.type === "left") {
    return { v: PROTOCOL_VERSION, type: "left" };
  }
  return null;
}

function humanizeError(
  code: string,
  snapshot: RoomSnapshot | null,
): string {
  const messages: Record<string, string> = {
    "room.full": "房间已有两位玩家。",
    "room.expired": "房间不存在或已经过期。",
    "room.revision_mismatch": "局面已更新，已为你重新同步。",
    "room.not_a_seat": "你没有这个房间的操作席位。",
    "room.waiting_for_opponent": "请等待对手加入。",
    "room.game_finished": "本局已经结束。",
    "room.game_in_progress": "对局结束后才能准备复赛。",
    "room.rule_mismatch": "客户端与房间规则版本不一致，请刷新页面。",
    "protocol.invalid_message": "消息格式无效，请刷新后重试。",
    "protocol.message_too_large": "消息过大。",
    "protocol.rate_limited": "操作太快，请稍后再试。",
  };
  const platformMessage = messages[code];
  if (platformMessage !== undefined) return platformMessage;
  if (snapshot !== null) {
    const adapter = getGameAdapter(snapshot.gameType, snapshot.ruleSetId);
    const gameMessage = adapter?.getErrorMessage(code);
    if (gameMessage) return gameMessage;
  }
  return "操作未完成，请重试。";
}

export async function ensureBrowserSession(): Promise<void> {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("session_failed");
}

function websocketUrl(roomId: string): string {
  const url = new URL(
    `/api/rooms/${encodeURIComponent(roomId)}/websocket`,
    location.href,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export function useRoom(roomId: string): RoomClientView {
  const [phase, setPhase] = useState<ConnectionPhase>("connecting");
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fatalCode, setFatalCode] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const snapshotRef = useRef<RoomSnapshot | null>(null);
  const pendingRevisionRef = useRef<number | null>(null);
  const retryRef = useRef<() => void>(() => undefined);
  const leaveRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let attempt = 0;
    let retryTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let connectTimer: number | null = null;
    let leaveTimer: number | null = null;
    let terminal = false;
    let leaveRequested = false;
    let leavePromise: Promise<void> | null = null;
    let leaveTargetSocket: WebSocket | null = null;
    let resolveLeave: (() => void) | null = null;
    let lastServerMessageAt = Date.now();
    const sessionReady = ensureBrowserSession();

    const clearTimers = () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
      if (connectTimer !== null) window.clearTimeout(connectTimer);
      retryTimer = null;
      heartbeatTimer = null;
      connectTimer = null;
    };

    const completeLeave = () => {
      if (leaveTimer !== null) window.clearTimeout(leaveTimer);
      leaveTimer = null;
      const resolve = resolveLeave;
      resolveLeave = null;
      resolve?.();
    };

    const closeForLeave = (socket: WebSocket, reason: string) => {
      try {
        socket.close(1000, reason);
      } catch {
        // Navigation must not depend on a partially opened socket closing cleanly.
      }
    };

    const applySnapshot = (next: RoomSnapshot) => {
      const current = snapshotRef.current;
      if (current !== null && next.revision < current.revision) return;
      snapshotRef.current = next;
      setSnapshot(next);
      if (
        pendingRevisionRef.current !== null &&
        next.revision > pendingRevisionRef.current
      ) {
        pendingRevisionRef.current = null;
        setPending(false);
      }
      attempt = 0;
      setPhase("online");
    };

    const scheduleReconnect = () => {
      if (disposed || terminal) return;
      clearTimers();
      setPending(false);
      pendingRevisionRef.current = null;
      if (!navigator.onLine) {
        setPhase("offline");
        return;
      }
      setPhase("retrying");
      const delay = Math.min(8_000, 250 * 2 ** attempt);
      attempt += 1;
      retryTimer = window.setTimeout(
        () => void connect(),
        delay * (0.8 + Math.random() * 0.4),
      );
    };

    const connect = async () => {
      if (disposed || terminal) return;
      clearTimers();
      const currentGeneration = ++generation;
      setPhase(snapshotRef.current === null ? "connecting" : "retrying");
      try {
        await sessionReady;
      } catch {
        if (!disposed) {
          setNotice("无法建立匿名会话，正在重试。");
          scheduleReconnect();
        }
        return;
      }
      if (disposed || currentGeneration !== generation) return;

      const socket = new WebSocket(websocketUrl(roomId));
      socketRef.current = socket;
      connectTimer = window.setTimeout(() => socket.close(), 8_000);

      socket.addEventListener("open", () => {
        if (disposed || currentGeneration !== generation) return;
        if (connectTimer !== null) window.clearTimeout(connectTimer);
        connectTimer = null;
        setPhase("syncing");
        lastServerMessageAt = Date.now();
        heartbeatTimer = window.setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastServerMessageAt > 60_000) {
            socket.close();
            return;
          }
          socket.send("ping");
        }, 25_000);
      });

      socket.addEventListener("message", (event) => {
        if (disposed || currentGeneration !== generation) return;
        lastServerMessageAt = Date.now();
        if (event.data === "pong") return;
        let raw: unknown;
        try {
          raw = JSON.parse(String(event.data));
        } catch {
          setNotice("收到无法识别的服务器消息。");
          return;
        }
        const message = parseServerMessage(raw);
        if (message === null) {
          setNotice("服务器协议不兼容，请刷新页面。");
          return;
        }
        if (message.type === "snapshot") {
          applySnapshot(message);
          return;
        }
        if (message.type === "left") {
          if (leaveTargetSocket === socket) completeLeave();
          return;
        }
        pendingRevisionRef.current = null;
        setPending(false);
        if (message.snapshot) applySnapshot(message.snapshot);
        setNotice(
          humanizeError(
            message.code,
            message.snapshot ?? snapshotRef.current,
          ),
        );
        if (fatalCodes.has(message.code)) {
          terminal = true;
          setFatalCode(message.code);
          setPhase("fatal");
          socket.close();
        }
      });

      socket.addEventListener("close", () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (leaveRequested && leaveTargetSocket === socket) completeLeave();
        if (currentGeneration === generation) scheduleReconnect();
      });
      socket.addEventListener("error", () => socket.close());
    };

    const retryNow = () => {
      if (terminal) return;
      generation += 1;
      socketRef.current?.close();
      void connect();
    };
    retryRef.current = retryNow;

    const leave = (): Promise<void> => {
      if (leavePromise !== null) return leavePromise;
      leaveRequested = true;
      terminal = true;
      clearTimers();
      setLeaving(true);
      setPending(false);
      pendingRevisionRef.current = null;
      setNotice(null);

      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) {
        if (socket !== null) closeForLeave(socket, "left");
        leavePromise = Promise.resolve();
        return leavePromise;
      }

      leaveTargetSocket = socket;
      leavePromise = new Promise<void>((resolve) => {
        resolveLeave = resolve;
      });
      leaveTimer = window.setTimeout(() => {
        closeForLeave(socket, "leave timeout");
        completeLeave();
      }, 1_500);
      try {
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "leave" }));
      } catch {
        closeForLeave(socket, "leave failed");
        completeLeave();
      }
      return leavePromise;
    };
    leaveRef.current = leave;

    const handleOffline = () => {
      setPhase("offline");
      socketRef.current?.close();
    };
    const handleOnline = () => retryNow();
    const handleVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        (socketRef.current?.readyState !== WebSocket.OPEN ||
          Date.now() - lastServerMessageAt > 60_000)
      ) {
        retryNow();
      }
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);
    void connect();

    return () => {
      disposed = true;
      generation += 1;
      clearTimers();
      if (leaveTimer !== null) window.clearTimeout(leaveTimer);
      leaveTimer = null;
      completeLeave();
      socketRef.current?.close();
      socketRef.current = null;
      retryRef.current = () => undefined;
      leaveRef.current = () => Promise.resolve();
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [roomId]);

  const send = useCallback((command: RoomCommand): boolean => {
    const socket = socketRef.current;
    if (
      socket?.readyState !== WebSocket.OPEN ||
      pendingRevisionRef.current !== null
    ) {
      return false;
    }
    pendingRevisionRef.current = command.expectedRevision;
    setPending(true);
    setNotice(null);
    socket.send(JSON.stringify(command));
    return true;
  }, []);

  const sendGameAction = useCallback(
    (payload: JsonValue): boolean => {
      const current = snapshotRef.current;
      if (current === null) return false;
      return send({
        v: PROTOCOL_VERSION,
        type: "game_action",
        gameType: current.gameType,
        ruleSetId: current.ruleSetId,
        expectedRevision: current.revision,
        payload,
      });
    },
    [send],
  );

  const resign = useCallback((): boolean => {
    const current = snapshotRef.current;
    if (current === null) return false;
    return send({
      v: PROTOCOL_VERSION,
      type: "resign",
      expectedRevision: current.revision,
    });
  }, [send]);

  const setRematchReady = useCallback(
    (ready: boolean): boolean => {
      const current = snapshotRef.current;
      if (current === null) return false;
      return send({
        v: PROTOCOL_VERSION,
        type: "rematch_ready",
        expectedRevision: current.revision,
        ready,
      });
    },
    [send],
  );

  return {
    phase,
    snapshot,
    pending,
    leaving,
    notice,
    fatalCode,
    sendGameAction,
    resign,
    setRematchReady,
    leave: () => leaveRef.current(),
    retryNow: () => retryRef.current(),
  };
}

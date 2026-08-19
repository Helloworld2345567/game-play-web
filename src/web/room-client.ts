import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { JsonValue } from "../core/game-rules";
import {
  PROTOCOL_VERSION,
  type ClientCommand,
  type RoomSnapshot,
  type ServerError,
} from "../shared/protocol";

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
  notice: string | null;
  fatalCode: string | null;
  sendGameAction(payload: JsonValue): boolean;
  resign(): boolean;
  setRematchReady(ready: boolean): boolean;
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

function parseServerMessage(value: unknown): RoomSnapshot | ServerError | null {
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
  return null;
}

function humanizeError(code: string): string {
  const messages: Record<string, string> = {
    "room.full": "房间已有两位玩家。",
    "room.expired": "房间不存在或已经过期。",
    "room.revision_mismatch": "局面已更新，已为你重新同步。",
    "room.not_a_seat": "你没有这个房间的操作席位。",
    "room.waiting_for_opponent": "请等待对手加入。",
    "room.game_finished": "本局已经结束。",
    "room.game_in_progress": "对局结束后才能准备复赛。",
    "room.rule_mismatch": "客户端与房间规则版本不一致，请刷新页面。",
    "gomoku.not_your_turn": "还没轮到你。",
    "gomoku.occupied": "这个交叉点已经有棋子。",
    "gomoku.out_of_bounds": "落点超出棋盘。",
    "gomoku.game_finished": "本局已经结束。",
    "gomoku.invalid_action": "无法识别这次落子。",
    "protocol.invalid_message": "消息格式无效，请刷新后重试。",
    "protocol.message_too_large": "消息过大。",
    "protocol.rate_limited": "操作太快，请稍后再试。",
  };
  return messages[code] ?? "操作未完成，请重试。";
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
  const [notice, setNotice] = useState<string | null>(null);
  const [fatalCode, setFatalCode] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const snapshotRef = useRef<RoomSnapshot | null>(null);
  const pendingRevisionRef = useRef<number | null>(null);
  const retryRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let attempt = 0;
    let retryTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let connectTimer: number | null = null;
    let terminal = false;
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

    const applySnapshot = (next: RoomSnapshot) => {
      const current = snapshotRef.current;
      if (current !== null && next.revision < current.revision) return;
      if (
        next.gameType !== "gomoku" ||
        next.ruleSetId !== "gomoku.freestyle15.v1"
      ) {
        terminal = true;
        setFatalCode("protocol.version_mismatch");
        setPhase("fatal");
        return;
      }
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
        pendingRevisionRef.current = null;
        setPending(false);
        if (message.snapshot) applySnapshot(message.snapshot);
        setNotice(humanizeError(message.code));
        if (fatalCodes.has(message.code)) {
          terminal = true;
          setFatalCode(message.code);
          setPhase("fatal");
          socket.close();
        }
      });

      socket.addEventListener("close", () => {
        if (socketRef.current === socket) socketRef.current = null;
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
      socketRef.current?.close();
      socketRef.current = null;
      retryRef.current = () => undefined;
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [roomId]);

  const send = useCallback((command: ClientCommand): boolean => {
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
    notice,
    fatalCode,
    sendGameAction,
    resign,
    setRematchReady,
    retryNow: () => retryRef.current(),
  };
}


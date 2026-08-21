import {
  getGuestSeat,
  type PlatformSeatId,
  type StoredRoom,
} from "../core/room-state";

export type RoomActivityTransport =
  | "http_sync"
  | "http_command"
  | "websocket_connect"
  | "websocket_message";

export interface ActivityHttpLease {
  guestId: string;
  seat: PlatformSeatId | null;
  expiresAt: number;
}

export type ActivityAdmission =
  | { ok: true }
  | { ok: false; code: "room.expired" | "room.connection_required" };

/**
 * Pure connection/lifecycle admission shared by every Room input adapter.
 * Storage-backed vacancy checks remain in GameRoom, after this cheap check.
 */
export function admitRoomActivity({
  transport,
  room,
  discarding,
  guestId,
  connectionId,
  httpLeases,
  socketSeat,
  now,
}: {
  transport: RoomActivityTransport;
  room: StoredRoom | null;
  discarding: boolean;
  guestId: string;
  connectionId?: string;
  httpLeases?: Readonly<Record<string, ActivityHttpLease>>;
  socketSeat?: PlatformSeatId | null;
  now: number;
}): ActivityAdmission {
  if (room === null || discarding || now >= room.expiresAt) {
    return { ok: false, code: "room.expired" };
  }

  if (transport === "http_command") {
    const lease =
      connectionId === undefined ? undefined : httpLeases?.[connectionId];
    if (
      lease === undefined ||
      lease.expiresAt <= now ||
      lease.guestId !== guestId ||
      getGuestSeat(room, guestId) !== lease.seat
    ) {
      return { ok: false, code: "room.connection_required" };
    }
  }

  if (
    transport === "websocket_message" &&
    getGuestSeat(room, guestId) !== socketSeat
  ) {
    return { ok: false, code: "room.connection_required" };
  }

  return { ok: true };
}

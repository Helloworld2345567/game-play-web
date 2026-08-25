import type { GameRules } from "../core/game-rules";
import {
  getGuestSeat,
  getRecentActionReceipts,
  getRoomSeatOrder,
  type StoredRoom,
} from "../core/room-state";
import { getRematchRuleSetIds } from "../games/registry";
import { defaultDisplayName } from "../shared/display-name";
import { PROTOCOL_VERSION, type RoomSnapshot } from "../shared/protocol";

/** Projects authoritative Room state without exposing rule-private data. */
export function projectRoomSnapshot({
  room,
  rules,
  viewerGuestId,
  onlineGuestIds,
  displayNames,
  snapshotRevision,
}: {
  room: StoredRoom;
  rules: GameRules;
  viewerGuestId: string;
  onlineGuestIds: ReadonlySet<string>;
  displayNames: Readonly<Record<string, string>>;
  snapshotRevision: number;
}): RoomSnapshot {
  const viewerSeat = getGuestSeat(room, viewerGuestId);
  const seatOrder = getRoomSeatOrder(room);
  const spectatorGuestIds = [...onlineGuestIds]
    .filter((guestId) => getGuestSeat(room, guestId) === null)
    .sort();
  const rematchRuleSetIds = getRematchRuleSetIds(room.ruleSetId);
  const selectedRematchRuleSetId =
    room.rematchRuleSetId !== null &&
    rematchRuleSetIds.includes(room.rematchRuleSetId)
      ? room.rematchRuleSetId
      : room.ruleSetId;
  const projectedSeats = Object.fromEntries(
    seatOrder.map((seatId) => {
      const seat = room.seats[seatId] ?? null;
      return [
        seatId,
        {
          occupied: seat !== null,
          online: seat !== null && onlineGuestIds.has(seat.guestId),
          rematchReady: seat?.rematchReady ?? false,
          displayName:
            seat === null
              ? null
              : displayNames[seat.guestId] ?? defaultDisplayName(seat.guestId),
        },
      ];
    }),
  );
  return {
    v: PROTOCOL_VERSION,
    type: "snapshot",
    roomId: room.roomId,
    gameType: room.gameType,
    ruleSetId: room.ruleSetId,
    actionConsistency: rules.definition.actionConsistency,
    snapshotRevision,
    revision: room.revision,
    round: room.round,
    selfSeat: viewerSeat,
    seatOrder,
    seats: projectedSeats,
    capabilities: {
      resign:
        seatOrder.length === 2 &&
        (rules.definition.resignPolicy ?? "opponent_wins") !== "disabled",
    },
    spectators: spectatorGuestIds.map((guestId) => ({
      displayName: displayNames[guestId] ?? defaultDisplayName(guestId),
      isSelf: guestId === viewerGuestId,
    })),
    preparation:
      room.position === null && rules.definition.openingRoleIds !== undefined
        ? {
            roleIds: rules.definition.openingRoleIds,
            roleBySeat: room.preparation?.roleBySeat ?? {
              ...Object.fromEntries(seatOrder.map((seatId) => [seatId, null])),
            },
          }
        : null,
    rematchOptions:
      room.position !== null &&
      room.position.outcome !== null &&
      rematchRuleSetIds.length > 1
        ? {
            ruleSetIds: rematchRuleSetIds,
            selectedRuleSetId: selectedRematchRuleSetId,
          }
        : null,
    position:
      room.position === null
        ? null
        : rules.project(room.position, viewerSeat),
    ...(viewerSeat !== null &&
    rules.definition.actionConsistency === "concurrent_idempotent"
      ? {
          actionReceipts: [...getRecentActionReceipts(room, viewerSeat)],
        }
      : {}),
  };
}

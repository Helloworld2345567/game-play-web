import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { JsonValue } from "../core/game-rules";
import { createBrowserRoomSession } from "./room-session/browser-room-session";
import { initialRoomSessionView, type RoomSession, type RoomSessionView,
  type RoomIntent, type RoomErrorMessageResolver } from "./room-session/room-session";

// Existing consumers keep a stable facade while identity, commands and the
// connection lifecycle have independent implementations and tests.
export { ensureBrowserSession } from "./room-session/browser-session";
export { nextClientSequence, isConcurrentRoom, createGameActionCommand,
  createPrepareRoleCommand, createSelectRematchRuleCommand } from "./room-session/room-commands";
export { createConcurrentActionLedger, type ConcurrentActionLedger } from "./room-session/legacy-action-ledger";
export { sendOutstandingConcurrentActions } from "./room-session/concurrent-action-tracker";
export type { ConnectionPhase, RoomTransport, RoomErrorMessageResolver } from "./room-session/room-session";

export interface UseRoomOptions {
  resolveErrorMessage?: RoomErrorMessageResolver;
}

export interface RoomClientView extends RoomSessionView {
  selectOpeningRole(roleId: string): boolean;
  sendGameAction(payload: JsonValue): boolean;
  resign(): boolean;
  selectRematchRule(ruleSetId: string): boolean;
  setRematchReady(ready: boolean): boolean;
  leave(): Promise<void>;
  retryNow(): void;
}

/** Preact only subscribes to a session; it owns no network or action state. */
export function useRoom(
  roomId: string,
  displayName: string,
  options: UseRoomOptions = {},
): RoomClientView {
  const [view, setView] = useState(initialRoomSessionView);
  const sessionRef = useRef<RoomSession | null>(null);
  const resolveErrorMessage = options.resolveErrorMessage;
  useEffect(() => {
    const session = createBrowserRoomSession(roomId, displayName, resolveErrorMessage);
    sessionRef.current = session;
    const unsubscribe = session.subscribe(setView);
    session.start();
    return () => {
      unsubscribe();
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [roomId, displayName, resolveErrorMessage]);

  const submit = useCallback((intent: RoomIntent) => sessionRef.current?.submit(intent) ?? false, []);
  const sendGameAction = useCallback((payload: JsonValue) => submit({ type: "game_action", payload }), [submit]);
  const selectOpeningRole = useCallback((roleId: string) => submit({ type: "prepare_role", roleId }), [submit]);
  const selectRematchRule = useCallback((ruleSetId: string) => submit({ type: "select_rematch_rule", ruleSetId }), [submit]);
  const setRematchReady = useCallback((ready: boolean) => submit({ type: "rematch_ready", ready }), [submit]);
  const resign = useCallback(() => submit({ type: "resign" }), [submit]);
  const leave = useCallback(() => sessionRef.current?.leave() ?? Promise.resolve(), []);
  const retryNow = useCallback(() => sessionRef.current?.retry(), []);
  return { ...view, sendGameAction, selectOpeningRole, selectRematchRule, setRematchReady, resign, leave, retryNow };
}

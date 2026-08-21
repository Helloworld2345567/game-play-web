import type { ActionReceipt } from "../shared/protocol";

export const MAX_RECENT_ACTION_RECEIPTS = 128;
const LEGACY_ACTION_SCOPE = "__legacy__";
const INVALID_ACTION_SCOPE = "!invalid_scope!";
const ACTION_SCOPE_PATTERN = /^[A-Za-z0-9_-]{1,96}$/u;

export type ActionJournalSeat = "seat-a" | "seat-b";

export interface ActionJournalSeatState {
  /**
   * Any unknown action at or below this sequence is outside the exact receipt
   * window and must never enter the rules module again. This root window is
   * retained for persisted legacy actions; current transports use `scopes`
   * so separate browser connections can legitimately arrive out of order.
   */
  compactedThrough: number;
  receipts: ActionReceipt[];
  /**
   * Sequence windows for newer transports.  The property is optional so
   * schema-v1/v2/v3 rooms (and tests that construct the old shape directly)
   * continue to hydrate without a rewrite.  Each connection owns its own
   * monotonic clientSeq space; action IDs remain globally deduplicated below.
   */
  scopes?: Record<string, ActionJournalScopeState>;
}

export interface ActionJournalScopeState {
  compactedThrough: number;
  receipts: ActionReceipt[];
}

export type ActionJournalState = Record<
  ActionJournalSeat,
  ActionJournalSeatState
>;

export type ActionJournalAdmission =
  | { kind: "new" }
  | { kind: "duplicate"; receipt: ActionReceipt }
  | { kind: "expired" }
  | { kind: "sequence_conflict" }
  /**
   * A lower sequence that was never seen cannot safely be replayed after a
   * higher sequence was admitted, because the higher action may be compacted.
   */
  | { kind: "out_of_order" };

function emptySeatJournal(): ActionJournalSeatState {
  return { compactedThrough: -1, receipts: [] };
}

function normalizedScope(scope: string | undefined): string {
  if (scope === undefined || scope === "") return LEGACY_ACTION_SCOPE;
  if (typeof scope !== "string" || scope.length === 0) {
    return INVALID_ACTION_SCOPE;
  }
  // Public adapters validate connection IDs before entering this module. Keep
  // a bounded second guard so an internal caller cannot create unbounded map
  // keys or accidentally collide with the legacy namespace.
  return ACTION_SCOPE_PATTERN.test(scope) ? scope : INVALID_ACTION_SCOPE;
}

function scopeState(
  seatJournal: ActionJournalSeatState,
  scope: string | undefined,
): ActionJournalScopeState {
  const key = normalizedScope(scope);
  if (key === LEGACY_ACTION_SCOPE) {
    return {
      compactedThrough: seatJournal.compactedThrough,
      receipts: seatJournal.receipts,
    };
  }
  return seatJournal.scopes?.[key] ?? { compactedThrough: -1, receipts: [] };
}

function maxKnownClientSeq(state: ActionJournalScopeState): number {
  return state.receipts.reduce(
    (highest, receipt) => Math.max(highest, receipt.clientSeq),
    state.compactedThrough,
  );
}

function allScopeReceipts(
  seatJournal: ActionJournalSeatState,
): Array<{ scope: string; receipt: ActionReceipt }> {
  const entries = seatJournal.receipts.map((receipt) => ({
    scope: LEGACY_ACTION_SCOPE,
    receipt,
  }));
  for (const [scope, state] of Object.entries(seatJournal.scopes ?? {})) {
    entries.push(...state.receipts.map((receipt) => ({ scope, receipt })));
  }
  return entries;
}

function oldestScopeReceipt(
  scope: string,
  receipts: ActionReceipt[],
): { scope: string; receipt: ActionReceipt } | undefined {
  let oldest: ActionReceipt | undefined;
  for (const receipt of receipts) {
    if (oldest === undefined || receipt.clientSeq < oldest.clientSeq) {
      oldest = receipt;
    }
  }
  return oldest === undefined ? undefined : { scope, receipt: oldest };
}

export function createActionJournal(): ActionJournalState {
  return {
    "seat-a": emptySeatJournal(),
    "seat-b": emptySeatJournal(),
  };
}

/** Migrates the bounded receipt arrays written by Room schema v2. */
export function migrateReceiptJournal(
  receiptsBySeat: Record<ActionJournalSeat, ActionReceipt[]>,
): ActionJournalState {
  const migrateSeat = (seat: ActionJournalSeat): ActionJournalSeatState => {
    const receipts = receiptsBySeat[seat].slice(-MAX_RECENT_ACTION_RECEIPTS);
    const minimumSequence = receipts.reduce(
      (minimum, receipt) => Math.min(minimum, receipt.clientSeq),
      Number.POSITIVE_INFINITY,
    );
    return {
      // Existing clients issued increasing per-page sequences. When a full v2
      // window exists, min - 1 safely represents the already-compacted prefix.
      compactedThrough:
        receipts.length === MAX_RECENT_ACTION_RECEIPTS &&
        Number.isFinite(minimumSequence)
          ? minimumSequence - 1
          : -1,
      receipts,
    };
  };
  return {
    "seat-a": migrateSeat("seat-a"),
    "seat-b": migrateSeat("seat-b"),
  };
}

export function admitAction(
  journal: ActionJournalState,
  seat: ActionJournalSeat,
  identity: Pick<ActionReceipt, "actionId" | "clientSeq">,
  scope?: string,
): ActionJournalAdmission {
  const seatJournal = journal[seat];
  // actionId is intentionally global to a Seat. A retry that changes
  // transport (HTTP ↔ WebSocket) must still be harmless.
  const duplicate = allScopeReceipts(seatJournal).find(
    ({ receipt }) => receipt.actionId === identity.actionId,
  );
  if (duplicate !== undefined) {
    return { kind: "duplicate", receipt: duplicate.receipt };
  }
  const current = scopeState(seatJournal, scope);
  if (identity.clientSeq <= current.compactedThrough) {
    return { kind: "expired" };
  }
  const sequenceReceipt = current.receipts.some(
    (receipt) => receipt.clientSeq === identity.clientSeq,
  );
  if (sequenceReceipt) {
    return { kind: "sequence_conflict" };
  }
  // A current connection must send its sequence monotonically. Cross-scope
  // actions remain independent, but accepting an unseen lower (or already
  // compacted equal) sequence here would let it enter the rules after a
  // higher sequence had already moved outside the bounded receipt window.
  if (
    normalizedScope(scope) !== LEGACY_ACTION_SCOPE &&
    identity.clientSeq <= maxKnownClientSeq(current)
  ) {
    return { kind: "out_of_order" };
  }
  return { kind: "new" };
}

export function recordActionReceipt(
  journal: ActionJournalState,
  seat: ActionJournalSeat,
  receipt: ActionReceipt,
  scope?: string,
): ActionJournalState {
  const current = journal[seat];
  const key = normalizedScope(scope);
  const scopes: Record<string, ActionJournalScopeState> = Object.fromEntries(
    Object.entries(current.scopes ?? {}).map(([name, state]) => [
      name,
      {
        compactedThrough: state.compactedThrough,
        receipts: state.receipts.slice(),
      },
    ]),
  );
  let legacyCompactedThrough = current.compactedThrough;
  let legacyReceipts = current.receipts.slice();
  if (key === LEGACY_ACTION_SCOPE) {
    legacyReceipts.push(receipt);
  } else {
    const target = scopes[key] ?? { compactedThrough: -1, receipts: [] };
    target.receipts.push(receipt);
    scopes[key] = target;
  }

  const allReceipts = () => [
    ...legacyReceipts.map((item) => ({
      scope: LEGACY_ACTION_SCOPE,
      receipt: item,
    })),
    ...Object.entries(scopes).flatMap(([name, state]) =>
      state.receipts.map((item) => ({ scope: name, receipt: item })),
    ),
  ];
  while (allReceipts().length > MAX_RECENT_ACTION_RECEIPTS) {
    // Compact the oldest sequence still present in a scope. The admission
    // layer rejects an unseen lower sequence than the greatest known sequence
    // in that scope, while this floor rejects sequences below the retained
    // receipt window. Choosing an arbitrary high sequence would make the
    // expiration boundary inaccurate.
    const candidates = [
      oldestScopeReceipt(LEGACY_ACTION_SCOPE, legacyReceipts),
      ...Object.entries(scopes).map(([name, state]) =>
        oldestScopeReceipt(name, state.receipts),
      ),
    ].filter(
      (candidate): candidate is { scope: string; receipt: ActionReceipt } =>
        candidate !== undefined,
    );
    let compacted = candidates[0];
    for (let index = 1; index < candidates.length; index += 1) {
      if (
        candidates[index]!.receipt.revision < compacted!.receipt.revision
      ) {
        compacted = candidates[index];
      }
    }
    if (compacted === undefined) break;
    if (compacted.scope === LEGACY_ACTION_SCOPE) {
      const index = legacyReceipts.indexOf(compacted.receipt);
      if (index >= 0) legacyReceipts.splice(index, 1);
      legacyCompactedThrough = Math.max(
        legacyCompactedThrough,
        compacted.receipt.clientSeq,
      );
    } else {
      const state = scopes[compacted.scope];
      if (state === undefined) break;
      const index = state.receipts.indexOf(compacted.receipt);
      if (index >= 0) state.receipts.splice(index, 1);
      state.compactedThrough = Math.max(
        state.compactedThrough,
        compacted.receipt.clientSeq,
      );
    }
  }
  // Empty scopes carry only an expiration floor. Retain a bounded number so
  // recent old connections still reject replays without allowing connection
  // churn to grow persisted Room state indefinitely.
  for (const scopeName of Object.keys(scopes)) {
    if (Object.keys(scopes).length <= MAX_RECENT_ACTION_RECEIPTS) break;
    if (scopes[scopeName]?.receipts.length === 0) delete scopes[scopeName];
  }
  return {
    ...journal,
    [seat]: {
      compactedThrough: legacyCompactedThrough,
      receipts: legacyReceipts,
      ...(Object.keys(scopes).length === 0 ? {} : { scopes }),
    },
  };
}

export function actionReceiptsFor(
  journal: ActionJournalState,
  seat: ActionJournalSeat,
): readonly ActionReceipt[] {
  // Scope storage is grouped by connection, so flattening it directly can
  // interleave revisions. Array#sort is stable for equal revisions, retaining
  // the original rejection order within one revision.
  return allScopeReceipts(journal[seat])
    .map(({ receipt }) => receipt)
    .sort((left, right) =>
      left.revision === right.revision
        ? 0
        : left.revision < right.revision
          ? -1
          : 1,
    );
}

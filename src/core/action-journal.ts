import type { ActionReceipt } from "../shared/protocol";

export const MAX_RECENT_ACTION_RECEIPTS = 128;

export type ActionJournalSeat = "seat-a" | "seat-b";

export interface ActionJournalSeatState {
  /**
   * Any unknown action at or below this sequence is outside the exact receipt
   * window and must never enter the rules module again. `clientSeq` is a
   * bounded de-duplication key, not a cross-connection ordering guarantee:
   * separate browser connections may legitimately arrive out of order.
   */
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
  | { kind: "sequence_conflict" };

function emptySeatJournal(): ActionJournalSeatState {
  return { compactedThrough: -1, receipts: [] };
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
): ActionJournalAdmission {
  const seatJournal = journal[seat];
  const duplicate = seatJournal.receipts.find(
    (receipt) => receipt.actionId === identity.actionId,
  );
  if (duplicate !== undefined) return { kind: "duplicate", receipt: duplicate };
  if (identity.clientSeq <= seatJournal.compactedThrough) {
    return { kind: "expired" };
  }
  if (
    seatJournal.receipts.some(
      (receipt) => receipt.clientSeq === identity.clientSeq,
    )
  ) {
    return { kind: "sequence_conflict" };
  }
  return { kind: "new" };
}

export function recordActionReceipt(
  journal: ActionJournalState,
  seat: ActionJournalSeat,
  receipt: ActionReceipt,
): ActionJournalState {
  const current = journal[seat];
  const receipts = [...current.receipts, receipt];
  let compactedThrough = current.compactedThrough;
  while (receipts.length > MAX_RECENT_ACTION_RECEIPTS) {
    let oldestSequenceIndex = 0;
    for (let index = 1; index < receipts.length; index += 1) {
      if (
        receipts[index]!.clientSeq <
        receipts[oldestSequenceIndex]!.clientSeq
      ) {
        oldestSequenceIndex = index;
      }
    }
    const [compacted] = receipts.splice(oldestSequenceIndex, 1);
    if (compacted !== undefined) {
      compactedThrough = Math.max(compactedThrough, compacted.clientSeq);
    }
  }
  return {
    ...journal,
    [seat]: { compactedThrough, receipts },
  };
}

export function actionReceiptsFor(
  journal: ActionJournalState,
  seat: ActionJournalSeat,
): readonly ActionReceipt[] {
  return journal[seat].receipts;
}

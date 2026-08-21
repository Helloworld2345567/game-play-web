import type { RoomPreparationView } from "../shared/protocol";
import type { OpeningRoleChoice } from "./games/registry";

type PlayerSeat = "seat-a" | "seat-b";

export interface OpeningRolePanelProps {
  preparation: RoomPreparationView | null | undefined;
  openingChoices: readonly OpeningRoleChoice[];
  selfSeat: string | null;
  pending: boolean;
  disabled: boolean;
  notice: string | null;
  onSelect(roleId: string): void;
}

export interface OpeningRoleButtonState {
  choice: OpeningRoleChoice;
  selectedBy: PlayerSeat | null;
  selectedBySelf: boolean;
  selectedByOpponent: boolean;
  claimedByAnother: boolean;
  disabled: boolean;
}

export interface OpeningRolePanelState {
  visible: boolean;
  ownRoleId: string | null;
  opponentRoleId: string | null;
  statusMessage: string;
  choices: readonly OpeningRoleButtonState[];
}

function playerSeat(value: string | null): PlayerSeat | null {
  return value === "seat-a" || value === "seat-b" ? value : null;
}

function otherSeat(seat: PlayerSeat): PlayerSeat {
  return seat === "seat-a" ? "seat-b" : "seat-a";
}

function selectedSeatForRole(
  preparation: RoomPreparationView,
  roleId: string,
): PlayerSeat | null {
  for (const seat of ["seat-a", "seat-b"] as const) {
    if (preparation.roleBySeat[seat] === roleId) return seat;
  }
  return null;
}

export function getOpeningRolePanelState({
  preparation,
  openingChoices,
  selfSeat,
  pending,
  disabled,
}: Pick<
  OpeningRolePanelProps,
  "preparation" | "openingChoices" | "selfSeat" | "pending" | "disabled"
>): OpeningRolePanelState {
  const visible = preparation !== null &&
    preparation !== undefined &&
    openingChoices.length > 0;
  if (!visible) {
    return {
      visible: false,
      ownRoleId: null,
      opponentRoleId: null,
      statusMessage: "",
      choices: [],
    };
  }

  const seat = playerSeat(selfSeat);
  const opponent = seat === null ? null : otherSeat(seat);
  const ownRoleId = seat === null
    ? null
    : preparation.roleBySeat[seat] ?? null;
  const opponentRoleId = opponent === null
    ? null
    : preparation.roleBySeat[opponent] ?? null;
  const allowedRoleIds = new Set(preparation.roleIds);
  const choices = openingChoices
    .filter((choice) => allowedRoleIds.has(choice.roleId))
    .map((choice) => {
      const selectedBy = selectedSeatForRole(preparation, choice.roleId);
      const selectedBySelf = selectedBy !== null && selectedBy === seat;
      const selectedByOpponent = selectedBy !== null && selectedBy === opponent;
      const claimedByAnother = selectedBy !== null && !selectedBySelf;
      return {
        choice,
        selectedBy,
        selectedBySelf,
        selectedByOpponent,
        claimedByAnother,
        disabled:
          disabled ||
          pending ||
          seat === null ||
          selectedByOpponent ||
          selectedBySelf,
      };
    });

  const statusMessage = seat === null
    ? "等待双方选择角色"
    : ownRoleId === null
      ? "请选择你的角色"
      : `已选择${choices.find((entry) => entry.choice.roleId === ownRoleId)
          ?.choice.label ?? "角色"}，等待对手`;
  return {
    visible,
    ownRoleId,
    opponentRoleId,
    statusMessage,
    choices,
  };
}

export function OpeningRolePanel({
  preparation,
  openingChoices,
  selfSeat,
  pending,
  disabled,
  notice,
  onSelect,
}: OpeningRolePanelProps) {
  const state = getOpeningRolePanelState({
    preparation,
    openingChoices,
    selfSeat,
    pending,
    disabled,
  });
  if (!state.visible) return null;

  return (
    <section class="opening-role-panel" aria-labelledby="opening-role-title">
      <div class="opening-role-heading">
        <div>
          <p class="eyebrow">开始前准备</p>
          <h2 id="opening-role-title">选择你的角色</h2>
        </div>
      </div>
      <div
        class="opening-role-choices"
        role="group"
        aria-label="可选择的角色"
      >
        {state.choices.map((entry) => (
          <button
            key={entry.choice.roleId}
            type="button"
            class={`opening-role-choice ${entry.selectedBySelf ? "is-selected" : ""} ${entry.claimedByAnother ? "is-taken" : ""}`}
            data-role-id={entry.choice.roleId}
            data-selected={entry.selectedBySelf ? "true" : "false"}
            aria-pressed={entry.selectedBySelf}
            aria-label={`${entry.choice.orderLabel}${entry.choice.label}${entry.claimedByAnother ? "（已有玩家选择）" : ""}`}
            disabled={entry.disabled}
            onClick={() => onSelect(entry.choice.roleId)}
          >
            <span
              class={`stone-swatch ${entry.choice.swatchClassName}`}
              aria-hidden="true"
            />
            <span class="opening-role-choice-copy">
              <strong>{entry.choice.label}</strong>
              <small>
                {entry.selectedBySelf
                  ? `${entry.choice.orderLabel} · 已选择`
                  : entry.claimedByAnother
                    ? `${entry.choice.orderLabel} · 已有玩家选择`
                    : `${entry.choice.orderLabel} · 点击选择`}
              </small>
            </span>
          </button>
        ))}
      </div>
      <p class="opening-role-status" role="status" aria-live="polite">
        {notice ?? state.statusMessage}
      </p>
    </section>
  );
}

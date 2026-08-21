import { describe, expect, it } from "vitest";
import { getOpeningRolePanelState } from "./OpeningRolePanel";

const choices = [
  {
    roleId: "x",
    label: "X 方",
    orderLabel: "先手",
    swatchClassName: "tictactoe-x",
  },
  {
    roleId: "o",
    label: "O 方",
    orderLabel: "后手",
    swatchClassName: "tictactoe-o",
  },
] as const;

function preparation(
  roleBySeat: { "seat-a": string | null; "seat-b": string | null },
) {
  return {
    roleIds: ["x", "o"] as const,
    roleBySeat,
  };
}

describe("opening role panel state", () => {
  it("keeps a role selected by the opponent unavailable", () => {
    const state = getOpeningRolePanelState({
      preparation: preparation({ "seat-a": null, "seat-b": "o" }),
      openingChoices: choices,
      selfSeat: "seat-a",
      pending: false,
      disabled: false,
    });

    expect(state.visible).toBe(true);
    expect(state.statusMessage).toBe("请选择你的角色");
    expect(state.choices).toMatchObject([
      { choice: choices[0], selectedByOpponent: false, disabled: false },
      { choice: choices[1], selectedByOpponent: true, disabled: true },
    ]);
  });

  it("marks the player's own choice and disables all controls for spectators", () => {
    const selected = getOpeningRolePanelState({
      preparation: preparation({ "seat-a": "x", "seat-b": null }),
      openingChoices: choices,
      selfSeat: "seat-a",
      pending: true,
      disabled: false,
    });
    expect(selected.ownRoleId).toBe("x");
    expect(selected.statusMessage).toBe("已选择X 方，等待对手");
    expect(selected.choices[0]).toMatchObject({
      selectedBySelf: true,
      disabled: true,
    });

    const spectator = getOpeningRolePanelState({
      preparation: preparation({ "seat-a": "x", "seat-b": null }),
      openingChoices: choices,
      selfSeat: null,
      pending: false,
      disabled: false,
    });
    expect(spectator.statusMessage).toBe("等待双方选择角色");
    expect(spectator.choices.every((choice) => choice.disabled)).toBe(true);
    expect(spectator.choices[0]).toMatchObject({
      claimedByAnother: true,
      selectedBySelf: false,
    });
  });

  it("does not render when the room has no preparation or choices", () => {
    expect(
      getOpeningRolePanelState({
        preparation: null,
        openingChoices: choices,
        selfSeat: "seat-a",
        pending: false,
        disabled: false,
      }).visible,
    ).toBe(false);
    expect(
      getOpeningRolePanelState({
        preparation: preparation({ "seat-a": null, "seat-b": null }),
        openingChoices: [],
        selfSeat: "seat-a",
        pending: false,
        disabled: false,
      }).visible,
    ).toBe(false);
  });
});

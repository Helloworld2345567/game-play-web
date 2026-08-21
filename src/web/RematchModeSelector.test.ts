import { describe, expect, it, vi } from "vitest";
import type { VNode } from "preact";
import {
  getRematchModeSelectorState,
  RematchModeSelector,
  type RematchModeOption,
} from "./RematchModeSelector";

const options: readonly RematchModeOption[] = [
  {
    ruleSetId: "chase.easy.v1",
    label: "简单",
    description: "上限 15 轮",
  },
  {
    ruleSetId: "chase.medium.v1",
    label: "中等",
    description: "上限 25 轮",
  },
];

type TestVNode = VNode<{
  readonly [key: string]: unknown;
  readonly children?: unknown;
}>;

function testVNode(value: unknown): TestVNode {
  if (typeof value !== "object" || value === null || !("props" in value)) {
    throw new Error("Expected a Preact VNode");
  }
  return value as TestVNode;
}

describe("rematch mode selector state", () => {
  it("marks the current mode and leaves choices enabled by default", () => {
    const state = getRematchModeSelectorState({
      options,
      selectedRuleSetId: "chase.easy.v1",
      disabled: false,
    });

    expect(state.visible).toBe(true);
    expect(state.options).toEqual([
      {
        option: options[0],
        selected: true,
        disabled: false,
      },
      {
        option: options[1],
        selected: false,
        disabled: false,
      },
    ]);
  });

  it("honours a disabled host and does not expose an empty selector", () => {
    expect(
      getRematchModeSelectorState({
        options,
        selectedRuleSetId: "chase.easy.v1",
        disabled: true,
      }).options.every((entry) => entry.disabled),
    ).toBe(true);
    expect(
      getRematchModeSelectorState({
        options: [],
        selectedRuleSetId: "chase.easy.v1",
        disabled: false,
      }),
    ).toEqual({ visible: false, options: [] });
  });

  it("renders radio semantics and forwards the selected rule id", () => {
    const onSelect = vi.fn();
    const tree = RematchModeSelector({
      options,
      selectedRuleSetId: "chase.easy.v1",
      disabled: false,
      onSelect,
    });

    if (tree === null) throw new Error("Expected the selector to render");
    const root = testVNode(tree);
    expect(root.props).toMatchObject({
      class: "rematch-mode-panel",
      "aria-label": "下一局模式",
    });

    const rootChildren = root.props.children;
    if (!Array.isArray(rootChildren)) {
      throw new Error("Expected the selector to have section children");
    }
    const optionsGroup = testVNode(rootChildren[1]);
    const groupChildren = optionsGroup.props.children;
    if (!Array.isArray(groupChildren)) {
      throw new Error("Expected the mode options to be an array");
    }
    const buttons = groupChildren.map(testVNode);
    expect(optionsGroup.props).toMatchObject({
      role: "radiogroup",
      "aria-label": "下一局模式选项",
    });
    expect(buttons).toHaveLength(2);
    const firstButton = buttons[0];
    const secondButton = buttons[1];
    if (firstButton === undefined || secondButton === undefined) {
      throw new Error("Expected two mode options");
    }
    expect(firstButton.props).toMatchObject({
      role: "radio",
      "aria-checked": true,
      "data-rule-set-id": "chase.easy.v1",
      disabled: false,
    });
    expect(secondButton.props).toMatchObject({
      role: "radio",
      "aria-checked": false,
      "data-rule-set-id": "chase.medium.v1",
      disabled: false,
    });

    const onClick = secondButton.props.onClick;
    if (typeof onClick !== "function") {
      throw new Error("Expected a mode option click handler");
    }
    onClick();
    expect(onSelect).toHaveBeenCalledWith("chase.medium.v1");
    expect(testVNode(rootChildren[2]).props.children).toContain(
      "更换模式后，双方需要重新确认再来一局",
    );
  });
});

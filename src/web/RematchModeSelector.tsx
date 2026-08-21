import type { FunctionComponent } from "preact";

export interface RematchModeOption {
  readonly ruleSetId: string;
  readonly label: string;
  readonly description?: string;
}

export interface RematchModeSelectorProps {
  readonly options: readonly RematchModeOption[];
  readonly selectedRuleSetId: string;
  readonly disabled: boolean;
  onSelect(ruleSetId: string): void;
}

export interface RematchModeOptionState {
  readonly option: RematchModeOption;
  readonly selected: boolean;
  readonly disabled: boolean;
}

export interface RematchModeSelectorState {
  readonly visible: boolean;
  readonly options: readonly RematchModeOptionState[];
}

/**
 * Derive the small amount of state needed by the selector. Keeping this pure
 * makes the interaction rules easy to exercise without a browser DOM.
 */
export function getRematchModeSelectorState({
  options,
  selectedRuleSetId,
  disabled,
}: Pick<
  RematchModeSelectorProps,
  "options" | "selectedRuleSetId" | "disabled"
>): RematchModeSelectorState {
  return {
    visible: options.length > 0,
    options: options.map((option) => ({
      option,
      selected: option.ruleSetId === selectedRuleSetId,
      disabled,
    })),
  };
}

export const RematchModeSelector: FunctionComponent<
  RematchModeSelectorProps
> = ({
  options,
  selectedRuleSetId,
  disabled,
  onSelect,
}) => {
  const state = getRematchModeSelectorState({
    options,
    selectedRuleSetId,
    disabled,
  });
  if (!state.visible) return null;

  return (
    <section class="rematch-mode-panel" aria-label="下一局模式">
      <div class="rematch-mode-heading">
        <div>
          <p class="eyebrow">下一局设置</p>
          <h2>选择下一局模式</h2>
        </div>
      </div>
      <div
        class="rematch-mode-options"
        role="radiogroup"
        aria-label="下一局模式选项"
      >
        {state.options.map((entry) => (
          <button
            key={entry.option.ruleSetId}
            type="button"
            role="radio"
            class={`rematch-mode-option ${entry.selected ? "is-selected" : ""}`}
            aria-label={entry.option.label}
            aria-checked={entry.selected}
            data-rule-set-id={entry.option.ruleSetId}
            data-selected={entry.selected ? "true" : "false"}
            disabled={entry.disabled}
            onClick={() => onSelect(entry.option.ruleSetId)}
          >
            <span class="rematch-mode-option-copy">
              <strong>{entry.option.label}</strong>
              <small>{entry.option.description}</small>
            </span>
          </button>
        ))}
      </div>
      <p class="rematch-mode-note" role="note">
        更换模式后，双方需要重新确认再来一局
      </p>
    </section>
  );
};

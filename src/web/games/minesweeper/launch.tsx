import { useEffect, useRef, useState } from "preact/hooks";
import {
  getMinesweeperRuleSetId,
  type MinefieldPresetId,
} from "../../../games/minesweeper/presets";
import type {
  GameLaunchPickerProps,
  GameLaunchTarget,
} from "../types";

export type MinesweeperLaunchMode = "solo" | "race";
export type MinesweeperPreset = MinefieldPresetId;

export function resolveMinesweeperLaunch(
  mode: MinesweeperLaunchMode,
  preset: MinesweeperPreset,
): GameLaunchTarget {
  if (mode === "solo") {
    return {
      kind: "navigate",
      href: `/minesweeper?preset=${preset}`,
    };
  }
  return {
    kind: "room",
    gameType: "minesweeper",
    ruleSetId: getMinesweeperRuleSetId("race", preset),
  };
}

const PRESET_OPTIONS: ReadonlyArray<{
  id: MinesweeperPreset;
  label: string;
  detail: string;
}> = [
  { id: "small", label: "小型", detail: "9×9 · 10 雷" },
  { id: "medium", label: "中型", detail: "16×16 · 40 雷" },
  { id: "large", label: "大型", detail: "30×16 · 99 雷" },
];

/** The minesweeper-specific launch choices live with the game. */
export function MinesweeperPicker({
  creating,
  error,
  onLaunch,
  onClose,
}: GameLaunchPickerProps) {
  const [mode, setMode] = useState<MinesweeperLaunchMode>("solo");
  const [preset, setPreset] = useState<MinesweeperPreset>("small");
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  const close = () => {
    if (creating) return;
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    else onClose();
  };

  const selectedPreset = PRESET_OPTIONS.find((option) => option.id === preset);

  return (
    <dialog
      ref={dialogRef}
      class="minesweeper-picker"
      aria-labelledby="minesweeper-picker-title"
      aria-describedby="minesweeper-picker-summary"
      onCancel={(event) => {
        if (creating) event.preventDefault();
      }}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <header class="dialog-heading">
        <div>
          <p class="eyebrow">选择玩法</p>
          <h2 id="minesweeper-picker-title">扫雷</h2>
        </div>
        <button
          class="dialog-close"
          type="button"
          aria-label="关闭扫雷玩法选择"
          disabled={creating}
          onClick={close}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <form
        class="minesweeper-picker-form"
        onSubmit={(event) => {
          event.preventDefault();
          onLaunch(resolveMinesweeperLaunch(mode, preset));
        }}
      >
        <fieldset disabled={creating}>
          <legend>玩法</legend>
          <div class="choice-segments mode-segments">
            <label class="choice-segment">
              <input
                type="radio"
                name="minesweeper-mode"
                value="solo"
                checked={mode === "solo"}
                autofocus={mode === "solo"}
                onChange={() => setMode("solo")}
              />
              <span>
                <strong>单人</strong>
                <small>计时闯关</small>
              </span>
            </label>
            <label class="choice-segment">
              <input
                type="radio"
                name="minesweeper-mode"
                value="race"
                checked={mode === "race"}
                autofocus={mode === "race"}
                onChange={() => setMode("race")}
              />
              <span>
                <strong>双人竞速</strong>
                <small>同图独立对战</small>
              </span>
            </label>
          </div>
        </fieldset>

        <fieldset disabled={creating}>
          <legend>难度</legend>
          <div class="choice-segments preset-segments">
            {PRESET_OPTIONS.map((option) => (
              <label class="choice-segment" key={option.id}>
                <input
                  type="radio"
                  name="minesweeper-preset"
                  value={option.id}
                  checked={preset === option.id}
                  onChange={() => setPreset(option.id)}
                />
                <span><strong>{option.label}</strong></span>
              </label>
            ))}
          </div>
        </fieldset>

        <p id="minesweeper-picker-summary" class="picker-summary">
          <strong>{selectedPreset?.detail}</strong>
          <span>
            {mode === "solo"
              ? "本机计时，完成后记录个人最佳与排行榜。"
              : "双方各扫一张相同布局的独立棋盘，先完成者获胜。"}
          </span>
        </p>

        {error && <p class="inline-error picker-error" role="alert">{error}</p>}

        <button class="primary-button picker-submit" type="submit" disabled={creating}>
          {creating
            ? "正在创建…"
            : mode === "solo"
              ? "开始单人扫雷"
              : "创建竞速房间"}
        </button>
      </form>
    </dialog>
  );
}

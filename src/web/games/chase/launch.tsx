import { useEffect, useRef, useState } from "preact/hooks";
import { getGameManifest } from "../../../shared/game-manifest";
import type {
  GameLaunchPickerProps,
  GameLaunchTarget,
} from "../types";

export type ChaseDifficulty = "easy" | "medium" | "hard";

export function resolveChaseLaunch(
  difficulty: ChaseDifficulty,
): GameLaunchTarget {
  const ruleSetId = `chase.${difficulty}.v1`;
  const manifest = getGameManifest("chase");
  if (!manifest?.creatableRuleSetIds.includes(ruleSetId)) {
    throw new Error("unsupported_chase_difficulty");
  }
  return {
    kind: "room",
    gameType: "chase",
    ruleSetId,
  };
}

const DIFFICULTY_OPTIONS: ReadonlyArray<{
  id: ChaseDifficulty;
  label: string;
  detail: string;
}> = [
  { id: "easy", label: "简单", detail: "上限 15 轮" },
  { id: "medium", label: "中等", detail: "上限 25 轮" },
  { id: "hard", label: "困难", detail: "上限 45 轮" },
];

/** The chase map selector belongs to the chase registration. */
export function ChasePicker({
  creating,
  error,
  onLaunch,
  onClose,
}: GameLaunchPickerProps) {
  const [difficulty, setDifficulty] = useState<ChaseDifficulty>("easy");
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

  const selectedDifficulty = DIFFICULTY_OPTIONS.find(
    (option) => option.id === difficulty,
  );

  return (
    <dialog
      ref={dialogRef}
      class="minesweeper-picker chase-picker"
      aria-labelledby="chase-picker-title"
      aria-describedby="chase-picker-summary"
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
          <p class="eyebrow">选择地图</p>
          <h2 id="chase-picker-title">警察抓小偷</h2>
        </div>
        <button
          class="dialog-close"
          type="button"
          aria-label="关闭警察抓小偷地图选择"
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
          onLaunch(resolveChaseLaunch(difficulty));
        }}
      >
        <fieldset disabled={creating}>
          <legend>难度</legend>
          <div class="choice-segments preset-segments">
            {DIFFICULTY_OPTIONS.map((option) => (
              <label class="choice-segment" key={option.id}>
                <input
                  type="radio"
                  name="chase-difficulty"
                  value={option.id}
                  checked={difficulty === option.id}
                  autofocus={difficulty === option.id}
                  onChange={() => setDifficulty(option.id)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.detail}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <p id="chase-picker-summary" class="picker-summary">
          <strong>{selectedDifficulty?.label}地图 · {selectedDifficulty?.detail}</strong>
          <span>
            小偷先走，双方每次沿线走一步；警察走到小偷所在点即获胜，
            撑过回合上限则小偷获胜。
          </span>
        </p>

        {error && <p class="inline-error picker-error" role="alert">{error}</p>}

        <button class="primary-button picker-submit" type="submit" disabled={creating}>
          {creating ? "正在创建…" : "创建追逃房间"}
        </button>
      </form>
    </dialog>
  );
}

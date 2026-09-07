import { useEffect, useRef, useState } from "preact/hooks";
import type {
  GameLaunchPickerProps,
  GameLaunchTarget,
} from "../types";

export type ChineseCheckersPlayerCount = 2 | 3 | 4;

export function resolveChineseCheckersLaunch(
  playerCount: ChineseCheckersPlayerCount,
): GameLaunchTarget {
  return {
    kind: "room",
    gameType: "chinese-checkers",
    ruleSetId: `chinese-checkers.room.${playerCount}p.v1`,
  };
}

const PLAYER_OPTIONS = [2, 3, 4] as const;

/** The player-count selector belongs to the Chinese Checkers registration. */
export function ChineseCheckersPicker({
  creating,
  error,
  onLaunch,
  onClose,
}: GameLaunchPickerProps) {
  const [playerCount, setPlayerCount] = useState<ChineseCheckersPlayerCount>(2);
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

  return (
    <dialog
      ref={dialogRef}
      class="minesweeper-picker checkers-picker"
      aria-labelledby="checkers-picker-title"
      aria-describedby="checkers-picker-summary"
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
          <p class="eyebrow">选择人数</p>
          <h2 id="checkers-picker-title">跳棋</h2>
        </div>
        <button
          class="dialog-close"
          type="button"
          aria-label="关闭跳棋人数选择"
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
          onLaunch(resolveChineseCheckersLaunch(playerCount));
        }}
      >
        <fieldset disabled={creating}>
          <legend>人数</legend>
          <div class="choice-segments preset-segments">
            {PLAYER_OPTIONS.map((count) => (
              <label class="choice-segment" key={count}>
                <input
                  type="radio"
                  name="checkers-player-count"
                  value={count}
                  checked={playerCount === count}
                  onChange={() => setPlayerCount(count)}
                />
                <span>
                  <strong>{count} 人</strong>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <p id="checkers-picker-summary" class="picker-summary">
          <strong>{playerCount} 人 · 邀请联机</strong>
          <span>
            创建固定 {playerCount} 个玩家席位的房间，坐满后自动开始。
          </span>
        </p>

        {error && <p class="inline-error picker-error" role="alert">{error}</p>}

        <button class="primary-button picker-submit" type="submit" disabled={creating}>
          {creating
            ? "正在创建…"
            : `创建 ${playerCount} 人联机房间`}
        </button>
      </form>
    </dialog>
  );
}

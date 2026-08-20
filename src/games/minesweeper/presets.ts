export interface MinefieldConfig {
  width: number;
  height: number;
  mineCount: number;
}

export type MinefieldPresetId = "small" | "medium" | "large";

export const MINEFIELD_PRESETS: Readonly<
  Record<MinefieldPresetId, Readonly<MinefieldConfig>>
> = {
  small: { width: 9, height: 9, mineCount: 10 },
  medium: { width: 16, height: 16, mineCount: 40 },
  large: { width: 30, height: 16, mineCount: 99 },
};

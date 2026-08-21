import { createContext, type ComponentChildren } from "preact";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "preact/hooks";

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "ym0v0.theme";

interface ThemeContextValue {
  theme: Theme;
  setTheme(theme: Theme): void;
  toggleTheme(): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light";
}

function readStoredTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : null;
  } catch {
    // Storage can be unavailable in private browsing or hardened contexts.
    return null;
  }
}

/** Apply the theme before rendering so a page never flashes the other palette. */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/** Resolve the persisted theme, keeping the existing dark palette as default. */
export function getInitialTheme(): Theme {
  return readStoredTheme() ?? "dark";
}

export function ThemeProvider({ children }: { children: ComponentChildren }) {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);

  const setTheme = useCallback(
    (nextTheme: Theme) => setThemeState(nextTheme),
    [],
  );

  const toggleTheme = useCallback(
    () => setThemeState((current) => current === "dark" ? "light" : "dark"),
    [],
  );

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // The current page still follows the selection when persistence is blocked.
    }
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, toggleTheme }),
    [setTheme, theme, toggleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

const FALLBACK_THEME_CONTEXT: ThemeContextValue = {
  theme: "dark",
  setTheme: () => undefined,
  toggleTheme: () => undefined,
};

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext) ?? FALLBACK_THEME_CONTEXT;
}

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const nextTheme: Theme = theme === "dark" ? "light" : "dark";
  const nextThemeLabel = nextTheme === "light" ? "白天" : "黑夜";

  return (
    <button
      class="theme-toggle"
      type="button"
      aria-label={`切换到${nextThemeLabel}模式`}
      title={`切换到${nextThemeLabel}模式`}
      aria-pressed={theme === "light"}
      onClick={toggleTheme}
    >
      <span class="theme-toggle-icon" aria-hidden="true">
        {theme === "dark" ? "☀" : "☾"}
      </span>
      <span class="theme-toggle-label">{nextThemeLabel}</span>
    </button>
  );
}

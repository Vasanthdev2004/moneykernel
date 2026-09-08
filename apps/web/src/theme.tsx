import { Moon, Sun } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { Hint } from "./components/ui.tsx";

type Theme = "light" | "dark";
const STORAGE_KEY = "moneykernel-theme";

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void } | null>(null);

function initialTheme(): Theme {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#0B0E11" : "#FFFFFF");
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Theme changes still work when browser storage is unavailable.
    }
  }, [theme]);

  const value = useMemo(() => ({ theme, setTheme }), [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const nextTheme = theme === "light" ? "dark" : "light";
  const label = `Switch to ${nextTheme} theme`;

  return (
    <Hint label={label}>
      <button
        type="button"
        className={`theme-toggle${className ? ` ${className}` : ""}`}
        aria-label={label}
        title={label}
        data-testid="theme-toggle"
        onClick={() => setTheme(nextTheme)}
      >
        {theme === "light" ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}
      </button>
    </Hint>
  );
}

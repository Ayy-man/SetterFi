export const THEME_STORAGE_KEY = "setterfi:device:workspace-theme";

/** What the document actually paints. */
export type WorkspaceTheme = "light" | "dark";

/**
 * What the person chose. "system" defers to the OS, and is what the stored
 * value is missing entirely -- an absent key and an explicit "system" resolve
 * the same way, so nothing has to migrate.
 */
export type ThemePreference = WorkspaceTheme | "system";

function isWorkspaceTheme(value: string | null | undefined): value is WorkspaceTheme {
  return value === "light" || value === "dark";
}

function isThemePreference(value: string | null | undefined): value is ThemePreference {
  return isWorkspaceTheme(value) || value === "system";
}

export function readStoredTheme(): WorkspaceTheme | null {
  if (typeof window === "undefined") return null;

  try {
    const theme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isWorkspaceTheme(theme) ? theme : null;
  } catch {
    return null;
  }
}

export function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function systemTheme(): WorkspaceTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(preference: ThemePreference): WorkspaceTheme {
  return preference === "system" ? systemTheme() : preference;
}

export function storeThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // The current page still changes theme when the storage jar is unavailable.
  }
}

export function applyTheme(theme: WorkspaceTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.workspaceTheme = theme;
  root.classList.toggle("dark", theme === "dark");
}

export const THEME_BOOT_SCRIPT = `(function(){try{var stored=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var theme=stored==="light"||stored==="dark"?stored:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");var root=document.documentElement;root.dataset.theme=theme;root.dataset.workspaceTheme=theme;root.classList.toggle("dark",theme==="dark")}catch(_){}})();`;

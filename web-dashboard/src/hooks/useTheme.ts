import { useEffect, useCallback, useState } from 'react';

const STORAGE_KEY = 'thunderflow_theme';
const VALID_THEMES = ['midnight', 'twilight', 'dawn', 'sahara'] as const;
export type ThemeName = (typeof VALID_THEMES)[number];

function getStoredTheme(): ThemeName {
  const stored = localStorage.getItem(STORAGE_KEY);
  // Migrate old 'claude' key to 'sahara'
  if (stored === 'claude') {
    localStorage.setItem(STORAGE_KEY, 'sahara');
    return 'sahara';
  }
  if (stored && (VALID_THEMES as readonly string[]).includes(stored)) return stored as ThemeName;
  return 'midnight';
}

function applyTheme(theme: ThemeName): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/** Call once in App.tsx to apply the stored theme on mount. */
export function useThemeInit(): void {
  useEffect(() => {
    applyTheme(getStoredTheme());
    const handler = () => applyTheme(getStoredTheme());
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);
}

/** Call in ThemeSelector to switch themes. */
export function useThemeSwitch() {
  const [current, setCurrent] = useState<ThemeName>(getStoredTheme);

  const setTheme = useCallback((theme: ThemeName) => {
    localStorage.setItem(STORAGE_KEY, theme);
    applyTheme(theme);
    setCurrent(theme);
  }, []);

  return { setTheme, currentTheme: current };
}

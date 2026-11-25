export type ThemeMode = 'light' | 'dark';

const storageKey = 'entregaja-theme';

export function readThemePreference(): ThemeMode {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
  // O HTML de referência abre no tema claro; a preferência do usuário é respeitada depois.
  return 'light';
}

export function applyThemePreference(theme: ThemeMode): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    // The current page still adopts the selected theme for this session.
  }
}

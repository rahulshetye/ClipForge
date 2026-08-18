import { createContext, useContext, useState } from 'react';
import { light, dark } from './theme.js';

const ThemeCtx = createContext({ t: light, isDark: false, toggle: () => {} });

export function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(false);
  const t = isDark ? dark : light;
  const toggle = () => setIsDark((prev) => !prev);

  return <ThemeCtx.Provider value={{ t, isDark, toggle }}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  return useContext(ThemeCtx);
}

import { useTheme } from '../theme/ThemeContext.jsx';
import { IconSun, IconMoon } from '../icons/index.jsx';

export default function ThemeToggle() {
  const { t, isDark, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      className="w-9 h-9 rounded-xl flex items-center justify-center transition-all hover:scale-105 active:scale-95"
      style={{ background: t.muted, border: `1px solid ${t.border}`, color: isDark ? '#A5B4FC' : '#F59E0B' }}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark ? <IconSun size={17} /> : <IconMoon size={17} />}
    </button>
  );
}

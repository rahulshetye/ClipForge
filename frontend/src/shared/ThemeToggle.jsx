import { useTheme } from '../theme/ThemeContext.jsx';
import { IconSun, IconMoon } from '../icons/index.jsx';

export default function ThemeToggle() {
  const { t, isDark, toggle } = useTheme();
  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <button
      onClick={toggle}
      aria-label={label}
      title={label}
      className="group w-9 h-9 rounded-xl flex items-center justify-center overflow-hidden transition-all hover:scale-105 active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6366F1]"
      style={{ background: t.muted, border: `1px solid ${t.border}`, color: isDark ? '#A5B4FC' : '#F59E0B' }}
    >
      {/* key remounts the icon on change so it turns in instead of snapping */}
      <span key={isDark ? 'sun' : 'moon'} className="flex transition-transform duration-300 group-hover:rotate-12 motion-safe:animate-[spin_0.4s_ease-out_1]">
        {isDark ? <IconSun size={17} /> : <IconMoon size={17} />}
      </span>
    </button>
  );
}
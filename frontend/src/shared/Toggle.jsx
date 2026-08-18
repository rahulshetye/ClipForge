import { useTheme } from '../theme/ThemeContext.jsx';

export default function Toggle({ checked, onChange, disabled = false }) {
  const { t } = useTheme();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0 disabled:opacity-50"
      style={{ background: checked ? 'linear-gradient(135deg, #6366F1, #8B5CF6)' : t.mutedStrong }}
    >
      <span
        className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-200"
        style={{ transform: checked ? 'translateX(20px)' : 'translateX(0)' }}
      />
    </button>
  );
}
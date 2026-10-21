import { useTheme } from '../theme/ThemeContext.jsx';

// Same API as before: <Toggle checked onChange disabled />, where onChange
// receives the new boolean. New optional `label` gives screen readers a name
// (for example the feature it switches).
export default function Toggle({ checked, onChange, disabled = false, label }) {
  const { t } = useTheme();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6366F1]"
      style={{
        background: checked ? 'linear-gradient(135deg, #6366F1, #8B5CF6)' : t.mutedStrong,
        boxShadow: checked ? '0 2px 10px rgba(99,102,241,0.35)' : 'inset 0 1px 2px rgba(0,0,0,0.15)',
      }}
    >
      <span
        className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-md flex items-center justify-center transition-transform duration-200 motion-reduce:transition-none"
        style={{ transform: checked ? 'translateX(20px)' : 'translateX(0)' }}
        aria-hidden="true"
      >
        {/* tiny check on the thumb so state isn't communicated by color alone */}
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#6366F1" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: checked ? 1 : 0, transition: 'opacity 150ms' }}>
          <path d="M2.5 6.5l2.5 2.5 4.5-5.5" />
        </svg>
      </span>
    </button>
  );
}
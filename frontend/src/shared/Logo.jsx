import { useId } from 'react';

const DISPLAY_FONT = "'Sora', 'Inter', system-ui, sans-serif";

const SIZES = {
  sm: { box: 28, text: 'text-lg', gap: 'gap-2' },
  md: { box: 34, text: 'text-xl', gap: 'gap-2.5' },
  lg: { box: 44, text: 'text-2xl', gap: 'gap-3' },
};

// VeloAI mark: a play button with speed streaks ("Velo" = velocity).
// `iconOnly` hides the wordmark (used by the collapsed sidebar rail).
export default function Logo({ size = 'md', iconOnly = false, className = '' }) {
  const s = SIZES[size] || SIZES.md;
  // Unique gradient id per instance, so several logos on one page never clash.
  const gid = `velo-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  return (
    <div className={`flex items-center ${s.gap} ${className}`} role="img" aria-label="VeloAI">
      <svg
        width={s.box}
        height={s.box}
        viewBox="0 0 40 40"
        className="shrink-0"
        style={{ filter: 'drop-shadow(0 6px 12px rgba(99,102,241,0.35))' }}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#6366F1" />
            <stop offset="1" stopColor="#8B5CF6" />
          </linearGradient>
        </defs>
        <rect width="40" height="40" rx="11" fill={`url(#${gid})`} />
        <path d="M17 12.5v15l12-7.5z" fill="#fff" />
        <rect x="6.5" y="16.5" width="6" height="2.4" rx="1.2" fill="#fff" opacity="0.75" />
        <rect x="8.5" y="21.1" width="4" height="2.4" rx="1.2" fill="#fff" opacity="0.5" />
      </svg>

      {!iconOnly && (
        <span className={`font-extrabold tracking-tight leading-none ${s.text}`} style={{ fontFamily: DISPLAY_FONT }} aria-hidden="true">
          <span style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)', WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            Velo
          </span>
          <span style={{ color: '#06B6D4' }}>AI</span>
        </span>
      )}
    </div>
  );
}
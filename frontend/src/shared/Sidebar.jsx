import { useTheme } from '../theme/ThemeContext.jsx';
import { useAuth } from '../theme/AuthContext.jsx';
import Logo from './Logo.jsx';
import { Avatar } from './Avatar.jsx';
import { IconVideo, IconEdit, IconShare } from '../icons/index.jsx';

const DISPLAY_FONT = "'Sora', 'Inter', system-ui, sans-serif";
const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6366F1]';

// The product is a sequence: make a video, polish it, post it. The sidebar
// shows that sequence so users always know where they are and what comes next.
// People can still start at any step (for example, in the editor with their
// own footage).
const STEPS = [
  { id: 'generator', title: 'Generate', desc: 'Turn an idea into a video', Icon: IconVideo },
  { id: 'editor', title: 'Edit', desc: 'Add captions, music and polish', Icon: IconEdit },
  { id: 'publisher', title: 'Publish', desc: 'Post to all your channels', Icon: IconShare },
];

// What to suggest after each screen. Shown in the "Up next" card.
const NEXT = {
  generator: {
    title: 'Happy with your video?',
    body: 'Polish it in the editor. Already have footage? Start there instead.',
    cta: 'Open editor',
    to: 'editor',
  },
  editor: {
    title: 'Edit finished?',
    body: 'Send it to YouTube, Instagram and more in one step.',
    cta: 'Go to publisher',
    to: 'publisher',
  },
  publisher: {
    title: 'Posted everything?',
    body: 'Start your next video from a fresh idea.',
    cta: 'Make a new video',
    to: 'generator',
  },
};

function HomeIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 11l9-8 9 8M5 10v10h14V10M10 20v-6h4v6" />
    </svg>
  );
}

// `screen` is the current screen id: 'generator' | 'editor' | 'publisher'
// (or 'dashboard' / 'profile' if those screens render the sidebar too).
export default function Sidebar({ screen, onNavigate, onLogout }) {
  const { t } = useTheme();
  const { user } = useAuth();
  const displayName = user?.displayName || user?.email?.split('@')[0] || 'User';

  const currentIndex = STEPS.findIndex((s) => s.id === screen);
  const next = NEXT[screen];
  const homeActive = screen === 'dashboard';

  return (
    <aside
      className="sticky top-0 h-screen shrink-0 flex flex-col w-[72px] lg:w-64 transition-colors duration-200"
      style={{ background: t.card, borderRight: `1px solid ${t.border}` }}
      aria-label="Main navigation"
    >
      {/* Brand */}
      <div className="px-4 lg:px-5 py-5 flex items-center justify-center lg:justify-start" style={{ borderBottom: `1px solid ${t.border}` }}>
        <button onClick={() => onNavigate('dashboard')} className={`rounded-lg ${focusRing}`} aria-label="Go to home">
          <span className="lg:hidden"><Logo size="md" iconOnly /></span>
          <span className="hidden lg:block"><Logo size="md" /></span>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {/* Home */}
        <button
          onClick={() => onNavigate('dashboard')}
          aria-current={homeActive ? 'page' : undefined}
          title="Home"
          className={`w-full flex items-center justify-center lg:justify-start gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 ${focusRing}`}
          style={{
            background: homeActive ? t.pillBg : 'transparent',
            color: homeActive ? t.pillFg : t.fgMuted,
            border: `1px solid ${homeActive ? t.pillBorder : 'transparent'}`,
          }}
        >
          <HomeIcon />
          <span className="hidden lg:inline">Home</span>
        </button>

        {/* Workflow */}
        <div>
          <p className="hidden lg:block px-3 mb-2 text-xs font-semibold" style={{ color: t.fgSubtle }}>
            Your workflow
          </p>
          <ol className="relative space-y-1">
            {STEPS.map((step, i) => {
              const active = step.id === screen;
              const passed = currentIndex > i;
              const { Icon } = step;
              return (
                <li key={step.id} className="relative">
                  {/* connector to the next step */}
                  {i < STEPS.length - 1 && (
                    <span
                      className="hidden lg:block absolute left-[31px] top-[46px] w-0.5 h-[calc(100%-26px)] rounded-full"
                      style={{ background: passed ? '#6366F1' : t.border }}
                      aria-hidden="true"
                    />
                  )}
                  <button
                    onClick={() => onNavigate(step.id)}
                    aria-current={active ? 'page' : undefined}
                    title={`${step.title}: ${step.desc}`}
                    className={`relative w-full flex items-center justify-center lg:justify-start gap-3 px-3 py-2.5 rounded-xl text-left transition-all hover:opacity-90 ${focusRing}`}
                    style={{
                      background: active ? t.pillBg : 'transparent',
                      border: `1px solid ${active ? t.pillBorder : 'transparent'}`,
                    }}
                  >
                    <span
                      className="relative w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-all"
                      style={{
                        background: active ? 'linear-gradient(135deg, #6366F1, #8B5CF6)' : passed ? 'rgba(99,102,241,0.18)' : t.muted,
                        color: active ? '#fff' : passed ? t.pillFg : t.fgMuted,
                        boxShadow: active ? '0 4px 14px rgba(99,102,241,0.35)' : 'none',
                      }}
                    >
                      <Icon size={16} />
                      <span
                        className="absolute -top-1 -right-1 w-4 h-4 rounded-full text-[10px] font-bold flex items-center justify-center"
                        style={{ background: t.card, color: active ? '#6366F1' : t.fgSubtle, border: `1px solid ${active ? '#6366F1' : t.border}` }}
                        aria-hidden="true"
                      >
                        {i + 1}
                      </span>
                    </span>
                    <span className="hidden lg:block min-w-0">
                      <span className="block text-sm font-semibold leading-tight" style={{ color: active ? t.pillFg : t.fg }}>{step.title}</span>
                      <span className="block text-xs mt-0.5 leading-snug" style={{ color: t.fgSubtle }}>{step.desc}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>

        {/* Up next */}
        {next && (
          <div className="hidden lg:block rounded-2xl p-4" style={{ background: t.muted, border: `1px solid ${t.border}` }}>
            <p className="text-sm font-bold leading-snug" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>{next.title}</p>
            <p className="text-xs mt-1.5 mb-3 leading-relaxed" style={{ color: t.fgMuted }}>{next.body}</p>
            <button
              onClick={() => onNavigate(next.to)}
              className={`w-full py-2 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98] ${focusRing}`}
              style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)', boxShadow: '0 4px 14px rgba(99,102,241,0.3)' }}
            >
              {next.cta} <span aria-hidden="true">→</span>
            </button>
          </div>
        )}
      </nav>

      {/* Account */}
      <div className="p-3" style={{ borderTop: `1px solid ${t.border}` }}>
        <div className="flex items-center justify-center lg:justify-start gap-3 px-2 py-2">
          <button
            onClick={() => onNavigate('profile')}
            title="Profile"
            aria-label="Open profile"
            className={`rounded-full shrink-0 ${focusRing}`}
          >
            <Avatar size={36} />
          </button>
          <div className="hidden lg:block min-w-0 flex-1">
            <p className="text-sm font-semibold truncate" style={{ color: t.fg }}>{displayName}</p>
            <p className="text-xs truncate" style={{ color: t.fgSubtle }}>{user?.email}</p>
          </div>
        </div>
        <button
          onClick={() => onLogout?.()}
          title="Log out"
          className={`w-full mt-1 py-2 rounded-lg text-xs font-semibold transition-colors hover:bg-red-500/10 hover:text-red-400 ${focusRing}`}
          style={{ color: t.fgMuted }}
        >
          <span className="hidden lg:inline">Log out</span>
          <span className="lg:hidden" aria-hidden="true">⎋</span>
          <span className="sr-only lg:hidden">Log out</span>
        </button>
      </div>
    </aside>
  );
}
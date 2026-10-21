import { useState } from 'react';
import { useTheme } from '../theme/ThemeContext.jsx';
import { useAuth } from '../theme/AuthContext.jsx';
import Logo from '../shared/Logo.jsx';
import ThemeToggle from '../shared/ThemeToggle.jsx';
import AvatarMenu from '../shared/Avatar.jsx';
import { IconVideo, IconEdit, IconShare, IconSparkles } from '../icons/index.jsx';

// Same optional font link as LoginScreen (only needed once, in index.html).
const DISPLAY_FONT = "'Sora', 'Inter', system-ui, sans-serif";

const PROMPT_IDEAS = [
  '3 tips to stay productive while working from home',
  'The story behind the first coffee shop',
  '5 facts about the deep ocean',
];

/* ---------------- Illustrations (one per tool) ---------------- */

function GeneratorArt() {
  return (
    <svg viewBox="0 0 320 150" className="w-full h-full" aria-hidden="true">
      {/* prompt lines */}
      <rect x="28" y="40" width="108" height="9" rx="4.5" fill="rgba(255,255,255,0.55)" />
      <rect x="28" y="58" width="84" height="9" rx="4.5" fill="rgba(255,255,255,0.35)" />
      <rect x="28" y="76" width="96" height="9" rx="4.5" fill="rgba(255,255,255,0.35)" />
      <rect x="28" y="100" width="46" height="18" rx="9" fill="rgba(255,255,255,0.9)" />
      {/* arrow */}
      <path d="M150 75h34m-9-9 9 9-9 9" stroke="rgba(255,255,255,0.8)" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      {/* vertical video */}
      <rect x="206" y="14" width="84" height="122" rx="14" fill="rgba(11,16,32,0.55)" stroke="rgba(255,255,255,0.5)" strokeWidth="2" />
      <rect x="214" y="22" width="68" height="106" rx="9" fill="rgba(255,255,255,0.18)" />
      <circle cx="260" cy="48" r="9" fill="rgba(255,255,255,0.45)" />
      <path d="M214 104 Q236 84 256 98 T282 90 V128 H214Z" fill="rgba(11,16,32,0.35)" />
      <rect x="224" y="108" width="48" height="7" rx="3.5" fill="#FDE047" />
    </svg>
  );
}

function EditorArt() {
  return (
    <svg viewBox="0 0 320 150" className="w-full h-full" aria-hidden="true">
      {/* video track */}
      <rect x="24" y="26" width="64" height="22" rx="6" fill="rgba(255,255,255,0.7)" />
      <rect x="92" y="26" width="92" height="22" rx="6" fill="rgba(255,255,255,0.45)" />
      <rect x="188" y="26" width="108" height="22" rx="6" fill="rgba(255,255,255,0.6)" />
      {/* captions track */}
      <rect x="40" y="58" width="50" height="16" rx="5" fill="#FDE047" opacity="0.9" />
      <rect x="116" y="58" width="70" height="16" rx="5" fill="#FDE047" opacity="0.7" />
      <rect x="214" y="58" width="56" height="16" rx="5" fill="#FDE047" opacity="0.9" />
      {/* audio waveform */}
      {Array.from({ length: 50 }).map((_, i) => {
        const h = 6 + Math.abs(Math.sin(i * 0.55) * 20);
        return <rect key={i} x={24 + i * 5.5} y={104 - h / 2} width="3" height={h} rx="1.5" fill="rgba(255,255,255,0.55)" />;
      })}
      {/* playhead */}
      <rect x="150" y="12" width="3" height="126" rx="1.5" fill="#fff" />
      <path d="M144 10h15l-7.5 10z" fill="#fff" />
    </svg>
  );
}

function PublisherArt() {
  const targets = [
    { y: 22, c: '#FF4D4D' },
    { y: 50, c: '#E1306C' },
    { y: 78, c: '#4C8DFF' },
    { y: 106, c: '#F5F5F5' },
    { y: 134, c: '#2D9CDB' },
  ];
  return (
    <svg viewBox="0 0 320 150" className="w-full h-full" aria-hidden="true">
      <rect x="30" y="34" width="62" height="82" rx="12" fill="rgba(11,16,32,0.55)" stroke="rgba(255,255,255,0.5)" strokeWidth="2" />
      <rect x="37" y="41" width="48" height="68" rx="7" fill="rgba(255,255,255,0.22)" />
      <path d="M54 62v26l22-13z" fill="rgba(255,255,255,0.85)" />
      {targets.map((tg) => (
        <g key={tg.y}>
          <path d={`M96 75 C150 75, 170 ${tg.y}, 224 ${tg.y}`} stroke="rgba(255,255,255,0.55)" strokeWidth="2" fill="none" strokeDasharray="4 5" />
          <circle cx="240" cy={tg.y} r="11" fill="rgba(255,255,255,0.16)" stroke="rgba(255,255,255,0.4)" />
          <circle cx="240" cy={tg.y} r="5.5" fill={tg.c} />
          <rect x="258" y={tg.y - 3.5} width="34" height="7" rx="3.5" fill="rgba(255,255,255,0.4)" />
        </g>
      ))}
    </svg>
  );
}

/* ---------------- Screen ---------------- */

export default function DashboardScreen({ onNavigate, onLogout }) {
  const { t, isDark } = useTheme();
  const { user } = useAuth();
  const displayName = user?.displayName || user?.email?.split('@')[0] || 'User';
  const firstName = displayName.split(' ')[0];

  const [quickPrompt, setQuickPrompt] = useState('');

  const cards = [
    {
      id: 'generator',
      title: 'AI Generator',
      desc: 'Describe a video or an image and get a finished result with voiceover and captions.',
      cta: 'Start creating',
      icon: <IconVideo size={18} />,
      gradient: 'linear-gradient(135deg, #4F46E5, #8B5CF6)',
      glow: 'rgba(99,102,241,0.28)',
      art: <GeneratorArt />,
      tag: 'Text to video, photo',
    },
    {
      id: 'editor',
      title: 'AI Editor',
      desc: 'Upload your own footage. Trim silences, add captions, B-roll, music and effects in one pass.',
      cta: 'Edit a video',
      icon: <IconEdit size={18} />,
      gradient: 'linear-gradient(135deg, #7C3AED, #C084FC)',
      glow: 'rgba(139,92,246,0.28)',
      art: <EditorArt />,
      tag: 'Hindi, Marathi, English captions',
    },
    {
      id: 'publisher',
      title: 'Publisher',
      desc: 'Send one video to YouTube, Instagram, Facebook, Threads and LinkedIn together.',
      cta: 'Publish a video',
      icon: <IconShare size={18} />,
      gradient: 'linear-gradient(135deg, #0891B2, #38BDF8)',
      glow: 'rgba(6,182,212,0.28)',
      art: <PublisherArt />,
      tag: '5 platforms',
    },
  ];

  const steps = [
    { id: 'generator', label: 'Generate', hint: 'Idea to video' },
    { id: 'editor', label: 'Edit', hint: 'Polish with AI' },
    { id: 'publisher', label: 'Publish', hint: 'Post everywhere' },
  ];

  function startFromPrompt(e) {
    e.preventDefault();
    const text = quickPrompt.trim();
    onNavigate('generator', text ? { prompt: text } : undefined);
  }

  return (
    <div className="min-h-screen relative transition-colors duration-200" style={{ background: t.bg }}>
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -right-40 w-[520px] h-[520px] rounded-full blur-3xl" style={{ background: 'radial-gradient(circle, #6366F1, transparent)', opacity: isDark ? 0.08 : 0.1 }} />
        <div className="absolute bottom-0 -left-20 w-80 h-80 rounded-full blur-3xl" style={{ background: 'radial-gradient(circle, #06B6D4, transparent)', opacity: isDark ? 0.06 : 0.08 }} />
      </div>

      <header
        className="sticky top-0 z-30 flex items-center justify-between px-6 md:px-10 py-4"
        style={{ background: t.headerBg, backdropFilter: 'blur(12px)', borderBottom: `1px solid ${t.border}` }}
      >
        <Logo size="md" />
        <div className="flex items-center gap-3">
          <ThemeToggle />

          <AvatarMenu onNavigate={onNavigate} onLogout={onLogout} />
        </div>
      </header>

      <main className="relative z-10 max-w-6xl mx-auto px-6 pt-14 pb-20">
        {/* Hero: greeting + quick start */}
        <section className="max-w-3xl mx-auto text-center mb-14">
          <h1 className="text-3xl md:text-[44px] font-extrabold tracking-tight leading-[1.1] mb-4" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>
            What are we making today, {firstName}?
          </h1>
          <p className="text-base md:text-lg mb-8" style={{ color: t.fgMuted }}>
            Type an idea and we’ll turn it into a video. Or jump straight into editing or publishing.
          </p>

          <form
            onSubmit={startFromPrompt}
            className="rounded-2xl p-2 flex items-center gap-2 text-left"
            style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowMd }}
          >
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ml-1" style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)' }}>
              <IconSparkles size={18} className="text-white" />
            </div>
            <label htmlFor="quick-prompt" className="sr-only">Describe your video</label>
            <input
              id="quick-prompt"
              type="text"
              value={quickPrompt}
              maxLength={500}
              onChange={(e) => setQuickPrompt(e.target.value)}
              placeholder="Describe the video you want to create..."
              className="flex-1 min-w-0 text-sm md:text-base bg-transparent outline-none border-0 px-1"
              style={{ color: t.fg, background: 'transparent', boxShadow: 'none' }}
            />
            <button
              type="submit"
              className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white shrink-0 transition-all hover:opacity-90 active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6366F1]"
              style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)', boxShadow: '0 4px 16px rgba(99,102,241,0.3)' }}
            >
              Generate
            </button>
          </form>

          <div className="flex flex-wrap items-center justify-center gap-2 mt-4">
            <span className="text-xs" style={{ color: t.fgSubtle }}>Try:</span>
            {PROMPT_IDEAS.map((idea) => (
              <button
                key={idea}
                type="button"
                onClick={() => setQuickPrompt(idea)}
                className="text-xs font-medium px-3 py-1.5 rounded-full transition-all hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#6366F1]"
                style={{ background: t.pillBg, color: t.pillFg, border: `1px solid ${t.pillBorder}` }}
              >
                {idea}
              </button>
            ))}
          </div>
        </section>

        {/* Tool cards */}
        <section aria-label="Tools" className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {cards.map((card) => (
            <button
              key={card.id}
              onClick={() => onNavigate(card.id)}
              className="group text-left rounded-2xl overflow-hidden transition-all duration-300 hover:-translate-y-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6366F1]"
              style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowMd }}
              onMouseEnter={(e) => { e.currentTarget.style.boxShadow = `0 18px 48px ${card.glow}`; }}
              onMouseLeave={(e) => { e.currentTarget.style.boxShadow = t.shadowMd; }}
            >
              <div className="relative h-40 overflow-hidden" style={{ background: card.gradient }}>
                <div className="absolute inset-0 p-2">{card.art}</div>
                <div className="absolute top-3 left-3 flex items-center gap-1.5 text-xs font-semibold text-white px-2.5 py-1 rounded-full" style={{ background: 'rgba(0,0,0,0.25)', backdropFilter: 'blur(6px)' }}>
                  {card.icon} {card.tag}
                </div>
              </div>
              <div className="p-6">
                <h2 className="text-lg font-bold mb-2" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>{card.title}</h2>
                <p className="text-sm leading-relaxed mb-5" style={{ color: t.fgMuted }}>{card.desc}</p>
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold transition-all group-hover:gap-2.5" style={{ color: t.pillFg }}>
                  {card.cta} <span aria-hidden="true">→</span>
                </span>
              </div>
            </button>
          ))}
        </section>

        {/* Workflow strip */}
        <section
          className="mt-10 rounded-2xl px-6 py-5 flex flex-col md:flex-row md:items-center gap-4 md:gap-6"
          style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowSm }}
        >
          <p className="text-sm font-semibold shrink-0" style={{ color: t.fg }}>The usual flow</p>
          <ol className="flex-1 flex items-center gap-3 flex-wrap">
            {steps.map((s, i) => (
              <li key={s.id} className="flex items-center gap-3">
                <button
                  onClick={() => onNavigate(s.id)}
                  className="flex items-center gap-2.5 rounded-xl px-3 py-2 transition-all hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#6366F1]"
                  style={{ background: t.muted }}
                >
                  <span className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white" style={{ background: '#6366F1' }}>{i + 1}</span>
                  <span className="text-left">
                    <span className="block text-sm font-semibold leading-tight" style={{ color: t.fg }}>{s.label}</span>
                    <span className="block text-xs" style={{ color: t.fgSubtle }}>{s.hint}</span>
                  </span>
                </button>
                {i < steps.length - 1 && <span className="hidden sm:block w-6 h-px" style={{ background: t.border }} aria-hidden="true" />}
              </li>
            ))}
          </ol>
        </section>
      </main>
    </div>
  );
}
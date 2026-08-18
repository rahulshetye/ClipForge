import { useState, useRef, useEffect } from 'react';
import { useTheme } from '../theme/ThemeContext.jsx';
import { useAuth } from '../theme/AuthContext.jsx';
import Logo from '../shared/Logo.jsx';
import ThemeToggle from '../shared/ThemeToggle.jsx';
import { IconVideo, IconEdit, IconShare, IconSparkles } from '../icons/index.jsx';

export default function DashboardScreen({ onNavigate, onLogout }) {
  const { t, isDark } = useTheme();
  const { user } = useAuth();
  const displayName = user?.displayName || user?.email?.split('@')[0] || 'User';
  const initials = displayName.slice(0, 2).toUpperCase();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const cards = [
    {
      id: 'generator',
      title: 'AI Video Generator',
      desc: 'Transform text prompts into stunning videos in seconds using cutting-edge AI.',
      icon: <IconVideo size={36} />,
      gradient: 'linear-gradient(135deg, #6366F1, #8B5CF6)',
      glow: 'rgba(99,102,241,0.25)',
      badge: 'Most Popular',
    },
    {
      id: 'editor',
      title: 'AI Editor',
      desc: 'Edit, trim, add effects, captions and music with an AI-powered timeline.',
      icon: <IconEdit size={36} />,
      gradient: 'linear-gradient(135deg, #8B5CF6, #A78BFA)',
      glow: 'rgba(139,92,246,0.25)',
      badge: 'Pro',
    },
    {
      id: 'publisher',
      title: 'Publisher',
      desc: 'Publish and schedule content across YouTube, Instagram, TikTok and more.',
      icon: <IconShare size={36} />,
      gradient: 'linear-gradient(135deg, #06B6D4, #0EA5E9)',
      glow: 'rgba(6,182,212,0.25)',
      badge: 'Multi-Platform',
    },
  ];

  return (
    <div className="min-h-screen transition-colors duration-200" style={{ background: t.bg }}>
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div
          className="absolute -top-40 -right-40 w-[500px] h-[500px] rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, #6366F1, transparent)', opacity: isDark ? 0.08 : 0.1 }}
        />
        <div
          className="absolute bottom-0 -left-20 w-80 h-80 rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, #06B6D4, transparent)', opacity: isDark ? 0.06 : 0.08 }}
        />
      </div>

      <header
        className="relative z-10 flex items-center justify-between px-10 py-5"
        style={{ background: t.headerBg, backdropFilter: 'blur(12px)', borderBottom: `1px solid ${t.border}` }}
      >
        <Logo size="md" />
        <div className="flex items-center gap-3">
          <ThemeToggle />

          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="w-9 h-9 rounded-full bg-gradient-to-br from-[#6366F1] to-[#8B5CF6] flex items-center justify-center text-white text-sm font-bold shadow-lg transition-transform active:scale-95"
            >
              {initials}
            </button>

            {menuOpen && (
              <div
                className="absolute right-0 mt-2 w-56 rounded-xl overflow-hidden z-20"
                style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowMd }}
              >
                <div className="px-4 py-3" style={{ borderBottom: `1px solid ${t.border}` }}>
                  <p className="text-sm font-semibold truncate" style={{ color: t.fg }}>{displayName}</p>
                  <p className="text-xs truncate" style={{ color: t.fgSubtle }}>{user?.email}</p>
                </div>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onNavigate('profile');
                  }}
                  className="w-full text-left px-4 py-2.5 text-sm font-medium transition-colors"
                  style={{ color: t.fgMuted }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = t.muted)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  Profile
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onLogout?.();
                  }}
                  className="w-full text-left px-4 py-2.5 text-sm font-medium transition-colors hover:bg-red-500/10 hover:text-red-400"
                  style={{ color: t.fgMuted }}
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="relative z-10 max-w-5xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <div
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-semibold mb-5"
            style={{ background: t.pillBg, color: t.pillFg, border: `1px solid ${t.pillBorder}` }}
          >
            <IconSparkles size={14} /> AI-Powered Video Platform
          </div>
          <h1 className="text-4xl font-bold mb-3" style={{ color: t.fg }}>
            What would you like to create?
          </h1>
          <p className="text-lg" style={{ color: t.fgMuted }}>
            Choose a tool to get started with your next video project
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {cards.map((card) => (
            <div
              key={card.id}
              className="group relative rounded-2xl overflow-hidden cursor-pointer transition-all duration-300 hover:-translate-y-1"
              style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowMd }}
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow = `0 16px 48px ${card.glow}`;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow = t.shadowMd;
              }}
            >
              <div className="h-2 w-full" style={{ background: card.gradient }} />
              <div className="p-7">
                <div
                  className="w-16 h-16 rounded-2xl flex items-center justify-center text-white mb-5 shadow-lg"
                  style={{ background: card.gradient }}
                >
                  {card.icon}
                </div>
                <div className="flex items-start justify-between mb-3">
                  <h2 className="text-lg font-bold" style={{ color: t.fg }}>
                    {card.title}
                  </h2>
                  <span
                    className="text-xs font-semibold px-2.5 py-1 rounded-full ml-2 shrink-0"
                    style={{ background: t.pillBg, color: t.pillFg, border: `1px solid ${t.pillBorder}` }}
                  >
                    {card.badge}
                  </span>
                </div>
                <p className="text-sm leading-relaxed mb-7" style={{ color: t.fgMuted }}>
                  {card.desc}
                </p>
                <button
                  onClick={() => onNavigate(card.id)}
                  className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-all duration-150 hover:opacity-90 active:scale-[0.98]"
                  style={{ background: card.gradient, boxShadow: `0 4px 16px ${card.glow}` }}
                >
                  Open →
                </button>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
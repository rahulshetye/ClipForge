import { useTheme } from '../theme/ThemeContext.jsx';
import Logo from './Logo.jsx';
import { IconVideo, IconEdit, IconShare, IconSettings, IconLogout } from '../icons/index.jsx';
import { useAuth } from '../theme/AuthContext.jsx';

export default function Sidebar({ screen, onNavigate, onLogout }) {
  const { t } = useTheme();

  const items = [
    { id: 'generator', label: 'AI Video Generator', icon: <IconVideo size={18} /> },
    { id: 'editor', label: 'AI Editor', icon: <IconEdit size={18} /> },
    { id: 'publisher', label: 'Publisher', icon: <IconShare size={18} /> },
  ];

  const { user } = useAuth();
  const displayName = user?.displayName || user?.email?.split('@')[0] || 'User';
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <aside
      className="w-60 min-h-screen flex flex-col shrink-0 transition-colors duration-200"
      style={{ background: t.sidebar, borderRight: `1px solid ${t.border}` }}
    >
      <div className="p-5" style={{ borderBottom: `1px solid ${t.border}` }}>
        <Logo size="sm" />
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {items.map((item) => {
          const active = screen === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150"
              style={{
                background: active ? 'linear-gradient(135deg, rgba(99,102,241,0.15), rgba(139,92,246,0.1))' : 'transparent',
                color: active ? '#6366F1' : t.fgMuted,
                border: active ? '1px solid rgba(99,102,241,0.25)' : '1px solid transparent',
              }}
            >
              <span style={{ color: active ? '#6366F1' : t.fgSubtle }}>{item.icon}</span>
              {item.label}
            </button>
          );
        })}
      </nav>
      <div className="p-3" style={{ borderTop: `1px solid ${t.border}` }}>
        <div className="flex items-center gap-3 px-3 py-2 rounded-xl mb-2" style={{ background: t.muted }}>
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#6366F1] to-[#8B5CF6] flex items-center justify-center text-white text-xs font-bold shrink-0">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate" style={{ color: t.fg }}>{displayName}</p>
            <p className="text-xs truncate" style={{ color: t.fgSubtle }}>{user?.email}</p>
          </div>
        </div>
        <button
          onClick={onLogout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors hover:bg-red-500/10 hover:text-red-400"
          style={{ color: t.fgMuted }}
        >
          <IconLogout size={18} /> Logout
        </button>
      </div>
    </aside>
  );
}
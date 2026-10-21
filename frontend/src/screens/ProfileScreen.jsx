import { useState, useEffect, useRef } from 'react';
import { updateProfile } from 'firebase/auth';
import { useTheme } from '../theme/ThemeContext.jsx';
import { useAuth } from '../theme/AuthContext.jsx';
import Sidebar from '../shared/Sidebar.jsx';
import ThemeToggle from '../shared/ThemeToggle.jsx';
import AvatarMenu, { Avatar, useAvatar } from '../shared/Avatar.jsx';
import Spinner from '../shared/Spinner.jsx';
import { part1, part3 } from '../api.js';

const DISPLAY_FONT = "'Sora', 'Inter', system-ui, sans-serif";
const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6366F1]';

const PROVIDERS = { 'google.com': 'Google', password: 'Email and password' };

function Card({ title, hint, children, t }) {
  return (
    <section className="rounded-2xl p-6" style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowSm }}>
      <h2 className="text-base font-bold" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>{title}</h2>
      {hint && <p className="text-xs mt-1 mb-5" style={{ color: t.fgSubtle }}>{hint}</p>}
      {!hint && <div className="mb-5" />}
      {children}
    </section>
  );
}

function Msg({ kind, children }) {
  const s = kind === 'error' ? { c: '#EF4444', bg: 'rgba(239,68,68,0.1)' } : { c: '#16A34A', bg: 'rgba(34,197,94,0.12)' };
  return (
    <p role={kind === 'error' ? 'alert' : 'status'} className="text-xs rounded-lg px-3 py-2 mt-3" style={{ color: s.c, background: s.bg }}>
      {children}
    </p>
  );
}

export default function ProfileScreen({ onNavigate, onLogout }) {
  const { t } = useTheme();
  const { user, resetPassword } = useAuth();
  const { hasCustom, setPhoto, removePhoto } = useAvatar();

  const fileRef = useRef(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoMsg, setPhotoMsg] = useState(null); // { kind, text }

  const [name, setName] = useState(user?.displayName || '');
  const [nameBusy, setNameBusy] = useState(false);
  const [nameMsg, setNameMsg] = useState(null);

  const [resetMsg, setResetMsg] = useState(null);
  const [resetBusy, setResetBusy] = useState(false);

  // Real counts from your own services. A failed call just shows a dash.
  const [stats, setStats] = useState({ videos: null, images: null, posts: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [jobs, publishes] = await Promise.allSettled([part1.listJobs(), part3.listPublishes()]);
      if (cancelled) return;
      setStats({
        videos: jobs.status === 'fulfilled' ? jobs.value.filter((j) => j.videoUrl && j.status === 'done').length : null,
        images: jobs.status === 'fulfilled' ? jobs.value.filter((j) => !j.videoUrl && j.final_prompt !== undefined && j.status === 'done').length : null,
        posts: publishes.status === 'fulfilled' ? publishes.value.filter((p) => p.status === 'done').length : null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const providerIds = (user?.providerData || []).map((p) => p.providerId);
  const usesPassword = providerIds.includes('password');
  const providerLabel = providerIds.map((id) => PROVIDERS[id] || id).join(', ') || 'Unknown';

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPhotoMsg(null);
    setPhotoBusy(true);
    try {
      await setPhoto(file);
      setPhotoMsg({ kind: 'ok', text: 'Photo updated.' });
    } catch (err) {
      setPhotoMsg({ kind: 'error', text: err.message });
    } finally {
      setPhotoBusy(false);
    }
  }

  function handleRemovePhoto() {
    try {
      removePhoto();
      setPhotoMsg({ kind: 'ok', text: 'Photo removed.' });
    } catch (err) {
      setPhotoMsg({ kind: 'error', text: err.message });
    }
  }

  async function handleSaveName(e) {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || clean === (user?.displayName || '')) return;
    setNameMsg(null);
    setNameBusy(true);
    try {
      await updateProfile(user, { displayName: clean });
      setNameMsg({ kind: 'ok', text: 'Name saved. It will show across the app the next time a screen loads.' });
    } catch (err) {
      console.error('Profile update failed:', err);
      setNameMsg({ kind: 'error', text: 'We couldn’t save your name. Please try again.' });
    } finally {
      setNameBusy(false);
    }
  }

  async function handleReset() {
    setResetMsg(null);
    setResetBusy(true);
    try {
      await resetPassword(user.email);
      setResetMsg({ kind: 'ok', text: `Reset link sent to ${user.email}. Check your inbox.` });
    } catch (err) {
      console.error('Password reset failed:', err);
      setResetMsg({ kind: 'error', text: 'We couldn’t send the email. Please try again in a moment.' });
    } finally {
      setResetBusy(false);
    }
  }

  const statItems = [
    { label: 'Videos generated', value: stats.videos },
    { label: 'Images generated', value: stats.images },
    { label: 'Posts published', value: stats.posts },
  ];

  const nameDirty = name.trim() && name.trim() !== (user?.displayName || '');

  return (
    <div className="flex min-h-screen transition-colors duration-200" style={{ background: t.bg }}>
      <Sidebar screen="profile" onNavigate={onNavigate} onLogout={onLogout} />
      <div className="flex-1 flex flex-col min-w-0">
        <header
          className="flex items-center justify-between px-8 py-4 sticky top-0 z-20 transition-colors duration-200"
          style={{ background: t.headerBg, backdropFilter: 'blur(12px)', borderBottom: `1px solid ${t.border}` }}
        >
          <div>
            <h1 className="text-lg font-bold" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>Profile</h1>
            <p className="text-xs" style={{ color: t.fgSubtle }}>Your photo, name and account details</p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <AvatarMenu onNavigate={onNavigate} onLogout={onLogout} />
          </div>
        </header>

        <main className="flex-1 p-6 lg:p-8">
          <div className="max-w-2xl mx-auto space-y-5">
            {/* Activity */}
            <div className="grid grid-cols-3 gap-3">
              {statItems.map((s) => (
                <div key={s.label} className="rounded-2xl p-4" style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowSm }}>
                  <p className="text-2xl font-extrabold" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>
                    {s.value === null ? '–' : s.value}
                  </p>
                  <p className="text-xs mt-1" style={{ color: t.fgSubtle }}>{s.label}</p>
                </div>
              ))}
            </div>

            {/* Photo */}
            <Card title="Profile photo" hint="Shown in the header and sidebar. We crop it to a square." t={t}>
              <div className="flex items-center gap-5">
                <Avatar size={96} />
                <div>
                  <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={handleFile} />
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => fileRef.current?.click()}
                      disabled={photoBusy}
                      className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-60 ${focusRing}`}
                      style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)' }}
                    >
                      {photoBusy ? <><Spinner size={14} label={null} /> Uploading...</> : 'Upload new photo'}
                    </button>
                    {hasCustom && (
                      <button
                        onClick={handleRemovePhoto}
                        className={`px-4 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-80 ${focusRing}`}
                        style={{ background: t.muted, color: t.fgMuted, border: `1px solid ${t.border}` }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <p className="text-xs mt-2" style={{ color: t.fgSubtle }}>PNG, JPEG or WEBP, up to 8 MB.</p>
                </div>
              </div>
              {photoMsg && <Msg kind={photoMsg.kind}>{photoMsg.text}</Msg>}
            </Card>

            {/* Details */}
            <Card title="Your details" t={t}>
              <form onSubmit={handleSaveName} className="space-y-4">
                <div>
                  <label htmlFor="profile-name" className="text-xs font-semibold block mb-1.5" style={{ color: t.fgMuted }}>Display name</label>
                  <input
                    id="profile-name"
                    type="text"
                    value={name}
                    maxLength={60}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="How should we address you?"
                    className="w-full text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="profile-email" className="text-xs font-semibold block mb-1.5" style={{ color: t.fgMuted }}>Email</label>
                  <input id="profile-email" type="email" value={user?.email || ''} readOnly className="w-full text-sm opacity-70 cursor-not-allowed" />
                  <p className="text-xs mt-1.5" style={{ color: t.fgSubtle }}>Signed in with {providerLabel}.</p>
                </div>
                <button
                  type="submit"
                  disabled={!nameDirty || nameBusy}
                  className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50 ${focusRing}`}
                  style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)' }}
                >
                  {nameBusy ? <><Spinner size={14} label={null} /> Saving...</> : 'Save changes'}
                </button>
                {nameMsg && <Msg kind={nameMsg.kind}>{nameMsg.text}</Msg>}
              </form>
            </Card>

            {/* Security */}
            <Card title="Password" hint={usesPassword ? 'We’ll email you a link to choose a new password.' : 'You sign in with Google, so there is no password to change here.'} t={t}>
              {usesPassword && (
                <button
                  onClick={handleReset}
                  disabled={resetBusy}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-80 disabled:opacity-60 ${focusRing}`}
                  style={{ background: t.muted, color: t.fg, border: `1px solid ${t.border}` }}
                >
                  {resetBusy ? <><Spinner size={14} label={null} /> Sending...</> : 'Send password reset email'}
                </button>
              )}
              {resetMsg && <Msg kind={resetMsg.kind}>{resetMsg.text}</Msg>}
            </Card>

            {/* Session */}
            <Card title="Session" hint="Log out of VeloAI on this device." t={t}>
              <button
                onClick={() => onLogout?.()}
                className={`px-4 py-2.5 rounded-xl text-sm font-semibold transition-all hover:bg-red-500/10 ${focusRing}`}
                style={{ color: '#EF4444', border: '1px solid rgba(239,68,68,0.4)' }}
              >
                Log out
              </button>
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}
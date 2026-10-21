import { useState, useRef, useEffect, useSyncExternalStore } from 'react';
import { useTheme } from '../theme/ThemeContext.jsx';
import { useAuth } from '../theme/AuthContext.jsx';

const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6366F1]';

const ACCEPTED = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
const MAX_BYTES = 8 * 1024 * 1024;
const AVATAR_PX = 256;

/* ------------------------------------------------------------------ */
/* Tiny shared store, so the header avatar, the sidebar avatar and the  */
/* menu all update the moment the photo changes, with no context needed. */
/* The photo is cropped square, shrunk to 256px and kept in this        */
/* browser's localStorage, per user. To sync across devices later, swap */
/* `writePhoto` for an upload to Firebase Storage / a Firestore field.  */
/* ------------------------------------------------------------------ */
const listeners = new Set();
const storeKey = (id) => `veloai:avatar:${id}`;

function subscribe(cb) {
  listeners.add(cb);
  window.addEventListener('storage', cb); // other tabs
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', cb);
  };
}

function readPhoto(id) {
  try {
    return localStorage.getItem(storeKey(id));
  } catch {
    return null;
  }
}

function writePhoto(id, dataUrl) {
  try {
    if (dataUrl) localStorage.setItem(storeKey(id), dataUrl);
    else localStorage.removeItem(storeKey(id));
  } catch {
    throw new Error('Your browser couldn’t save the photo. Free up some storage and try again.');
  }
  listeners.forEach((l) => l());
}

// Centre-crops to a square and shrinks, so a 12 MB phone photo becomes ~20 KB.
async function resizeToSquare(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('We couldn’t read that image. Try a PNG, JPEG or WEBP file.'));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_PX;
    canvas.height = AVATAR_PX;
    canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
    return canvas.toDataURL('image/jpeg', 0.88);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function useAvatar() {
  const { user } = useAuth();
  const id = user?.uid || user?.email || 'anon';
  const custom = useSyncExternalStore(subscribe, () => readPhoto(id), () => null);
  const displayName = user?.displayName || user?.email?.split('@')[0] || 'User';

  async function setPhoto(file) {
    if (!ACCEPTED.includes(file.type)) throw new Error('Please choose a PNG, JPEG or WEBP image.');
    if (file.size > MAX_BYTES) throw new Error('That image is over 8 MB. Choose a smaller one.');
    writePhoto(id, await resizeToSquare(file));
  }

  return {
    // custom upload wins, then the Google account photo, then initials
    src: custom || user?.photoURL || null,
    hasCustom: Boolean(custom),
    initials: displayName.slice(0, 2).toUpperCase(),
    displayName,
    email: user?.email,
    setPhoto,
    removePhoto: () => writePhoto(id, null),
  };
}

/* ---------------- Display-only avatar (also used by the Sidebar) ---------------- */

export function Avatar({ size = 36, className = '' }) {
  const { src, initials, displayName } = useAvatar();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  return (
    <span
      className={`rounded-full overflow-hidden flex items-center justify-center text-white font-bold bg-gradient-to-br from-[#6366F1] to-[#8B5CF6] shrink-0 ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {src && !failed ? (
        <img src={src} alt={`${displayName}’s photo`} className="w-full h-full object-cover" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        <span aria-hidden="true">{initials}</span>
      )}
    </span>
  );
}

function CameraIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

/* ---------------- Header avatar with account menu ---------------- */

export default function AvatarMenu({ onNavigate, onLogout }) {
  const { t } = useTheme();
  const { hasCustom, displayName, email, setPhoto, removePhoto } = useAvatar();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const ref = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    function onDown(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const id = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(id);
  }, [notice]);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // so choosing the same file again still fires
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      await setPhoto(file);
      setNotice('Photo updated.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function handleRemove() {
    setError(null);
    try {
      removePhoto();
      setNotice('Photo removed.');
    } catch (err) {
      setError(err.message);
    }
  }

  const item = `w-full text-left px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:bg-[rgba(99,102,241,0.12)]`;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className={`rounded-full transition-transform active:scale-95 shadow-md ${focusRing}`}
      >
        <Avatar size={36} />
      </button>

      <input ref={fileRef} type="file" accept={ACCEPTED.join(',')} hidden onChange={handleFile} />

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-72 rounded-2xl overflow-hidden z-50"
          style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowLg }}
        >
          <div className="px-4 py-5 flex flex-col items-center text-center" style={{ borderBottom: `1px solid ${t.border}` }}>
            <div className="relative">
              <Avatar size={72} />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                aria-label="Change profile photo"
                title="Change photo"
                className={`absolute -bottom-1 -right-1 w-8 h-8 rounded-full flex items-center justify-center text-white transition-all hover:opacity-90 disabled:opacity-60 ${focusRing}`}
                style={{ background: '#6366F1', border: `2px solid ${t.card}` }}
              >
                <CameraIcon />
              </button>
            </div>
            <p className="text-sm font-bold mt-3 truncate max-w-full" style={{ color: t.fg }}>{displayName}</p>
            <p className="text-xs truncate max-w-full" style={{ color: t.fgSubtle }}>{email}</p>
          </div>

          <div aria-live="polite" className="px-4">
            {error && (
              <p role="alert" className="text-xs rounded-lg px-3 py-2 mt-3" style={{ color: '#EF4444', background: 'rgba(239,68,68,0.1)' }}>{error}</p>
            )}
            {notice && !error && (
              <p className="text-xs rounded-lg px-3 py-2 mt-3" style={{ color: '#16A34A', background: 'rgba(34,197,94,0.12)' }}>{notice}</p>
            )}
          </div>

          <div className="py-1.5">
            <button role="menuitem" onClick={() => fileRef.current?.click()} disabled={busy} className={`${item} flex items-center gap-2.5 disabled:opacity-60`} style={{ color: t.fg }}>
              <CameraIcon size={15} /> {busy ? 'Uploading...' : 'Change photo'}
            </button>
            {hasCustom && (
              <button role="menuitem" onClick={handleRemove} className={item} style={{ color: t.fgMuted }}>
                Remove photo
              </button>
            )}
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onNavigate('profile'); }}
              className={item}
              style={{ color: t.fgMuted }}
            >
              Profile
            </button>
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onLogout?.(); }}
              className={`${item} hover:bg-red-500/10 hover:text-red-400`}
              style={{ color: t.fgMuted }}
            >
              Log out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
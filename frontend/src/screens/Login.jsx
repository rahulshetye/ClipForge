import { useState } from 'react';
import { useTheme } from '../theme/ThemeContext.jsx';
import { useAuth } from '../theme/AuthContext.jsx';
import ThemeToggle from '../shared/ThemeToggle.jsx';
import Logo from '../shared/Logo.jsx';
import Spinner from '../shared/Spinner.jsx';
import { IconGoogle, IconMail, IconLock, IconEye, IconSparkles } from '../icons/index.jsx';

// Optional: add this once to index.html <head> for the display font.
// <link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&display=swap" rel="stylesheet">
const DISPLAY_FONT = "'Sora', 'Inter', system-ui, sans-serif";

const PIPELINE = ['Write', 'Voice', 'Caption', 'Edit', 'Publish'];

/* ------------------------------------------------------------------ */
/* Illustration: a prompt turning into a finished vertical video.      */
/* Pure CSS/SVG, no assets to load, always renders on the dark panel.  */
/* ------------------------------------------------------------------ */
function HeroIllustration() {
  return (
    <div className="relative mx-auto" style={{ width: 380, height: 420 }} aria-hidden="true">
      {/* soft stage glow */}
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-72 h-72 rounded-full blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.55), transparent 70%)' }}
      />

      {/* prompt card */}
      <div
        className="absolute left-0 top-6 w-44 rounded-2xl p-3.5"
        style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)', backdropFilter: 'blur(10px)', transform: 'rotate(-4deg)' }}
      >
        <div className="flex items-center gap-1.5 mb-2 text-[11px] font-semibold" style={{ color: '#C4B5FD' }}>
          <IconSparkles size={12} /> Your idea
        </div>
        <p className="text-[13px] leading-snug text-white/90">
          3 tips to stay productive while working from home
        </p>
        <div className="mt-3 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.12)' }}>
          <div className="h-full w-4/5 rounded-full" style={{ background: 'linear-gradient(90deg,#818CF8,#22D3EE)' }} />
        </div>
      </div>

      {/* phone / vertical video */}
      <div
        className="absolute left-1/2 top-0 -translate-x-1/2 rounded-[28px] p-2"
        style={{ width: 198, height: 352, background: '#0B1020', border: '1px solid rgba(255,255,255,0.18)', boxShadow: '0 30px 60px rgba(0,0,0,0.45)' }}
      >
        <div
          className="relative w-full h-full rounded-[22px] overflow-hidden"
          style={{ background: 'linear-gradient(160deg, #4F46E5 0%, #7C3AED 45%, #0EA5E9 100%)' }}
        >
          {/* abstract scene */}
          <svg viewBox="0 0 180 320" className="absolute inset-0 w-full h-full" preserveAspectRatio="xMidYMid slice">
            <circle cx="132" cy="78" r="26" fill="rgba(255,255,255,0.22)" />
            <path d="M0 230 Q45 180 90 215 T180 190 V320 H0Z" fill="rgba(15,23,42,0.35)" />
            <path d="M0 262 Q50 225 100 255 T180 238 V320 H0Z" fill="rgba(15,23,42,0.5)" />
            <rect x="24" y="112" width="70" height="8" rx="4" fill="rgba(255,255,255,0.35)" />
            <rect x="24" y="128" width="46" height="8" rx="4" fill="rgba(255,255,255,0.2)" />
          </svg>
          {/* captions */}
          <div className="absolute inset-x-3 bottom-14 text-center">
            <span className="inline-block text-[13px] font-extrabold text-white px-2 py-1 rounded-md" style={{ background: 'rgba(0,0,0,0.55)', fontFamily: DISPLAY_FONT }}>
              Start with the <span style={{ color: '#FDE047' }}>hardest</span> task
            </span>
          </div>
          {/* progress */}
          <div className="absolute inset-x-3 bottom-6 h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.3)' }}>
            <div className="h-full w-1/3 rounded-full bg-white" />
          </div>
        </div>
      </div>

      {/* timeline card */}
      <div
        className="absolute right-0 bottom-16 w-48 rounded-2xl p-3.5"
        style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)', backdropFilter: 'blur(10px)', transform: 'rotate(3deg)' }}
      >
        <div className="text-[11px] font-semibold mb-2" style={{ color: '#67E8F9' }}>Voiceover and music</div>
        <svg viewBox="0 0 160 36" className="w-full">
          {Array.from({ length: 32 }).map((_, i) => {
            const h = 6 + Math.abs(Math.sin(i * 0.7) * 22) + (i % 3) * 2;
            return <rect key={i} x={i * 5} y={18 - h / 2} width="3" height={h} rx="1.5" fill={i < 20 ? '#A5B4FC' : 'rgba(255,255,255,0.25)'} />;
          })}
        </svg>
        <div className="flex gap-1.5 mt-2.5">
          {['Captions', 'B-roll', 'Music'].map((c) => (
            <span key={c} className="text-[10px] font-semibold px-2 py-0.5 rounded-full text-white/85" style={{ background: 'rgba(255,255,255,0.12)' }}>
              {c}
            </span>
          ))}
        </div>
      </div>

      {/* published chip */}
      <div
        className="absolute left-4 bottom-6 flex items-center gap-2 rounded-full pl-2 pr-3.5 py-1.5 text-[12px] font-semibold text-white"
        style={{ background: 'rgba(34,197,94,0.18)', border: '1px solid rgba(34,197,94,0.45)' }}
      >
        <span className="w-4 h-4 rounded-full flex items-center justify-center text-[10px]" style={{ background: '#22C55E' }}>✓</span>
        Published to YouTube
      </div>
    </div>
  );
}

function BrandPanel() {
  return (
    <aside
      className="hidden lg:flex relative flex-col justify-between overflow-hidden p-12 xl:p-16"
      style={{ background: 'linear-gradient(155deg, #0B1020 0%, #1E1B4B 55%, #312E81 100%)' }}
    >
      <div className="absolute -bottom-32 -left-32 w-[420px] h-[420px] rounded-full blur-3xl" style={{ background: 'radial-gradient(circle, #06B6D4, transparent 70%)', opacity: 0.18 }} />

      <div className="relative z-10">
        <Logo size="md" />
      </div>

      <div className="relative z-10">
        <HeroIllustration />
      </div>

      <div className="relative z-10">
        <h2 className="text-3xl xl:text-4xl font-extrabold text-white leading-tight tracking-tight max-w-md" style={{ fontFamily: DISPLAY_FONT }}>
          From a single idea to a published video.
        </h2>
        <p className="mt-3 text-[15px] leading-relaxed max-w-md" style={{ color: 'rgba(224,231,255,0.75)' }}>
          Write a prompt, and the platform handles the script, voiceover, captions and edit. Then it posts to your channels for you.
        </p>

        <ol className="mt-7 flex items-center gap-2 flex-wrap">
          {PIPELINE.map((step, i) => (
            <li key={step} className="flex items-center gap-2">
              <span className="text-xs font-semibold px-3 py-1.5 rounded-full text-white" style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.16)' }}>
                {step}
              </span>
              {i < PIPELINE.length - 1 && <span className="w-3 h-px" style={{ background: 'rgba(255,255,255,0.35)' }} />}
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
}

export default function LoginScreen() {
  const { t } = useTheme();
  const { login, signup, loginWithGoogle, resetPassword } = useAuth();

  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [resetSent, setResetSent] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setResetSent(false);
    setLoading(true);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await signup(email, password);
      }
    } catch (err) {
      setError(friendlyError(err.code));
      console.error('Auth error:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogle() {
    setError(null);
    setLoading(true);
    try {
      await loginWithGoogle();
    } catch (err) {
      setError(friendlyError(err.code));
      console.error('Auth error:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotPassword() {
    if (!email) {
      setError('Enter your email above first, then click “Forgot password?”');
      return;
    }
    setError(null);
    try {
      await resetPassword(email);
      setResetSent(true);
    } catch (err) {
      setError(friendlyError(err.code));
      console.error('Auth error:', err);
    }
  }

  function friendlyError(code) {
    const map = {
      'auth/invalid-email': 'That email address looks invalid.',
      'auth/user-not-found': 'No account found with that email.',
      'auth/wrong-password': 'Incorrect password.',
      'auth/invalid-credential': 'Incorrect email or password.',
      'auth/email-already-in-use': 'An account already exists with that email.',
      'auth/weak-password': 'Password should be at least 6 characters.',
      'auth/popup-closed-by-user': 'Google sign-in was closed before completing.',
    };
    return map[code] || 'Something went wrong. Please try again.';
  }

  const isLogin = mode === 'login';

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.05fr_1fr] transition-colors duration-200" style={{ background: t.bg }}>
      <BrandPanel />

      <main className="relative flex items-center justify-center px-6 py-12">
        <div className="absolute top-5 right-5">
          <ThemeToggle />
        </div>

        {/* soft glow, kept very light so the form stays the focus */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden lg:hidden">
          <div className="absolute -top-40 -right-40 w-[460px] h-[460px] rounded-full blur-3xl" style={{ background: 'radial-gradient(circle, #6366F1, transparent)', opacity: 0.1 }} />
        </div>

        <div className="relative z-10 w-full max-w-[400px]">
          <div className="lg:hidden flex justify-center mb-8">
            <Logo size="lg" />
          </div>

          <h1 className="text-[28px] font-extrabold tracking-tight mb-2" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>
            {isLogin ? 'Welcome back' : 'Create your account'}
          </h1>
          <p className="text-[15px] mb-8" style={{ color: t.fgMuted }}>
            {isLogin ? 'Log in to pick up your projects where you left off.' : 'Turn your first idea into a video in a few minutes.'}
          </p>

          <button
            type="button"
            onClick={handleGoogle}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2.5 py-3 rounded-xl text-sm font-semibold mb-5 transition-all hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6366F1] disabled:opacity-60"
            style={{ background: t.card, border: `1px solid ${t.border}`, color: t.fg, boxShadow: t.shadowSm }}
          >
            <IconGoogle size={18} /> Continue with Google
          </button>

          <div className="flex items-center gap-3 mb-5" role="separator">
            <div className="flex-1 h-px" style={{ background: t.border }} />
            <span className="text-xs" style={{ color: t.fgSubtle }}>or use your email</span>
            <div className="flex-1 h-px" style={{ background: t.border }} />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4" noValidate={false}>
            <div>
              <label htmlFor="auth-email" className="text-xs font-semibold block mb-1.5" style={{ color: t.fgMuted }}>
                Email
              </label>
              <div className="relative">
                <IconMail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: t.fgSubtle }} />
                <input
                  id="auth-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full pl-9 text-sm"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="auth-password" className="text-xs font-semibold" style={{ color: t.fgMuted }}>
                  Password
                </label>
                {isLogin && (
                  <button
                    type="button"
                    onClick={handleForgotPassword}
                    className="text-xs font-semibold hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#6366F1] rounded"
                    style={{ color: t.pillFg }}
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <div className="relative">
                <IconLock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: t.fgSubtle }} />
                <input
                  id="auth-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={6}
                  autoComplete={isLogin ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isLogin ? 'Your password' : 'At least 6 characters'}
                  className="w-full pl-9 pr-10 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-md transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#6366F1]"
                  style={{ color: showPassword ? t.pillFg : t.fgSubtle }}
                >
                  <IconEye size={16} />
                </button>
              </div>
            </div>

            <div aria-live="polite">
              {resetSent && (
                <p className="text-xs rounded-lg px-3 py-2" style={{ color: '#16A34A', background: 'rgba(34,197,94,0.1)' }}>
                  Password reset email sent. Check your inbox.
                </p>
              )}
              {error && (
                <p role="alert" className="text-xs rounded-lg px-3 py-2" style={{ color: '#EF4444', background: 'rgba(239,68,68,0.1)' }}>
                  {error}
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6366F1] disabled:opacity-60"
              style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)', boxShadow: '0 6px 20px rgba(99,102,241,0.35)' }}
            >
              {loading ? <Spinner /> : isLogin ? 'Log in' : 'Create account'}
            </button>
          </form>

          <p className="text-sm text-center mt-8" style={{ color: t.fgMuted }}>
            {isLogin ? 'New here? ' : 'Already have an account? '}
            <button
              type="button"
              onClick={() => {
                setMode(isLogin ? 'signup' : 'login');
                setError(null);
                setResetSent(false);
              }}
              className="font-semibold hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#6366F1] rounded"
              style={{ color: t.pillFg }}
            >
              {isLogin ? 'Create an account' : 'Log in'}
            </button>
          </p>
        </div>
      </main>
    </div>
  );
}
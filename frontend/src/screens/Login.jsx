import { useState } from 'react';
import { useTheme } from '../theme/ThemeContext.jsx';
import { useAuth } from '../theme/AuthContext.jsx';
import ThemeToggle from '../shared/ThemeToggle.jsx';
import Logo from '../shared/Logo.jsx';
import Spinner from '../shared/Spinner.jsx';
import { IconGoogle, IconMail, IconLock } from '../icons/index.jsx';

export default function LoginScreen() {
  const { t } = useTheme();
  const { login, signup, loginWithGoogle, resetPassword } = useAuth();

  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [resetSent, setResetSent] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
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
      setError('Enter your email above first, then click "Forgot password?"');
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

  return (
    <div className="min-h-screen flex items-center justify-center relative" style={{ background: t.bg }}>
      <div className="absolute top-5 right-5">
        <ThemeToggle />
      </div>

      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div
          className="absolute -top-40 -right-40 w-[500px] h-[500px] rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, #6366F1, transparent)', opacity: 0.1 }}
        />
        <div
          className="absolute bottom-0 -left-20 w-80 h-80 rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, #06B6D4, transparent)', opacity: 0.08 }}
        />
      </div>

      <div
        className="relative z-10 w-full max-w-sm rounded-2xl p-8"
        style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowLg }}
      >
        <div className="flex justify-center mb-6">
          <Logo size="lg" />
        </div>

        <h1 className="text-xl font-bold text-center mb-1" style={{ color: t.fg }}>
          {mode === 'login' ? 'Welcome back' : 'Create your account'}
        </h1>
        <p className="text-sm text-center mb-6" style={{ color: t.fgMuted }}>
          {mode === 'login' ? 'Log in to keep creating' : 'Start generating videos in minutes'}
        </p>

        <button
          onClick={handleGoogle}
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold mb-4 transition-all hover:opacity-90 disabled:opacity-60"
          style={{ background: t.muted, border: `1px solid ${t.border}`, color: t.fg }}
        >
          <IconGoogle size={18} /> Continue with Google
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="flex-1 h-px" style={{ background: t.border }} />
          <span className="text-xs" style={{ color: t.fgSubtle }}>or</span>
          <div className="flex-1 h-px" style={{ background: t.border }} />
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="relative">
            <IconMail size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: t.fgSubtle }} />
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full pl-9 text-sm"
            />
          </div>
          <div className="relative">
            <IconLock size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: t.fgSubtle }} />
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full pl-9 text-sm"
            />
          </div>

          {mode === 'login' && (
            <button
              type="button"
              onClick={handleForgotPassword}
              className="text-xs font-medium block ml-auto"
              style={{ color: t.pillFg }}
            >
              Forgot password?
            </button>
          )}

          {resetSent && (
            <p className="text-xs" style={{ color: '#22C55E' }}>Password reset email sent -- check your inbox.</p>
          )}
          {error && <p className="text-xs" style={{ color: '#EF4444' }}>{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
            style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)', boxShadow: '0 4px 16px rgba(99,102,241,0.3)' }}
          >
            {loading ? <Spinner /> : mode === 'login' ? 'Log in' : 'Sign up'}
          </button>
        </form>

        <p className="text-sm text-center mt-6" style={{ color: t.fgMuted }}>
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <button
            onClick={() => {
              setMode(mode === 'login' ? 'signup' : 'login');
              setError(null);
              setResetSent(false);
            }}
            className="font-semibold"
            style={{ color: t.pillFg }}
          >
            {mode === 'login' ? 'Sign up' : 'Log in'}
          </button>
        </p>
      </div>
    </div>
  );
}
import { useState } from 'react';
import { ThemeProvider } from './theme/ThemeContext.jsx';
import { AuthProvider, useAuth } from './theme/AuthContext.jsx';
import LoginScreen from './screens/Login.jsx';
import DashboardScreen from './screens/Dashboard.jsx';
import GeneratorScreen from './screens/Generator.jsx';
import EditorScreen from './screens/Editor.jsx';
import PublisherScreen from './screens/Publisher.jsx';

function AppContent() {
  const { user, loading, logout } = useAuth();
  const [screen, setScreen] = useState('dashboard');

  const handleNavigate = (screenId, _payload) => {
    setScreen(screenId);
  };

  const handleLogout = async () => {
    try {
      await logout();
      setScreen('dashboard'); // reset so the next login lands on dashboard, not wherever they were
    } catch (err) {
      console.error('Logout failed:', err);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  return (
    <>
      {screen === 'dashboard' && <DashboardScreen onNavigate={handleNavigate} onLogout={handleLogout} />}
      {screen === 'generator' && <GeneratorScreen onNavigate={handleNavigate} onLogout={handleLogout} />}
      {screen === 'editor' && <EditorScreen onNavigate={handleNavigate} onLogout={handleLogout} />}
      {screen === 'publisher' && <PublisherScreen onNavigate={handleNavigate} onLogout={handleLogout} />}
    </>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ThemeProvider>
  );
}
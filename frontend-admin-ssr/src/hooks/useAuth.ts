import { useState, useEffect } from 'react';

export function useAuth() {
  const [auth, setAuth] = useState({ user: null, token: '' });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('auth');
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          setAuth({ user: parsed.user || null, token: parsed.token || '' });
        } catch {
          setAuth({ user: null, token: '' });
        }
      }
    }
  }, []);

  return {
    user: auth.user,
    token: auth.token,
    logout: () => {
      setAuth({ user: null, token: '' });
      if (typeof window !== 'undefined') {
        localStorage.removeItem('auth');
      }
    },
  };
}

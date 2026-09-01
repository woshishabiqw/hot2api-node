import { createContext, useContext, useState, useEffect } from 'react';
import axios from 'axios';
import api from '../lib/api';

const AuthContext = createContext({});

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    console.log('[Auth] init check, token exists:', !!token);
    if (token) {
      api.get('/user/profile')
        .then((res) => {
          console.log('[Auth] profile loaded, user:', res.data?.username);
          setUser(res.data);
        })
        .catch((err) => {
          console.log('[Auth] profile failed:', err.response?.status, err.response?.data);
          localStorage.removeItem('token');
          setUser(null);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  // Use bare axios for login to avoid global interceptor refreshing page on 401
  const login = async (credentials) => {
    const { username, password, captchaToken, captchaCode } = credentials || {};
    console.log('[Auth] login attempt:', username);
    const res = await axios.post('/api/auth/login', {
      username,
      password,
      captchaToken,
      captchaCode,
    });
    console.log('[Auth] login response token?', !!res.data?.token, 'user?', !!res.data?.user);
    localStorage.setItem('token', res.data?.token);
    setUser(res.data?.user);
    return res.data;
  };

  const logout = () => {
    localStorage.removeItem('token');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

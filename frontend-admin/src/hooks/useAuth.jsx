import { createContext, useContext, useState, useEffect } from 'react';
import axios from 'axios';
import api from '../lib/api';

const AuthContext = createContext({});

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      api.get('/user/profile')
        .then((res) => setUser(res.data))
        .catch(() => {
          localStorage.removeItem('token');
          setUser(null);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  // Use bare axios for login to avoid global interceptor refreshing page on 401
  const login = async (username, password) => {
    const res = await axios.post('/api/auth/login', { username, password });
    localStorage.setItem('token', res.data?.token);
    setUser(res.data?.user);
    return res.data;
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('second_auth_token');
    localStorage.removeItem('payment_auth_token');

    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, token: localStorage.getItem('token') || '' }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

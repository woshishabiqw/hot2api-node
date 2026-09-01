import { useState, useEffect } from 'react';

export function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('theme');
      const system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      setTheme((stored as 'light' | 'dark') || system);
    }
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('theme', theme);
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }
  }, [theme]);

  return { theme, setTheme };
}

import { useState } from 'react';

const KEY = 'bh_theme';
const isDark = () => document.documentElement.classList.contains('dark');

// The saved choice wins; otherwise follow the system. index.html applies it before first paint to avoid a flash.
export function ThemeButton({ className = '' }: { className?: string }) {
  const [dark, setDark] = useState(isDark());
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem(KEY, next ? 'dark' : 'light'); } catch { /* private mode: not saved */ }
    setDark(next);
  };
  return (
    <button className={className} onClick={toggle} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title={dark ? 'Light mode' : 'Dark mode'}>
      {dark ? '☀' : '☾'}
    </button>
  );
}

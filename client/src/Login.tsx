/* ────────────────────────────────────────────────
 * Login.tsx • панорамный Minecraft‑логин (v3)
 * ─────────────────────────────────────────────── */
import React, { useState } from 'react';
import './login.css';

const API = 'http://89.104.67.130:4000';

export default function Login({ onAuth }: { onAuth: (u: string, t: string) => void }) {
  const [mode, setMode]     = useState<'login'|'register'>('login');
  const [username, setUser] = useState('');
  const [password, setPass] = useState('');
  const [error, setErr]     = useState<string|null>(null);

  async function submit() {
    setErr(null);
    try {
      const res = await fetch(`${API}/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password })
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      const { accessToken } = await res.json();
      onAuth(username, accessToken);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <div className="mc-scene">
      {/* 📸 слой-бэкграунд, который «гуляет» */}
      <div className="mc-parallax" />

      <div className="mc-login-card">
        <h1 className="mc-title">
          FlexCraft — {mode === 'login' ? 'Вход' : 'Регистрация'}
        </h1>

        <input
          className="mc-input"
          placeholder="Никнейм"
          value={username}
          onChange={e => setUser(e.target.value)}
        />
        <input
          className="mc-input"
          type="password"
          placeholder="Пароль"
          value={password}
          onChange={e => setPass(e.target.value)}
        />

        {error && <p className="mc-error">{error}</p>}

        <button className="mc-btn" onClick={submit}>
          {mode === 'login' ? 'Войти' : 'Создать аккаунт'}
        </button>

        <span
          className="mc-switch"
          onClick={() => setMode(m => (m === 'login' ? 'register' : 'login'))}
        >
          {mode === 'login'
            ? 'Нет аккаунта? Регистрация'
            : 'Уже есть? Войти'}
        </span>
      </div>
    </div>
  );
}

/*  Login.tsx — fixed 20 Jul 2025
 *  • tg:// → веб‑fallback, работает без установленного Telegram Desktop
 *  • мелкие тип‑фиксы и чистка useEffect
 */
import React, {
  useState, useEffect, FC, useRef, useCallback,
} from 'react';
import './login.css';

/* ─────────── backend URL ─────────── */
function getBackendUrl(): string {
  const env =
    // Vite
    (import.meta as any)?.env?.VITE_BACKEND_URL ||
    // Electron + webpack
    (typeof process !== 'undefined' ? process.env?.VITE_BACKEND_URL : undefined);

  if (env) return env;

  /* если нет ENV → используем протокол текущей страницы */
  const proto =
    typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'https' : 'http';

  return `${proto}://89.104.67.130:4000`;
}
const API = getBackendUrl();

/* ─────────── helpers ─────────── */
async function readJsonSafe(res: Response) {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      /* ignore */ /* fall‑through */
    }
  }
  return { error: await res.text() };
}

/** Открывает tg://, а при отсутствии клиента — web.telegram.org */
function openTelegram(tgLink: string, webLink: string) {
  const api = (window as any).electron;

  /* ── Electron shell ‑ два вызова: tg://, затем web‑link резервом ── */
  if (api?.openExternal) {
    api.openExternal(tgLink);
    setTimeout(() => api.openExternal(webLink), 1500);
    return;
  }

  /* ── Обычный браузер ── */
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = tgLink;
  document.body.appendChild(iframe);

  const fallback = setTimeout(() => {
    window.open(webLink, '_blank', 'noopener,noreferrer');
    document.body.removeChild(iframe);
  }, 1000);

  /* если Telegram Desktop установится/откроется — вкладка теряет фокус */
  window.addEventListener(
    'blur',
    () => {
      clearTimeout(fallback);
      document.body.removeChild(iframe);
    },
    { once: true },
  );
}

/* ─────────── component ─────────── */
interface Props {
  onAuth: (user: string, token: string) => void;
}
type Mode = 'login' | 'register';
type TgState = 'idle' | 'waiting' | 'success' | 'error';

const DEFAULT_TTL_SEC = 15 * 60;

const Login: FC<Props> = ({ onAuth }) => {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUser] = useState('');
  const [password, setPass] = useState('');
  const [error, setErr] = useState<string | null>(null);

  const [tgState, setTg] = useState<TgState>('idle');
  const [nonce, setNonce] = useState<string | null>(null);
  const [ttlSec, setTtl] = useState<number>(DEFAULT_TTL_SEC);

  const polls = useRef(0);
  const ctrl = useRef<AbortController | null>(null);
  const timeout = useRef<NodeJS.Timeout | null>(null);

  /* ─────────── login ─────────── */
  const submitLogin = async () => {
    setErr(null);
    try {
      const r = await fetch(`${API}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      });
      const data = await readJsonSafe(r);
      if (!r.ok) throw new Error(data.error ?? r.statusText);
      onAuth(username, data.accessToken);
    } catch (e: any) {
      setErr(`Ошибка: ${e.message ?? 'неизвестная'}`);
    }
  };

  /* ─────────── TG flow ─────────── */
  const startTgFlow = useCallback(async () => {
    setErr(null);
    setTg('idle');
    try {
      const r = await fetch(`${API}/api/auth/tg/register_link`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await readJsonSafe(r);
      if (!r.ok) throw new Error(data.error ?? r.statusText);

      /*  tg:// + fallback на web.telegram.org  */
      openTelegram(data.tg, data.web);

      setNonce(data.nonce);
      setTtl(Number(data.ttl ?? DEFAULT_TTL_SEC));
      setTg('waiting');
    } catch (e: any) {
      setErr(e.message);
      setTg('error');
    }
  }, []);

  /* ─────────── polling ─────────── */
  useEffect(() => {
    if (tgState !== 'waiting' || !nonce) return () => {};

    ctrl.current?.abort();
    clearTimeout(timeout.current as any);
    polls.current = 0;

    ctrl.current = new AbortController();
    let alive = true;
    const started = Date.now();

    const poll = async (delay: number) => {
      if (!alive) return;
      timeout.current = setTimeout(async () => {
        try {
          const r = await fetch(`${API}/api/auth/tg/poll?nonce=${nonce}`, {
            signal: ctrl.current!.signal,
            credentials: 'include',
          });

          if (r.status === 404) {
            polls.current += 1;

            if (Date.now() - started > ttlSec * 1e3) {
              setErr('Время истекло. Начните заново.');
              setTg('error');
              alive = false;
              return;
            }

            return poll(Math.min(delay * 1.5, 30_000));
          }

          const data = await readJsonSafe(r);
          if (!r.ok) throw new Error(data.error ?? r.statusText);

          setTg('success');
          onAuth(data.username, data.accessToken);
          alive = false;
        } catch (e: any) {
          if (!alive || ctrl.current!.signal.aborted) return;
          setErr(
            e.message.includes('Failed to fetch')
              ? 'Нет подключения к серверу'
              : e.message,
          );
          setTg('error');
          alive = false;
        }
      }, delay);
    };

    poll(2000);

    return () => {
      alive = false;
      ctrl.current?.abort();
      clearTimeout(timeout.current as any);
      ctrl.current = null;
    };
  }, [tgState, nonce, ttlSec, onAuth]);

  const isLogin = mode === 'login';

  /* ─────────── UI ─────────── */
  return (
    <div className="mc-scene">
      <div className="panorama" aria-hidden="true" />

      <form
        className="mc-login-card"
        onSubmit={(e) => {
          e.preventDefault();
          isLogin ? submitLogin() : startTgFlow();
        }}
        aria-label={isLogin ? 'Форма входа' : 'Форма регистрации'}
      >
        <h1 className="mc-title">
          FlexCraft&nbsp;—&nbsp;{isLogin ? 'Вход' : 'Регистрация'}
        </h1>

        {isLogin && (
          <>
            <label className="sr-only" htmlFor="login-user">
              Никнейм
            </label>
            <input
              id="login-user"
              className="mc-input"
              value={username}
              onChange={(e) => setUser(e.target.value)}
              placeholder="Никнейм"
              required
            />

            <label className="sr-only" htmlFor="login-pass">
              Пароль
            </label>
            <input
              id="login-pass"
              className="mc-input"
              type="password"
              value={password}
              onChange={(e) => setPass(e.target.value)}
              placeholder="Пароль"
              required
            />
          </>
        )}

        {!isLogin && (
          <p className="mc-info">
            Нажмите кнопку — бот откроется в Telegram, заполните ник и пароль.
          </p>
        )}

        {error && (
          <p className="mc-error" role="alert">
            {error}
          </p>
        )}

        {isLogin ? (
          <button type="submit" className="mc-btn">
            Войти
          </button>
        ) : (
          <button
            type="button"
            className="mc-btn mc-btn-tg"
            onClick={startTgFlow}
            disabled={tgState === 'waiting'}
          >
            {tgState === 'waiting' ? 'Ожидание…' : 'Регистрация через Telegram'}
          </button>
        )}

        <span
          className="mc-switch"
          onClick={() => {
            setMode(isLogin ? 'register' : 'login');
            setErr(null);
          }}
        >
          {isLogin ? 'Нет аккаунта? Регистрация' : 'Уже есть? Войти'}
        </span>
      </form>
    </div>
  );
};

export default Login;

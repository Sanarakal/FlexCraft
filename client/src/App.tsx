import React, { useEffect, useState, useRef } from 'react';
import flipTarget from './assets/flip-target.png';
import './App.css';

/* ───── types ───── */
interface Server {
  label: string;
  type: 'vanilla' | 'modded';
  ip: string;
  port: number;
}
interface DlEvt {
  tag: string;
  pct?: number;
}

/* ───── constants ───── */
const API = 'http://89.104.67.130:4000';
const tagLabel: Record<string, string> = {
  java: 'Установка Java',
  forge: 'Установка NeoForge',
  procdep: 'Загрузка библиотек',
  minecraft: 'Загрузка ресурсов Minecraft',
};
const visibleTags = new Set(Object.keys(tagLabel));
const SHOW_DELAY = 1000; // мс – сколько держать тишину, прежде чем показать полосу

/* ───── helpers ───── */
function aggregateProgress(map: Record<string, number>) {
  const active = Object.entries(map);
  if (active.length === 0) return null;
  const pct = Math.round(active.reduce((s, [, v]) => s + v, 0) / active.length);
  return { pct, tags: active.map(([t]) => t) };
}

export default function App() {
  /* ───── state ───── */
  const [username, setUsername] = useState('');
  const [servers, setServers] = useState<Server[]>([]);
  const [sel, setSel] = useState(0);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('⏳ Проверка серверов…');
  const [dl, setDl] = useState<Record<string, number>>({});
  const [tiles, setTiles] = useState<React.ReactElement | null>(null);
  const [flipping, setFlipping] = useState(false);

  const sceneRef = useRef<HTMLDivElement>(null);

  /* ───── загрузка серверов ───── */
  useEffect(() => {
    (async () => {
      try {
        const [van, mod] = await Promise.all([
          fetch(`${API}/api/server-info?type=vanilla`).then((r) => r.json()),
          fetch(`${API}/api/server-info?type=modded`).then((r) => r.json()),
        ]);
        setServers([
          { label: 'Ванильный сервер', type: 'vanilla', ...van },
          { label: 'Модовый сервер (Forge)', type: 'modded', ...mod },
        ]);
        setReady(true);
        setStatus('✅ Серверы доступны');
      } catch {
        setStatus('❌ Серверы недоступны');
      }
    })();
  }, []);

  /* ───── IPC прогресс ───── */
  useEffect(() => {
    const startAt = new Map<string, number>();
    const timers = new Map<string, NodeJS.Timeout>();

    const ensureVisible = (tag: string) => {
      if (!visibleTags.has(tag)) return false;
      if (timers.has(tag)) {
        clearTimeout(timers.get(tag)!);
        timers.delete(tag);
      }
      return true;
    };

    const commit = (tag: string, pct: number) => {
      if (!ensureVisible(tag)) return;
      setDl((p) => ({ ...p, [tag]: pct }));
    };

    const onStart = (_: unknown, e: DlEvt) => {
      if (!visibleTags.has(e.tag)) return;
      startAt.set(e.tag, Date.now());
      // покажем «0 %» только если скачивание не закончится за SHOW_DELAY
      timers.set(
        e.tag,
        setTimeout(() => {
          commit(e.tag, 0);
        }, SHOW_DELAY),
      );
    };

    const onProg = (_: unknown, e: DlEvt) => {
      if (!Number.isFinite(e.pct) || !visibleTags.has(e.tag)) return;
      const show = () => commit(e.tag, Math.max(0, Math.min(100, Math.round(e.pct!))));
      if (Date.now() - (startAt.get(e.tag) ?? 0) >= SHOW_DELAY) show();
      else {
        // если прогресс пришёл раньше таймаута – просто ждём; таймаут потом вызовет commit(0), а следующий вызов прогресса подхватит
      }
    };

    const onDone = (_: unknown, e: DlEvt) => {
      if (!visibleTags.has(e.tag)) return;
      // отменяем возможный запланированный «0 %»
      if (timers.has(e.tag)) {
        clearTimeout(timers.get(e.tag)!);
        timers.delete(e.tag);
      }
      // если полосу так и не отрисовали за SHOW_DELAY, то и не будем – всё прошло мгновенно
      if (!dl[e.tag]) return;
      commit(e.tag, 100);
    };

    window.electron.on('download-start', onStart);
    window.electron.on('download-progress', onProg);
    window.electron.on('download-done', onDone);
    return () => {
      window.electron.off('download-start', onStart as any);
      window.electron.off('download-progress', onProg as any);
      window.electron.off('download-done', onDone as any);
      timers.forEach((t) => clearTimeout(t));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dl]);

  /* ───── play ───── */
  const play = async () => {
    if (!username.trim()) {
      setStatus('❌ Введите ник');
      return;
    }
    setDl({});

    // Шаг 0: скрин
    await document.fonts.ready;
    const b64 = await window.electron.snapshot();
    const shotURL = 'data:image/png;base64,' + b64;
    const img = new Image();
    await new Promise((res) => {
      img.onload = res;
      img.src = shotURL;
    });
    const dpr = window.devicePixelRatio || 1;
    const W = img.width / dpr;
    const H = img.height / dpr;

    // Шаг 1: запуск MC
    setStatus('⏳ Запуск Minecraft…');
    const srv = servers[sel];
    await window.electron.invoke('launch-minecraft', {
      username,
      mode: srv.type,
      server: { name: srv.label, ip: srv.ip, port: srv.port },
    });

    // Шаг 2: плитки
    const ROWS = 10,
      COLS = 15,
      DUR = 650,
      DEL = 20;
    const baseCW = Math.floor(W / COLS),
      baseCH = Math.floor(H / ROWS);
    const extraW = W - baseCW * COLS,
      extraH = H - baseCH * ROWS;
    const colW = Array.from({ length: COLS }, (_, c) => baseCW + (c < extraW ? 1 : 0));
    const rowH = Array.from({ length: ROWS }, (_, r) => baseCH + (r < extraH ? 1 : 0));
    const sum = (a: number[], n: number) => a.slice(0, n).reduce((s, v) => s + v, 0);
    const order = Array.from({ length: ROWS * COLS }, (_, i) => i).sort(() => Math.random() - 0.5);

    setTiles(
      <div className="tiles-wrapper">
        {order.map((idx, seq) => {
          const r = ~~(idx / COLS),
            c = idx % COLS;
          const w = colW[c],
            h = rowH[r];
          const left = sum(colW, c),
            top = sum(rowH, r);
          return (
            <div
              key={idx}
              className="piece"
              style={{
                width: w,
                height: h,
                left,
                top,
                animationDelay: `${seq * DEL}ms`,
                animationDuration: `${DUR}ms`,
              }}
            >
              <div
                className="face front"
                style={{
                  backgroundImage: `url(${shotURL})`,
                  backgroundSize: `${W}px ${H}px`,
                  backgroundPosition: `-${left}px -${top}px`,
                }}
              />
              <div
                className="face back"
                style={{
                  backgroundImage: `url(${flipTarget})`,
                  backgroundSize: `${W}px ${H}px`,
                  backgroundPosition: `-${left}px -${top}px`,
                }}
              />
            </div>
          );
        })}
      </div>,
    );

    // Шаг 3: закрываем окно после анимации
    setFlipping(true);
    const flipTime = ROWS * COLS * DEL + DUR + 200;
    setTimeout(() => window.electron.invoke('close-window'), flipTime);
  };

  /* ───── render ───── */
  const combined = aggregateProgress(dl);
  const showLoader = combined && combined.pct < 100;

  return (
    <div className="app-container" ref={sceneRef}>
      {tiles}

      {showLoader && (
        <div className="loader-card" style={{ visibility: flipping ? 'hidden' : 'visible' }}>
          <div className="loader-block">
            <h2>
              {combined!.tags.length === 1 ? tagLabel[combined!.tags[0]] : 'Загрузка файлов'}
            </h2>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${combined!.pct}%` }} />
            </div>
            <span>{combined!.pct}%</span>
          </div>
        </div>
      )}

      <div className="content" style={{ visibility: flipping ? 'hidden' : 'visible' }}>
        <h1 className="logo">SexCraft Launcher</h1>
        <select className="select" value={sel} onChange={(e) => setSel(+e.target.value)}>
          {servers.map((s, i) => (
            <option key={i} value={i}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          className="input"
          placeholder="Введите ник"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <button className="play" onClick={play} disabled={!ready || Boolean(combined && combined.pct < 100)}>
          Играть
        </button>
        <p className="status">{status}</p>
      </div>
    </div>
  );
}

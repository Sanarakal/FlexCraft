/* ─────────────────────────────────────────────────────────────
 *  App.tsx – основной UI лаунчера + вызов IPC launch‑minecraft
 *  Отличия от прошлой версии:
 *    • авто‑refresh access‑JWT (чтобы не протухал)
 *    • комментарии + мелкий рефактор без изменения логики
 * ──────────────────────────────────────────────────────────── */

import React, { useEffect, useState, useRef } from 'react';
import flipTarget from './assets/flip-target.png';
import './App.css';

import Login from './Login';          // импорт из файла выше

/* ───── типы ───── */
interface Server { label: string; type: 'vanilla'|'modded'; ip: string; port: number }
interface DlEvt  { tag: string; pct?: number }

/* ───── константы ───── */
const API        = 'http://89.104.67.130:4000';
const SHOW_DELAY = 1000;

const tagLabel: Record<string,string> = {
  java     : 'Установка Java',
  forge    : 'Установка NeoForge',
  procdep  : 'Загрузка библиотек',
  minecraft: 'Загрузка ресурсов Minecraft'
};
const visibleTags = new Set(Object.keys(tagLabel));

/* ───── helpers ───── */
function aggregate(prog: Record<string,number>) {
  const entries = Object.entries(prog);
  if (!entries.length) return null;
  const pct = Math.round(entries.reduce((s, [,v]) => s + v, 0) / entries.length);
  return { pct, tags: entries.map(([t]) => t) };
}

/* ───── React‑компонент ───── */
export default function App() {
  /* auth */
  const [jwt , setJwt ] = useState<string|null>(null);
  const [user, setUser] = useState<string|null>(null);

  /* состояние лаунчера */
  const [servers, setServers] = useState<Server[]>([]);
  const [sel, setSel] = useState(0);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('⏳ Проверка серверов…');
  const [dl, setDl] = useState<Record<string,number>>({});
  const [tiles, setTiles] = useState<React.ReactElement|null>(null);
  const [flip , setFlip ] = useState(false);

  const sceneRef = useRef<HTMLDivElement>(null);

  /* ───────── загрузка информации о серверах ───────── */
  useEffect(() => {
    (async () => {
      try {
        const [van, mod] = await Promise.all([
          fetch(`${API}/api/server-info?type=vanilla`).then(r=>r.json()),
          fetch(`${API}/api/server-info?type=modded`).then(r=>r.json())
        ]);
        setServers([
          { label: 'Ванильный сервер',          type: 'vanilla', ...van },
          { label: 'Модовый сервер (NeoForge)', type: 'modded' , ...mod }
        ]);
        setReady(true);
        setStatus('✅ Серверы доступны');
      } catch {
        setStatus('❌ Серверы недоступны');
      }
    })();
  }, []);

  /* ───────── IPC‑download прогресс ───────── */
  useEffect(() => {
    const starts = new Map<string,number>();
    const timers = new Map<string,NodeJS.Timeout>();

    function commit(tag:string, pct:number) {
      setDl(p => ({ ...p, [tag]: pct }));
    }

    const onStart = (_:unknown, e:DlEvt) => {
      if (!visibleTags.has(e.tag)) return;
      starts.set(e.tag, Date.now());
      timers.set(e.tag, setTimeout(()=>commit(e.tag,0), SHOW_DELAY));
    };

    const onProg = (_:unknown, e:DlEvt) => {
      if (!visibleTags.has(e.tag) || !Number.isFinite(e.pct)) return;
      if (Date.now() - (starts.get(e.tag) ?? 0) >= SHOW_DELAY)
        commit(e.tag, Math.max(0, Math.min(100, Math.round(e.pct!))));
    };

    const onDone = (_:unknown, e:DlEvt) => {
      if (!visibleTags.has(e.tag)) return;
      if (timers.has(e.tag)) clearTimeout(timers.get(e.tag)!);
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
      timers.forEach(t=>clearTimeout(t));
    };
  }, [dl]);

  /* ───────── helper: refresh‑token если истекает ───────── */
  async function ensureFreshToken() {
    if (!jwt) return;
    const { exp } = JSON.parse(atob(jwt.split('.')[1]));
    if (Date.now()/1000 < exp - 30) return;                  // валиден
    const res = await fetch(`${API}/api/auth/refresh`, {
      method: 'POST', credentials: 'include'
    });
    if (!res.ok) { setJwt(null); setUser(null); return; }    // refresh истёк
    const { accessToken } = await res.json();
    setJwt(accessToken);
  }

  /* ───────── запуск игры ───────── */
  async function play() {
    await ensureFreshToken();                // ← авто‑refresh
    setDl({});
    setStatus('⏳ Запуск Minecraft…');

    /* снимок окна */
    await document.fonts.ready;
    const b64  = await window.electron.snapshot();
    const shot = 'data:image/png;base64,'+b64;
    const img  = await new Promise<HTMLImageElement>(res=>{
      const i=new Image(); i.onload=()=>res(i); i.src=shot;
    });
    const dpr=window.devicePixelRatio||1;
    const W=img.width/dpr, H=img.height/dpr;

    /* IPC → main‑process */
    const srv = servers[sel];
    await window.electron.invoke('launch-minecraft',{
      username: user!, token: jwt!, mode: srv.type,
      server  : { name: srv.label, ip: srv.ip, port: srv.port }
    });

    /* анимация плиток */
    const ROWS=10, COLS=15, DUR=650, DEL=20;
    const baseCW=Math.floor(W/COLS), baseCH=Math.floor(H/ROWS);
    const extraW=W-baseCW*COLS,      extraH=H-baseCH*ROWS;
    const colW = Array.from({length:COLS},(_,c)=>baseCW+(c<extraW?1:0));
    const rowH = Array.from({length:ROWS},(_,r)=>baseCH+(r<extraH?1:0));
    const sum  = (arr:number[], n:number)=>arr.slice(0,n).reduce((s,v)=>s+v,0);

    const order = Array.from({length:ROWS*COLS},(_,i)=>i).sort(()=>Math.random()-0.5);
    setTiles(
      <div className="tiles-wrapper">
        {order.map((idx,seq)=>{
          const r=Math.floor(idx/COLS), c=idx%COLS;
          const w=colW[c], h=rowH[r];
          const l=sum(colW,c), t=sum(rowH,r);
          return (
            <div
              key={idx}
              className="piece"
              style={{
                width:w, height:h, left:l, top:t,
                animationDelay:`${seq*DEL}ms`,
                animationDuration:`${DUR}ms`
              }}
            >
              <div
                className="face front"
                style={{
                  backgroundImage:`url(${shot})`,
                  backgroundSize:`${W}px ${H}px`,
                  backgroundPosition:`-${l}px -${t}px`
                }}
              />
              <div
                className="face back"
                style={{
                  backgroundImage:`url(${flipTarget})`,
                  backgroundSize:`${W}px ${H}px`,
                  backgroundPosition:`-${l}px -${t}px`
                }}
              />
            </div>
          );
        })}
      </div>
    );

    setFlip(true);
    setTimeout(() => window.electron.invoke('close-window'),
      ROWS*COLS*DEL + DUR + 200);
  }

  /* ───────── ветка “не авторизован” ───────── */
  if (!jwt) return <Login onAuth={(u,t)=>{setUser(u);setJwt(t);}} />;

  /* ───────── основной рендер ───────── */
  const combo = aggregate(dl);
  const showLoader = combo && combo.pct < 100;

  return (
    <div className="app-container" ref={sceneRef}>
      {tiles}

      {showLoader && (
        <div className="loader-card" style={{visibility:flip?'hidden':'visible'}}>
          <div className="loader-block">
            <h2>{combo!.tags.length===1 ? tagLabel[combo!.tags[0]] : 'Загрузка файлов'}</h2>
            <div className="progress-bar">
              <div className="progress-fill" style={{width:`${combo!.pct}%`}}/>
            </div>
            <span>{combo!.pct}%</span>
          </div>
        </div>
      )}

      <div className="content" style={{visibility:flip?'hidden':'visible'}}>
        <h1 className="logo">SexCraft Launcher</h1>

        <select className="select" value={sel} onChange={e=>setSel(+e.target.value)}>
          {servers.map((s,i)=><option key={i} value={i}>{s.label}</option>)}
        </select>

        <input className="input" value={user!} disabled />

        <button
          className="play"
          onClick={play}
          disabled={!ready || Boolean(combo && combo.pct < 100)}
        >
          Играть
        </button>

        <p className="status">{status}</p>
      </div>
    </div>
  );
}

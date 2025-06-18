import React, { useEffect, useState, useRef, ChangeEvent } from 'react';
import html2canvas from 'html2canvas';
import flipTarget from './assets/flip-target.png';
import './App.css';

type Server  = { label:string; type:'vanilla'|'modded'; ip:string; port:number };
type DlEvent = { type:'jre'|'forge'; pct?:number };
type DlState = { type:'jre'|'forge'; pct:number } | null;

const API = 'http://89.104.67.130:4000';

export default function App() {
  /* ---------- state ---------- */
  const [username,setUsername] = useState('');
  const [servers ,setServers ] = useState<Server[]>([]);
  const [sel     ,setSel     ] = useState(0);
  const [ready   ,setReady   ] = useState(false);
  const [status  ,setStatus  ] = useState('⏳ Проверка серверов…');
  const [dl      ,setDl      ] = useState<DlState>(null);
  const [tilesJSX,setTiles   ] = useState<React.ReactElement|null>(null);

  /* ref теперь на общий контейнер, а не на .content */
  const containerRef = useRef<HTMLDivElement>(null);

  /* ---------- fetch серверов ---------- */
  useEffect(()=>{ (async()=>{
    try{
      const [van,mod] = await Promise.all([
        fetch(`${API}/api/server-info?type=vanilla`).then(r=>r.json()),
        fetch(`${API}/api/server-info?type=modded`).then(r=>r.json()),
      ]);
      setServers([
        { label:'Ванильный сервер',       type:'vanilla', ...van },
        { label:'Модовый сервер (Forge)', type:'modded',  ...mod },
      ]);
      setReady(true); setStatus('✅ Серверы доступны');
    }catch{ setStatus('❌ Серверы недоступны'); }
  })(); },[]);

  /* ---------- IPC-прогресс ---------- */
  useEffect(()=>{
    const s = (_:unknown,d:DlEvent)=>setDl({type:d.type,pct:0});
    const p = (_:unknown,d:DlEvent)=>setDl({type:d.type,pct:d.pct ?? 0});
    const e = ()=>setDl(null);

    window.electron.on('download-start',    s);
    window.electron.on('download-progress', p);
    window.electron.on('download-done',     e);
  },[]);

  /* ---------- запуск ---------- */
  const play = async ()=>{
    if(!username.trim()){ setStatus('❌ Введите ник'); return; }
    const s = servers[sel];
    await window.electron.invoke('launch-minecraft',{
      username, mode:s.type, server:{ name:s.label, ip:s.ip, port:s.port },
    });

    /* ===== плиточная анимация ===== */
    const node = containerRef.current!;
    /* 1. Снимаем скриншот ПРЕЖДЕ, чем прячем интерфейс */
    const shot = await html2canvas(node,{ backgroundColor:null });
    const ctx  = shot.getContext('2d')!;
    const { width:w, height:h } = shot;

    /* 2. Теперь можно скрыть оригинальный UI */
    node.style.visibility = 'hidden';

    /* параметры сетки */
    const ROWS = 10, COLS = 15, DELAY = 35, DUR = 650;
    const cw = Math.ceil(w / COLS);
    const ch = Math.ceil(h / ROWS);

    /* задняя сторона (картинка-цель) */
    const img = new Image(); img.src = flipTarget; await img.decode();
    const backCv = document.createElement('canvas'); backCv.width=w; backCv.height=h;
    backCv.getContext('2d')!.drawImage(img,0,0,w,h);

    /* случайный порядок переворота */
    const order = Array.from({length:ROWS*COLS},(_,i)=>i).sort(()=>Math.random()-.5);

    const pieces = order.map((idx,n)=>{
      const r = Math.floor(idx / COLS);
      const c = idx % COLS;

      /* вырезаем «фронт» */
      const frontPiece = document.createElement('canvas'); frontPiece.width=cw; frontPiece.height=ch;
      frontPiece.getContext('2d')!
        .putImageData(ctx.getImageData(c*cw, r*ch, cw, ch), 0, 0);

      /* и «тыл» */
      const backPiece  = document.createElement('canvas'); backPiece.width=cw; backPiece.height=ch;
      backPiece.getContext('2d')!
        .putImageData(backCv.getContext('2d')!.getImageData(c*cw, r*ch, cw, ch), 0, 0);

      return (
        <div
          key={idx}
          className='piece'
          style={{
            width:cw, height:ch,
            left:c*cw, top:r*ch,
            animationDelay:`${n*DELAY}ms`,
            animationDuration:`${DUR}ms`,
          }}
        >
          <div className='face front' style={{backgroundImage:`url(${frontPiece.toDataURL()})`}}/>
          <div className='face back'  style={{backgroundImage:`url(${backPiece.toDataURL()})`}}/>
        </div>
      );
    });

    setTiles(<div className='tiles-wrapper'>{pieces}</div>);

    /* выходим из приложения, когда последняя плитка докручена */
    setTimeout(() => window.electron.invoke('close-window'),
      order.length * DELAY + DUR + 300);
  };

  /* ---------- JSX ---------- */
  const onNick = (e:ChangeEvent<HTMLInputElement>) => setUsername(e.target.value);
  const onSel  = (e:ChangeEvent<HTMLSelectElement>) => setSel(+e.target.value);

  return(
    <div className='app-container' ref={containerRef}>
      {/* плиточная маска поверх всего */}
      {tilesJSX}

      {/* окно загрузок (остается поверх плиток) */}
      {dl && (
        <div className='loader-card'>
          <h2>{dl.type==='jre'?'Установка Java':'Установка Forge'}</h2>
          <div className='progress-bar'>
            <div className='progress-fill' style={{width:`${dl.pct}%`}}/>
          </div>
          <span>{dl.pct}%</span>
        </div>
      )}

      {/* основной контент лаунчера */}
      <div className='content'>
        <h1 className='logo'>SexCraft Launcher</h1>
        <select className='select' value={sel} onChange={onSel}>
          {servers.map((s,i)=><option key={i} value={i}>{s.label}</option>)}
        </select>
        <input className='input' placeholder='Введите ник'
               value={username} onChange={onNick}/>
        <button className='play' onClick={play} disabled={!ready||!!dl}>Играть</button>
        <p className='status'>{status}</p>
      </div>
    </div>
  );
}

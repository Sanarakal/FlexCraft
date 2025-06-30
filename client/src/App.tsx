/* App.tsx – SexCraft Launcher UI (flip-before-launch) */
import React, { useEffect, useState, useRef } from 'react';
import html2canvas                       from 'html2canvas';
import flipTarget                        from './assets/flip-target.png';
import './App.css';

type Server = { label:string; type:'vanilla'|'modded'; ip:string; port:number };
type DlEvt  = { tag:string; pct?:number };
type DlMap  = Record<string,number>;

const API = 'http://89.104.67.130:4000';

/* метки для прогресс-бара */
const tagLabel:Record<string,string> = {
  java:'Установка Java', forge:'Установка NeoForge',
  procdep:'Загрузка библиотек', minecraft:'Загрузка ресурсов Minecraft',
};

export default function App() {
/* ───────── state ───────── */
  const [username,setUsername] = useState('');
  const [servers ,setServers ] = useState<Server[]>([]);
  const [sel     ,setSel     ] = useState(0);
  const [ready   ,setReady   ] = useState(false);
  const [status  ,setStatus  ] = useState('⏳ Проверка серверов…');
  const [dl      ,setDl      ] = useState<DlMap>({});
  const [tiles   ,setTiles   ] = useState<React.ReactElement|null>(null);

  const sceneRef = useRef<HTMLDivElement>(null);

/* ───────── загрузка сведений о серверах ───────── */
  useEffect(()=>{
    (async()=>{
      try{
        const [van,mod] = await Promise.all([
          fetch(`${API}/api/server-info?type=vanilla`).then(r=>r.json()),
          fetch(`${API}/api/server-info?type=modded` ).then(r=>r.json()),
        ]);
        setServers([
          { label:'Ванильный сервер',       type:'vanilla', ...van },
          { label:'Модовый сервер (Forge)', type:'modded',  ...mod },
        ]);
        setReady(true); setStatus('✅ Серверы доступны');
      }catch{ setStatus('❌ Серверы недоступны'); }
    })();
  },[]);

/* ───────── IPC: прогресс-бар ───────── */
  useEffect(()=>{
    const upd = (t:string,v:number)=>setDl(p=>({ ...p, [t]:v }));

    const onStart = (_:unknown,e:DlEvt)=>upd(e.tag,0);
    const onDone  = (_:unknown,e:DlEvt)=>upd(e.tag,100);
    const onProg  = (_:unknown,e:DlEvt)=>{
      if(Number.isFinite(e.pct)) upd(e.tag,Math.max(0,Math.min(100,Math.round(e.pct!))));
    };

    window.electron.on ('download-start'   , onStart);
    window.electron.on ('download-progress', onProg );
    window.electron.on ('download-done'    , onDone );
    return ()=>{
      window.electron.off('download-start'   , onStart);
      window.electron.off('download-progress', onProg );
      window.electron.off('download-done'    , onDone );
    };
  },[]);

/* ───────── основной сценарий ───────── */
  const play = async ()=>{
    if(!username.trim()){ setStatus('❌ Введите ник'); return; }

    /* ① делаем скриншот интерфейса */
    const shot = await html2canvas(sceneRef.current!, { backgroundColor:null, scale:1 });
    const { width:W, height:H } = shot;
    const ctx  = shot.getContext('2d')!;

    /* ② готовим заднюю текстуру */
    const img  = new Image(); img.src = flipTarget; await img.decode();
    const back = Object.assign(document.createElement('canvas'),{ width:W, height:H});
    back.getContext('2d')!.drawImage(img,0,0,W,H);

    /* ③ создаём плитки и включаем анимацию */
    const ROWS=10, COLS=15, N=ROWS*COLS, DUR=650, DEL=20;
    const CW=W/COLS, CH=H/ROWS;
    const order = Array.from({length:N},(_,i)=>i).sort(()=>Math.random()-0.5);

    setTiles(<div className='tiles-wrapper'>
      {order.map((idx,seq)=>{
        const r=~~(idx/COLS), c=idx%COLS;
        const fc = ctx.getImageData(c*CW, r*CH, CW, CH);
        const bc = back.getContext('2d')!.getImageData(c*CW, r*CH, CW, CH);

        const front = Object.assign(document.createElement('canvas'),{width:CW,height:CH});
        front.getContext('2d')!.putImageData(fc,0,0);
        const backcv = Object.assign(document.createElement('canvas'),{width:CW,height:CH});
        backcv.getContext('2d')!.putImageData(bc,0,0);

        return (
          <div key={idx} className='piece'
               style={{
                 width:CW, height:CH, left:c*CW, top:r*CH,
                 animationDelay:`${seq*DEL}ms`,
                 animationDuration:`${DUR}ms`,
               }}>
            <div className='face front' style={{ backgroundImage:`url(${front.toDataURL()})` }} />
            <div className='face back'  style={{ backgroundImage:`url(${backcv.toDataURL()})` }} />
          </div>
        );
      })}
    </div>);

    /* ④ когда flip закончился → запускаем MC */
    const flipTime = (N-1)*DEL + DUR + 150;      // полный цикл + небольшой запас
    setTimeout(async ()=>{
      const srv=servers[sel];
      await window.electron.invoke('launch-minecraft',{
        username,
        mode   :srv.type,
        server :{ name:srv.label, ip:srv.ip, port:srv.port },
      });
      /* даём окну клиента подняться и сворачиваем лаунчер */
      setTimeout(()=>window.electron.invoke('close-window'),300);
    }, flipTime);
  };

/* ───────── JSX ───────── */
  const activeLoads = Object.entries(dl);

  return (
    <div className='app-container' ref={sceneRef}>
      {tiles}
      {activeLoads.length>0 && (
        <div className='loader-card'>
          {activeLoads.map(([tag,pct])=>(
            <div key={tag} className='loader-block'>
              <h2>{tagLabel[tag]??'Загрузка'}</h2>
              <div className='progress-bar'>
                <div className='progress-fill' style={{ width:`${pct}%` }} />
              </div>
              <span>{pct}%</span>
            </div>
          ))}
        </div>
      )}

      <div className='content'>
        <h1 className='logo'>SexCraft Launcher</h1>

        <select className='select' value={sel} onChange={e=>setSel(+e.target.value)}>
          {servers.map((s,i)=><option key={i} value={i}>{s.label}</option>)}
        </select>

        <input className='input' placeholder='Введите ник'
               value={username} onChange={e=>setUsername(e.target.value)} />

        <button className='play' onClick={play}
                disabled={!ready || activeLoads.length>0}>
          Играть
        </button>

        <p className='status'>{status}</p>
      </div>
    </div>
  );
}

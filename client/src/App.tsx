import React, { useEffect, useState, useRef } from 'react';
import html2canvas                         from 'html2canvas';
import flipTarget                          from './assets/flip-target.png';
import './App.css';

type Server  = { label:string; type:'vanilla'|'modded'; ip:string; port:number };
type DlEvt   = { tag:string; pct?:number };
type DlState = Record<string, number | undefined>;

const API = 'http://89.104.67.130:4000';

export default function App() {
  /* ───────────────── state ───────────────── */
  const [username ,setUsername ] = useState('');
  const [servers  ,setServers  ] = useState<Server[]>([]);
  const [sel      ,setSel      ] = useState(0);
  const [ready    ,setReady    ] = useState(false);
  const [status   ,setStatus   ] = useState('⏳ Проверка серверов…');
  const [dl       ,setDl       ] = useState<DlState>({});
  const [tilesJSX ,setTiles    ] = useState<React.ReactElement|null>(null);

  /* ───────────────── refs ───────────────── */
  const sceneRef           = useRef<HTMLDivElement>(null); // весь UI
  const downloadsHappened  = useRef(false);

  /* ───────── fetch серверов ───────── */
  useEffect(()=>{(async()=>{
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
  })();},[]);

  /* ───────── IPC‑прогресс ───────── */
  useEffect(()=>{
    const mark = ()=> (downloadsHappened.current = true);

    window.electron.on('download-start',(_:unknown,d:DlEvt)=>{
      mark(); setDl(prev=>({...prev,[d.tag]:0}));
    });
    window.electron.on('download-progress',(_:unknown,d:DlEvt)=>{
      if(typeof d.pct==='number'){
        setDl(prev=>({...prev,[d.tag]:d.pct}));
      }
    });
    window.electron.on('download-done',(_:unknown,d:DlEvt)=>{
      setDl(prev=>{
        const copy={...prev}; delete copy[d.tag]; return copy;
      });
    });
  },[]);

  /* ───────── PLAY ───────── */
  const play = async ()=>{
    if(!username.trim()){ setStatus('❌ Введите ник'); return; }

    /* 1. Скриншот текущего UI (нативные CSS‑пиксели) */
    const shot = await html2canvas(sceneRef.current!, { backgroundColor:null, scale:1 });
    const { width:w, height:h } = shot;
    const ctx = shot.getContext('2d')!;

    /* 2. Запуск Minecraft + профилируем время */
    const t0 = performance.now();
    const srv=servers[sel];
    await window.electron.invoke('launch-minecraft',{
      username,
      mode  : srv.type,
      server: { name:srv.label, ip:srv.ip, port:srv.port },
    });
    const elapsed = Math.max(700, performance.now() - t0);

    /* 3. Если что‑то качалось → UI уже отображал полосы, завершаем без плиток */
    if(downloadsHappened.current){
      window.electron.invoke('close-window'); return;
    }

    /* 4. Генерация плиток красивой анимации */
    const ROWS=10, COLS=15, N=ROWS*COLS, DUR=650;
    const DEL = Math.max(0,(elapsed-DUR)/N);
    const cw  = w/COLS, ch=h/ROWS;

    /* задник */
    const img=new Image(); img.src=flipTarget; await img.decode();
    const backCv=Object.assign(document.createElement('canvas'),{width:w,height:h});
    const bctx=backCv.getContext('2d')!;
    bctx.imageSmoothingEnabled=false;
    bctx.drawImage(img,0,0,w,h);

    const order=Array.from({length:N}, (_,i)=>i).sort(()=>Math.random()-.5);

    const tiles=order.map((idx,seq)=>{
      const r=~~(idx/COLS), c=idx%COLS;

      const front=document.createElement('canvas');
      front.width=cw; front.height=ch;
      front.getContext('2d')!
        .putImageData(ctx.getImageData(c*cw,r*ch,cw,ch),0,0);

      const back=document.createElement('canvas');
      back.width=cw; back.height=ch;
      back.getContext('2d')!
        .putImageData(bctx.getImageData(c*cw,r*ch,cw,ch),0,0);

      return(
        <div
          key={idx}
          className='piece'
          style={{
            width:cw, height:ch,
            left:c*cw, top:r*ch,
            animationDelay:`${seq*DEL}ms`,
            animationDuration:`${DUR}ms`,
          }}>
          <div className='face front' style={{backgroundImage:`url(${front.toDataURL()})`}}/>
          <div className='face back'  style={{backgroundImage:`url(${back .toDataURL()})`}}/>
        </div>
      );
    });

    /* 5. Отрисовываем и закрываем после конца анимации */
    setTiles(<div className='tiles-wrapper' style={{willChange:'transform'}}>{tiles}</div>);
    setTimeout(()=>window.electron.invoke('close-window'), elapsed+150);
  };

  /* ───────── UI ───────── */
  const activeLoads = Object.entries(dl);

  return(
    <div className='app-container' ref={sceneRef}>
      {tilesJSX}

      {activeLoads.length>0 && (
        <div className='loader-card'>
          {activeLoads.map(([tag,pct])=>(
            <div key={tag} className='loader-block'>
              <h2>{tag==='minecraft'
                    ? 'Загрузка ресурсов Minecraft'
                    : tag==='jre'||tag==='jdk'
                      ? 'Установка Java'
                      : tag==='forge'
                        ? 'Установка Forge'
                        : 'Загрузка библиотек'}
              </h2>
              <div className='progress-bar'>
                <div className='progress-fill' style={{width:`${pct}%`}}/>
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
               value={username} onChange={e=>setUsername(e.target.value)}/>

        <button className='play' onClick={play} disabled={!ready||activeLoads.length>0}>Играть</button>
        <p className='status'>{status}</p>
      </div>
    </div>
  );
}

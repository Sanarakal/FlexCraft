/* -------------------------------------------------------------------------- */
/*  SexCraft Launcher – main process (patch 7, Custom ModPack support)        */
/*  ➥ Changes since patch 6:                                                  *
/*     • Removed hard‑wired Arcana modpack logic                              *
/*     • Added generic ensureCustomModpack():                                 *
/*         – version / URL / SHA‑256 via env vars (MODPACK_VER / …)           *
/*         – safely no‑op if MODPACK_URL unset                                *
/*     • launch‑minecraft now calls ensureCustomModpack()                     *
/*  2025‑07‑16                                                                */
/* -------------------------------------------------------------------------- */

import { app, BrowserWindow, ipcMain }          from 'electron';
import {
  createWriteStream, createReadStream, existsSync, mkdirSync,
  readdirSync, rmSync, writeFileSync, readFileSync, renameSync,
}                                               from 'node:fs';
import path                                     from 'node:path';
import https                                    from 'node:https';
import AdmZip                                   from 'adm-zip';
import tar                                      from 'tar';
import { setTimeout as delay }                  from 'node:timers/promises';
import { v4 as uuidv4 }                         from 'uuid';
import { Client }                               from 'minecraft-launcher-core';
import { writeUncompressed, NBT }               from 'prismarine-nbt';
import log                                      from 'electron-log';
import { pipeline }                             from 'node:stream';
import { promisify }                            from 'node:util';
import { createHash }                           from 'node:crypto';

const pump = promisify(pipeline);

/* ──────────────── пользовательский мод‑пак ──────────────── *
 * Включается **только** если указана переменная MODPACK_URL. */
const MODPACK_VER   = process.env.MODPACK_VER   ?? '1.0';
const MODPACK_URL   = process.env.MODPACK_URL   ?? '';     // «»  → пропустить загрузку
const MODPACK_SHA256= process.env.MODPACK_SHA256?? '';     // «»  → пропустить проверку

/* ───────────────────── webpack constants ───────────────────── */
declare const MAIN_WINDOW_WEBPACK_ENTRY        : string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

/* ──────────────── версии Minecraft и NeoForge ──────────────── */
const VANILLA_VERSION    = '1.21.5';
const NEOFORGE_VERSION   = '1.21.1';
const NEOFORGE_MAVEN_VER = '21.1.170';
const INSTALLERTOOLS_VER = '2.1.4';

/* ───── Maven зеркала (приоритет сверху) ───── */
const MAVEN_REPOS = [
  'https://maven.neoforged.net/releases',
  'https://repo1.maven.org/maven2',
] as const;

/* ───── Processor‑dependencies ───── */
const PROC_DEPS = [
  /* Installertools */
  `net.neoforged.installertools:cli-utils:${INSTALLERTOOLS_VER}`,
  `net.neoforged.installertools:jarsplitter:${INSTALLERTOOLS_VER}`,
  'net.neoforged:AutoRenamingTool:2.0.3:all',

  /* Javadoctor */
  'net.neoforged.javadoctor:gson-io:2.0.17',
  'net.neoforged.javadoctor:spec:2.0.17',

  /* Misc */
  'net.neoforged:srgutils:1.0.10',
  'net.neoforged:neoform:1.21.1-20240808.144430@zip',

  'net.md-5:SpecialSource:1.11.0',
  'net.sf.jopt-simple:jopt-simple:5.0.4',
  'com.google.code.gson:gson:2.8.9',
  'de.siegmar:fastcsv:2.0.0',
  'org.ow2.asm:asm-commons:9.3',
  'org.ow2.asm:asm-analysis:9.3',
  'org.ow2.asm:asm-tree:9.3',
  'org.ow2.asm:asm:9.3',
  'org.apache.commons:commons-text:1.3',
  'org.apache.commons:commons-lang3:3.8.1',
  'commons-logging:commons-logging:1.2',
  'commons-beanutils:commons-beanutils:1.9.3',
  'org.apache.commons:commons-collections4:4.2',
  'commons-collections:commons-collections:3.2.2',
  'com.google.guava:guava:20.0',
  'com.opencsv:opencsv:4.4',
] as const;

/* ─────────────────────────── директории ───────────────────────── */
const ROOT     = path.join(app.getPath('userData'), '.sexcraft');
const RUNTIME  = path.join(ROOT, 'runtime');
const CACHE    = path.join(ROOT, 'cache');
const LOG_FILE = path.join(ROOT, 'launcher.log');
const JAVA_EXE = process.platform === 'win32' ? 'java.exe' : 'java';

/* ──────────────────────────── логирование ────────────────────── */
log.transports.file.resolvePath = () => LOG_FILE;
log.initialize({ preload: true });
log.info('=== SexCraft Launcher started (patch 7) ===');

const DEBUG_PROGRESS = !!process.env.LAUNCHER_DEBUG;

/* ───────────────────────────── типы ──────────────────────────── */
type OS   = 'windows' | 'macos' | 'linux';
type Arch = 'x64' | 'aarch64';
interface FixedServer { name:string; ip:string; port:number }
interface LaunchOpts  { username:string; mode:'vanilla'|'modded'; server:FixedServer }

type DlTag = 'java'|'forge'|'procdep'|'minecraft'|'modpack';

interface ProgressObj {
  percent?: number;
  percentage?: number;
  progress?: number;
  downloaded?: number;
  total?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  completed?: number;
  current?: number;
  task?: number;
}

/* ╭── helpers ──╮ */
const offlineAuth = (n:string)=>({
  name:n, uuid:uuidv4(), accessToken:'offline', clientToken:'offline',
  userProperties:{}, userType:'mojang',
});
const send = <T>(w:BrowserWindow, ev:string, payload:T)=>{
  if (!w.isDestroyed()) w.webContents.send(ev,payload);
};
const toPosix = (p:string)=>p.replace(/\\/g,'/');

/* ──────────────── snapshot‑ui IPC ──────────────── */
let win:BrowserWindow|null=null;
ipcMain.handle('snapshot-ui', async () => {
  if (!win) throw new Error('window not ready');
  const img = await win.webContents.capturePage();
  return img.toPNG().toString('base64');
});

/* ╭────────────── Temurin helpers ───────────────╮ */
function assetsApi(os:OS, arch:Arch, img:'jre'|'jdk'){
  return `/v3/assets/feature_releases/21/ga?architecture=${arch}`+
         `&heap_size=normal&image_type=${img}&jvm_impl=hotspot&os=${os}&vendor=eclipse`;
}
function redirectApi(os:OS, arch:Arch, img:'jre'|'jdk'){
  return `https://api.adoptium.net/v3/binary/latest/21/ga/${os}/${arch}/${img}/hotspot/normal/eclipse`;
}
function githubToPackages(link: string) {
  const m = link.match(/\/download\/([^/]+)\/(OpenJDK.*\.(?:zip|tar\.gz))$/i);
  return m ? `https://packages.adoptium.net/artifactory/temurin/21/ga/${m[1]}/${m[2]}` : undefined;
}
async function fetchTemurinLink(os:OS, arch:Arch, img:'jre'|'jdk'){
  return new Promise<string>((res,rej)=>{
    https.get({host:'api.adoptium.net',path:assetsApi(os,arch,img)},r=>{
      let raw=''; r.setEncoding('utf8');
      r.on('data',c=>raw+=c);
      r.on('end',()=>{
        try{
          const link = JSON.parse(raw)?.[0]?.binary?.package?.link;
          link?res(link):rej(new Error('link not found'));
        }catch(err){rej(err);}
      });
    }).on('error',rej);
  });
}
/* ╰──────────────────────────────────────────────╯ */

/* ╭───────── downloader (+retry+mirror) ─────────╮ */
async function headOk(url:string){
  return new Promise<boolean>(resolve=>{
    const req = https.request(url,{method:'HEAD'},res=>{
      /* на некоторых зеркалах HEAD отдаёт 307/308 → fallback на GET */
      if(res.statusCode!==undefined && res.statusCode>=200 && res.statusCode<400){
        resolve(true); return;
      }
      if(res.statusCode===307||res.statusCode===308){
        resolve(true); return;
      }
      resolve(false);
    });
    req.on('error',()=>resolve(false));
    req.end();
  });
}

async function downloadWithRetry(
  tag:DlTag, url:string, dest:string, w:BrowserWindow, tries=3,
){
  mkdirSync(path.dirname(dest),{recursive:true});
  let attempt=url;

  for(let i=1;i<=tries;i++){
    try{
      send(w,'download-start',{tag,url:attempt});
      log.debug(`[DL] start ${tag} → ${attempt}`);

      await new Promise<void>((res,rej)=>{
        https.get(attempt,r=>{
          /* redirect */
          if(r.statusCode && r.statusCode>=300 && r.statusCode<400 && r.headers.location){
            r.resume();
            attempt=r.headers.location!;
            downloadWithRetry(tag,attempt,dest,w,tries).then(res).catch(rej);
            return;
          }
          /* http error */
          if(!r.statusCode || r.statusCode>=400){
            r.resume(); rej(new Error(`GET ${attempt} → ${r.statusCode}`)); return;
          }

          const total=Number(r.headers['content-length']??0);
          let done=0;
          const tmp=createWriteStream(dest);
          r.on('data',b=>{
            done+=(b as Buffer).length;
            if(total){
              const pct=Math.floor(done/total*100);
              send(w,'download-progress',{tag,pct});
            }
          });
          pump(r,tmp).then(()=>{
            send(w,'download-progress',{tag,pct:100});
            send(w,'download-done',{tag});
            res();
          }).catch(rej);
        }).on('error',rej);
      });

      log.info(`[DL] done  ${tag}`);
      return;
    }catch(err:any){
      if(existsSync(dest)) rmSync(dest);
      log.warn(`[DL] fail ${tag} try ${i}/${tries}: ${err.message||err}`);
      if(i<tries){
        await delay(1000*2**(i-1));
        continue;
      }
      send(w,'download-error',{tag,url:attempt,err:err.message});
      log.error(`[DL] abort ${tag}: ${err.stack||err}`);
      throw err;
    }
  }
}
/* ╰──────────────────────────────────────────────╯ */

/* ──────── helpers: batch concurrency ──────── */
async function runLimited<T>(
  concurrency:number, tasks:readonly (()=>Promise<T>)[]
):Promise<T[]>{
  const results:Promise<T>[]=[];
  const queue=tasks.slice();
  const runners:Promise<void>[]=[];

  const runNext=async()=>{
    const task=queue.shift();
    if(!task) return;
    results.push(task());
    await results[results.length-1];
    await runNext();
  };
  for(let i=0;i<Math.min(concurrency,tasks.length);i++) runners.push(runNext());
  await Promise.all(runners);
  return Promise.all(results);
}

/* ───────── ensure Java 21 ───────── */
async function ensureJava(w:BrowserWindow):Promise<string>{
  const bundled=path.join(process.resourcesPath,'jre','bin',JAVA_EXE);
  if(existsSync(bundled)){log.info('Using bundled JRE');return bundled;}

  mkdirSync(RUNTIME,{recursive:true});
  mkdirSync(CACHE  ,{recursive:true});

  const cached=readdirSync(RUNTIME,{withFileTypes:true})
    .find(d=>d.isDirectory()&&/(jre|jdk)-21/.test(d.name));
  if(cached){
    log.info('Using cached JRE');
    return path.join(RUNTIME,cached.name,'bin',JAVA_EXE);
  }

  const os :OS  = process.platform==='win32'?'windows'
                : process.platform==='darwin'?'macos':'linux';
  const arch:Arch=process.arch==='arm64'?'aarch64':'x64';
  const archive=path.join(CACHE,'temurin-runtime'); // без расширения заранее

  const tryDownload=async(img:'jre'|'jdk')=>{
    let link:string;
    try{link=await fetchTemurinLink(os,arch,img);}
    catch{link=redirectApi(os,arch,img);}
    const ext = link.endsWith('.zip')?'.zip':'.tar.gz';
    await downloadWithRetry('java',link,archive+ext,w);
    return ext;
  };

  let ext:string;
  try{ext = await tryDownload('jre');}
  catch(e:any){
    const mirror=githubToPackages(e.message??'');
    if(mirror){ ext = mirror.endsWith('.zip')?'.zip':'.tar.gz';
      await downloadWithRetry('java',mirror,archive+ext,w);
    }else{log.warn('[Temurin] JRE 404 → fallback JDK');ext = await tryDownload('jdk');}
  }

  /* распаковка */
  send(w,'download-progress',{tag:'java',pct:95});
  if(ext==='.zip'){
    new AdmZip(archive+ext).extractAllTo(RUNTIME,true);
  }else{
    await tar.x({file:archive+ext,cwd:RUNTIME,strip:0});
  }
  send(w,'download-progress',{tag:'java',pct:100});
  send(w,'download-done',{tag:'java'});

  /* определяем реальный bin‑путь */
  const unpacked=readdirSync(RUNTIME).find(d=>d.startsWith('jre')||d.startsWith('jdk'));
  if(!unpacked) throw new Error('Temurin unpack failed');
  const rootDir=path.join(RUNTIME,unpacked);
  /* macOS: bin лежит внутри Contents/Home */
  const macHome=path.join(rootDir,'Contents','Home');
  const binDir=existsSync(macHome)?path.join(macHome,'bin'):path.join(rootDir,'bin');
  return path.join(binDir,JAVA_EXE);
}

/* ───────── installertools (один JAR) ───────── */
async function ensureInstallertools(w:BrowserWindow){
  const jar=path.join(
    ROOT,'libraries','net','neoforged','installertools','installertools',
    INSTALLERTOOLS_VER,`installertools-${INSTALLERTOOLS_VER}.jar`,
  );
  if(existsSync(jar)) return jar;

  const rel=`net/neoforged/installertools/installertools/${INSTALLERTOOLS_VER}`+
            `/installertools-${INSTALLERTOOLS_VER}.jar`;

  for(const repo of MAVEN_REPOS){
    if(!(await headOk(`${repo}/${rel}`))) continue;
    try{
      await downloadWithRetry('forge',`${repo}/${rel}`,jar,w);
      return jar;
    }catch{/* next mirror */}
  }
  throw new Error('installertools download failed');
}

/* ──────────── processor‑deps (bulk) ──────────── */
interface GAV{group:string;artifact:string;version:string;classifier?:string;ext:string}
function parseGAV(raw:string):GAV{
  const [coords,ext='jar']=raw.split('@',2);
  const parts=coords.split(':');
  if(parts.length<3||parts.length>4) throw new Error(`Bad GAV: ${raw}`);
  const [group,artifact,version]=parts;
  const classifier=parts[3];
  return {group,artifact,version,classifier,ext};
}

async function ensureProcessorDeps(w:BrowserWindow){
  const stillMissing:Set<string>=new Set();

  const missing=PROC_DEPS.filter(raw=>{
    const {group,artifact,version,classifier,ext}=parseGAV(raw);
    const relDir=path.join(...group.split('.'),artifact,version);
    const file  =`${artifact}-${version}${classifier?`-${classifier}`:''}.${ext}`;
    const found=!existsSync(path.join(ROOT,'libraries',relDir,file));
    if(found) stillMissing.add(raw);
    return found;
  });

  if(missing.length===0) return;

  /* aggregated progress bar */
  let done=0;
  const total=missing.length;
  send(w,'download-start',{tag:'procdep',url:''});
  const tick=()=>send(w,'download-progress',{tag:'procdep',pct:Math.floor(done/total*100)});

  const tasks=missing.map(raw=>async()=>{
    const {group,artifact,version,classifier,ext}=parseGAV(raw);
    const relDir=path.join(...group.split('.'),artifact,version);
    const file  =`${artifact}-${version}${classifier?`-${classifier}`:''}.${ext}`;
    const dst   =path.join(ROOT,'libraries',relDir,file);

    const relPosix=`${toPosix(relDir)}/${encodeURIComponent(file)}`;
    let ok=false;
    for(const repo of MAVEN_REPOS){
      const full=`${repo}/${relPosix}`;
      if(!(await headOk(full))) continue;
      try{
        await downloadWithRetry('procdep',full,dst,w);
        ok=true; break;
      }catch{/* next mirror */}
    }
    if(!ok) log.error('[PROCDEP] failed',raw);
    else    stillMissing.delete(raw);
    done++;tick();
  });

  await runLimited(6,tasks);

  tick(); send(w,'download-done',{tag:'procdep'});

  if(stillMissing.size){
    throw new Error(`Processor‑deps missing: ${Array.from(stillMissing).join(', ')}`);
  }
}

/* ───────── NeoForge installer ───────── */
async function ensureNeoForgeInstaller(w:BrowserWindow){
  const jar=path.join(CACHE,`neoforge-${NEOFORGE_MAVEN_VER}-installer.jar`);
  if(existsSync(jar)) return jar;

  const rel=`net/neoforged/neoforge/${NEOFORGE_MAVEN_VER}`+
            `/neoforge-${NEOFORGE_MAVEN_VER}-installer.jar`;

  for(const repo of MAVEN_REPOS){
    const full=`${repo}/${rel}`;
    if(!(await headOk(full))) continue;
    try{
      await downloadWithRetry('forge',full,jar,w);
      return jar;
    }catch{/* next mirror */}
  }
  throw new Error('NeoForge installer download failed');
}

/* ───────── write servers.dat ───────── */
function writeServersDat(root:string,s:FixedServer){
  const nbt:NBT={
    type:'compound',name:'',value:{
      servers:{type:'list',value:{type:'compound',value:[{
        name :{type:'string',value:s.name},
        ip   :{type:'string',value:`${s.ip}:${s.port}`},
        icon :{type:'string',value:''},
        acceptTextures:{type:'byte',value:0},
        hideAddress   :{type:'byte',value:0},
      }]}}
    },
  } as any;
  mkdirSync(root,{recursive:true});
  writeFileSync(path.join(root,'servers.dat'),writeUncompressed(nbt));
}

/* ───────── SHA‑256 helper ───────── */
async function sha256File(file:string):Promise<string>{
  return new Promise<string>((res,rej)=>{
    const hash=createHash('sha256');
    const s=createReadStream(file);
    s.on('error',rej);
    s.on('data',d=>hash.update(d));
    s.on('end',()=>res(hash.digest('hex')));
  });
}

/* ───────── Custom modpack ensure/install ───────── */
async function ensureCustomModpack(w: BrowserWindow) {
  /* Если MODPACK_URL не задан – ничего не делаем. */
  if (!MODPACK_URL) {
    log.info('No custom modpack URL provided – skipping modpack step');
    return;
  }

  const sentinel = path.join(ROOT, '.modpack_version.txt');

  /* 1. Уже нужная версия? */
  let current: string | null = null;
  try   { current = readFileSync(sentinel, 'utf8').trim(); }
  catch { /* файла нет – устанавливаем */ }

  if (current === MODPACK_VER) {
    log.info('Custom modpack already installed');
    return;
  }

  /* 2. Скачиваем ZIP и (опционально) проверяем хэш */
  mkdirSync(CACHE, { recursive: true });
  const fname = `modpack-${MODPACK_VER}.zip`;
  const zip = path.join(CACHE, fname);
  await downloadWithRetry('modpack', MODPACK_URL, zip, w);

  if (MODPACK_SHA256) {
    const actual = await sha256File(zip);
    if (actual.toLowerCase() !== MODPACK_SHA256.toLowerCase()) {
      send(w, 'download-error',
        { tag: 'modpack', url: MODPACK_URL, err: 'SHA-256 mismatch' });
      throw new Error(
        `Modpack SHA-256 mismatch: expected ${MODPACK_SHA256}, got ${actual}`,
      );
    }
    log.info('Modpack SHA-256 verified');
  } else {
    log.info('SHA‑256 check skipped (no MODPACK_SHA256)');
  }

  /* 3. Чистим старое содержимое (mods, config, …) */
  ['mods', 'config', 'resourcepacks', 'kubejs', 'defaultconfigs'].forEach(d =>
    rmSync(path.join(ROOT, d), { recursive: true, force: true }));

  /* 4. Распаковка архива в корень лаунчера */
  send(w, 'download-progress', { tag: 'modpack', pct: 90 });
  new AdmZip(zip).extractAllTo(ROOT, true);

  /* 5. Плоская или обёртка? (аналогично прежней логике) */
  let wrapper: string | null = null;

  /* 5‑A. overrides/  или  <wrapper>/overrides/ */
  for (const d of readdirSync(ROOT, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    if (d.name.toLowerCase() === 'overrides') {
      wrapper = path.join(ROOT, d.name);
    } else {
      const inner = path.join(ROOT, d.name, 'overrides');
      if (existsSync(inner)) wrapper = inner;
    }
    if (wrapper) break;
  }

  /* 5‑B. fallback – обёртка без overrides, но с mods */
  if (!wrapper) {
    for (const d of readdirSync(ROOT, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const candidate = path.join(ROOT, d.name);
      if (existsSync(path.join(candidate, 'mods'))) {
        wrapper = candidate;
        break;
      }
    }
  }

  /* 6. Если wrapper найден – переносим каталоги наверх */
  if (wrapper) {
    const targets = ['mods', 'config', 'resourcepacks', 'kubejs', 'defaultconfigs'];
    for (const dir of targets) {
      const src = path.join(wrapper, dir);
      if (!existsSync(src)) continue;

      const dst = path.join(ROOT, dir);
      rmSync(dst, { recursive: true, force: true });
      mkdirSync(dst, { recursive: true });

      readdirSync(src, { withFileTypes: true }).forEach(e => {
        renameSync(path.join(src, e.name), path.join(dst, e.name));
      });
    }

    /* удаляем сам wrapper / overrides */
    rmSync(wrapper, { recursive: true, force: true });
    log.info('Custom modpack flattened');
  } else {
    log.info('Custom modpack is already flat – no wrapper detected');
  }

  /* 7. Завершаем */
  send(w, 'download-progress', { tag: 'modpack', pct: 100 });
  send(w, 'download-done',     { tag: 'modpack' });
  writeFileSync(sentinel, MODPACK_VER);
  log.info('Custom modpack unpacked');
}

/* ───────── Electron window ───────── */
function createWindow(){
  win=new BrowserWindow({
    width:1100,height:720,frame:false,resizable:false,transparent:true,
    backgroundColor:'#00000000',title:'SexCraft Launcher',
    webPreferences:{
      preload:MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation:true,nodeIntegration:false,webSecurity:true,
      allowRunningInsecureContent:false,
    },
  });
  win.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  win.on('closed',()=>{win=null;});
}
app.whenReady().then(createWindow);
app.on('window-all-closed',()=>process.platform!=='darwin'&&app.quit());
app.on('activate',()=>BrowserWindow.getAllWindows().length===0&&createWindow());

/* ╭── адаптер процента ────────────────╮ */
function toPercent(obj:any):number|undefined{
  if(obj?.type==='assets'&&obj?.current!==undefined&&obj?.task===undefined)
    return undefined;

  if(typeof obj?.downloadedBytes==='number'&&typeof obj?.totalBytes==='number'&&obj.totalBytes>0)
    return obj.downloadedBytes/obj.totalBytes*100;

  if(typeof obj?.task==='number'&&typeof obj?.total==='number'&&obj.total>0)
    return obj.task/obj.total*100;

  if(typeof obj?.current==='number'&&typeof obj?.total==='number'&&obj.total>0)
    return obj.current/obj.total*100;

  if(typeof obj==='number'&&Number.isFinite(obj))
    return obj>1?obj:obj*100;

  if(typeof obj?.percentage==='number')
    return obj.percentage;

  if(typeof obj?.percent==='number')
    return obj.percent;

  if(typeof obj?.progress==='number')
    return obj.progress>1?obj.progress:obj.progress*100;

  if(typeof obj?.downloaded==='number'&&typeof obj?.total==='number'&&obj.total>0)
    return obj.downloaded/obj.total*100;

  if(typeof obj?.value==='number')
    return obj.value>1?obj.value:obj.value*100;

  return undefined;
}
/* ╰──────────────────────────────────────────────╯ */

function debugProgress(tag:string,payload:any){
  if(!DEBUG_PROGRESS) return;
  log.debug(`[DBG] ${tag}: ${JSON.stringify(payload).slice(0,500)}`);
  console.debug(`[DBG] ${tag}:`,payload);
}

/* ───────── IPC: launch-minecraft ───────── */
ipcMain.handle('launch-minecraft',async(_e,opts:LaunchOpts)=>{
  if(!win) return;
  const w=win!;

  try{
    writeServersDat(ROOT,opts.server);

    const java=await ensureJava(w);
    const version=opts.mode==='vanilla'
      ?{number:VANILLA_VERSION,type:'release'}
      :{number:NEOFORGE_VERSION,type:'neoforge'};

    const cfg:any={
      authorization:offlineAuth(opts.username),
      root:ROOT,
      version,
      javaPath:java,
      memory:{min:'8G',max:'12G'},
      detached:true,
      extraArgs:['--server',`${opts.server.ip}:${opts.server.port}`],
    };

    if(opts.mode==='modded'){
      await ensureCustomModpack(w);   /* << заменили вызов */
      await ensureInstallertools(w);
      await ensureProcessorDeps(w);
      cfg.forge=await ensureNeoForgeInstaller(w);
      cfg.forgeAutoInstall=true;
    }

    send(w,'download-start',{tag:'minecraft',url:''});
    send(w,'download-progress',{tag:'minecraft',pct:0});

    const launcher=new Client();
    let hasProgress=false;

    const pushPct=(()=>{
      let last=-1;
      let started=false;
      return(val:number)=>{
        const pct=Math.max(0,Math.min(100,Math.round(val)));
        if(!started){
          if(pct>=100) return;
          started=true;
        }
        if(pct!==last){
          last=pct;
          send(w,'download-progress',{tag:'minecraft',pct});
          if(pct===100) send(w,'download-done',{tag:'minecraft'});
        }
      };
    })();

    const onAnyProgress=(payload:ProgressObj|number,src:string)=>{
      debugProgress(src,payload);
      const v=toPercent(payload);
      if(Number.isFinite(v)){
        hasProgress=true;
        pushPct(v!);
      }else{
        log.warn(`[PROGRESS] Unrecognised payload from ${src}`);
      }
    };

    launcher.on('progress',p=>onAnyProgress(p as ProgressObj,'progress'));
    launcher.on('download-status',s=>onAnyProgress(s as ProgressObj,'download-status'));
    launcher.on('debug',(d:any)=>{
      if(typeof d==='string'&&d.startsWith('Downloading'))
        debugProgress('debug-line',d);
      log.debug('[MC]',d);
    });

    launcher.on('data',d=>process.stdout.write(d));
    launcher.on('error',e=>{
      send(w,'launch-error',e.message);
      log.error('[MC]',e);
    });

    launcher.on('close',()=>{
      if(!hasProgress){
        send(w,'download-progress',{tag:'minecraft',pct:100});
        send(w,'download-done',{tag:'minecraft'});
      }
    });

    log.info(`Launching Minecraft (${opts.mode}) for ${opts.username}`);
    await launcher.launch(cfg);
    log.info('Launcher returned control (game detached)');

  }catch(err:any){
    send(w,'launch-error',err.message??String(err));
    log.error('launch-minecraft IPC error',err);
    throw err;
  }
});

/* ───────── IPC: close-window ───────── */
ipcMain.handle('close-window', async () => {
  log.info('[IPC] close-window');
  if (win && !win.isDestroyed()) win.close();
});

/*  SexCraft Launcher — main (Electron 36 + TypeScript 5.9, 2025‑06‑20, v6 fix‑all)
 *  ✓ Temurin 21 GA        → 3‑step fallback (API → redirect → packages)
 *  ✓ NeoForge 21.1.57     (installer auto‑install)
 *  ✓ Vanilla 1.21.5 / NeoForge 1.21.1 “one‑click”
 *  ✓ Processor‑deps: много‑зеркальный скачиватель
 *  ─────────────────────────────────────────────────────────────────────────────
 *  CHANGELOG
 *  # 2025‑06‑20  v6 fix‑all
 *    • PROC_DEPS: исправлен ‘javadoctors’ → ‘javadoctor’; убран дубль srgutils.
 *    • downloadWithRetry: fallback и на 4xx; эксп. задержка 1 → 2 → 4 s.
 *    • Единый массив MAVEN_REPOS; используется во всех ensure‑*.
 *    • ensureInstallertools/ensureNeoForgeInstaller: добавлен fallback.
 *    • parseGAV: надёжное разбор GAV; поддержка classifier/ext.
 *    • Доп. события прогресса → UI.
 *  ------------------------------------------------------------------------- */

import { app, BrowserWindow, ipcMain } from 'electron';
import {
  createWriteStream, existsSync, mkdirSync, readdirSync,
  rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import AdmZip from 'adm-zip';
import { setTimeout as delay } from 'node:timers/promises';
import { v4 as uuidv4 } from 'uuid';
import { Client } from 'minecraft-launcher-core';
import { writeUncompressed, NBT } from 'prismarine-nbt';

/* ───────────────────── webpack constants ───────────────────── */
declare const MAIN_WINDOW_WEBPACK_ENTRY : string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY : string;

/* ──────────────── версии Minecraft и NeoForge ──────────────── */
const VANILLA_VERSION    = '1.21.5';
const NEOFORGE_VERSION   = '1.21.1';
const NEOFORGE_MAVEN_VER = '21.1.57';
const INSTALLERTOOLS_VER = '2.1.4';

/* ───── Maven зеркала (первое — приоритет) ───── */
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

  /* Javadoctor (fixed groupId) */
  'net.neoforged.javadoctor:gson-io:2.0.17',
  'net.neoforged.javadoctor:spec:2.0.17',        // ← fix

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
const ROOT    = path.join(app.getPath('userData'), '.sexcraft');
const RUNTIME = path.join(ROOT, 'runtime');
const CACHE   = path.join(ROOT, 'cache');
const JAVA_EXE = process.platform === 'win32' ? 'javaw.exe' : 'java';

/* ───────────────────────────── типы ──────────────────────────── */
type OS   = 'windows' | 'mac' | 'linux';
type Arch = 'x64' | 'aarch64';
interface FixedServer { name:string; ip:string; port:number }
interface LaunchOpts  { username:string; mode:'vanilla'|'modded'; server:FixedServer }

/* ╭── helpers ──╮ */
const offlineAuth = (n:string)=>({
  name:n, uuid:uuidv4(),
  access_token:'offline', client_token:'offline',
  user_properties:{}, user_type:'mojang',
});
const send = <T>(w:BrowserWindow, ev:string, payload:T)=>{
  if(!w.isDestroyed()) w.webContents.send(ev, payload);
};
const toPosix = (p:string)=>p.replace(/\\/g,'/');

/* ╭────────────── Temurin helpers ───────────────╮ */
function assetsApi(os:OS, arch:Arch, img:'jre'|'jdk'){
  return `/v3/assets/feature_releases/21/ga?architecture=${arch}`+
         `&heap_size=normal&image_type=${img}&jvm_impl=hotspot&os=${os}&vendor=eclipse`;
}
function redirectApi(os:OS, arch:Arch, img:'jre'|'jdk'){
  return `https://api.adoptium.net/v3/binary/latest/21/ga/${os}/${arch}/${img}/hotspot/normal/eclipse`;
}
function githubToPackages(link:string){
  const m = link.match(/\/download\/([^/]+)\/(OpenJDK.*\.(?:zip|tar\.gz))$/i);
  return m?`https://packages.adoptium.net/artifactory/temurin/21/ga/${m[1]}/${m[2]}`:undefined;
}
async function fetchTemurinLink(os:OS, arch:Arch, img:'jre'|'jdk'){
  return new Promise<string>((res,rej)=>{
    https.get({host:'api.adoptium.net',path:assetsApi(os,arch,img)}, r=>{
      let raw=''; r.setEncoding('utf8');
      r.on('data',c=>raw+=c);
      r.on('end',()=>{
        try{
          const link = JSON.parse(raw)?.[0]?.binary?.package?.link;
          link?res(link):rej(new Error('link not found'));
        }catch{ rej(new Error('bad JSON')); }
      });
    }).on('error',rej);
  });
}
/* ╰──────────────────────────────────────────────╯ */

/* ╭───────── downloader (+retry+mirror) ─────────╮ */
async function downloadWithRetry(
  tag:'jre'|'jdk'|'forge'|'procdep',
  url:string,
  dest:string,
  w:BrowserWindow,
  tries=3,
){
  mkdirSync(path.dirname(dest),{recursive:true});

  let attempt = url;
  for(let i=1;i<=tries;i++){
    try{
      await new Promise<void>((res,rej)=>{
        const file = createWriteStream(dest);
        let done=0,total=0;
        send(w,'download-start',{tag,url:attempt});

        https.get(attempt,r=>{
          /* redirection */
          if(r.statusCode && r.statusCode>=300 && r.statusCode<400 && r.headers.location){
            r.resume();
            downloadWithRetry(tag,r.headers.location,dest,w,tries).then(res).catch(rej);
            return;
          }
          /* error http code */
          if(!r.statusCode || r.statusCode>=400){
            r.resume(); rej(new Error(`GET ${attempt} → ${r.statusCode}`)); return;
          }

          total = Number(r.headers['content-length']??0);
          r.on('data',b=>{
            done += (b as Buffer).length;
            if(total) send(w,'download-progress',{tag,pct:Math.floor(done/total*100)});
          });
          r.pipe(file);
          file.on('finish',()=>file.close(e=>e?rej(e):(send(w,'download-done',{tag}),res())));
        }).on('error',rej);
      });
      return; // success
    }catch(err:any){
      if(existsSync(dest)) rmSync(dest);
      /* если есть ещё попытки — подождать эксп. время и попробовать снова */
      if(i<tries){
        await delay(1000*2**(i-1));
        continue;
      }
      send(w,'download-error',{tag,url:attempt,err:err.message});
      throw err;
    }
  }
}
/* ╰──────────────────────────────────────────────╯ */

/* ───────── ensure Java 21 ───────── */
async function ensureJava(w:BrowserWindow):Promise<string>{
  const bundled = path.join(process.resourcesPath,'jre','bin',JAVA_EXE);
  if(existsSync(bundled)) return bundled;

  mkdirSync(RUNTIME,{recursive:true});
  mkdirSync(CACHE,{recursive:true});

  const cached = readdirSync(RUNTIME,{withFileTypes:true})
    .find(d=>d.isDirectory() && /(jre|jdk)-21/.test(d.name));
  if(cached) return path.join(RUNTIME,cached.name,'bin',JAVA_EXE);

  const os:OS   = process.platform==='win32' ? 'windows'
                : process.platform==='darwin'? 'mac' : 'linux';
  const arch:Arch = process.arch==='arm64' ? 'aarch64' : 'x64';
  const zip = path.join(CACHE,'temurin-runtime.zip');

  const tryDownload = async(img:'jre'|'jdk')=>{
    let link:string;
    try{ link = await fetchTemurinLink(os,arch,img); }
    catch{ link = redirectApi(os,arch,img); }
    await downloadWithRetry(img,link,zip,w);
  };

  try{ await tryDownload('jre'); }
  catch(e:any){
    /* если JRE отсутствует → пробуем JDK */
    const mirror = githubToPackages(e.message??'');
    if(mirror){ await downloadWithRetry('jdk',mirror,zip,w); }
    else{ console.warn('[Temurin] JRE 404 → fallback JDK'); await tryDownload('jdk'); }
  }

  /* распаковка */
  send(w,'download-progress',{tag:'jre',pct:95});
  const z = new AdmZip(zip);
  const entries = z.getEntries();
  for(let i=0;i<entries.length;i++){
    z.extractEntryTo(entries[i],RUNTIME,true,true);
    if(i%Math.ceil(entries.length/5)===0){
      send(w,'download-progress',{tag:'jre',pct:95+Math.floor(i/entries.length*4)});
    }
  }
  send(w,'download-done',{tag:'jre'});

  const unpacked = readdirSync(RUNTIME).find(d=>d.startsWith('jre')||d.startsWith('jdk'));
  if(!unpacked) throw new Error('Temurin unpack failed');
  return path.join(RUNTIME,unpacked,'bin',JAVA_EXE);
}

/* ───────── installertools ───────── */
async function ensureInstallertools(w:BrowserWindow){
  const jar = path.join(
    ROOT,'libraries','net','neoforged','installertools','installertools',
    INSTALLERTOOLS_VER,`installertools-${INSTALLERTOOLS_VER}.jar`,
  );
  if(existsSync(jar)) return jar;

  const rel = `net/neoforged/installertools/installertools/${INSTALLERTOOLS_VER}`+
              `/installertools-${INSTALLERTOOLS_VER}.jar`;

  for(const repo of MAVEN_REPOS){
    try{
      await downloadWithRetry('forge',`${repo}/${rel}`,jar,w);
      return jar;
    }catch{/* пробуем след. репозиторий */}
  }
  throw new Error('installertools download failed');
}

/* ──────────── processor‑deps ──────────── */
interface GAV{group:string;artifact:string;version:string;classifier?:string;ext:string}
function parseGAV(raw:string):GAV{
  const [coords,ext = 'jar'] = raw.split('@',2);
  const parts = coords.split(':');
  if(parts.length<3 || parts.length>4) throw new Error(`Bad GAV: ${raw}`);
  const [group,artifact,version] = parts;
  const classifier = parts[3];
  return {group,artifact,version,classifier,ext};
}
async function ensureProcessorDeps(w:BrowserWindow){
  await Promise.all(PROC_DEPS.map(async raw=>{
    const {group,artifact,version,classifier,ext} = parseGAV(raw);
    const relDir = path.join(...group.split('.'),artifact,version);
    const file   = `${artifact}-${version}${classifier?`-${classifier}`:''}.${ext}`;
    const dst    = path.join(ROOT,'libraries',relDir,file);
    if(existsSync(dst)) return;

    const relPathPosix = `${toPosix(relDir)}/${encodeURIComponent(file)}`;

    for(const repo of MAVEN_REPOS){
      try{
        await downloadWithRetry('procdep',`${repo}/${relPathPosix}`,dst,w);
        return;          // success
      }catch{/* → следующее зеркало */}
    }
    throw new Error(`Failed to download ${raw}`);
  }));
}

/* ───────── NeoForge installer ───────── */
async function ensureNeoForgeInstaller(w:BrowserWindow){
  const jar = path.join(CACHE,`neoforge-${NEOFORGE_MAVEN_VER}-installer.jar`);
  if(existsSync(jar)) return jar;

  const rel = `net/neoforged/neoforge/${NEOFORGE_MAVEN_VER}`+
              `/neoforge-${NEOFORGE_MAVEN_VER}-installer.jar`;

  for(const repo of MAVEN_REPOS){
    try{
      await downloadWithRetry('forge',`${repo}/${rel}`,jar,w);
      return jar;
    }catch{/* пробуем след. */}
  }
  throw new Error('NeoForge installer download failed');
}

/* ───────── write servers.dat ───────── */
function writeServersDat(root:string,s:FixedServer){
  const nbt:NBT = {
    type:'compound',name:'',value:{
      servers:{type:'list',value:{type:'compound',value:[{
        name:{type:'string',value:s.name},
        ip  :{type:'string',value:`${s.ip}:${s.port}`},
        icon:{type:'string',value:''},
        acceptTextures:{type:'byte',value:0},
        hideAddress   :{type:'byte',value:0},
      }]}},
    },
  } as any;
  mkdirSync(root,{recursive:true});
  writeFileSync(path.join(root,'servers.dat'),writeUncompressed(nbt));
}

/* ───────── Electron window ───────── */
let win:BrowserWindow|null = null;
function createWindow(){
  win = new BrowserWindow({
    width:1100,height:720,frame:false,resizable:false,transparent:true,
    backgroundColor:'#00000000',title:'SexCraft Launcher',
    webPreferences:{
      preload:MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation:true,nodeIntegration:false,webSecurity:app.isPackaged,
    },
  });
  win.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  win.on('closed',()=>{ win=null; });
}
app.whenReady().then(createWindow);
app.on('window-all-closed',()=>process.platform!=='darwin'&&app.quit());
app.on('activate',()=>BrowserWindow.getAllWindows().length===0&&createWindow());

/* ───────── IPC: launch Minecraft ───────── */
ipcMain.handle('launch-minecraft',async(_e,opts:LaunchOpts)=>{
  if(!win) return;
  try{
    writeServersDat(ROOT,opts.server);

    const java = await ensureJava(win);
    const version = opts.mode==='vanilla'
      ? {number:VANILLA_VERSION ,type:'release'}
      : {number:NEOFORGE_VERSION,type:'neoforge'};

    const cfg:any = {
      authorization:offlineAuth(opts.username),
      root:ROOT,version,javaPath:java,
      memory:{min:'2G',max:'4G'},detached:true,
      extraArgs:['--server',`${opts.server.ip}:${opts.server.port}`],
    };

    if(opts.mode==='modded'){
      await ensureInstallertools(win);
      await ensureProcessorDeps(win);
      cfg.forge               = await ensureNeoForgeInstaller(win);
      cfg.forgeAutoInstall    = true;
      cfg.neoforgeAutoInstall = true;
    }

    const launcher = new Client();
    launcher.on('download-status',s=>send(win!,'download-status',s));
    launcher.on('debug',d=>console.log('[debug]',d));
    launcher.on('data',d=>process.stdout.write(d));
    launcher.on('error',e=>send(win!,'launch-error',e.message));
    await launcher.launch(cfg);
  }catch(err:any){
    send(win!,'launch-error',err.message??String(err));
    throw err;
  }
});

/* ───────── IPC: close window ───────── */
ipcMain.handle('close-window',()=>win?.close());

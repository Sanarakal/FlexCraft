/* ──────────────────────────────────────────────────────────────
 *  SexCraft Launcher — main (Electron 30 + TypeScript 5.5)
 *  ✓ Temurin 21 GA  → авторитетный JRE/JDK + fallback на Artifactory
 *  ✓ Forge‑installer 1.21.1‑52.1.0 (forgeAutoInstall = true)
 *  ✓ Vanilla 1.21.5 и Forge 1.21.1 запускаются «с нуля»
 *  ✓ Автоконнект на фиксированный сервер без лишних кликов
 *  ✓ Продвинутый retry & mirror logic (GitHub 5xx → packages.adoptium.net)
 *  ✓ Fallback: если JRE 21 GA отсутствует (404) — скачиваем JDK 21 GA
 *  ✓ ESM‑friendly, строгий TS, async/await везде
 * ────────────────────────────────────────────────────────────── */

import { app, BrowserWindow, ipcMain } from 'electron';
import fs, { WriteStream }             from 'fs';
import path                            from 'path';
import https                           from 'https';
import AdmZip                          from 'adm-zip';
import { setTimeout as delay }         from 'timers/promises';
import { v4 as uuidv4 }                from 'uuid';
import { Client }                      from 'minecraft-launcher-core';
import { writeUncompressed, NBT }      from 'prismarine-nbt';

/* ─ webpack const ─ */
declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

/* ─ versions ─ */
const VANILLA_VERSION = '1.21.5';
const FORGE_MAVEN_VER = '1.21.1-52.1.0';
const FORGE_VERSION   = '1.21.1';

/* ─ dirs ─ */
const ROOT      = path.join(app.getPath('appData'), '.sexcraft');
const RUNTIME   = path.join(ROOT, 'runtime');
const CACHE     = path.join(ROOT, 'cache');
const JAVA_EXE  = process.platform === 'win32' ? 'javaw.exe' : 'java';

/* ─ helpers ─ */
type OS   = 'windows' | 'mac' | 'linux';
type Arch = 'x64' | 'aarch64';

interface FixedServer { name: string; ip: string; port: number }
interface LaunchOpts  { username: string; mode: 'vanilla'|'modded'; server: FixedServer }

const offlineAuth = (name: string) => ({
  name,
  uuid         : uuidv4(),
  access_token : 'fake',
  client_token : 'fake',
  user_properties: {},
  user_type    : 'mojang',
});

/* ╭──────────── Adoptium API helpers ───────────╮ */
function assetsApi(os: OS, arch: Arch, img: 'jre'|'jdk') {
  return `/v3/assets/feature_releases/21/ga?architecture=${arch}` +
         `&heap_size=normal&image_type=${img}&jvm_impl=hotspot` +
         `&os=${os}&vendor=eclipse`;
}
function redirectApi(os: OS, arch: Arch, img: 'jre'|'jdk') {
  return `https://api.adoptium.net/v3/binary/latest/21/ga/${os}/${arch}/${img}` +
         `/hotspot/normal/eclipse`;
}
/** GitHub‑ссылка → packages.adoptium.net */
function githubToPackages(link: string): string | null {
  const m = link.match(/\/download\/([^/]+)\/(OpenJDK.*\.zip)$/i);
  return m ? `https://packages.adoptium.net/artifactory/temurin/21/ga/${m[1]}/${m[2]}` : null;
}
async function fetchTemurinLink(os: OS, arch: Arch, img: 'jre'|'jdk'): Promise<string> {
  return new Promise((res, rej) => {
    https.get({ host: 'api.adoptium.net', path: assetsApi(os, arch, img) }, r => {
      let raw = '';
      r.setEncoding('utf8');
      r.on('data', c => (raw += c));
      r.on('end', () => {
        try {
          const link: string = JSON.parse(raw)?.[0]?.binary?.package?.link;
          link ? res(link) : rej(new Error('link not found'));
        } catch { rej(new Error('bad JSON')); }
      });
    }).on('error', rej);
  });
}
/* ╰──────────────────────────────────────────────╯ */

/* ╭──────────── downloader (+IPC +retry +mirror) ───────────╮ */
function downloadRaw(
  type: 'jre' | 'forge' | 'jdk',
  url: string,
  dest: string,
  win: BrowserWindow,
): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const emit = (ev: string, pct?: number) =>
      win.webContents.send(ev, { type, ...(pct !== undefined ? { pct } : {}) });

    const doGet = (link: string) => {
      https.get(link, r => {
        if (r.statusCode && r.statusCode >= 300 && r.statusCode < 400 && r.headers.location)
          return doGet(r.headers.location);
        if (!r.statusCode || r.statusCode >= 400)
          return reject(new Error(`GET ${link} → ${r.statusCode}`));

        const len = Number(r.headers['content-length'] ?? 0);
        let done = 0;
        const file: WriteStream = fs.createWriteStream(dest);
        emit('download-start');
        r.on('data', b => { done += (b as Buffer).length; if (len) emit('download-progress', Math.round(done / len * 100)); });
        r.pipe(file);
        file.on('finish', () => file.close(e => e ? reject(e) : (emit('download-done'), resolve())));
      }).on('error', reject);
    };
    doGet(url);
  });
}
async function downloadWithRetry(
  type: 'jre' | 'forge' | 'jdk',
  url: string,
  dest: string,
  win: BrowserWindow,
  tries = 3,
) {
  let lastErr: unknown = null;
  let altTried = false;

  for (let i = 0; i < tries; i++) {
    try { await downloadRaw(type, url, dest, win); return; }
    catch (e) {
      lastErr = e;
      /* GitHub перегружен (5xx) → переключаемся на packages.adoptium.net */
      const code = /→ (\d+)/.exec((e as Error).message)?.[1];
      if (!altTried && code && Number(code) >= 500) {
        const mirror = githubToPackages(url);
        if (mirror) { console.warn('[DL] GitHub 5xx → mirror'); url = mirror; altTried = true; continue; }
      }
      if (i < tries - 1) {
        console.warn(`[DL] retry ${i + 1} — ${(e as Error).message}`);
        await delay(1000 * (i + 1));
      }
    }
  }
  throw lastErr;
}
/* ╰──────────────────────────────────────────────╯ */

/* ─── ensure Temurin 21 (JRE or JDK) ─── */
async function ensureJava(win: BrowserWindow): Promise<string> {
  // 1) bundled with the app (packed into resources)
  const bundled = path.join(process.resourcesPath, 'jre', 'bin', JAVA_EXE);
  if (fs.existsSync(bundled)) return bundled;

  // 2) previously downloaded runtime
  const local = (() => {
    try {
      const sub = fs.readdirSync(RUNTIME).find(d => /(jre|jdk)-21/.test(d));
      return sub ? path.join(RUNTIME, sub, 'bin', JAVA_EXE) : '';
    } catch { return ''; }
  })();
  if (local && fs.existsSync(local)) return local;

  // 3) fresh download (pref JRE → fallback JDK)
  const os: OS   = process.platform === 'win32' ? 'windows'
                  : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch: Arch = process.arch === 'arm64' ? 'aarch64' : 'x64';

  const zip = path.join(CACHE, 'temurin-runtime.zip');

  const attempt = async (img: 'jre'|'jdk') => {
    let url: string;
    try   { url = await fetchTemurinLink(os, arch, img); }
    catch  { url = redirectApi(os, arch, img); }
    await downloadWithRetry(img, url, zip, win);
  };

  try { await attempt('jre'); }
  catch (e) {
    const is404 = /→ 404/.test((e as Error).message);
    if (!is404) throw e; // network etc.
    console.warn('[Temurin] JRE 404 — switching to JDK build');
    await attempt('jdk');
  }

  new AdmZip(zip).extractAllTo(RUNTIME, true);
  const dir = fs.readdirSync(RUNTIME).find(d => d.startsWith('jre') || d.startsWith('jdk'));
  if (!dir) throw new Error('Runtime unpack failed');
  return path.join(RUNTIME, dir, 'bin', JAVA_EXE);
}

/* ─── ensure Forge installer ─── */
async function ensureForgeInstaller(win: BrowserWindow): Promise<string> {
  const prod = path.join(process.resourcesPath, 'forge', `forge-${FORGE_MAVEN_VER}-installer.jar`);
  if (fs.existsSync(prod)) return prod;

  const jar = path.join(CACHE, `forge-${FORGE_MAVEN_VER}-installer.jar`);
  if (fs.existsSync(jar)) return jar;

  const url = `https://maven.minecraftforge.net/net/minecraftforge/forge` +
              `/${FORGE_MAVEN_VER}/forge-${FORGE_MAVEN_VER}-installer.jar`;
  await downloadWithRetry('forge', url, jar, win);
  return jar;
}

/* ─── write servers.dat ─── */
function writeServersDat(root: string, s: FixedServer) {
  const nbt: NBT = {
    type: 'compound', name: '',
    value: {
      servers: {
        type: 'list', value: { type: 'compound', value: [{
          name  : { type: 'string', value: s.name },
          ip    : { type: 'string', value: `${s.ip}:${s.port}` },
          icon  : { type: 'string', value: '' },
          acceptTextures: { type: 'byte', value: 0 },
          hideAddress   : { type: 'byte', value: 0 },
        }] },
      },
    },
  } as any;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'servers.dat'), writeUncompressed(nbt));
}

/* ─── Electron window ─── */
let win: BrowserWindow | null = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 720, frame: false, resizable: false,
    transparent: true, backgroundColor: '#00000000', title: 'SexCraft Launcher',
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: app.isPackaged,
    },
  });
  win.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  win.on('closed', () => (win = null));
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());

/* ─── IPC: launch-minecraft ─── */
ipcMain.handle('launch-minecraft', async (_e, opts: LaunchOpts) => {
  if (!win) return;
  console.group('[launch]');
  writeServersDat(ROOT, opts.server);

  const java = await ensureJava(win);
  const version = opts.mode === 'vanilla'
        ? { number: VANILLA_VERSION, type: 'release' }
        : { number: FORGE_VERSION , type: 'forge'   };

  const optsMC: any = {
    authorization: offlineAuth(opts.username),
    root: ROOT,
    version,
    javaPath: java,
    memory: { min: '2G', max: '4G' },
    detached: true,
    extraArgs: ['--server', `${opts.server.ip}:${opts.server.port}`], // автоконнект
  };
  if (opts.mode === 'modded') {
    optsMC.forge            = await ensureForgeInstaller(win);
    optsMC.forgeAutoInstall = true;
  }

  console.log('launchOpts:', JSON.stringify(
    { ...optsMC, authorization: { name: opts.username, uuid: '…' } }, null, 2));

  const launcher = new Client();
  launcher.on('debug', d => console.log('[debug]', d));
  launcher.on('data', d => process.stdout.write(d));
  // делимся прогрессом скачивания с UI (assets, libs, файлы Forge и т.д.)
  launcher.on('download-status', (s: any) => win?.webContents.send('download-status', s));

  try {
    await launcher.launch(optsMC);
  } finally {
    console.groupEnd();
  }
});

/* ─── IPC: close-window ─── */
ipcMain.handle('close-window', () => win?.close());

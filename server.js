/**
 * 在线听歌 - 本地服务器
 * 作用：
 *  1. 托管 index.html
 *  2. 代理网易云公开接口（搜索 / 热歌榜 / 实时换播放链），绕开浏览器跨域限制
 *  3. VIP 歌换链由本地 NeteaseCloudMusicApi 提供（破解加密协议，绕过 VIP 限制）
 *  依赖: npm install NeteaseCloudMusicApi + 后台运行 node node_modules/NeteaseCloudMusicApi/app.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 8125;
const IS_WIN = process.platform === 'win32';
const ROOT = __dirname;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HEADERS = { Referer: 'https://music.163.com', 'User-Agent': UA };

/* ---------------- 本地 NeteaseCloudMusicApi ---------------- */
// npm install NeteaseCloudMusicApi 后 node node_modules/NeteaseCloudMusicApi/app.js 启动
const NCM_BASE = process.env.NCM_BASE || 'http://127.0.0.1:3000';
const NCM_APP = path.join(ROOT, 'node_modules', 'NeteaseCloudMusicApi', 'app.js');
let ncmStarting = null;
let ncmChild = null;

async function ncmAlive() {
  try {
    const r = await fetch(NCM_BASE + '/search?keywords=a&limit=1', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch (e) { return false; }
}

/** 确保本地 NCM 在线；不在线就自己拉起子进程（单入口启动，不依赖第二个窗口） */
async function ensureNCM() {
  if (process.env.NO_NCM === '1') return false;   // 云端部署不带本地 NCM，换链走公共音源
  if (await ncmAlive()) return true;
  if (ncmStarting) return ncmStarting;
  if (!fs.existsSync(NCM_APP)) {
    console.log('[NCM] 未安装，请先执行: npm install NeteaseCloudMusicApi');
    return false;
  }

  ncmStarting = (async () => {
    console.log('[NCM] 正在启动 VIP 换链服务…');
    const child = spawn(process.execPath, [NCM_APP], {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { const s = String(d).trim(); if (s) console.log('[NCM] ' + s.slice(0, 160)); });
    child.stderr.on('data', d => { const s = String(d).trim(); if (s) console.log('[NCM!] ' + s.slice(0, 160)); });
    child.on('exit', c => { console.log('[NCM] 进程退出 code=' + c); ncmStarting = null; });
    ncmChild = child;  // 主服务关闭时一并结束，避免残留进程占用 3000

    for (let i = 0; i < 40; i++) {  // 最多等 20 秒
      await new Promise(r => setTimeout(r, 500));
      if (await ncmAlive()) { console.log('[NCM] ✅ 已就绪 127.0.0.1:3000'); return true; }
    }
    console.log('[NCM] ❌ 启动超时，VIP 歌将无法播放');
    ncmStarting = null;
    return false;
  })();

  return ncmStarting;
}

/* ---------------- 第三方音源（VIP 歌取整曲） ---------------- */
// NCM 匿名态对 VIP 歌只给 30s 试听（freeTrialInfo），这里用聚合接口换整曲
// ① Meting 公共实例优先：302 直跳网易云 CDN，能拿到 320k 整曲
// ② GD Studio 兜底（Cloudflare 443 本机经常连不上，只留一次短超时尝试）
const METING_BASE = 'https://api.qijieya.cn/meting/';
const GDS_BASE = 'https://music-api.gdstudio.xyz/api.php';
const gdCache = new Map();          // id -> { url, at }
const GD_TTL = 8 * 60 * 1000;

async function metingUrl(id) {
  try {
    const r = await fetch(METING_BASE + '?type=url&server=netease&id=' + encodeURIComponent(id),
      { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (loc && /^https?:\/\//.test(loc)) return loc;
    }
  } catch (e) { /* 换下一个源 */ }
  return null;
}

async function gdUrlRaw(id) {
  try {
    const r = await fetch(GDS_BASE + '?types=url&source=netease&id=' + id + '&br=320',
      { signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const d = await r.json();
      if (d && d.url) return d.url;
    }
  } catch (e) { /* 不可达就放弃 */ }
  return null;
}

async function gdUrl(id) {
  const key = String(id);
  const c = gdCache.get(key);
  if (c && Date.now() - c.at < GD_TTL) return c.url;
  const url = (await metingUrl(key)) || (await gdUrlRaw(key));
  if (url) gdCache.set(key, { url, at: Date.now() });  // 只缓存成功，失败下次重试
  else gdCache.delete(key);
  return url;
}

/* ---------------- QQ 音乐补充源（Vkeys 公共接口，补网易云没有的版权歌） ---------------- */
const VK_BASE = 'https://api.vkeys.cn/v2/music';
const vkCache = new Map();

function vkDur(s) {
  const m = /(?:(\d+)分)?(?:(\d+)秒)?/.exec(String(s || ''));
  if (!m) return 0;
  return (+(m[1] || 0)) * 60 + (+(m[2] || 0));
}

async function vkFetch(path) {
  const r = await fetch(VK_BASE + path, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/** QQ 音乐搜索（周杰伦等网易云没有版权的歌靠它补全） */
async function vkSearch(kw) {
  try {
    const d = await vkFetch('/tencent?word=' + encodeURIComponent(kw) + '&num=10');
    const arr = (d && d.data) || [];
    return (Array.isArray(arr) ? arr : []).map(x => ({
      wyId: x.id,
      src: 'tencent',
      name: x.song || x.name || '',
      artist: x.singer || '未知歌手',
      album: x.album || '',
      cover: toHttps(x.cover) || '',
      dur: String(x.pay || '').includes('付费') ? 60 : vkDur(x.interval),
      // 付费歌匿名接口只下发 60s 试听，标出来免得误以为能听整首
      tag: String(x.pay || '').includes('付费') ? 'QQ试听60s' : 'QQ',
      locked: false,
      trial: false
    })).filter(t => t.name);
  } catch (e) {
    console.log('[VK] 搜索失败:', e.message);
    return [];
  }
}

/** QQ 音乐换链（付费歌匿名只能拿到 60s 试听片段） */
async function vkUrl(id) {
  const key = 'vk:' + id;
  const c = vkCache.get(key);
  if (c && Date.now() - c.at < 8 * 60 * 1000) return c.url;
  let url = null;
  try {
    const d = await vkFetch('/tencent?id=' + encodeURIComponent(id));
    url = (d && d.data && d.data.url) || null;
  } catch (e) { console.log('[VK] 换链失败:', e.message); }
  vkCache.set(key, { url, at: Date.now() });
  return url;
}

/** QQ 音乐歌词（Vkeys 自带，比在网易云里找翻唱靠谱） */
async function vkLyric(id) {
  try {
    const d = await vkFetch('/tencent/lyric?id=' + encodeURIComponent(id));
    return { lrc: (d && d.data && d.data.lrc) || '' };
  } catch (e) {
    console.log('[VK] 歌词失败:', e.message);
    return { lrc: '' };
  }
}

/* ---------------- 网易云相关 ---------------- */

async function wyGet(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error('上游响应 ' + res.status);
  return res.json();
}

/** 批量换取播放链：返回 id → { url, trial }。
 *  trial=true 表示 NCM 只给了 30s 试听片段（VIP 歌），播放时会再走第三方音源换整曲 */
async function fetchUrlMap(ids) {
  const nums = ids.map(Number).filter(n => Number.isFinite(n));
  if (!nums.length) return new Map();
  const urlMap = new Map();

  // 优先: NeteaseCloudMusicApi (本地代理，能破解加密协议)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(NCM_BASE + '/song/url?id=' + nums.join(','), { signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const d = await r.json();
        (d.data || []).forEach(item => {
          if (item && item.url) urlMap.set(item.id, { url: item.url, trial: !!item.freeTrialInfo });
        });
        if (urlMap.size > 0) return urlMap;
        break; // NCM 在线但确实无版权，别重复拉
      }
      break;
    } catch (e) {
      if (attempt === 0) { await ensureNCM(); continue; }  // 自动拉起并重试一次
      console.log('[NCM] 不可用，回退官方接口:', e.message);
    }
  }

  // Fallback: 网易云官方（VIP 歌会返回 null）
  try {
    const data = await wyGet(
      'https://music.163.com/api/song/enhance/player/url' +
      '?ids=' + encodeURIComponent(JSON.stringify(nums)) + '&br=320000'
    );
    (data.data || []).forEach(d => { if (d.url) urlMap.set(d.id, { url: d.url, trial: false }); });
  } catch (e) {
    console.log('[官方] 换链失败:', e.message);
  }
  return urlMap;
}

/** 过滤出当前可完整播放的歌曲（带 _url） */
async function filterPlayable(tracks) {
  if (!tracks.length) return [];
  const urlMap = await fetchUrlMap(tracks.map(t => t.id));
  return tracks.filter(t => urlMap.has(t.id)).map(t => {
    t._url = urlMap.get(t.id).url;
    return t;
  });
}

/** 批量标注：locked=完全拿不到链；trial=VIP 试听（播放时自动换整曲），两者都可播 */
async function annotateLocked(tracks) {
  if (!tracks.length) return [];
  const urlMap = await fetchUrlMap(tracks.map(t => t.id));
  return tracks.map(t => {
    const m = mapTrack(t);
    const hit = urlMap.get(t.id);
    m.locked = !hit;
    m.trial = !!(hit && hit.trial);
    m.tag = m.locked ? 'VIP' : (m.trial ? 'VIP·换源' : '完整');
    if (hit && !hit.trial) m._url = hit.url;
    return m;
  });
}

function mapTrack(t) {
  // 兼容两种字段：完整版 artists/album 与 v6 接口的精简版 ar/al
  const artists = t.artists || t.ar || [];
  const album = t.album || t.al || {};
  return {
    wyId: t.id,
    name: t.name,
    artist: artists.map(a => a.name).join(' / ') || '未知歌手',
    album: album.name || '',
    cover: toHttps(album.blurPicUrl || album.picUrl) ||
           toHttps(artists[0] && artists[0].img1v1Url) || '',
    dur: Math.round((t.duration || t.dt || 0) / 1000),
    tag: '完整'
  };
}

function toHttps(u) {
  return u ? u.replace(/^http:\/\//, 'https://') : '';
}

let lastSearchErr = '';

/** 网易云搜索：云端机房 IP 偶尔会被 search/get/web 拒绝，按顺序试多个入口 */
async function wySearchRaw(kw) {
  const q = encodeURIComponent(kw);
  const tries = [
    () => wyGet('https://music.163.com/api/search/get/web?s=' + q + '&type=1&limit=50&offset=0'),
    () => fetch('https://music.163.com/api/cloudsearch/pc', {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 's=' + q + '&type=1&limit=50&offset=0',
      signal: AbortSignal.timeout(10000)
    }).then(r => r.json()),
    () => wyGet('https://music.163.com/api/search/get?s=' + q + '&type=1&limit=50&offset=0')
  ];
  for (let i = 0; i < tries.length; i++) {
    try {
      const d = await tries[i]();
      const songs = (d && d.result && d.result.songs) || [];
      if (songs.length) { lastSearchErr = ''; return songs; }
      lastSearchErr = 'try' + i + ' 空结果';
    } catch (e) {
      lastSearchErr = 'try' + i + ' ' + (e.message || e);
    }
  }
  return [];
}

/** 搜索：网易云结果 + QQ 音乐补充（补周杰伦等网易云没有版权的原唱） */
async function wySearch(kw) {
  const [wySongs, vkList] = await Promise.all([wySearchRaw(kw), vkSearch(kw)]);

  const songs = wySongs.slice(0, 30);
  const urlMap = await fetchUrlMap(songs.map(s => s.id));
  const list = songs.map(t => {
    const m = mapTrack(t);
    const hit = urlMap.get(t.id);
    m.src = 'netease';
    m.locked = !hit;
    m.trial = !!(hit && hit.trial);
    m.tag = m.locked ? 'VIP' : (m.trial ? 'VIP·换源' : '完整');
    return m;
  });

  // 合并 QQ 结果：同歌名 + 歌手名有交集的不重复展示；插到前 5 条之后，保证一眼能看到
  const norm = s => String(s || '').toLowerCase().replace(/[\s()（）·,，.。\-—_「」『』"']/g, '');
  const seen = new Set(list.map(s => norm(s.name) + '|' + norm(s.artist)));
  const extra = [];
  for (const t of vkList) {
    const k = norm(t.name) + '|' + norm(t.artist);
    if (seen.has(k)) continue;
    seen.add(k);
    extra.push(t);
  }
  if (extra.length) list.splice(Math.min(5, list.length), 0, ...extra);
  return list;
}

/** 批量检测哪些 ID 当前可完整播放（收藏页蹲限免用：只查状态，不下载音频） */
async function wyCheck(ids) {
  const nums = ids.map(Number).filter(n => Number.isFinite(n));
  const out = [];
  for (let i = 0; i < nums.length; i += 100) {
    const map = await fetchUrlMap(nums.slice(i, i + 100));
    map.forEach((url, id) => out.push(id));
  }
  return out;
}

/** 热门歌池：合并多个榜单去重，批量换链过滤，按天缓存，分批返回 */
/* 42 个官方榜单，顺序即优先级：热度榜在最前（合并去重先出现者优先），风格/外语在后 */
const CHARTS = [
  { id: 3778678,    name: '热歌榜' },
  { id: 19723756,   name: '飙升榜' },
  { id: 8246775932, name: '实时热度榜' },
  { id: 6723173524, name: '网络热歌榜' },
  { id: 12344472377, name: '黑胶VIP限免榜' },
  { id: 3779629,    name: '新歌榜' },
  { id: 18176153161, name: '实时分享榜' },
  { id: 5338990334, name: '潜力爆款榜' },
  { id: 13372522766, name: '潮流风向榜' },
  { id: 6688069460, name: '听歌识曲榜' },
  { id: 2884035,    name: '原创榜' },
  { id: 21845217,   name: 'KTV唛榜' },
  { id: 6886768100, name: '中文慢摇DJ榜' },
  { id: 991319590,  name: '中文说唱榜' },
  { id: 5059633707, name: '摇滚榜' },
  { id: 5059642708, name: '国风榜' },
  { id: 5059661515, name: '民谣榜' },
  { id: 71385702,   name: 'ACG榜' },
  { id: 9651277674, name: 'AI歌曲榜' },
  { id: 2809513713, name: '欧美热歌榜' },
  { id: 2809577409, name: '欧美新歌榜' },
  { id: 12225155968, name: '欧美R&B榜' },
  { id: 60198,      name: 'Billboard榜' },
  { id: 180106,     name: 'UK排行榜' },
  { id: 745956260,  name: '韩语榜' },
  { id: 5059644681, name: '日语榜' },
  { id: 7095271308, name: '泰语榜' },
  { id: 6732051320, name: '俄语榜' },
  { id: 6732014811, name: '越南语榜' },
  { id: 1978921795, name: '电音榜' },
  { id: 14028249541, name: '全球说唱榜' },
  { id: 3001835560, name: 'ACG动画榜' },
  { id: 3001795926, name: 'ACG游戏榜' },
  { id: 3001890046, name: 'VOCALOID榜' },
  { id: 71384707,   name: '古典榜' },
  { id: 3812895,    name: 'Beatport电子榜' },
  { id: 60131,      name: 'Oricon榜' },
  { id: 27135204,   name: '法国NRJ榜' },
  { id: 8661209031, name: '乐夏榜' },
  { id: 7775163417, name: '赏音榜' },
  { id: 12911589513, name: '音乐合伙人热歌榜' },
  { id: 7356827205, name: 'BEAT排行榜' }
];
const BATCH_SIZE = 30;
const POOL_TTL = 60 * 60 * 1000;
let hotPool = { list: null, day: '', at: 0, promise: null };

/** 上海时区的今天（YYYY-MM-DD），用于跨天强制刷新歌池 */
function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

/* 简单并发限制器：同时最多 limit 个任务 */
async function runPool(items, limit, worker) {
  const ret = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return ret;
}

/* 抓单个榜单：v6 接口返回全量 trackIds（老接口多数新榜只给 10 首预览） */
async function fetchChart(c) {
  const d = await wyGet('https://music.163.com/api/v6/playlist/detail?id=' + c.id + '&n=1000');
  const pl = d.playlist || {};
  const have = new Map();
  (pl.tracks || []).forEach(t => have.set(t.id, t));
  return { have, allIds: (pl.trackIds || []).map(x => x.id).filter(Boolean) };
}

/* 按 ID 批量补歌曲详情（歌手/专辑/封面），每批最多 100 */
async function fetchSongsByIds(ids) {
  const d = await wyGet(
    'https://music.163.com/api/song/detail?ids=' + encodeURIComponent(JSON.stringify(ids))
  );  return d.songs || [];
}

/* 分类补充：按分类关键词搜热门歌单，把歌单里的歌并进榜单池。
 * 官方榜单往往只有几十上百首（日语榜就 100 首），搜得到的好歌进不了分类页，这里补齐 */
const EXTRA_LIMIT = 120;   // 每个分类额外补多少首
const EXTRA_PLAYLISTS = 4; // 取前几个热门歌单

async function fetchCategoryExtra(kw, exclude) {
  try {
    const d = await wyGet('https://music.163.com/api/search/get/web?s=' +
      encodeURIComponent(kw) + '&type=1000&limit=6&offset=0');
    const pids = ((d.result && d.result.playlists) || []).map(p => p && p.id).filter(Boolean);
    const ids = [];
    const seen = new Set(exclude);
    for (const pid of pids.slice(0, EXTRA_PLAYLISTS)) {
      if (ids.length >= EXTRA_LIMIT) break;
      try {
        const pl = await wyGet('https://music.163.com/api/v6/playlist/detail?id=' + pid + '&n=1000');
        for (const x of (((pl.playlist || {}).trackIds) || [])) {
          if (ids.length >= EXTRA_LIMIT) break;
          if (!x || !x.id || seen.has(x.id)) continue;
          seen.add(x.id);
          ids.push(x.id);
        }
      } catch (e) { /* 单个歌单失败不影响 */ }
    }
    return ids;
  } catch (e) {
    console.log('[分类补充] 搜索失败:', kw, e.message);
    return [];
  }
}

async function buildHotPool() {
  const t0 = Date.now();
  // 抓榜单限并发（最多 6 个），单个失败不影响其它
  const charts = await runPool(CHARTS, 6, c => fetchChart(c).catch(() => null));
  // 按 CHARTS 优先级顺序去重；已带详情的直接用，其余收集 ID 后批量补详情
  const seen = new Set();
  const orderedIds = [];
  const detailMap = new Map();
  const missingIds = [];
  charts.forEach(r => {
    if (!r) return;
    r.have.forEach((t, id) => {
      if (!seen.has(id)) { seen.add(id); orderedIds.push(id); detailMap.set(id, t); }
    });
    r.allIds.forEach(id => {
      if (!seen.has(id)) { seen.add(id); orderedIds.push(id); missingIds.push(id); }
    });
  });
  const detailChunks = [];
  for (let i = 0; i < missingIds.length; i += 100)
    detailChunks.push(missingIds.slice(i, i + 100));
  const detailGroups = await runPool(detailChunks, 5, ch => fetchSongsByIds(ch).catch(() => []));
  detailGroups.flat().forEach(s => detailMap.set(s.id, s));
  const tracks = orderedIds.map(id => detailMap.get(id)).filter(Boolean);

  const chunks = [];
  for (let i = 0; i < tracks.length; i += 100) chunks.push(tracks.slice(i, i + 100));
  const groups = await runPool(chunks, 5, ch => annotateLocked(ch).catch(() => []));
  const list = groups.flat();
  const playable = list.filter(s => !s.locked).length;
  const vip = list.length - playable;

  // 关键优化：VIP 歌排后面，但不丢弃 —— 让可播歌永远排在最前
  const playableList = list.filter(s => !s.locked);
  const lockedList = list.filter(s => s.locked);
  const ordered = [...playableList, ...lockedList];

  console.log('热门歌池构建完成：' + CHARTS.length + ' 个榜单，候选 ' + tracks.length +
    ' 首（补详情 ' + missingIds.length + '），可播 ' + playable + ' 首在前，' +
    'VIP/版权 ' + vip + ' 首在后，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  return ordered;
}

/* 按天 + 1 小时过期：跨天一定重建，绝不再把昨天的歌池返回给页面 */
async function getHotPool(force) {
  const day = todayKey();
  const fresh = hotPool.list && hotPool.day === day && Date.now() - hotPool.at < POOL_TTL;
  if (!force && fresh) return hotPool;
  if (hotPool.promise) return hotPool.promise; // 已有构建在进行，等同一个结果
  hotPool.promise = buildHotPool()
    .then(list => {
      hotPool = { list, day, at: Date.now(), promise: null };
      return hotPool;
    })
    .catch(e => {
      hotPool.promise = null;
      // 构建失败时才退回当天旧池；跨天旧池不能再用
      if (hotPool.list && hotPool.day === day) {
        console.log('歌池更新失败，暂用当天旧池:', e.message);
        return hotPool;
      }
      throw e;
    });
  return hotPool.promise;
}

async function wyHot(batch, force) {
  const pool = await getHotPool(force);
  const list = pool.list;
  const totalBatches = Math.max(1, Math.ceil(list.length / BATCH_SIZE));
  // 歌池已按热度排序：第 0 批永远是最热的 30 首；换一批依次向后，看完所有批次才循环，不重复
  const b = ((batch % totalBatches) + totalBatches) % totalBatches;
  return {
    list: list.slice(b * BATCH_SIZE, b * BATCH_SIZE + BATCH_SIZE),
    batch: b,
    totalBatches,
    total: list.length,
    updated: pool.at,
    date: pool.day
  };
}

/* ---------------- 分类页：单个榜单分页（与热门池同样按天 + 1 小时缓存） ---------------- */
const chartCache = new Map(); // id -> { list, day, at, promise }

async function buildChartPool(c) {
  const r = await fetchChart(c);
  // 榜单本身歌少（日语榜只有 100 首），用分类关键词补热门歌单里的歌
  const kw = String(c.name || '').replace(/榜$/, '');
  const extraIds = kw ? await fetchCategoryExtra(kw, new Set(r.allIds)) : [];
  const ids = [...r.allIds, ...extraIds];
  const detailMap = new Map();
  r.have.forEach((t, id) => detailMap.set(id, t));
  const missing = ids.filter(id => !detailMap.has(id));
  const detailChunks = [];
  for (let i = 0; i < missing.length; i += 100) detailChunks.push(missing.slice(i, i + 100));
  const detailGroups = await runPool(detailChunks, 5, ch => fetchSongsByIds(ch).catch(() => []));
  detailGroups.flat().forEach(s => detailMap.set(s.id, s));
  const tracks = ids.map(id => detailMap.get(id)).filter(Boolean);
  // 完整标注 VIP/可播，全部返回，让前端展示完整榜单
  const chunks = [];
  for (let i = 0; i < tracks.length; i += 100) chunks.push(tracks.slice(i, i + 100));
  const groups = await runPool(chunks, 5, ch => annotateLocked(ch).catch(() => []));
  const list = groups.flat();
  // 分类页排序：VIP 优先（VIP·换源 → VIP → 完整）。
  // 换源接口能给 VIP 歌换到整曲，所以把它们顶到前面，每个分类第一页就能看到 VIP 歌
  const ordered = [
    ...list.filter(s => s.trial),
    ...list.filter(s => s.locked),
    ...list.filter(s => !s.trial && !s.locked)
  ];
  return ordered;
}

function chartInfo(id) {
  return CHARTS.find(c => String(c.id) === String(id)) || null;
}

async function getChartPool(id, force) {
  const c = chartInfo(id);
  if (!c) return null;
  const key = String(id);
  const day = todayKey();
  const hit = chartCache.get(key);
  const fresh = hit && hit.list && hit.day === day && Date.now() - hit.at < POOL_TTL;
  if (!force && fresh) return hit;
  if (hit && hit.promise) return hit.promise;
  const p = buildChartPool(c)
    .then(list => {
      const rec = { list, day, at: Date.now(), promise: null };
      chartCache.set(key, rec);
      return rec;
    })
    .catch(e => {
      const cur = chartCache.get(key);
      if (cur) cur.promise = null;
      // 只有当天旧池可以兜底，跨天数据不再使用
      if (cur && cur.list && cur.day === day) return cur;
      throw e;
    });
  chartCache.set(key, {
    list: hit && hit.list, day: hit && hit.day, at: hit && hit.at, promise: p
  });
  return p;
}

async function wyChart(id, batch, force) {
  const pool = await getChartPool(id, force);
  if (!pool) return null;
  const list = pool.list;
  const totalBatches = Math.max(1, Math.ceil(list.length / BATCH_SIZE));
  const b = ((batch % totalBatches) + totalBatches) % totalBatches;
  const c = chartInfo(id);
  return {
    name: c.name,
    list: list.slice(b * BATCH_SIZE, b * BATCH_SIZE + BATCH_SIZE),
    batch: b,
    totalBatches,
    total: list.length,
    updated: pool.at,
    date: pool.day
  };
}

/** 歌词（原文 LRC + 翻译 LRC），纯歌词/伴奏曲对应字段为空 */
async function wyLyric(id) {
  const d = await wyGet(
    'https://music.163.com/api/song/lyric?os=pc&id=' + id + '&lv=-1&kv=-1&tv=-1'
  );
  return {
    lrc: (d.lrc && d.lrc.lyric) || '',
    tlyric: (d.tlyric && d.tlyric.lyric) || '',
    instrumental: d.nolyric === true
  };
}

/** 播放时实时换链：
 *  ① NCM 给整曲 → 直接用
 *  ② NCM 只给试听片段（VIP）→ 第三方音源换整曲
 *  ③ 都失败 → 官方接口兜底 */
async function wyUrl(id) {
  let trialUrl = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(NCM_BASE + '/song/url?id=' + id, { signal: AbortSignal.timeout(12000) });
      if (r.ok) {
        const d = await r.json();
        const item = d.data && d.data[0];
        if (item && item.url) {
          if (!item.freeTrialInfo) return item.url;   // 整曲，直接播
          trialUrl = item.url;                        // 只有 30s 试听，先记下
        }
        break;
      }
      break;
    } catch (e) {
      if (attempt === 0) { await ensureNCM(); continue; }
      console.log('[NCM] 单换链不可用:', e.message);
    }
  }

  // VIP 歌：向第三方音源要整曲（NCM 匿名态只能给试听）
  const full = await gdUrl(id);
  if (full) return full;

  if (trialUrl) return trialUrl;   // 换不到整曲时至少能听 30s

  // Fallback: 网易云官方
  try {
    const d = await wyGet(
      'https://music.163.com/api/song/enhance/player/url' +
      '?id=' + id + '&ids=' + encodeURIComponent(JSON.stringify([Number(id)])) + '&br=320000'
    );
    const item = d.data && d.data[0];
    return item && item.url ? item.url : null;
  } catch (e) { return null; }
}

/* ---------------- HTTP 服务 ---------------- */

function sendJSON(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    if (p === '/api/wy/search') {
      const kw = (u.searchParams.get('kw') || '').trim();
      if (!kw) return sendJSON(res, { error: '缺少关键词' }, 400);
      const list = await wySearch(kw);
      return sendJSON(res, u.searchParams.get('debug') === '1' ? { list, dbg: lastSearchErr } : { list });
    }
    if (p === '/api/wy/check') {
      const ids = (u.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!ids.length) return sendJSON(res, { playable: [] });
      return sendJSON(res, { playable: await wyCheck(ids) });
    }
    if (p === '/api/wy/hot') {
      const batch = parseInt(u.searchParams.get('batch') || '0', 10) || 0;
      const force = u.searchParams.get('refresh') === '1';
      return sendJSON(res, await wyHot(batch, force));
    }
    if (p === '/api/wy/chart') {
      const id = u.searchParams.get('id');
      const batch = parseInt(u.searchParams.get('batch') || '0', 10) || 0;
      if (!id) return sendJSON(res, { error: '缺少分类 id' }, 400);
      const data = await wyChart(id, batch, u.searchParams.get('refresh') === '1');
      if (!data) return sendJSON(res, { error: '分类不存在' }, 404);
      return sendJSON(res, data);
    }
    if (p === '/api/wy/lyric') {
      const id = u.searchParams.get('id');
      const src = u.searchParams.get('src') || 'netease';
      if (!id) { res.writeHead(400); return res.end('missing id'); }
      return sendJSON(res, src === 'tencent' ? await vkLyric(id) : await wyLyric(id));
    }
    if (p === '/api/wy/url') {
      const id = u.searchParams.get('id');
      const src = u.searchParams.get('src') || 'netease';
      if (!id) { res.writeHead(400); return res.end('missing id'); }
      const url = src === 'tencent' ? await vkUrl(id) : await wyUrl(id);
      if (!url) { res.writeHead(404); return res.end(''); }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(url);
    }

    // 静态文件：只托管 index.html（禁用浏览器缓存，方便前端热更新）
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      return res.end(html);
    }
    res.writeHead(404); res.end('404');
  } catch (e) {
    sendJSON(res, { error: String(e.message || e) }, 502);
  }
});

/** 本机局域网 IPv4（手机连同一个 WiFi 就能访问） */
function lanIps() {
  const nets = require('os').networkInterfaces();
  const out = [];
  Object.keys(nets).forEach(k => {
    (nets[k] || []).forEach(n => {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    });
  });
  return out;
}

server.listen(PORT, '0.0.0.0', async () => {
  console.log('=================================');
  console.log('  电脑打开: http://localhost:' + PORT);
  lanIps().forEach(ip => console.log('  手机打开: http://' + ip + ':' + PORT));
  console.log('  （手机需与电脑连同一个 WiFi；首次可能要在防火墙里放行 Node）');
  console.log('  听歌时请保持本窗口开着，关闭窗口即停止服务');
  console.log('=================================');
  // 仅 Windows 本地运行时自动开浏览器；部署到云端不需要
  if (IS_WIN) exec('start "" "http://localhost:' + PORT + '"');
  // 先确保 VIP 换链服务在线（未启动则自动拉起），再预热热门歌池
  await ensureNCM();
  getHotPool(false).catch(e => console.log('歌池预热失败（不影响使用）:', e.message));
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log('端口 ' + PORT + ' 被占用，服务可能已经在运行，正在为你打开浏览器…');
    if (IS_WIN) exec('start "" "http://localhost:' + PORT + '"');
  } else {
    console.log('服务启动失败:', e.message);
    process.exit(1);
  }
});

/** 关闭主服务时一并结束 NCM 子进程，避免残留占用 3000 端口 */
function shutdown() {
  try { if (ncmChild) ncmChild.kill(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

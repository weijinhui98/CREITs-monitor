// REITs Public Server v3 - Optimized
const http = require('http');
const fs = require('fs');
const querystring = require('querystring');
const path = require('path');

const PORT = process.env.PORT || 8080;
const PAGE_SIZE = 20;
const SEEN_FILE = path.join(__dirname, 'reits_seen.json');

let cachedData = null;
let lastFullFetch = 0;
let lastIncrFetch = 0;
const seenIds = new Set();

// ========== Persistence ==========
function loadSeen() {
    try {
        if (fs.existsSync(SEEN_FILE)) {
            JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')).forEach(id => seenIds.add(id));
            console.log('Loaded ' + seenIds.size + ' seen IDs');
        }
    } catch (e) { console.log('No saved state'); }
}
function saveSeen() {
    try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...seenIds].slice(-10000)), 'utf8'); } catch (e) {}
}

// ========== Category ==========
const CATEGORY_RULES = [
    { key: 'operating', label: '运营数据',  kw: ['运营数据','经营数据','经营情况'] },
    { key: 'periodic',  label: '定期报告',  kw: ['年报','半年报','季度报告','年度报告','中期报告'] },
    { key: 'dividend',  label: '收益分配',  kw: ['收益分配','分红','派息','利润分配'] },
    { key: 'product',   label: '产品文件',  kw: ['招募说明书','基金合同','产品资料概要','托管协议'] },
    { key: 'ipo',       label: '发售上市',  kw: ['发售公告','上市交易','询价','战略配售','认购','基金份额发售','发售'] },
    { key: 'meeting',   label: '持有人大会',kw: ['持有人大会','投票','表决'] },
    { key: 'manager',   label: '管理人变更',kw: ['管理人变更','高级管理人员','基金经理'] },
    { key: 'nav',       label: '净值估值',  kw: ['净值公告','估值','资产评估'] },
    { key: 'trading',   label: '交易提示',  kw: ['交易提示','停牌','复牌','风险提示','交易情况提示'] },
    { key: 'material',  label: '重大事项',  kw: ['资产收购','资产处置','关联交易','扩募','原始权益人调整','重大事项','项目运营','解除限售'] },
    { key: 'investor',  label: '投资者关系',kw: ['投资者开放日','说明会','调研','问答','业绩说明'] },
    { key: 'legal',     label: '法律意见',  kw: ['法律意见书','律师事务所','核查','专项报告'] },
    { key: 'other',     label: '其他',      kw: [] }
];
function classifyTitle(t) {
    if (!t) return 'other';
    for (const r of CATEGORY_RULES) {
        if (!r.kw.length) continue;
        for (const k of r.kw) if (t.includes(k)) return r.key;
    }
    return 'other';
}
function catLabel(k) { const r = CATEGORY_RULES.find(c => c.key === k); return r ? r.label : k; }

// ========== SSE API (parallel pages) ==========
function fetchSSEPage(sd, ed, pn, ps) {
    return new Promise((resolve) => {
        const pd = querystring.stringify({
            'sqlId': 'REITS_BULLETIN','isPagination': 'true','fundCode': '',
            'startDate': sd,'endDate': ed,
            'pageHelp.pageSize': ps,'pageHelp.cacheSize': '1',
            'pageHelp.pageNo': pn,'pageHelp.beginPage': pn,'pageHelp.endPage': pn
        });
        const req = http.request({
            hostname: 'query.sse.com.cn', port: 80, path: '/commonSoaQuery.do', method: 'POST',
            headers: { 'Referer': 'http://www.sse.com.cn/', 'User-Agent': 'Mozilla/5.0',
                'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(pd) },
            timeout: 15000
        }, (res) => {
            let b = '';
            res.on('data', c => b += c);
            res.on('end', () => {
                try {
                    const d = JSON.parse(b);
                    const items = (d.pageHelp.data || []).map(item => {
                        let u = item.url || '';
                        if (u && !u.startsWith('http')) u = 'https://www.sse.com.cn' + u;
                        const t = item.title || '';
                        const id = Buffer.from(item.securityCode+'_'+item.sseDate+'_'+t.substring(0,30)).toString('base64');
                        return { code: item.securityCode||'', name: item.fundExtAbbr||item.fundAbbr||'', title: t, date: item.sseDate||'', url: u, cat: classifyTitle(t), exchange: 'SSE', id, isNew: !seenIds.has(id) };
                    });
                    resolve({ items, hasMore: items.length >= ps });
                } catch (e) { resolve({ items: [], hasMore: false }); }
            });
        });
        req.on('error', () => resolve({ items: [], hasMore: false }));
        req.on('timeout', () => { req.destroy(); resolve({ items: [], hasMore: false }); });
        req.write(pd); req.end();
    });
}

async function fetchSSE(sd, ed) {
    const ps = 200;
    const p1 = await fetchSSEPage(sd, ed, 1, ps);
    if (!p1.hasMore) return p1.items;
    // Parallel fetch remaining pages (2-30)
    const promises = [];
    for (let p = 2; p <= 30; p++) promises.push(fetchSSEPage(sd, ed, p, ps));
    const results = await Promise.all(promises);
    return [...p1.items, ...results.flatMap(r => r.items)];
}

// ========== SZSE API (parallel pages) ==========
function fetchSZSEPage(sd, ed, pn) {
    return new Promise((resolve) => {
        const ps = 50;
        const jb = JSON.stringify({ type: 4, pageSize: ps, pageNum: pn, seDate: [sd, ed], channelCode: ['reits-xxpl'] });
        const req = http.request({
            hostname: 'reits.szse.cn', path: '/api/disc/announcement/annList', method: 'POST',
            headers: { 'Referer': 'http://reits.szse.cn/disclosure/index.html', 'User-Agent': 'Mozilla/5.0',
                'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(jb) },
            timeout: 15000
        }, (res) => {
            let b = '';
            res.on('data', c => b += c);
            res.on('end', () => {
                try {
                    const d = JSON.parse(b);
                    const total = parseInt(d.announceCount) || 0;
                    const items = (d.data || []).map(item => {
                        let u = item.attachPath || '';
                        if (u && !u.startsWith('http')) u = 'https://disc.static.szse.cn' + u;
                        const t = item.title || '';
                        return {
                            code: (item.secCode&&item.secCode.length)?item.secCode[0]:'',
                            name: (item.secName&&item.secName.length)?item.secName[0]:'',
                            title: t, date: item.publishTime?item.publishTime.substring(0,10):'',
                            url: u, cat: classifyTitle(t), exchange: 'SZSE',
                            id: item.id||'', isNew: !seenIds.has(item.id||'')
                        };
                    });
                    resolve({ items, total, hasMore: pn * ps < total });
                } catch (e) { resolve({ items: [], total: 0, hasMore: false }); }
            });
        });
        req.on('error', () => resolve({ items: [], total: 0, hasMore: false }));
        req.on('timeout', () => { req.destroy(); resolve({ items: [], total: 0, hasMore: false }); });
        req.write(jb); req.end();
    });
}

async function fetchSZSE(sd, ed) {
    const p1 = await fetchSZSEPage(sd, ed, 1);
    const tp = Math.min(20, Math.ceil(p1.total / 50));
    if (tp <= 1) return p1.items;
    const promises = [];
    for (let p = 2; p <= tp; p++) promises.push(fetchSZSEPage(sd, ed, p));
    const results = await Promise.all(promises);
    return [...p1.items, ...results.flatMap(r => r.items)];
}

// ========== Data building ==========
async function buildData(sseItems, szseItems) {
    const sf = (a, b) => (b.date||'').localeCompare(a.date||'');
    sseItems.sort(sf); szseItems.sort(sf);
    const all = [...sseItems, ...szseItems].sort(sf);
    const cm = {};
    all.forEach(i => { cm[i.cat] = (cm[i.cat]||0)+1; });
    const cats = CATEGORY_RULES.map(r => ({ key: r.key, label: r.label, count: cm[r.key]||0 })).filter(c => c.count > 0);
    const d = new Date();
    const today = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    const todayCount = all.filter(i => i.date === today).length;
    const now = new Date();
    const pad = n => String(n).padStart(2,'0');
    const updateTime = now.getFullYear()+'-'+pad(now.getMonth()+1)+'-'+pad(now.getDate())+' '+pad(now.getHours())+':'+pad(now.getMinutes())+':'+pad(now.getSeconds());
    return { updateTime, sse: sseItems, szse: szseItems, all, categories: cats, newCount: all.filter(i => i.isNew).length, todayCount };
}

async function fullRefresh() {
    console.log('Full refresh...');
    const [sse, szse] = await Promise.all([fetchSSE('2021-01-01','2026-12-31'), fetchSZSE('2021-01-01','2026-12-31')]);
    cachedData = await buildData(sse, szse);
    lastFullFetch = lastIncrFetch = Date.now();
    saveSeen();
    pageCache.clear();
    console.log('Full: '+cachedData.all.length+' items, '+cachedData.newCount+' new, today='+cachedData.todayCount);
    return cachedData;
}

const pageCache = new Map();  // URL key -> rendered HTML
function getCacheKey(params) {
    return [params.ex||'all', params.cat||'all', params.q||'', params.page||'1', params.sd||'', params.ed||''].join('|');
}

async function incrementalRefresh() {
    const now = Date.now();
    if (now - lastIncrFetch < 300000) return cachedData; // 5min throttle

    const td = new Date();
    const wa = new Date(td.getTime() - 7*24*60*60*1000);
    const es = td.getFullYear()+'-'+String(td.getMonth()+1).padStart(2,'0')+'-'+String(td.getDate()).padStart(2,'0');
    const ss = wa.getFullYear()+'-'+String(wa.getMonth()+1).padStart(2,'0')+'-'+String(wa.getDate()).padStart(2,'0');
    console.log('Incremental: '+ss+' ~ '+es);

    const [sseN, szseN] = await Promise.all([fetchSSE(ss, es), fetchSZSE(ss, es)]);

    // Merge with existing
    const sm = new Map(cachedData.sse.map(i => [i.id, i]));
    const zm = new Map(cachedData.szse.map(i => [i.id, i]));
    sseN.forEach(i => sm.set(i.id, i));
    szseN.forEach(i => zm.set(i.id, i));

    cachedData = await buildData([...sm.values()], [...zm.values()]);
    lastIncrFetch = now;
    if (now - lastFullFetch >= 3600000) lastFullFetch = 0; // trigger full refresh next time
    saveSeen();
    console.log('Incr: '+cachedData.all.length+' total');
    return cachedData;
}

async function getData() {
    if (!cachedData) return fullRefresh();
    if (Date.now() - lastFullFetch >= 3600000) return fullRefresh();
    return incrementalRefresh();
}

// ========== URL builder ==========
function buildUrl(p) {
    const a = [];
    if (p.ex && p.ex !== 'all') a.push('ex='+p.ex);
    if (p.cat && p.cat !== 'all') a.push('cat='+p.cat);
    if (p.q) a.push('q='+encodeURIComponent(p.q));
    if (p.page && p.page > 1) a.push('page='+p.page);
    if (p.sd) a.push('sd='+p.sd);
    if (p.ed) a.push('ed='+p.ed);
    return a.length ? '/?'+a.join('&') : '/';
}

// ========== HTML Render ==========
function renderPage(data, params) {
    const ex = params.ex || 'all', cat = params.cat || 'all', q = params.q || '';
    const sd = params.sd || '2021-01-01', ed = params.ed || '2026-12-31';
    const page = Math.min(parseInt(params.page)||1, Math.max(1, Math.ceil(((ex==='sse'?data.sse:ex==='szse'?data.szse:ex==='new'?data.all.filter(i=>i.isNew):data.all).length)/PAGE_SIZE)));

    let items = data.all;
    if (ex === 'sse') items = data.sse;
    else if (ex === 'szse') items = data.szse;
    else if (ex === 'new') items = data.all.filter(i => i.isNew);
    if (cat !== 'all') items = items.filter(i => i.cat === cat);
    if (q) { const lq = q.toLowerCase(); items = items.filter(i => (i.code+i.name+i.title).toLowerCase().includes(lq)); }
    // Date range filter
    items = items.filter(i => i.date >= sd && i.date <= ed);

    const ti = items.length, tp = Math.max(1, Math.ceil(ti/PAGE_SIZE)), cp = Math.min(page, tp);
    const pi = items.slice((cp-1)*PAGE_SIZE, cp*PAGE_SIZE);

    const pObj = {ex,cat,q,sd,ed,page:1};
    function exTab(k, l, c) {
        const a = ex === k;
        const s = a ? 'background:#1a5a8a;color:#fff;border-color:#3a8ac0' : 'background:#162530;color:#8899aa;border:1px solid #2a5a7a';
        return '<a href="'+buildUrl({...pObj,ex:k})+'" style="display:inline-block;padding:7px 16px;border-radius:16px;text-decoration:none;font-size:12px;margin:3px;'+s+'">'+l+'('+c+')</a>';
    }

    let cpills = '<a href="'+buildUrl({...pObj,cat:'all'})+'" style="display:inline-block;padding:6px 13px;border:1px solid #2a5a7a;background:#162530;color:#8899aa;border-radius:14px;text-decoration:none;font-size:11px;margin:2px'+(cat==='all'?';background:#0d4a6a;color:#5cf;border-color:#2a7aaa':'')+'">All('+ti+')</a>';
    data.categories.forEach(c => {
        const a = cat === c.key;
        cpills += '<a href="'+buildUrl({...pObj,cat:c.key})+'" style="display:inline-block;padding:6px 13px;border:1px solid #2a5a7a;background:#162530;color:#8899aa;border-radius:14px;text-decoration:none;font-size:11px;margin:2px'+(a?';background:#0d4a6a;color:#5cf;border-color:#2a7aaa':'')+'">'+c.label+'('+c.count+')</a>';
    });

    let pnav = '';
    if (tp > 1) {
        pnav = '<div style="text-align:center;margin:15px 0;display:flex;gap:4px;justify-content:center;flex-wrap:wrap;align-items:center">';
        if (cp > 1) pnav += '<a href="'+buildUrl({...pObj,page:cp-1})+'" style="padding:6px 12px;background:#1a3a4a;color:#5cf;border-radius:6px;text-decoration:none;font-size:12px">Prev</a>';
        const ms = 7;
        let ps = Math.max(1, cp - Math.floor(ms/2)), pe = Math.min(tp, ps + ms - 1);
        if (pe - ps < ms - 1) ps = Math.max(1, pe - ms + 1);
        for (let i = ps; i <= pe; i++) {
            const a = i === cp;
            pnav += '<a href="'+buildUrl({...pObj,page:i})+'" style="padding:6px 10px;min-width:32px;text-align:center;border-radius:6px;text-decoration:none;font-size:12px;'+(a?'background:#1a5a8a;color:#fff;font-weight:700':'background:#162530;color:#8899aa;border:1px solid #2a5a7a')+'">'+i+'</a>';
        }
        if (cp < tp) pnav += '<a href="'+buildUrl({...pObj,page:cp+1})+'" style="padding:6px 12px;background:#1a3a4a;color:#5cf;border-radius:6px;text-decoration:none;font-size:12px">Next</a>';
        pnav += '<span style="padding:6px;color:#667788;font-size:11px">'+ti+'/'+tp+'p</span></div>';
    }

    let rows = '';
    pi.forEach(i => {
        const ec = i.exchange === 'SSE' ? '#5cf' : '#fa0';
        const nt = i.isNew ? '<span style="background:#f44336;color:#fff;border-radius:3px;padding:1px 4px;font-size:9px;font-weight:700;margin-left:4px">NEW</span>' : '';
        const link = i.isNew ? '/?markone='+encodeURIComponent(i.id)+'&target='+encodeURIComponent(i.url||'#')+'&ex='+ex+'&cat='+cat+'&q='+encodeURIComponent(q)+'&page='+cp : (i.url||'#');
        rows += '<tr'+(i.isNew?' style="background:#1a2a1a"':'')+'><td><span style="background:#0f3460;color:'+ec+';padding:1px 5px;border-radius:3px;font-size:10px;margin-right:4px">'+i.exchange+'</span>'+(i.code||'-')+nt+'</td><td>'+(i.name||'-')+'</td><td><a href="'+link+'" target="_blank">'+(i.title||'-')+'</a></td><td style="white-space:nowrap;color:#8899aa;font-size:11px">'+(i.date||'-')+'</td><td><span style="background:#1a2a4a;color:#fa0;padding:1px 5px;border-radius:3px;font-size:10px">'+catLabel(i.cat)+'</span></td></tr>\n';
    });

    const na = data.newCount > 0 ? '<div style="background:#2a1a1a;border:1px solid #f44336;border-radius:8px;padding:8px 14px;margin-bottom:10px;font-size:12px;color:#f66;text-align:center">NEW: '+data.newCount+' <a href="/?ex=new" style="color:#f88;font-weight:700">View</a> | <a href="/?markread=1&ex='+ex+'&cat='+cat+'&q='+encodeURIComponent(q)+'" style="color:#ffa726">Mark read</a></div>' : '';

    const ri = ti > 0 ? '<div style="text-align:center;color:#667788;font-size:11px;margin-bottom:4px">'+(ti?(cp-1)*PAGE_SIZE+1:0)+'-'+Math.min(cp*PAGE_SIZE,ti)+' / '+ti+'</div>' : '';

    return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">\n<meta http-equiv="refresh" content="180">\n<title>REITs公告监控 | SSE & SZSE</title>\n<style>\n*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif;background:#0f1923;color:#e0e0e0;min-height:100vh}.header{background:linear-gradient(135deg,#1a3a4a,#0d2130);padding:12px 16px;border-bottom:2px solid #2a5a7a;position:sticky;top:0;z-index:100;text-align:center}.header h1{color:#5cf;font-size:18px;margin:0}.header .sub{color:#8899aa;font-size:11px;margin-top:3px}.main{padding:10px;max-width:900px;margin:0 auto}.stats{display:flex;gap:8px;margin-bottom:10px;text-align:center}.stat{background:#162530;border:1px solid #2a4a5a;border-radius:8px;padding:8px 12px;flex:1}.stat .n{font-size:20px;font-weight:700;color:#5cf}.stat .l{font-size:10px;color:#8899aa}.stat .r{color:#f44336}.tabs{text-align:center;margin-bottom:8px}.cat-bar{text-align:center;margin-bottom:8px;line-height:2.2}.search-row{display:flex;gap:6px;margin-bottom:10px;align-items:center}.search-row input{padding:8px 12px;background:#162530;border:1px solid #2a5a7a;border-radius:8px;color:#e0e0e0;font-size:13px;flex:1;outline:none;-webkit-appearance:none}.search-row input:focus{border-color:#3a8ac0}.search-row button{padding:8px 14px;background:#1a5a8a;color:#fff;border:none;border-radius:8px;font-size:12px;cursor:pointer;white-space:nowrap}table{width:100%;border-collapse:collapse;background:#162530;border-radius:8px;overflow:hidden}th{background:#1a3a4a;color:#5cf;padding:10px 8px;text-align:left;font-size:12px;border-bottom:2px solid #2a5a7a}td{padding:8px;border-bottom:1px solid #1a2a3a;font-size:12px;vertical-align:top}tr:hover{background:#1a3040}a{color:#5cf;text-decoration:none}.foot{text-align:center;color:#556;font-size:10px;padding:15px}.empty{text-align:center;padding:30px;color:#667788;font-size:14px}@media(max-width:600px){td{font-size:11px;padding:6px 4px}th{font-size:10px;padding:8px 4px}}\n</style>\n</head>\n<body>\n<div class="header"><h1>REITs 公告监控</h1><div class="sub">更新于 '+data.updateTime+' | 每3分钟自动刷新</div></div>\n<div class="main">\n'+na+'\n<div class="stats"><div class="stat"><div class="n" style="color:#ffa726">'+data.todayCount+'</div><div class="l">今日公告</div></div><div class="stat"><div class="n">'+data.sse.length+'</div><div class="l">SSE 上交所</div></div><div class="stat"><div class="n">'+data.szse.length+'</div><div class="l">SZSE 深交所</div></div><div class="stat"><div class="n r">'+data.newCount+'</div><div class="l">未读公告</div></div></div>\n<div class="tabs">'+exTab('all','All',data.all.length)+exTab('sse','SSE',data.sse.length)+exTab('szse','SZSE',data.szse.length)+exTab('new','New',data.newCount)+'</div>\n<div class="cat-bar">'+cpills+'</div>\n<form class="search-row" action="/" method="get"><input type="hidden" name="ex" value="'+ex+'"><input type="hidden" name="cat" value="'+cat+'"><input type="text" name="q" value="'+q.replace(/"/g,'&quot;')+'" placeholder="Search..." style="max-width:120px"><input type="date" name="sd" value="'+sd+'" style="padding:6px 8px;background:#162530;border:1px solid #2a5a7a;border-radius:8px;color:#e0e0e0;font-size:11px;width:115px;outline:none;-webkit-appearance:none"><input type="date" name="ed" value="'+ed+'" style="padding:6px 8px;background:#162530;border:1px solid #2a5a7a;border-radius:8px;color:#e0e0e0;font-size:11px;width:115px;outline:none;-webkit-appearance:none"><button type="submit">Search</button><a href="/?markread=1&ex='+ex+'&cat='+cat+'&q='+encodeURIComponent(q)+'" style="padding:8px 12px;background:#5a3a1a;color:#fff;border:none;border-radius:8px;font-size:11px;text-decoration:none;white-space:nowrap">Mark read</a></form>\n'+ri+'\n'+(pi.length===0?'<div class="empty">No results</div>':'<table><thead><tr><th style="width:100px">Code</th><th style="width:120px">Name</th><th>Title</th><th style="width:90px">Date</th><th style="width:75px">Type</th></tr></thead><tbody>\n'+rows+'</tbody></table>\n'+pnav)+'\n<div class="foot">SSE & SZSE | '+data.updateTime+'</div>\n</div>\n<script>!function(){var t='+data.all.length+',s=localStorage.getItem("r_cnt")||"0",n=t-parseInt(s);if(s!="0"&&n>0){if("Notification"in window&&Notification.permission==="granted"){var o=new Notification("REITs",{body:n+" new",tag:"r",requireInteraction:!0});o.onclick=function(){window.open("/?ex=new","_self")}}else{var d=document.createElement("div");d.setAttribute("style","position:fixed;bottom:20px;left:10px;right:10px;background:#1a3a4a;border:1px solid #3a8ac0;border-radius:10px;padding:12px 16px;z-index:999;color:#fff;font-size:13px;text-align:center");d.innerHTML=n+" new! <a href=/?ex=new style=color:#5cf>View</a> <span onclick=this.parentElement.remove() style=margin-left:8px;color:#8899aa;cursor:pointer>&times;</span>";document.body.appendChild(d);setTimeout(function(){d.remove()},15000)}}localStorage.setItem("r_cnt",t)}();</script>\n</body>\n</html>';
}

// ========== HTTP Server ==========
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost:'+PORT);
    if (url.searchParams.has('markread')) {
        const data = await getData();
        data.all.forEach(i => { seenIds.add(i.id); i.isNew = false; });
        data.newCount = 0;
        saveSeen();
        pageCache.clear();
        const rp = { ex: url.searchParams.get('ex')||'all', cat: url.searchParams.get('cat')||'all', q: url.searchParams.get('q')||'' };
        res.writeHead(302, { 'Location': buildUrl(rp) });
        return res.end();
    }
    if (url.searchParams.has('markone')) {
        const id = url.searchParams.get('markone');
        const target = url.searchParams.get('target') || '/';
        seenIds.add(id);
        saveSeen();
        if (cachedData) {
            cachedData.all.forEach(i => { if (i.id === id) i.isNew = false; });
            cachedData.sse.forEach(i => { if (i.id === id) i.isNew = false; });
            cachedData.szse.forEach(i => { if (i.id === id) i.isNew = false; });
            cachedData.newCount = cachedData.all.filter(i => i.isNew).length;
        }
        pageCache.clear();
        res.writeHead(302, { 'Location': target });
        return res.end();
    }
    const params = { ex: url.searchParams.get('ex')||'all', cat: url.searchParams.get('cat')||'all', q: url.searchParams.get('q')||'', page: url.searchParams.get('page')||'1', sd: url.searchParams.get('sd')||'2021-01-01', ed: url.searchParams.get('ed')||'2026-12-31' };
    const cacheKey = getCacheKey(params);
    let html = pageCache.get(cacheKey);
    if (!html) {
        const data = await getData();
        html = renderPage(data, params);
        pageCache.set(cacheKey, html);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
});

loadSeen();
server.listen(PORT, '0.0.0.0', () => {
    console.log('Ready: http://localhost:'+PORT);
    getData().then(d => console.log('Loaded: '+d.all.length+' items'));
});

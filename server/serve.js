const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const FILE = path.join(ROOT, 'index.html');
const LOGIN_FILE = path.join(ROOT, 'login.html');
const PORT = process.env.PORT || 5173;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const COOKIE_FILE = path.join(DATA_DIR, 'session-cookie.txt');
const JAR_FILE = path.join(DATA_DIR, 'session-cookies.json');
const TARGET = 'ict.dunesinternationalschool.com';
const BASE = 'https://' + TARGET;
const AES_KEY = Buffer.from('NpeRTM55Zw7pbF7iFhD1dgK5K+G1Dgly2jEk2WtubR4=', 'base64');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const REWRITES = [
  'https://' + TARGET + ':443',
  'https://' + TARGET,
  'http://' + TARGET + ':443',
  'http://' + TARGET
];

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
};

let storedCookie = '';
let cookieJar = null;

function loadJar() {
  if (cookieJar) return cookieJar;
  cookieJar = [];
  if (fs.existsSync(JAR_FILE)) {
    try { cookieJar = JSON.parse(fs.readFileSync(JAR_FILE, 'utf8')); } catch (e) { cookieJar = []; }
  }
  if (cookieJar.length === 0 && fs.existsSync(COOKIE_FILE)) {
    const t = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
    const m = t && t.match(/^([^=]+)=([^;]*)/);
    if (m) cookieJar.push({ name: m[1], value: m[2], path: '' });
  }
  return cookieJar;
}

function saveJar() {
  fs.writeFileSync(JAR_FILE, JSON.stringify(loadJar()), 'utf8');
  try { fs.unlinkSync(COOKIE_FILE); } catch (e) {}
  storedCookie = '';
}

async function saveSessionTri(x) {
  await null;
  cookieJar = x;
  saveJar();
}

function cookieFor(path) {
  const jars = loadJar();
  const matched = jars
    .filter(o => !o.path || path.indexOf(o.path) === 0)
    .sort((p, q) => (q.path || '').length - (p.path || '').length);
  const seen = {};
  const out = [];
  for (const o of matched) {
    if (seen[o.name]) continue;
    seen[o.name] = true;
    out.push(o.name + '=' + o.value);
  }
  return out.join('; ');
}

function hasSession() {
  return loadJar().some(o => o.name === 'JSESSIONID');
}

function dcCookie() {
  const jars = loadJar();
  let pick = jars.find(o => o.name === 'JSESSIONID' && /EasyConnectWeb/.test(o.path || ''));
  if (!pick) pick = jars.find(o => o.name === 'JSESSIONID');
  if (!pick) return '';
  return pick.name + '=' + pick.value;
}

function allCookies() {
  const jars = loadJar().slice().sort((p, q) => (q.path || '').length - (p.path || '').length);
  const seen = {};
  const out = [];
  for (const o of jars) {
    if (!seen[o.name]) { seen[o.name] = true; out.push(o.name + '=' + o.value); }
  }
  return out.join('; ');
}

function sessionCookie() {
  if (storedCookie) return storedCookie;
  if (fs.existsSync(COOKIE_FILE)) {
    storedCookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  }
  return storedCookie;
}

function saveSession(cookie) {
  if (cookie) {
    const vals = [];
    for (const part of cookie.split(';')) {
      const m = part.trim().match(/^([^=]+)=([^;]*)/);
      if (m) vals.push({ name: m[1], value: m[2], path: '' });
    }
    cookieJar = vals;
    saveJar();
    return;
  }
  storedCookie = '';
  cookieJar = [];
  saveJar();
}

function rewriteBody(text) {
  for (const r of REWRITES) {
    text = text.split(r).join('');
  }
  return text;
}

function isTextual(ctype) {
  return /text\/html|text\/css|application\/javascript|application\/json|text\/plain|xml/i.test(ctype || '');
}

function decryptPayload(b64url) {
  try {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '===='.substring(0, 4 - (b64.length % 4));
    const all = Buffer.from(padded, 'base64');
    const iv = all.slice(0, 12);
    const ctWithTag = all.slice(12);
    const tag = ctWithTag.slice(ctWithTag.length - 16);
    const ct = ctWithTag.slice(0, ctWithTag.length - 16);
    const dec = crypto.createDecipheriv('aes-256-gcm', AES_KEY, iv);
    dec.setAuthTag(tag);
    const out = Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
    return Buffer.from(out, 'base64').toString('utf8');
  } catch (e) {
    throw new Error('Decrypt failed: ' + e.message);
  }
}

async function retryFetch(url, opts, tries) {
  let last;
  for (let i = 0; i < (tries || 4); i++) {
    try { return await fetch(url, opts); }
    catch (e) { last = e; if (i < (tries || 4) - 1) await new Promise(r => setTimeout(r, 500)); }
  }
  throw last;
}

async function fetchCirculars() {
  const baseHeaders = { 'User-Agent': UA };
  const c = allCookies();
  if (c) baseHeaders.Cookie = c;

  const pageRes = await retryFetch(BASE + '/EasyConnectWeb/form/jsp_widget/jsp_circular.jsp?selPrivilegeId=privilege_2177', { headers: baseHeaders, redirect: 'follow' }, 3);
  const pageHtml = await pageRes.text();

  if (/SessionExpired|timeout\.jsp/i.test(pageRes.url) || /SessionExpired/i.test(pageHtml)) {
    try {
      fs.writeFileSync(path.join(DATA_DIR, 'circ_debug.json'),
        JSON.stringify({ cookie: c, url: pageRes.url, status: pageRes.status, len: pageHtml.length, jar: loadJar() }, null, 2), 'utf8');
    } catch (e) {}
    return { error: 'SESSION_EXPIRED' };
  }

  const csrf = (pageHtml.match(/<meta name="_csrf" content="([^"]+)"/) || [])[1] || '';
  const ecToken = (pageHtml.match(/var ecToken = '([^']+)'/) || [])[1] || '';
  let studentId = (pageHtml.match(/studentIdStr":"(\d+)"/) || [])[1] || '17211020267';

  const payload = new URLSearchParams({
    schoolCode: 'DUNES',
    studentIdStr: studentId,
    durationType: 'cirId',
    startDate: '01-01-2025',
    endDate: '01-01-2027'
  });

const apiRes = await retryFetch(BASE + '/EasyConnectAPI/service/API/getCircularsList', {
    method: 'POST',
    headers: Object.assign({}, baseHeaders, {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-Token': csrf,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Authorization': ecToken ? 'Bearer ' + ecToken : ''
    }),
    body: payload.toString(),
    redirect: 'follow'
  }, 3);
  const enc = await apiRes.text();
  if (!enc || enc.length < 40) return { error: 'Empty API response' };
  if (/<!DOCTYPE|<html|SessionExpired/i.test(enc)) return { error: 'SESSION_EXPIRED' };

  let plain;
  try { plain = decryptPayload(enc); } catch (e) { return { error: 'SESSION_EXPIRED' }; }
  try { return { data: JSON.parse(plain) }; } catch (e) { return { error: 'Parse failed: ' + e.message }; }
}

async function fetchProfile() {
  const baseHeaders = { 'User-Agent': UA };
  const c = allCookies();
  if (c) baseHeaders.Cookie = c;

  const pageRes = await retryFetch(BASE + '/EasyConnectWeb/form/jsp_widget/jsp_circular.jsp?selPrivilegeId=privilege_2177', { headers: baseHeaders, redirect: 'follow' }, 3);
  const pageHtml = await pageRes.text();

  if (/SessionExpired|timeout\.jsp/i.test(pageRes.url) || /SessionExpired/i.test(pageHtml)) {
    return { error: 'SESSION_EXPIRED' };
  }

  const name = (pageHtml.match(/studentName\s*=\s*"([^"]+)"/) || [])[1] || '';
  const gradeStr = (pageHtml.match(/studentGrade\s*=\s*"([^"]+)"/) || [])[1] || '';
  const studentId = (pageHtml.match(/studentIdStr":"(\d+)"/) || [])[1] || '';
  const eno = (pageHtml.match(/studentEno\s*=\s*"([^"]*)"/) || [])[1] || '';

  const gradeMatch = gradeStr.match(/grade\s*(\d+)/i);
  const grade = gradeMatch ? 'Grade ' + gradeMatch[1] : (gradeStr || '');
  const sectionMatch = gradeStr.match(/\b([A-Za-z])\b\s*$/) || gradeStr.match(/[-\s](\w)\s*$/);
  const section = sectionMatch ? sectionMatch[1] : '';

  return { name: name.trim(), grade: grade, section: section, studentId: studentId, eno: eno };
}

async function loginToPortal(loginid, password) {
  let jar = [];
  const collectCookies = function (headers, urlPath) {
    let all = [];
    try { all = headers.getSetCookie(); } catch (e) {}
    if (!all || all.length === 0) {
      const sc = headers.get('set-cookie');
      if (sc) all = sc.split(/,(?=\s*\w+=)/);
    }
    for (const c of all) {
      const m = c.match(/^([^=]+)=([^;]*)/);
      if (!m) continue;
      let p = '/';
      const pm = c.match(/;\s*path=([^;\s]+)/i);
      if (pm) p = pm[1];
      jar = jar.filter(o => !(o.name === m[1] && o.path === p));
      jar.push({ name: m[1], value: m[2], path: p });
    }
  };
  const jarFor = function (path) {
    return jar.filter(o => path.indexOf(o.path) === 0)
      .map(o => o.name + '=' + o.value).join('; ');
  };

  // Step 1: load login page chain to establish a fresh session
  let url = BASE + '/';
  for (let i = 0; i < 8; i++) {
    const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA, 'Cookie': jarFor(new URL(url).pathname) } });
    collectCookies(r.headers, url);
    const loc = r.headers.get('location');
    if (loc) { url = new URL(loc, url).toString(); }
    else { await r.text(); break; }
  }

  const log = { startUrl: url, cookies: jar.map(o => o.name + '@' + o.path) };

  async function tryPost(endpoint) {
    const fd = new FormData();
    fd.append('loginid', loginid);
    fd.append('password', password);
    fd.append('dbConnVar', 'DUNES');
    fd.append('hiddenfield', '');
    fd.append('service_id', '');

    const r2 = await fetch(BASE + endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        'Origin': BASE,
        'Referer': url,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': jarFor(endpoint)
      },
      body: fd
    });
    collectCookies(r2.headers, endpoint);
    const loc = r2.headers.get('location') || '';
    let bodyText = '';
    try { bodyText = await r2.text(); } catch (e) {}
    const setc = (function () { try { return r2.headers.getSetCookie(); } catch (e) { return []; } })();
    return {
      endpoint: endpoint, status: r2.status, locRaw: loc,
      locNorm: loc.split('//')[1] ? loc.split('//')[1] : loc,
      setCookie: setc, bodyLen: bodyText.length,
      bodySnippet: bodyText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 250)
    };
  }

  // Try the JS-overridden endpoint first, then the HTML form endpoint
  const a = await tryPost('/DCNWeb/authenticate.do');
  const session = jar.filter(o => o.name === 'JSESSIONID').map(o => o.name + '=' + o.value).join('; ');
  const hasSession = session.length > 0;
  log.a = a;

  let verified = false;
  let cur = a.locRaw || (BASE + '/');
  let landingHtml = '';
  if (hasSession) {
    // Follow the post-login chain like a browser: redirects and auto-submit handoff forms.
    // After auth, EasyConnectWeb.jsp auto-POSTs a handoff form to /EasyConnectWeb/session.jsp,
    // which 302s to welcomePage.jsp — that page brings up the /EasyConnectWeb session.
    try {
      const dcnCookie = 'JSESSIONID=' + (jar.filter(o => o.path.indexOf('/DCNWeb') === 0)[0] || jar[0]).value;

      async function runHandoff() {
        // 1) load the handoff form (fresh per session)
        const hi = await fetch(BASE + '/DCNWeb/form/jsp_web/EasyConnectWeb.jsp', { headers: { 'User-Agent': UA, 'Cookie': dcnCookie }, redirect: 'manual' });
        collectCookies(hi.headers, '/DCNWeb/form/jsp_web/EasyConnectWeb.jsp');
        const formHtml = await hi.text();
        const actionM = formHtml.match(/<form[^>]*action="([^"]+)"[^>]*>/);
        if (!actionM) return { ok: false, why: 'no-handoff-form', html: formHtml };
        const inputs = [];
        for (const m of formHtml.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
          const tag = m[0];
          const n = (tag.match(/name="([^"]*)"/) || [])[1];
          const v = (tag.match(/value="([^"]*)"/) || [])[1];
          if (n != null) inputs.push([n, v == null ? '' : v]);
        }
        const fd = new URLSearchParams();
        inputs.forEach(([n, v]) => fd.append(n, v));
        const handoffUrl = new URL(actionM[1], BASE + '/DCNWeb/form/jsp_web/EasyConnectWeb.jsp').toString();

        // 2) POST the handoff -> establishes the /EasyConnectWeb JSESSIONID
        const hp = await fetch(handoffUrl, {
          method: 'POST', redirect: 'manual',
          headers: { 'User-Agent': UA, 'Referer': BASE + '/DCNWeb/form/jsp_web/EasyConnectWeb.jsp', 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': dcnCookie },
          body: fd.toString()
        });
        collectCookies(hp.headers, new URL(handoffUrl).pathname);
        const ecSess = jar.find(o => o.name === 'JSESSIONID' && /EasyConnectWeb/.test(o.path || ''));
        if (!ecSess) return { ok: false, why: 'no-ec-session', html: '' };
        const ecCk = 'JSESSIONID=' + ecSess.value;

        // 3) fetch welcomePage.jsp -> ec_param + csrf
        const w = await fetch(BASE + '/EasyConnectWeb/welcomePage.jsp', { headers: { 'User-Agent': UA, 'Cookie': ecCk }, redirect: 'follow' });
        const wt = await w.text();
        const ecParam = (wt.match(/"ec_param"\s*:\s*"([^"]+)"/) || [])[1] || '';
        const csrf = (wt.match(/name="_csrf" value="([^"]+)"/) || [])[1] || '';
        if (!ecParam) return { ok: false, why: 'no-ec-param', html: wt };

        // 4) authenicate -> JWT token + loginId + schoolCode
        const au = await fetch(BASE + '/EasyConnectAPI/service/API/authenicate', {
          method: 'POST', redirect: 'follow',
          headers: { 'User-Agent': UA, 'Cookie': ecCk, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json, text/javascript, */*; q=0.01' },
          body: 'ec_param=' + encodeURIComponent(ecParam)
        });
        let authResp;
        try { authResp = await au.json(); } catch (e) { return { ok: false, why: 'authenicate-parse', html: wt }; }
        if (!authResp || !authResp.token) return { ok: false, why: 'authenicate-fail', html: wt, auth: authResp };

        // 5) getPrivileges (AES-GCM encrypted response)
        const gp = await fetch(BASE + '/EasyConnectAPI/service/API/getPrivileges', {
          method: 'POST', redirect: 'follow',
          headers: { 'User-Agent': UA, 'Cookie': ecCk, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/*', 'Authorization': 'Bearer ' + authResp.token },
          body: 'schoolCode=' + encodeURIComponent(authResp.schoolCode) + '&parentId=' + encodeURIComponent(authResp.loginId)
        });
        let resp;
        try { resp = JSON.parse(decryptPayload(await gp.text())); }
        catch (e) { return { ok: false, why: 'privileges-decrypt', html: wt }; }
        if (String(resp.result) !== '1') return { ok: false, why: 'privileges-result', html: wt };
        const privilegeList = Buffer.from(JSON.stringify(resp.privilege)).toString('base64');
        const wardList = JSON.stringify(resp.wards);

        // 6) POST welcomePage with token + privileges -> full session (lands on circular.jsp)
        const wf = new URLSearchParams();
        wf.append('_csrf', csrf);
        wf.append('privilegeList', privilegeList);
        wf.append('wardList', wardList);
        wf.append('ecAuthToken', authResp.token);
        const w2 = await fetch(BASE + '/EasyConnectWeb/welcomePage.jsp', {
          method: 'POST', redirect: 'follow',
          headers: { 'User-Agent': UA, 'Cookie': ecCk, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE + '/EasyConnectWeb/welcomePage.jsp' },
          body: wf.toString()
        });
        const final = await w2.text();
        const ecStillSet = jar.some(o => o.name === 'JSESSIONID' && /EasyConnectWeb/.test(o.path || ''));
        return { ok: final.length > 500 && ecStillSet, why: final.length, html: final, handoffLoc: handoffUrl, student: authResp.enrollments };
      }

      let chain = await runHandoff();
      log.chain = chain.why;
      if (!chain.ok) {
        await new Promise(r => setTimeout(r, 600));
        chain = await runHandoff();
        log.chain2 = chain.why;
      }
      landingHtml = chain.html;
      log.chainStudent = chain.student || [];
      log.chainHandoffLoc = chain.handoffLoc || '';

      try {
        const ts2 = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(path.join(DATA_DIR, 'landing_' + ts2 + '.html'), landingHtml, 'utf8');
      } catch (e) {}
      // Now hit a protected page with the session jar
      const ck = jarFor('/EasyConnectWeb/form/jsp_widget/jsp_circular.jsp');
      let vRes, vText;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          vRes = await fetch(BASE + '/EasyConnectWeb/form/jsp_widget/jsp_circular.jsp?selPrivilegeId=privilege_2177', {
            headers: { 'User-Agent': UA, 'Cookie': ck },
            redirect: 'follow'
          });
          vText = await vRes.text();
          break;
        } catch (e) { vRes = null; await new Promise(r => setTimeout(r, 500)); }
      }
      if (vRes) {
        verified = !/SessionExpired|timeout\.jsp/i.test(vRes.url) && !/SessionExpired/i.test(vText) && vText.length > 5000;
        log.verifyStatus = vRes.status;
        log.verifyUrl = vRes.url;
        log.verifyLen = vText.length;
      } else {
        log.verifyError = 'fetch failed after retries';
      }
      log.redirectChain = cur;
    } catch (e) { verified = false; log.verifyError = e.message; }
  }

  log.verified = verified;
  const sessionFinal = jar.filter(o => o.name === 'JSESSIONID').map(o => o.name + '=' + o.value).join('; ');
  log.session = jar.filter(o => o.name === 'JSESSIONID').map(o => o.name + '=' + o.value + '@' + o.path).join('; ');

  // Log attempt for debugging
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(DATA_DIR, 'login_debug_' + ts + '.json'), JSON.stringify(log, null, 2), 'utf8');
  } catch (e) {}

  const likelyOk = /Unauthorized|SessionExpired|timeout|login/i.test(a.locNorm) ? false : true;
  const hasEcSession = jar.some(o => o.name === 'JSESSIONID' && (o.path.indexOf('/EasyConnectWeb') === 0 || o.path === '/EasyConnectWeb'));
  const ok = likelyOk && hasEcSession;
  return {
    ok: ok,
    status: a.status,
    loc: a.locNorm.slice(0, 120),
    hasSession: hasSession,
    verified: verified,
    hasEcSession: hasEcSession,
    bodyLen: a.bodyLen,
    bodySnippet: a.bodySnippet,
    session: sessionFinal,
    jarArr: jar.map(o => ({ name: o.name, value: o.value, path: o.path })),
    _debug: log
  };
}

function proxy(req, res, isLogin) {
  const headers = Object.assign({}, req.headers);
  headers.host = TARGET;
  headers['accept-encoding'] = 'identity';
  headers['origin'] = BASE;
  headers['referer'] = BASE + '/';

  const cookie = allCookies();
  if (cookie && !isLogin) headers.cookie = cookie;

  const preq = https.request({
    host: TARGET,
    port: 443,
    method: req.method,
    path: req.url,
    headers: headers
  }, function (pres) {
    const ctype = pres.headers['content-type'] || '';

    const hdrs = {};
    let newCookies = [];
    for (const k of Object.keys(pres.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'x-frame-options' || lk === 'content-security-policy' || lk === 'strict-transport-security') continue;
      let v = pres.headers[k];
      if (lk === 'set-cookie') {
        newCookies.push(v);
        continue;
      }
      if (lk === 'location') v = rewriteBody(v);
      hdrs[k] = v;
    }

    // Capture session cookie from login response
    if (isLogin && newCookies.length > 0) {
      for (const c of newCookies) {
        const match = c.match(/JSESSIONID=([^;]+)/i);
        if (match) {
          saveSession('JSESSIONID=' + match[1]);
          hdrs['set-cookie'] = ['JSESSIONID=' + match[1] + '; Path=/; HttpOnly'];
          break;
        }
      }
    } else if (cookie) {
      const val = cookie.split(';')[0].split('=').slice(1).join('=');
      hdrs['set-cookie'] = ['JSESSIONID=' + val + '; Path=/; HttpOnly'];
    }

    res.writeHead(pres.statusCode, hdrs);

    const raw = [];
    pres.on('data', function (c) { raw.push(c); });
    pres.on('end', function () {
      let body = Buffer.concat(raw);
      if (isTextual(ctype)) {
        body = Buffer.from(rewriteBody(body.toString('utf8')));
      }
      res.end(body);
    });
  });

  preq.on('error', function (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Proxy error: ' + e.message);
  });
  req.pipe(preq);
}

const ACCESS = process.env.PORTAL_KEY || '';
const rateLimit = { map: new Map() };

function checkRate(ip, key, max, windowMs) {
  const now = Date.now();
  const rec = rateLimit.map.get(ip) || { ts: now, count: 0 };
  if (now - rec.ts > windowMs) { rec.ts = now; rec.count = 0; }
  rec.count += 1;
  rateLimit.map.set(ip, rec);
  return rec.count > max;
}

function allowAccess(req) {
  if (!ACCESS) return true;
  return (req.headers['x-portal-key'] || '') === ACCESS || (req.queryKey === ACCESS);
}

http.createServer(function (req, res) {
  const rawUrl = req.url || '/';
  const url = decodeURIComponent(rawUrl.split('?')[0].split('#')[0]);
  const qs = new URLSearchParams(rawUrl.split('?')[1] || '');
  req.queryKey = qs.get('key') || '';
  const isLogin = url === '/DUNES/authenticate.do';
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '0.0.0.0';

  if (/^\/api\//.test(url) || url === '/DUNES/authenticate.do' || url === '/circulars' || url === '/profile' || url === '/logout') {
    if (checkRate(ip, 'api', 30, 60000)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many requests' }));
      return;
    }
  }

  if (url === '/login') {
    fs.readFile(LOGIN_FILE, function (err, data) {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Login page not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  if (url === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      const params = new URLSearchParams(body);
      const l = (params.get('loginid') || '').trim();
      const p = params.get('password') || '';
      if (!l || !p) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Missing credentials' }));
        return;
      }
      loginToPortal(l, p).then(function (result) {
        if (result.ok) {
          cookieJar = (result.jarArr || []).slice();
          saveJar();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, name: l }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            error: 'Invalid username or password',
            debug: { status: result.status, loc: result.loc, hasSession: result.hasSession, verified: result.verified, bodyLen: result.bodyLen, bodySnippet: result.bodySnippet }
          }));
        }
      }).catch(function (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Login failed: ' + e.message }));
      });
    });
    return;
  }

  if (url === '/logout') {
    storedCookie = '';
    cookieJar = [];
    try { fs.unlinkSync(COOKIE_FILE); } catch (e) {}
    try { fs.unlinkSync(JAR_FILE); } catch (e) {}
    res.writeHead(302, { 'Location': '/login' });
    res.end();
    return;
  }

  if (url === '/circulars') {
    fetchCirculars()
      .then(function (result) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result)); })
      .catch(function (e) { res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'Proxy error: ' + e.message })); });
    return;
  }

  if (url === '/profile') {
    fetchProfile()
      .then(function (result) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result)); })
      .catch(function (e) { res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'Proxy error: ' + e.message })); });
    return;
  }

  if (isLogin) {
    proxy(req, res, true);
    return;
  }

  const PORTAL_PREFIXES = ['/EasyConnectWeb', '/EasyConnectAPI', '/DCNWeb', '/DCWeb', '/container', '/EasyConnectQS', '/assets', '/school_data', '/DUNES'];
  if (PORTAL_PREFIXES.some(function (p) { return url.indexOf(p) === 0; })) {
    proxy(req, res, false);
    return;
  }

  // If not logged in and accessing root, redirect to login
  if (url === '/' && !hasSession()) {
    res.writeHead(302, { 'Location': '/login' });
    res.end();
    return;
  }

  let fp = url === '/' ? FILE : path.join(ROOT, url);
  if (fp.toLowerCase().indexOf(ROOT.toLowerCase()) !== 0) { res.writeHead(403); res.end(); return; }

  fs.readFile(fp, function (err, data) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    let ctype = mime[path.extname(fp).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ctype });
    res.end(data);
  });
}).listen(PORT, function () {
  console.log('Dunes portal on http://localhost:' + PORT + '/login');
});

setInterval(() => {}, 1 << 30);
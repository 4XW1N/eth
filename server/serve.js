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
const SESSION_TTL = 60 * 60 * 1000;

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

const sessions = new Map();

function gcSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.ts > SESSION_TTL) sessions.delete(id);
  }
}
setInterval(gcSessions, 5 * 60 * 1000);

function parseCookie(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const m = part.trim().match(/^([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function makeSid() {
  return crypto.randomBytes(18).toString('base64url');
}

function getSid(req) {
  return parseCookie(req.headers.cookie || '').sid || '';
}

function getSession(sid) {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.ts > SESSION_TTL) { sessions.delete(sid); return null; }
  return s;
}

function jarAllCookies(jar) {
  const sorted = jar.slice().sort((a, b) => (b.path || '').length - (a.path || '').length);
  const seen = {};
  const out = [];
  for (const o of sorted) {
    if (!seen[o.name]) { seen[o.name] = true; out.push(o.name + '=' + o.value); }
  }
  return out.join('; ');
}

function jarCookiesFor(jar, reqPath) {
  const matched = jar
    .filter(o => !o.path || reqPath.indexOf(o.path) === 0)
    .sort((a, b) => (b.path || '').length - (a.path || '').length);
  const seen = {};
  const out = [];
  for (const o of matched) {
    if (seen[o.name]) continue;
    seen[o.name] = true;
    out.push(o.name + '=' + o.value);
  }
  return out.join('; ');
}

function jarHasSession(jar) {
  return jar.some(o => o.name === 'JSESSIONID');
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

async function fetchCirculars(jar) {
  const baseHeaders = { 'User-Agent': UA };
  const c = jarAllCookies(jar);
  if (c) baseHeaders.Cookie = c;

  const pageRes = await retryFetch(BASE + '/EasyConnectWeb/form/jsp_widget/jsp_circular.jsp?selPrivilegeId=privilege_2177', { headers: baseHeaders, redirect: 'follow' }, 3);
  const pageHtml = await pageRes.text();

  if (/SessionExpired|timeout\.jsp/i.test(pageRes.url) || /SessionExpired/i.test(pageHtml)) {
    return { error: 'SESSION_EXPIRED' };
  }

  const csrf = (pageHtml.match(/<meta name="_csrf" content="([^"]+)"/) || [])[1] || '';
  const ecToken = (pageHtml.match(/var ecToken = '([^']+)'/) || [])[1] || '';
  let studentId = (pageHtml.match(/studentIdStr":"(\d+)"/) || [])[1] || '';

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

async function fetchProfile(jar) {
  const baseHeaders = { 'User-Agent': UA };
  const c = jarAllCookies(jar);
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
  let parentLoginId = '';
  const collectCookies = function (headers) {
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
  const jarFor = function (p) {
    return jar.filter(o => p.indexOf(o.path) === 0)
      .map(o => o.name + '=' + o.value).join('; ');
  };

  let url = BASE + '/';
  for (let i = 0; i < 8; i++) {
    const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA, 'Cookie': jarFor(new URL(url).pathname) } });
    collectCookies(r.headers);
    const loc = r.headers.get('location');
    if (loc) { url = new URL(loc, url).toString(); }
    else { await r.text(); break; }
  }

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
    collectCookies(r2.headers);
    const loc = r2.headers.get('location') || '';
    let bodyText = '';
    try { bodyText = await r2.text(); } catch (e) {}
    return {
      endpoint: endpoint, status: r2.status, locRaw: loc,
      locNorm: loc.split('//')[1] ? loc.split('//')[1] : loc,
      bodyLen: bodyText.length,
      bodySnippet: bodyText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 250)
    };
  }

  const a = await tryPost('/DCNWeb/authenticate.do');
  const hasSession = jar.some(o => o.name === 'JSESSIONID');

  let verified = false;
  if (hasSession) {
    try {
      const dcnCookie = 'JSESSIONID=' + (jar.filter(o => o.path.indexOf('/DCNWeb') === 0)[0] || jar[0]).value;

      async function runHandoff() {
        const hi = await fetch(BASE + '/DCNWeb/form/jsp_web/EasyConnectWeb.jsp', { headers: { 'User-Agent': UA, 'Cookie': dcnCookie }, redirect: 'manual' });
        collectCookies(hi.headers);
        const formHtml = await hi.text();
        const actionM = formHtml.match(/<form[^>]*action="([^"]+)"[^>]*>/);
        if (!actionM) return { ok: false, why: 'no-handoff-form' };
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

        const hp = await fetch(handoffUrl, {
          method: 'POST', redirect: 'manual',
          headers: { 'User-Agent': UA, 'Referer': BASE + '/DCNWeb/form/jsp_web/EasyConnectWeb.jsp', 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': dcnCookie },
          body: fd.toString()
        });
        collectCookies(hp.headers);
        const ecSess = jar.find(o => o.name === 'JSESSIONID' && /EasyConnectWeb/.test(o.path || ''));
        if (!ecSess) return { ok: false, why: 'no-ec-session' };
        const ecCk = 'JSESSIONID=' + ecSess.value;

        const w = await fetch(BASE + '/EasyConnectWeb/welcomePage.jsp', { headers: { 'User-Agent': UA, 'Cookie': ecCk }, redirect: 'follow' });
        const wt = await w.text();
        const ecParam = (wt.match(/"ec_param"\s*:\s*"([^"]+)"/) || [])[1] || '';
        const csrf = (wt.match(/name="_csrf" value="([^"]+)"/) || [])[1] || '';
        if (!ecParam) return { ok: false, why: 'no-ec-param' };

        const au = await fetch(BASE + '/EasyConnectAPI/service/API/authenicate', {
          method: 'POST', redirect: 'follow',
          headers: { 'User-Agent': UA, 'Cookie': ecCk, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json, text/javascript, */*; q=0.01' },
          body: 'ec_param=' + encodeURIComponent(ecParam)
        });
        let authResp;
        try { authResp = await au.json(); } catch (e) { return { ok: false, why: 'authenicate-parse' }; }
        if (!authResp || !authResp.token) return { ok: false, why: 'authenicate-fail', auth: authResp };
        parentLoginId = authResp.loginId || '';

        const gp = await fetch(BASE + '/EasyConnectAPI/service/API/getPrivileges', {
          method: 'POST', redirect: 'follow',
          headers: { 'User-Agent': UA, 'Cookie': ecCk, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/*', 'Authorization': 'Bearer ' + authResp.token },
          body: 'schoolCode=' + encodeURIComponent(authResp.schoolCode) + '&parentId=' + encodeURIComponent(authResp.loginId)
        });
        let resp;
        try { resp = JSON.parse(decryptPayload(await gp.text())); }
        catch (e) { return { ok: false, why: 'privileges-decrypt' }; }
        if (String(resp.result) !== '1') return { ok: false, why: 'privileges-result' };
        const privilegeList = Buffer.from(JSON.stringify(resp.privilege)).toString('base64');
        const wardList = JSON.stringify(resp.wards);

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
        return { ok: final.length > 500 && ecStillSet, why: final.length, html: final, student: authResp.enrollments };
      }

      let chain = await runHandoff();
      if (!chain.ok) {
        await new Promise(r => setTimeout(r, 600));
        chain = await runHandoff();
      }

      const ck = jarCookiesFor(jar, '/EasyConnectWeb/form/jsp_widget/jsp_circular.jsp');
      let vRes, vText;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          vRes = await fetch(BASE + '/EasyConnectWeb/form/jsp_widget/jsp_circular.jsp?selPrivilegeId=privilege_2177', {
            headers: { 'User-Agent': UA, 'Cookie': ck }, redirect: 'follow'
          });
          vText = await vRes.text();
          break;
        } catch (e) { vRes = null; await new Promise(r => setTimeout(r, 500)); }
      }
      if (vRes) {
        verified = !/SessionExpired|timeout\.jsp/i.test(vRes.url) && !/SessionExpired/i.test(vText) && vText.length > 5000;
      }
    } catch (e) { verified = false; }
  }

  const likelyOk = /Unauthorized|SessionExpired|timeout|login/i.test(a.locNorm) ? false : true;
  const hasEcSession = jar.some(o => o.name === 'JSESSIONID' && (o.path.indexOf('/EasyConnectWeb') === 0 || o.path === '/EasyConnectWeb'));
  const ok = likelyOk && hasEcSession;
  return {
    ok: ok,
    jar: jar,
    jarArr: jar.map(o => ({ name: o.name, value: o.value, path: o.path })),
    loginId: parentLoginId
  };
}

function proxyToPortal(req, res, jar) {
  const headers = Object.assign({}, req.headers);
  headers.host = TARGET;
  headers['accept-encoding'] = 'identity';
  headers['origin'] = BASE;
  headers['referer'] = BASE + '/';

  if (jar) {
    const c = jarAllCookies(jar);
    if (c) headers.cookie = c;
  }

  const preq = https.request({
    host: TARGET,
    port: 443,
    method: req.method,
    path: req.url,
    headers: headers
  }, function (pres) {
    const ctype = pres.headers['content-type'] || '';

    const hdrs = {};
    for (const k of Object.keys(pres.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'x-frame-options' || lk === 'content-security-policy' || lk === 'strict-transport-security') continue;
      let v = pres.headers[k];
      if (lk === 'location') v = rewriteBody(v);
      hdrs[k] = v;
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

const rateLimit = { map: new Map() };

function checkRate(ip, max, windowMs) {
  const now = Date.now();
  const rec = rateLimit.map.get(ip) || { ts: now, count: 0 };
  if (now - rec.ts > windowMs) { rec.ts = now; rec.count = 0; }
  rec.count += 1;
  rateLimit.map.set(ip, rec);
  return rec.count > max;
}

function setSidCookie(res, sid) {
  res.setHeader('Set-Cookie', 'sid=' + sid + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600');
}

http.createServer(function (req, res) {
  const rawUrl = req.url || '/';
  const url = decodeURIComponent(rawUrl.split('?')[0].split('#')[0]);
  const isLoginPost = url === '/DUNES/authenticate.do';
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '0.0.0.0';

  if (/^\/api\//.test(url) || url === '/DUNES/authenticate.do' || url === '/circulars' || url === '/profile' || url === '/logout') {
    if (checkRate(ip, 30, 60000)) {
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
          const sid = makeSid();
          sessions.set(sid, { jar: result.jarArr, loginId: result.loginId || '', username: l, ts: Date.now() });
          setSidCookie(res, sid);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, name: l }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid username or password' }));
        }
      }).catch(function (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Login failed: ' + e.message }));
      });
    });
    return;
  }

  if (url === '/logout') {
    const sid = getSid(req);
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; Max-Age=0');
    res.writeHead(302, { 'Location': '/login' });
    res.end();
    return;
  }

  const sid = getSid(req);
  const sess = getSession(sid);

  if (url === '/whoami') {
    if (!sess) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'SESSION_EXPIRED' }));
      return;
    }
    fetchProfile(sess.jar)
      .then(function (prof) {
        const body = { loginId: sess.loginId || '', username: sess.username || '' };
        if (prof && prof.studentId) body.studentId = prof.studentId;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
      })
      .catch(function () {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ loginId: sess.loginId || '', username: sess.username || '' }));
      });
    return;
  }

  if (url === '/circulars') {
    if (!sess) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'SESSION_EXPIRED' }));
      return;
    }
    fetchCirculars(sess.jar)
      .then(function (result) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result)); })
      .catch(function (e) { res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'Proxy error: ' + e.message })); });
    return;
  }

  if (url === '/profile') {
    if (!sess) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'SESSION_EXPIRED' }));
      return;
    }
    fetchProfile(sess.jar)
      .then(function (result) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result)); })
      .catch(function (e) { res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'Proxy error: ' + e.message })); });
    return;
  }

  if (isLoginPost) {
    proxyToPortal(req, res, sess ? sess.jar : null);
    return;
  }

  const PORTAL_PREFIXES = ['/EasyConnectWeb', '/EasyConnectAPI', '/DCNWeb', '/DCWeb', '/container', '/EasyConnectQS', '/assets', '/school_data', '/DUNES'];
  if (PORTAL_PREFIXES.some(function (p) { return url.indexOf(p) === 0; })) {
    proxyToPortal(req, res, sess ? sess.jar : null);
    return;
  }

  if (url === '/' && !sess) {
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

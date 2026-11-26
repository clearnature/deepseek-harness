#!/usr/bin/env node
/**
 * dsh-gate — DeepSeek Harness 的登录页 + 会话认证反向代理（零依赖）
 *
 * 浏览器 --TLS--> nginx --HTTP--> dsh-gate :3081 --HTTP--> dsh web :3080
 *
 * 职责：
 * 1. 提供 /login 登录页；用户名 + 密码经 scrypt 校验；
 * 2. 登录成功签发 30 天 HttpOnly/Secure/SameSite=Lax 会话 Cookie；
 * 3. 未登录一律重定向到 /login（API 返回 401）；
 * 4. 登录后首次访问 / 时，自动读取 dsh web 的 launch token 并完成 token 交换，
 *    把 DSH 自己的 dsh-auth-* Cookie 转交给浏览器（用户不再需要 token URL）；
 * 5. 透传 HTTP/SSE 与 WebSocket 升级；
 * 6. 登录失败按 IP 限流锁定，记录审计日志（不含密码）。
 */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import { scryptSync, timingSafeEqual, randomBytes } from 'node:crypto'
import { URL } from 'node:url'

const PORT = Number(process.env.DSH_GATE_PORT || 3081)
const UPSTREAM_HOST = process.env.DSH_UPSTREAM_HOST || '127.0.0.1'
const UPSTREAM_PORT = Number(process.env.DSH_UPSTREAM_PORT || 3080)
const USERS_FILE = process.env.DSH_GATE_USERS || '/opt/dsh/data/gate-users.json'
const SESSIONS_FILE = process.env.DSH_GATE_SESSIONS || '/opt/dsh/data/gate-sessions.json'
const WEB_LOG = process.env.DSH_WEB_LOG || '/opt/dsh/data/web.log'
const SESSION_TTL_MS = Number(process.env.DSH_GATE_SESSION_TTL_MS || 30 * 24 * 3600 * 1000)
const SESSION_COOKIE = 'dsh_gate_sid'
const DSH_COOKIE_PREFIX = 'dsh-auth-'
const LOCK_FAILS = Number(process.env.DSH_GATE_LOCK_FAILS || 5)
const LOCK_WINDOW_MS = Number(process.env.DSH_GATE_LOCK_WINDOW_MS || 15 * 60 * 1000)
const LOCK_MS = Number(process.env.DSH_GATE_LOCK_MS || 5 * 60 * 1000)
const BODY_LIMIT = 8 * 1024

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`)

/* ---------------- 用户与密码 ---------------- */

const loadUsers = () => {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).users ?? []
  } catch {
    return []
  }
}

const verifyPassword = (username, password) => {
  const user = loadUsers().find((item) => item.username === username)
  if (!user) {
    // 用户不存在也做一次等价计算，避免用户名枚举时序差异
    scryptSync(password, 'invalid-salt', 64)
    return false
  }
  const expected = Buffer.from(user.hash, 'hex')
  const actual = scryptSync(password, Buffer.from(user.salt, 'hex'), expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/* ---------------- 会话 ---------------- */

const sessions = new Map()

const loadSessions = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))
    const now = Date.now()
    for (const [id, item] of Object.entries(raw.sessions ?? {})) {
      if (item?.exp > now) sessions.set(id, item)
    }
  } catch {
    /* 首次运行没有会话文件 */
  }
}

const saveSessions = () => {
  try {
    const data = { sessions: Object.fromEntries(sessions) }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data), { mode: 0o600 })
  } catch (error) {
    log(`session save failed: ${error?.message ?? error}`)
  }
}

const createSession = (username) => {
  const id = randomBytes(32).toString('base64url')
  sessions.set(id, { username, exp: Date.now() + SESSION_TTL_MS })
  saveSessions()
  return id
}

const dropSession = (id) => {
  if (sessions.delete(id)) saveSessions()
}

const parseCookies = (header = '') => {
  const out = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return out
}

const sessionOf = (req) => {
  const id = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (!id) return null
  const item = sessions.get(id)
  if (!item) return null
  if (item.exp <= Date.now()) {
    dropSession(id)
    return null
  }
  return { id, ...item }
}

const sessionCookie = (id) =>
  `${SESSION_COOKIE}=${id}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; ` +
  'HttpOnly; Secure; SameSite=Lax'

const clearCookie = () =>
  `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`

/* ---------------- 登录失败限流 ---------------- */

const failures = new Map() // ip -> { count, first, lockedUntil }

const clientIp = (req) => {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
  return forwarded || req.socket.remoteAddress || 'unknown'
}

const isLocked = (ip) => {
  const item = failures.get(ip)
  return item?.lockedUntil > Date.now() ? item.lockedUntil : 0
}

const recordFailure = (ip) => {
  const now = Date.now()
  const item = failures.get(ip)
  if (!item || now - item.first > LOCK_WINDOW_MS) {
    failures.set(ip, { count: 1, first: now, lockedUntil: 0 })
    return
  }
  item.count += 1
  if (item.count >= LOCK_FAILS) {
    item.lockedUntil = now + LOCK_MS
    item.count = 0
    item.first = now
    log(`login locked ip=${ip} for ${Math.round(LOCK_MS / 1000)}s`)
  }
}

const recordSuccess = (ip) => failures.delete(ip)

/* ---------------- launch token（DSH 自动登录） ---------------- */

let tokenCache = { value: null, checkedAt: 0 }

const latestLaunchToken = () => {
  const now = Date.now()
  if (tokenCache.value && now - tokenCache.checkedAt < 5_000) return tokenCache.value
  tokenCache.checkedAt = now
  try {
    const content = fs.readFileSync(WEB_LOG, 'utf8')
    const matches = content.match(/[?&]token=([A-Za-z0-9_-]{10,})/g)
    tokenCache.value = matches?.length ? matches[matches.length - 1].replace(/^[?&]token=/, '') : null
  } catch {
    tokenCache.value = null
  }
  return tokenCache.value
}

/** 用 DSH 的 launch token 换取 dsh-auth-* Cookie（返回 Set-Cookie 数组） */
const exchangeLaunchToken = (hostHeader) =>
  new Promise((resolve) => {
    const token = latestLaunchToken()
    if (!token) return resolve(null)
    const upstream = http.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: `/?token=${encodeURIComponent(token)}`,
        method: 'GET',
        headers: { host: hostHeader, accept: 'text/html', connection: 'close' },
      },
      (res) => {
        const cookies = (res.headers['set-cookie'] ?? []).map((cookie) =>
          /;\s*secure/i.test(cookie) ? cookie : `${cookie}; Secure`
        )
        res.resume()
        resolve(cookies.length ? cookies : null)
      }
    )
    upstream.on('error', () => resolve(null))
    upstream.end()
  })

/** 容器重启后日志会清空并写入新 token：失败时失效 5s 缓存并重试，避免首个请求误报 401 */
const exchangeLaunchTokenWithRetry = async (hostHeader, attempts = 4) => {
  for (let i = 0; i < attempts; i += 1) {
    const issued = await exchangeLaunchToken(hostHeader)
    if (issued) return issued
    tokenCache.checkedAt = 0
    await new Promise((resolve) => setTimeout(resolve, 300 * (i + 1)))
  }
  return null
}

/* ---------------- 登录页 ---------------- */

const htmlEscape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  )

const safeNext = (value) => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/'
  return value
}

const loginPage = (next, notice = '') => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>登录 · DeepSeek Harness</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: radial-gradient(1200px 600px at 20% -10%, #2a3a63 0%, #101423 55%, #0a0d17 100%);
    color: #e8ecf6;
  }
  .card {
    width: 100%; max-width: 380px; padding: 32px 28px; border-radius: 18px;
    background: rgba(17, 22, 36, .86); border: 1px solid rgba(255,255,255,.09);
    box-shadow: 0 24px 60px rgba(0,0,0,.45); backdrop-filter: blur(14px);
  }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .logo {
    width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center;
    background: linear-gradient(135deg, #4f7cff, #7a4dff); font-weight: 700; font-size: 16px;
  }
  h1 { font-size: 18px; margin: 0; font-weight: 600; letter-spacing: .2px; }
  .sub { margin: 4px 0 24px; font-size: 13px; color: #93a0b8; }
  label { display: block; font-size: 13px; color: #b7c2d6; margin: 0 0 6px; }
  .field { margin-bottom: 16px; }
  input {
    width: 100%; height: 44px; padding: 0 14px; font-size: 15px; color: inherit;
    background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.14);
    border-radius: 11px; outline: none; transition: border-color .15s, background .15s;
  }
  input:focus { border-color: #5b8cff; background: rgba(255,255,255,.08); }
  button {
    width: 100%; height: 46px; margin-top: 6px; font-size: 15px; font-weight: 600; color: #fff;
    background: linear-gradient(135deg, #4f7cff, #6e5bff); border: 0; border-radius: 11px;
    cursor: pointer; transition: filter .15s, opacity .15s;
  }
  button:hover { filter: brightness(1.08); }
  button:disabled { opacity: .6; cursor: default; }
  .error { min-height: 20px; margin-top: 12px; font-size: 13px; color: #ff8a8a; }
  .foot { margin-top: 22px; font-size: 12px; color: #71809d; text-align: center; }
</style>
</head>
<body>
  <main class="card">
    <div class="brand"><span class="logo">DS</span><h1>DeepSeek Harness</h1></div>
    <p class="sub">服务器专用入口 · 请登录后使用</p>
    <form id="form" method="post" action="/login" autocomplete="on">
      <div class="field">
        <label for="username">用户名</label>
        <input id="username" name="username" type="text" autocomplete="username"
               autocapitalize="off" autocorrect="off" spellcheck="false" required autofocus>
      </div>
      <div class="field">
        <label for="password">密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
      </div>
      <button id="submit" type="submit">登 录</button>
      <div class="error" id="error" role="alert">${htmlEscape(notice)}</div>
    </form>
    <div class="foot">连续失败 ${LOCK_FAILS} 次将锁定 ${Math.round(LOCK_MS / 60000)} 分钟</div>
  </main>
<script src="/login.js"></script>
</body>
</html>`

const loginScript = `(() => {
  const raw = new URLSearchParams(location.search).get('next') || '/';
  const next = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
  const form = document.getElementById('form');
  const error = document.getElementById('error');
  const button = document.getElementById('submit');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    button.disabled = true;
    button.textContent = '登录中…';
    try {
      const response = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('username').value.trim(),
          password: document.getElementById('password').value,
        }),
      });
      if (response.ok) {
        location.replace(next);
        return;
      }
      if (response.status === 429) {
        const retry = Number(response.headers.get('Retry-After') || 0);
        error.textContent = '尝试次数过多，请' + Math.max(1, Math.ceil(retry / 60)) + '分钟后再试';
      } else if (response.status === 401) {
        error.textContent = '用户名或密码不正确';
        document.getElementById('password').select();
      } else {
        error.textContent = '登录失败，请稍后重试';
      }
    } catch {
      error.textContent = '网络异常，请检查连接';
    } finally {
      button.disabled = false;
      button.textContent = '登 录';
    }
  });
})()`

/* ---------------- 代理 ---------------- */

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
}

const proxy = (req, res, session) => {
  const headers = { ...req.headers }
  delete headers['proxy-connection']
  // 保留浏览器原始 Host（DSH 的信任栅栏依赖它）
  const upstream = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: req.url, method: req.method, headers },
    (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers }
      const cookies = upstreamRes.headers['set-cookie']
      if (cookies) {
        responseHeaders['set-cookie'] = cookies.map((cookie) =>
          /;\s*secure/i.test(cookie) ? cookie : `${cookie}; Secure`
        )
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
      upstreamRes.pipe(res)
    }
  )
  upstream.on('error', (error) => {
    log(`upstream error: ${error.message}`)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    }
    res.end('Upstream unavailable')
  })
  req.pipe(upstream)
}

const json = (res, status, body, extraHeaders = {}) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  })
  res.end(JSON.stringify(body))
}

const readBody = (req) =>
  new Promise((resolve) => {
    let body = ''
    let tooLarge = false
    req.on('data', (chunk) => {
      if (tooLarge) return
      body += chunk
      if (body.length > BODY_LIMIT) {
        tooLarge = true
        req.destroy()
      }
    })
    req.on('end', () => resolve(tooLarge ? null : body))
    req.on('error', () => resolve(null))
  })

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://gate.local')
  const ip = clientIp(req)
  const session = sessionOf(req)

  // ---- 登录页 ----
  if ((url.pathname === '/login' || url.pathname === '/login/') && req.method === 'GET') {
    if (session) {
      res.writeHead(302, { Location: safeNext(url.searchParams.get('next')) })
      res.end()
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    })
    res.end(loginPage(safeNext(url.searchParams.get('next'))))
    return
  }

  if (url.pathname === '/login.js') {
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
    })
    res.end(loginScript)
    return
  }

  // ---- 登录提交 ----
  if (url.pathname === '/login' && req.method === 'POST') {
    const lockedUntil = isLocked(ip)
    if (lockedUntil) {
      json(res, 429, { ok: false, error: 'too_many_attempts' }, {
        'Retry-After': String(Math.ceil((lockedUntil - Date.now()) / 1000)),
      })
      return
    }
    const body = await readBody(req)
    if (body === null) {
      json(res, 413, { ok: false, error: 'payload_too_large' })
      return
    }
    let username = ''
    let password = ''
    const contentType = String(req.headers['content-type'] ?? '')
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const form = new URLSearchParams(body)
      username = (form.get('username') ?? '').trim()
      password = form.get('password') ?? ''
    } else {
      try {
        const parsed = JSON.parse(body)
        username = typeof parsed.username === 'string' ? parsed.username.trim() : ''
        password = typeof parsed.password === 'string' ? parsed.password : ''
      } catch {
        json(res, 400, { ok: false, error: 'bad_request' })
        return
      }
    }
    if (!username || !password || username.length > 64 || password.length > 256) {
      json(res, 400, { ok: false, error: 'bad_request' })
      return
    }
    if (!verifyPassword(username, password)) {
      recordFailure(ip)
      log(`login failed user=${username} ip=${ip}`)
      json(res, 401, { ok: false, error: 'invalid_credentials' })
      return
    }
    recordSuccess(ip)
    const id = createSession(username)
    log(`login ok user=${username} ip=${ip}`)
    json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(id) })
    return
  }

  // ---- 登出 ----
  if (url.pathname === '/logout') {
    if (session) {
      dropSession(session.id)
      log(`logout user=${session.username} ip=${ip}`)
    }
    res.writeHead(302, {
      Location: '/login',
      'Set-Cookie': clearCookie(),
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
    })
    res.end()
    return
  }

  // ---- 未登录 ----
  if (!session) {
    const acceptsHtml = String(req.headers.accept ?? '').includes('text/html')
    if (req.method === 'GET' && acceptsHtml) {
      const next = req.url && req.url !== '/' ? req.url : '/'
      res.writeHead(302, {
        Location: `/login?next=${encodeURIComponent(next)}`,
        'Cache-Control': 'no-store',
      })
      res.end()
      return
    }
    json(res, 401, { ok: false, error: 'authentication_required' })
    return
  }

  // ---- 已登录：首次访问且没有 DSH Cookie 时，自动完成 launch token 交换 ----
  const cookies = parseCookies(req.headers.cookie)
  const hasDshCookie = Object.keys(cookies).some((name) => name.startsWith(DSH_COOKIE_PREFIX))
  if (!hasDshCookie && req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const issued = await exchangeLaunchTokenWithRetry(req.headers.host ?? '')
    if (issued) {
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': issued,
        'Cache-Control': 'no-store',
        ...SECURITY_HEADERS,
      })
      res.end()
      return
    }
    log('launch token exchange failed; falling back to upstream 401')
  }

  proxy(req, res, session)
})

// ---- WebSocket 升级：校验会话后原样透传 ----
server.on('upgrade', (req, socket, head) => {
  if (!sessionOf(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [name, value] of Object.entries(req.headers)) {
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head?.length) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

loadSessions()
server.listen(PORT, '127.0.0.1', () => {
  log(`dsh-gate listening on 127.0.0.1:${PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`)
})

#!/usr/bin/env node
/**
 * dsh-gate 账号管理（零依赖）
 *
 * 设置密码（交互输入或环境变量）：
 *   DSH_GATE_PASSWORD='...' node admin.mjs set-user dsh
 *   node admin.mjs set-user dsh        # 回车后从 stdin 读取一行
 *
 * 删除账号：
 *   node admin.mjs del-user dsh
 *
 * 文件默认 /opt/dsh/data/gate-users.json（0600）；支持 DSH_GATE_USERS 覆盖。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { randomBytes, scryptSync } from 'node:crypto'

const USERS_FILE = process.env.DSH_GATE_USERS || '/opt/dsh/data/gate-users.json'
const [command, username] = process.argv.slice(2)

const readUsers = () => {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
  } catch {
    return { users: [] }
  }
}

const writeUsers = (data) => {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true })
  const tmp = `${USERS_FILE}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, USERS_FILE)
  fs.chmodSync(USERS_FILE, 0o600)
}

const promptPassword = () =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false })
    rl.once('line', (line) => {
      rl.close()
      resolve(line.trim())
    })
  })

const main = async () => {
  if (!command || !username) {
    console.error('usage: admin.mjs set-user <username> | del-user <username>')
    process.exit(2)
  }
  const data = readUsers()

  if (command === 'del-user') {
    const before = data.users.length
    data.users = data.users.filter((item) => item.username !== username)
    writeUsers(data)
    console.error(`removed ${before - data.users.length} user(s)`)
    return
  }

  if (command !== 'set-user') {
    console.error(`unknown command: ${command}`)
    process.exit(2)
  }

  const password = process.env.DSH_GATE_PASSWORD ?? (await promptPassword())
  if (!password || password.length < 8) {
    console.error('password must be at least 8 characters')
    process.exit(1)
  }
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  const entry = { username, salt: salt.toString('hex'), hash: hash.toString('hex'), updatedAt: new Date().toISOString() }
  data.users = data.users.filter((item) => item.username !== username)
  data.users.push(entry)
  writeUsers(data)
  console.error(`user "${username}" updated in ${USERS_FILE}`)
}

await main()

import 'dotenv/config'
import express from 'express'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import {
  createSession,
  getSessionStatus,
  createGroup,
  checkPhoneNumber,
  sendTextMessage,
  sendImageMessage,
  getGroupInviteLink,
  getGroupParticipantCount,
  destroySession,
  listSessions,
  listGroups,
} from './sessionManager.js'

const log = pino({ level: process.env.LOG_LEVEL || 'info' })
const app = express()
app.use(express.json({ limit: '20mb' }))

const API_SECRET = process.env.API_SECRET || 'dev-secret-change-in-production'

// Internal auth middleware
app.use((req, res, next) => {
  if (req.headers['x-api-secret'] !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
})

// ───────────────── Session Management ─────────────────

// POST /sessions  → create (or re-create) a session, triggers QR code generation
app.post('/sessions', async (req, res) => {
  const { sessionId } = req.body
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' })

  try {
    const result = await createSession(sessionId)
    res.status(201).json(result)
  } catch (err) {
    log.error({ err, sessionId }, 'Failed to create session')
    res.status(500).json({ error: err.message })
  }
})

// GET /sessions/:sessionId  → get status + QR code (if waiting_scan)
app.get('/sessions/:sessionId', (req, res) => {
  const { sessionId } = req.params
  const status = getSessionStatus(sessionId)
  res.json(status)
})

// GET /sessions  → list all sessions
app.get('/sessions', (_req, res) => {
  res.json(listSessions())
})

// DELETE /sessions/:sessionId  → disconnect and remove session
app.delete('/sessions/:sessionId', (req, res) => {
  destroySession(req.params.sessionId)
  res.status(204).end()
})

// ───────────────── Group Operations ─────────────────

// POST /check-number  → verifica se um número é conta WhatsApp ativa
app.post('/check-number', async (req, res) => {
  const { sessionId, phone } = req.body
  if (!sessionId || !phone) return res.status(400).json({ error: 'sessionId and phone are required' })
  try {
    const result = await checkPhoneNumber(sessionId, phone)
    res.json(result)
  } catch (err) {
    log.error({ err, sessionId, phone }, 'Failed to check phone number')
    res.status(500).json({ error: err.message })
  }
})

// POST /groups  → create a new WhatsApp group
app.post('/groups', async (req, res) => {
  const { sessionId, groupName, participants, profilePicUrl } = req.body
  if (!sessionId || !groupName) {
    return res.status(400).json({ error: 'sessionId and groupName are required' })
  }

  try {
    const result = await createGroup(sessionId, groupName, participants ?? [], profilePicUrl ?? null)
    res.status(201).json(result)
  } catch (err) {
    log.error({ err, sessionId, groupName }, 'Failed to create group')
    res.status(500).json({ error: err.message })
  }
})

// GET /sessions/:sessionId/groups  → lista grupos que a sessão participa
app.get('/sessions/:sessionId/groups', async (req, res) => {
  try {
    const groups = await listGroups(req.params.sessionId)
    res.json(groups)
  } catch (err) {
    log.error({ err, sessionId: req.params.sessionId }, 'Failed to list groups')
    res.status(500).json({ error: err.message })
  }
})

// GET /groups/:groupId/participants/count  → get participant count from WhatsApp
app.get('/groups/:groupId/participants/count', async (req, res) => {
  const { sessionId } = req.query
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' })

  try {
    const count = await getGroupParticipantCount(sessionId, req.params.groupId)
    res.json({ count })
  } catch (err) {
    log.error({ err }, 'Failed to get participant count')
    res.status(500).json({ error: err.message })
  }
})

// GET /groups/:groupId/invite-link  → get or refresh invite link
app.get('/groups/:groupId/invite-link', async (req, res) => {
  const { sessionId } = req.query
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' })

  try {
    const link = await getGroupInviteLink(sessionId, req.params.groupId)
    res.json({ inviteLink: link })
  } catch (err) {
    log.error({ err }, 'Failed to get invite link')
    res.status(500).json({ error: err.message })
  }
})

// ───────────────── Message Operations ─────────────────

// POST /messages/text  → send text message to a group
app.post('/messages/text', async (req, res) => {
  const { sessionId, groupId, text } = req.body
  if (!sessionId || !groupId || !text) {
    return res.status(400).json({ error: 'sessionId, groupId, and text are required' })
  }

  try {
    await sendTextMessage(sessionId, groupId, text)
    res.json({ success: true })
  } catch (err) {
    log.error({ err, sessionId, groupId }, 'Failed to send text message')
    res.status(500).json({ error: err.message })
  }
})

// POST /messages/image  → send image message to a group (via URL or base64)
app.post('/messages/image', async (req, res) => {
  const { sessionId, groupId, imageUrl, imageBase64, caption } = req.body
  if (!sessionId || !groupId || (!imageUrl && !imageBase64)) {
    return res.status(400).json({ error: 'sessionId, groupId, and imageUrl or imageBase64 are required' })
  }

  try {
    await sendImageMessage(sessionId, groupId, imageUrl ?? null, caption, imageBase64 ?? null)
    res.json({ success: true })
  } catch (err) {
    log.error({ err, sessionId, groupId }, 'Failed to send image message')
    res.status(500).json({ error: err.message })
  }
})

// ───────────────── Health ─────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', sessions: listSessions().length })
})

// ───────────────── Auto-restore sessions on startup ─────────────────

async function restorePersistedSessions() {
  const sessionsDir = process.env.SESSIONS_DIR || './sessions'
  if (!fs.existsSync(sessionsDir)) return

  const dirs = fs.readdirSync(sessionsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)

  log.info(`Restoring ${dirs.length} persisted session(s) from disk...`)

  for (const sessionId of dirs) {
    const credsPath = path.join(sessionsDir, sessionId, 'creds.json')
    if (!fs.existsSync(credsPath)) {
      log.warn({ sessionId }, 'Skipping session — no creds.json found')
      continue
    }
    try {
      log.info({ sessionId }, 'Restoring session from disk')
      await createSession(sessionId)
    } catch (err) {
      log.error({ sessionId, err: err.message }, 'Failed to restore session')
    }
  }
}

const PORT = process.env.PORT || 3001
app.listen(PORT, async () => {
  log.info(`WhatsApp service listening on port ${PORT}`)
  await restorePersistedSessions()
})

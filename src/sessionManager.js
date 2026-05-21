import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode'
import pino from 'pino'
import path from 'path'
import fs from 'fs'
import { attachMessageMonitor } from './messageMonitor.js'

const log = pino({ level: 'info' })

/**
 * Baixa uma imagem de uma URL e retorna como Buffer.
 * Mais confiável que passar { url } ao Baileys, pois evita
 * problemas de acesso ao S3 pelo processo interno do Baileys.
 */
async function fetchImageBuffer(url) {
  // Tenta a URL original primeiro; se falhar com DNS/network, tenta URL direta do S3
  const tryFetch = async (targetUrl) => {
    const res = await fetch(targetUrl, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading image from ${targetUrl}`)
    return Buffer.from(await res.arrayBuffer())
  }

  try {
    return await tryFetch(url)
  } catch (err) {
    // Se falhou por DNS/rede (CDN não acessível), tenta URL pública do S3 diretamente
    const isNetworkError = err.message?.includes('ENOTFOUND') ||
                           err.message?.includes('fetch failed') ||
                           err.cause?.code === 'ENOTFOUND'
    if (isNetworkError) {
      // Extrai o caminho da imagem e monta URL S3 direta
      const parsed = new URL(url)
      const s3Url = `https://grupolink-media.s3.us-east-1.amazonaws.com${parsed.pathname}`
      log.warn({ url, s3Url }, 'CDN URL failed, falling back to direct S3 URL')
      return await tryFetch(s3Url)
    }
    throw err
  }
}

// Active sessions: Map<sessionId, { socket, status, qrBase64, phone }>
const sessions = new Map()

const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions'

function ensureSessionsDir(sessionId) {
  const dir = path.join(SESSIONS_DIR, sessionId)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

export async function createSession(sessionId) {
  if (sessions.has(sessionId)) {
    const existing = sessions.get(sessionId)
    if (existing.status === 'authenticated') return { status: 'already_authenticated', phone: existing.phone }
    // Sessão aguardando scan — não destrói, só retorna o estado atual
    if (existing.status === 'waiting_scan') {
      log.info({ sessionId }, 'Session already waiting for QR scan, skipping recreate')
      return { status: 'qr_generated', sessionId }
    }
    destroySession(sessionId)
  }

  const sessionEntry = { status: 'waiting_scan', qrBase64: null, phone: null, socket: null }
  sessions.set(sessionId, sessionEntry)

  const authDir = ensureSessionsDir(sessionId)
  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const { version } = await fetchLatestBaileysVersion()

  const socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, log),
    },
    logger: log.child({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['GrupoLink', 'Chrome', '120.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  })

  sessionEntry.socket = socket

  socket.ev.on('creds.update', saveCreds)

  // Listener de mensagens com filtro de meli.la — emite webhook ao backend
  attachMessageMonitor(socket, sessionId)

  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    const entry = sessions.get(sessionId)
    if (!entry) return

    if (qr) {
      try {
        entry.qrBase64 = await qrcode.toDataURL(qr)
        entry.status = 'waiting_scan'
        log.info({ sessionId }, 'QR code generated')
      } catch (err) {
        log.error({ sessionId, err }, 'Failed to generate QR code')
      }
    }

    // Atualiza o QR enquanto aguarda (Baileys pode emitir múltiplos QRs durante retentativas)
    if (update.qrUpdate) {
      try {
        entry.qrBase64 = await qrcode.toDataURL(update.qrUpdate)
        log.info({ sessionId }, 'QR code refreshed')
      } catch (_) {}
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      if (reason === DisconnectReason.loggedOut || reason === DisconnectReason.forbidden) {
        log.warn({ sessionId, reason }, 'Session logged out, destroying')
        entry.status = 'disconnected'
        destroySession(sessionId)
      } else if (reason !== DisconnectReason.connectionReplaced) {
        log.info({ sessionId, reason }, 'Reconnecting after close...')
        // Aguarda 2s para garantir que saveCreds gravou tudo em disco antes de recriar
        // (sem isso, as credenciais podem não estar salvas quando o novo socket inicia)
        sessions.delete(sessionId)
        setTimeout(() => createSession(sessionId), 2000)
      }
    }

    if (connection === 'open') {
      const me = socket.user
      const phone = me?.id?.split(':')[0] ?? me?.id ?? ''
      // Atualiza entry que pode ser a nova criada pelo reconnect
      const currentEntry = sessions.get(sessionId)
      if (currentEntry) {
        currentEntry.status = 'authenticated'
        currentEntry.phone = phone
        currentEntry.qrBase64 = null
      }
      log.info({ sessionId, phone }, 'Session authenticated ✓')
    }
  })

  return { status: 'qr_generated', sessionId }
}

export function getSessionStatus(sessionId) {
  const entry = sessions.get(sessionId)
  if (!entry) return { status: 'not_found' }
  return {
    status: entry.status,
    qrBase64: entry.qrBase64,
    phone: entry.phone,
  }
}

export async function checkPhoneNumber(sessionId, phone) {
  const entry = sessions.get(sessionId)
  if (!entry || entry.status !== 'authenticated') throw new Error('Session not authenticated')

  const normalized = phone.replace(/\D/g, '')

  log.info({ sessionId, phone: normalized }, 'Checking phone number on WhatsApp...')

  let results
  try {
    results = await entry.socket.onWhatsApp(normalized)
  } catch (err) {
    log.error({ sessionId, phone: normalized, err: err.message }, 'onWhatsApp threw an error')
    throw new Error(`WhatsApp check failed: ${err.message}`)
  }

  log.info({ sessionId, phone: normalized, results }, 'onWhatsApp result')

  const result = Array.isArray(results) ? results[0] : results

  if (!result) {
    // Número não encontrado
    return {
      exists: false,
      jid:   `${normalized}@s.whatsapp.net`,
      phone: normalized,
    }
  }

  const jid = result.jid ?? `${normalized}@s.whatsapp.net`
  return {
    exists: result.exists ?? false,
    jid,
    phone: normalized,
  }
}

export async function createGroup(sessionId, groupName, participantJids = [], profilePicUrl = null) {
  const entry = sessions.get(sessionId)
  if (!entry || entry.status !== 'authenticated') throw new Error('Session not authenticated')

  // participantJids devem ser JIDs exatos do WhatsApp (ex: "5511999998888@s.whatsapp.net")
  // Normaliza qualquer entrada que ainda seja telefone puro
  const participants = participantJids
    .filter(Boolean)
    .map(p => p.includes('@') ? p : `${p.replace(/\D/g, '')}@s.whatsapp.net`)

  if (participants.length === 0) throw new Error('É necessário pelo menos 1 participante para criar um grupo')

  log.info({ sessionId, groupName, participants }, 'Creating WhatsApp group')
  const result = await entry.socket.groupCreate(groupName, participants)
  const groupId = result.id

  // Define foto de perfil do grupo
  if (profilePicUrl) {
    try {
      const imageBuffer = await fetchImageBuffer(profilePicUrl)
      await entry.socket.updateProfilePicture(groupId, imageBuffer)
      log.info({ sessionId, groupId }, 'Group profile picture set')
    } catch (err) {
      log.warn({ sessionId, groupId, err: err.message }, 'Failed to set group profile picture')
    }
  }

  // Gera link de convite
  const inviteCode = await entry.socket.groupInviteCode(groupId)
  return {
    groupId,
    inviteLink: `https://chat.whatsapp.com/${inviteCode}`,
  }
}

export async function sendTextMessage(sessionId, groupId, text) {
  const entry = sessions.get(sessionId)
  if (!entry || entry.status !== 'authenticated') throw new Error('Session not authenticated')
  await entry.socket.sendMessage(groupId, { text })
  return true
}

export async function sendImageMessage(sessionId, groupId, imageUrl, caption, imageBase64 = null) {
  const entry = sessions.get(sessionId)
  if (!entry || entry.status !== 'authenticated') throw new Error('Session not authenticated')

  const imageBuffer = imageBase64
    ? Buffer.from(imageBase64, 'base64')
    : await fetchImageBuffer(imageUrl)

  await entry.socket.sendMessage(groupId, {
    image: imageBuffer,
    caption: caption ?? '',
  })
  return true
}

export async function getGroupParticipantCount(sessionId, groupId) {
  const entry = sessions.get(sessionId)
  if (!entry || entry.status !== 'authenticated') throw new Error('Session not authenticated')
  const metadata = await entry.socket.groupMetadata(groupId)
  return metadata.participants.length
}

export async function getGroupInviteLink(sessionId, groupId) {
  const entry = sessions.get(sessionId)
  if (!entry || entry.status !== 'authenticated') throw new Error('Session not authenticated')
  const code = await entry.socket.groupInviteCode(groupId)
  return `https://chat.whatsapp.com/${code}`
}

export async function getGroupInfo(sessionId, groupId) {
  const entry = sessions.get(sessionId)
  if (!entry || entry.status !== 'authenticated') throw new Error('Session not authenticated')
  const metadata = await entry.socket.groupMetadata(groupId)
  let profilePicUrl = null
  try {
    profilePicUrl = await entry.socket.profilePictureUrl(groupId, 'image')
  } catch (_) {}
  const inviteCode = await entry.socket.groupInviteCode(groupId).catch(() => null)
  return {
    groupId:       metadata.id,
    name:          metadata.subject ?? '(sem nome)',
    participants:  metadata.participants?.length ?? 0,
    profilePicUrl,
    inviteLink:    inviteCode ? `https://chat.whatsapp.com/${inviteCode}` : null,
  }
}

/**
 * Lista todos os grupos WhatsApp que a sessão participa.
 * Retorna apenas dados essenciais para seleção na UI.
 */
export async function listGroups(sessionId) {
  const entry = sessions.get(sessionId)
  if (!entry || entry.status !== 'authenticated') throw new Error('Session not authenticated')

  const userJid  = entry.socket.user?.id  ?? ''
  const userLid  = entry.socket.user?.lid ?? ''
  // WhatsApp migrou para LID (Linked Identity) — owners e participantes usam @lid, não @s.whatsapp.net
  // Precisamos comparar contra ambos os formatos
  const bareId = (jid) => jid ? jid.split('@')[0].split(':')[0] : ''
  const myBare    = bareId(userJid)   // ex: "554896750519" (phone)
  const myBareLid = bareId(userLid)   // ex: "192603630919688" (LID)

  const all = await entry.socket.groupFetchAllParticipating()
  return Object.values(all)
    .filter((g) => {
      const ownerBare = bareId(g.owner ?? '')
      if (g.owner && (ownerBare === myBare || ownerBare === myBareLid)) return true
      // Fallback: superadmin nos participantes (= criador original)
      const me = g.participants?.find((p) => {
        const pb = bareId(p.id)
        return pb === myBare || pb === myBareLid
      })
      return me?.admin === 'superadmin'
    })
    .map((g) => ({
      groupId:      g.id,
      name:         g.subject ?? '(sem nome)',
      participants: g.participants?.length ?? 0,
    }))
}

export function destroySession(sessionId) {
  const entry = sessions.get(sessionId)
  if (entry?.socket) {
    try { entry.socket.end() } catch (_) {}
  }
  sessions.delete(sessionId)
  // Remove persisted auth files
  const authDir = path.join(SESSIONS_DIR, sessionId)
  if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
  log.info({ sessionId }, 'Session destroyed')
}

export function listSessions() {
  return Array.from(sessions.entries()).map(([id, entry]) => ({
    sessionId: id,
    status: entry.status,
    phone: entry.phone,
  }))
}

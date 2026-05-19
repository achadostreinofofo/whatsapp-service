import { downloadMediaMessage } from '@whiskeysockets/baileys'
import pino from 'pino'

const log = pino({ level: process.env.LOG_LEVEL || 'info' })

const MELI_URL_PATTERN    = /https?:\/\/meli\.la\//i
const BACKEND_MESSAGE_URL = process.env.BACKEND_WEBHOOK_URL
  || 'http://localhost:8080/api/webhooks/whatsapp/internal/message'
const BACKEND_API_SECRET  = process.env.BACKEND_API_SECRET || 'dev-secret-change-in-production'

function extractText(message) {
  if (!message) return ''
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ''
  )
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us')
}

/**
 * Baixa a imagem da mensagem via Baileys e retorna o buffer em base64.
 * Retorna null em caso de falha — o webhook ainda é emitido sem imagem.
 */
async function downloadImageAsBase64(msg) {
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {})
    if (!buffer || buffer.length === 0) return null
    return buffer.toString('base64')
  } catch (err) {
    log.error({ err: err.message }, 'Erro ao baixar imagem da mensagem')
    return null
  }
}

/**
 * Anexa o listener de mensagens à sessão.
 * Filtra mensagens de grupos com link "https://meli.la/...".
 * Se houver imagem, converte para base64 e inclui no payload — sem S3, sem banco.
 */
export function attachMessageMonitor(socket, sessionId) {
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue

        const groupId = msg.key.remoteJid
        if (!isGroupJid(groupId)) continue

        const text = extractText(msg.message)
        if (!text) continue

        if (!MELI_URL_PATTERN.test(text)) continue

        // Se houver imagem, baixa e converte para base64 (sem upload externo)
        let imageBase64   = null
        let imageMimeType = null
        if (msg.message?.imageMessage) {
          log.info({ sessionId, groupId }, 'Imagem detectada — baixando via Baileys')
          imageBase64   = await downloadImageAsBase64(msg)
          imageMimeType = msg.message.imageMessage.mimetype || 'image/jpeg'
        }

        const payload = {
          sessionId,
          groupId,
          senderJid:    msg.key.participant ?? null,
          messageId:    msg.key.id,
          text,
          imageBase64,
          imageMimeType,
          timestamp:    Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
        }

        log.info(
          { sessionId, groupId, messageId: payload.messageId, hasImage: !!imageBase64 },
          'Mensagem com link meli.la detectada — enviando webhook'
        )

        fetch(BACKEND_MESSAGE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-secret': BACKEND_API_SECRET,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        }).catch((err) => {
          log.error({ sessionId, err: err.message }, 'Falha ao enviar webhook para o backend')
        })
      } catch (err) {
        log.error({ sessionId, err: err.message }, 'Erro processando mensagem recebida')
      }
    }
  })

  log.info({ sessionId }, 'Message monitor attached (filtro: meli.la)')
}

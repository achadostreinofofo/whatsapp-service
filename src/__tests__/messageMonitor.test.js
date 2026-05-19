import { jest, describe, it, expect, beforeEach } from '@jest/globals'

// ── global fetch mock ──────────────────────────────────────────────────────
const mockFetch = jest.fn()
global.fetch = mockFetch

// ── pino: silence all log output ──────────────────────────────────────────
jest.unstable_mockModule('pino', () => ({
  default: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(() => ({ level: 'silent' })),
  })),
}))

// ── Baileys: mock only downloadMediaMessage ───────────────────────────────
const mockDownloadMediaMessage = jest.fn()
jest.unstable_mockModule('@whiskeysockets/baileys', () => ({
  downloadMediaMessage: mockDownloadMediaMessage,
}))

// ── dynamic import AFTER mocks ────────────────────────────────────────────
const { attachMessageMonitor } = await import('../messageMonitor.js')

// ── helpers ───────────────────────────────────────────────────────────────
const SESSION_ID = 'sess-monitor'
const GROUP_JID  = '111222333@g.us'
const MELI_TEXT  = 'Veja a oferta: https://meli.la/XaB3k'

function buildMessage({
  fromMe       = false,
  remoteJid    = GROUP_JID,
  participant  = '5511@s.whatsapp.net',
  id           = 'msg-1',
  messageType  = 'conversation',
  text         = MELI_TEXT,
  withImage    = false,
  timestamp    = 1700000000,
} = {}) {
  let message
  if (withImage) {
    message = { imageMessage: { caption: text, mimetype: 'image/jpeg' } }
  } else if (messageType === 'conversation') {
    message = { conversation: text }
  } else if (messageType === 'extended') {
    message = { extendedTextMessage: { text } }
  } else if (messageType === 'image') {
    message = { imageMessage: { caption: text, mimetype: 'image/jpeg' } }
  } else if (messageType === 'video') {
    message = { videoMessage: { caption: text } }
  } else {
    message = null
  }
  return { key: { fromMe, remoteJid, id, participant }, message, messageTimestamp: timestamp }
}

function makeSocket() {
  let handler = null
  const socket = {
    ev: {
      on: jest.fn((event, fn) => { if (event === 'messages.upsert') handler = fn }),
    },
    _trigger: (payload) => handler(payload),
  }
  return socket
}

// ── tests ─────────────────────────────────────────────────────────────────
describe('attachMessageMonitor', () => {
  let socket

  beforeEach(() => {
    jest.clearAllMocks()
    mockFetch.mockResolvedValue({ ok: true })
    mockDownloadMediaMessage.mockResolvedValue(Buffer.from('img-data'))
    socket = makeSocket()
  })

  it('registra listener messages.upsert no socket', () => {
    attachMessageMonitor(socket, SESSION_ID)
    expect(socket.ev.on).toHaveBeenCalledWith('messages.upsert', expect.any(Function))
  })

  it('ignora eventos com type != notify', async () => {
    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({ messages: [buildMessage()], type: 'append' })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('ignora mensagens enviadas pelo proprio numero (fromMe)', async () => {
    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({ messages: [buildMessage({ fromMe: true })], type: 'notify' })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('ignora JIDs que nao sao de grupo (@s.whatsapp.net)', async () => {
    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({
      messages: [buildMessage({ remoteJid: '5511999998888@s.whatsapp.net' })],
      type: 'notify',
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('ignora mensagens sem texto (message null)', async () => {
    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({
      messages: [{ key: { fromMe: false, remoteJid: GROUP_JID, id: 'x' }, message: null }],
      type: 'notify',
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('ignora mensagens sem link meli.la', async () => {
    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({
      messages: [buildMessage({ text: 'Oi pessoal, tudo bem?' })],
      type: 'notify',
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('envia webhook quando mensagem contem link meli.la', async () => {
    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({ messages: [buildMessage()], type: 'notify' })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toContain('/api/webhooks/whatsapp/internal/message')
    expect(opts.method).toBe('POST')
  })

  it('payload do webhook contem campos corretos', async () => {
    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({ messages: [buildMessage({ id: 'id-42', timestamp: 1700001234 })], type: 'notify' })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.sessionId).toBe(SESSION_ID)
    expect(body.groupId).toBe(GROUP_JID)
    expect(body.messageId).toBe('id-42')
    expect(body.text).toBe(MELI_TEXT)
    expect(body.timestamp).toBe(1700001234)
    expect(body.imageBase64).toBeNull()
    expect(body.imageMimeType).toBeNull()
  })

  it('payload inclui senderJid da key.participant', async () => {
    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({
      messages: [buildMessage({ participant: '55119@s.whatsapp.net' })],
      type: 'notify',
    })
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.senderJid).toBe('55119@s.whatsapp.net')
  })

  it('envia x-api-secret no header do webhook', async () => {
    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({ messages: [buildMessage()], type: 'notify' })
    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.headers['x-api-secret']).toBeDefined()
    expect(typeof opts.headers['x-api-secret']).toBe('string')
  })

  // ── extração de texto ────────────────────────────────────────────────────

  it('extrai texto de extendedTextMessage', async () => {
    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({ messages: [buildMessage({ messageType: 'extended' })], type: 'notify' })
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.text).toBe(MELI_TEXT)
  })

  it('extrai texto de imageMessage.caption', async () => {
    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({ messages: [buildMessage({ messageType: 'image' })], type: 'notify' })
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.text).toBe(MELI_TEXT)
  })

  it('extrai texto de videoMessage.caption', async () => {
    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({ messages: [buildMessage({ messageType: 'video' })], type: 'notify' })
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.text).toBe(MELI_TEXT)
  })

  // ── imagens ──────────────────────────────────────────────────────────────

  it('baixa imagem e inclui base64 no payload', async () => {
    const imgBuf = Buffer.from('fake-image-bytes')
    mockDownloadMediaMessage.mockResolvedValue(imgBuf)

    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({ messages: [buildMessage({ withImage: true })], type: 'notify' })

    expect(mockDownloadMediaMessage).toHaveBeenCalledTimes(1)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.imageBase64).toBe(imgBuf.toString('base64'))
    expect(body.imageMimeType).toBe('image/jpeg')
  })

  it('envia webhook sem imagem se download retornar null', async () => {
    mockDownloadMediaMessage.mockResolvedValue(null)

    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({ messages: [buildMessage({ withImage: true })], type: 'notify' })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.imageBase64).toBeNull()
  })

  it('envia webhook sem imagem se download retornar buffer vazio', async () => {
    mockDownloadMediaMessage.mockResolvedValue(Buffer.alloc(0))

    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({ messages: [buildMessage({ withImage: true })], type: 'notify' })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.imageBase64).toBeNull()
  })

  it('envia webhook sem imagem se download lancar erro', async () => {
    mockDownloadMediaMessage.mockRejectedValue(new Error('Download failed'))

    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({ messages: [buildMessage({ withImage: true })], type: 'notify' })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.imageBase64).toBeNull()
  })

  // ── robustez ─────────────────────────────────────────────────────────────

  it('nao crasha se o fetch do webhook falhar', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))

    attachMessageMonitor(socket, SESSION_ID)
    await expect(
      socket._trigger({ messages: [buildMessage()], type: 'notify' })
    ).resolves.toBeUndefined()
  })

  it('continua processando mensagens validas apos uma mensagem com erro interno', async () => {
    attachMessageMonitor(socket, SESSION_ID)
    const badMsg = { key: null }  // key.fromMe vai lancar TypeError → cai no catch
    const goodMsg = buildMessage({ id: 'good-1' })

    await socket._trigger({ messages: [badMsg, goodMsg], type: 'notify' })

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('processa multiplas mensagens validas no mesmo batch', async () => {
    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({
      messages: [
        buildMessage({ id: 'm1', text: 'sem link' }),
        buildMessage({ id: 'm2', text: 'veja https://meli.la/aaa' }),
        buildMessage({ id: 'm3', text: 'outro https://meli.la/bbb' }),
      ],
      type: 'notify',
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('pattern meli.la case-insensitive', async () => {
    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({
      messages: [buildMessage({ text: 'HTTPS://MELI.LA/oferta' })],
      type: 'notify',
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('pattern meli.la exige barra apos o dominio', async () => {
    attachMessageMonitor(socket, SESSION_ID)
    await socket._trigger({
      messages: [buildMessage({ text: 'https://meli.la' })],  // sem barra final
      type: 'notify',
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('usa Math.floor(Date.now()/1000) quando messageTimestamp e falsy', async () => {
    const before = Math.floor(Date.now() / 1000)

    attachMessageMonitor(socket, SESSION_ID)
    const msg = buildMessage({ timestamp: 0 })
    await socket._trigger({ messages: [msg], type: 'notify' })

    const after = Math.floor(Date.now() / 1000)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.timestamp).toBeGreaterThanOrEqual(before)
    expect(body.timestamp).toBeLessThanOrEqual(after)
  })
})

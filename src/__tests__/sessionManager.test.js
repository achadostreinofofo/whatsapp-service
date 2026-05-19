import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'

// ── global fetch mock ──────────────────────────────────────────────────────
const mockFetch = jest.fn()
global.fetch = mockFetch

// ── pino: silence ─────────────────────────────────────────────────────────
jest.unstable_mockModule('pino', () => ({
  default: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(() => ({ level: 'silent' })),
  })),
}))

// ── messageMonitor: no-op para nao interferir ─────────────────────────────
jest.unstable_mockModule('../messageMonitor.js', () => ({
  attachMessageMonitor: jest.fn(),
}))

// ── fs: controle total do filesystem ─────────────────────────────────────
const mockFs = {
  existsSync: jest.fn().mockReturnValue(false),
  mkdirSync:  jest.fn(),
  rmSync:     jest.fn(),
}
jest.unstable_mockModule('fs', () => ({ default: mockFs, ...mockFs }))

// ── qrcode ───────────────────────────────────────────────────────────────
const mockQrToDataURL = jest.fn().mockResolvedValue('data:image/png;base64,QRTEST')
jest.unstable_mockModule('qrcode', () => ({
  default: { toDataURL: mockQrToDataURL },
}))

// ── @hapi/boom ────────────────────────────────────────────────────────────
jest.unstable_mockModule('@hapi/boom', () => ({
  Boom: jest.fn((err) => ({ output: { statusCode: err?.output?.statusCode ?? 500 } })),
}))

// ── Baileys: socket + funções de auth/versão ──────────────────────────────
const evHandlers = {}

const mockSocket = {
  ev: {
    on: jest.fn((event, fn) => { evHandlers[event] = fn }),
  },
  user: { id: '5511999998888:1@s.whatsapp.net' },
  onWhatsApp:                jest.fn(),
  groupCreate:               jest.fn(),
  groupInviteCode:           jest.fn(),
  groupMetadata:             jest.fn(),
  groupFetchAllParticipating: jest.fn(),
  sendMessage:               jest.fn(),
  updateProfilePicture:      jest.fn(),
  end:                       jest.fn(),
}

const mockSaveCreds = jest.fn()

jest.unstable_mockModule('@whiskeysockets/baileys', () => ({
  default:                    jest.fn(() => mockSocket),
  useMultiFileAuthState:      jest.fn().mockResolvedValue({
    state: { creds: {}, keys: {} },
    saveCreds: mockSaveCreds,
  }),
  fetchLatestBaileysVersion:  jest.fn().mockResolvedValue({ version: [2, 3000, 1] }),
  makeCacheableSignalKeyStore: jest.fn((keys) => keys),
  DisconnectReason: {
    loggedOut:           401,
    forbidden:           403,
    connectionReplaced:  409,
  },
}))

// ── importação real do módulo após mocks ──────────────────────────────────
const {
  createSession,
  getSessionStatus,
  checkPhoneNumber,
  createGroup,
  sendTextMessage,
  sendImageMessage,
  getGroupParticipantCount,
  getGroupInviteLink,
  listGroups,
  destroySession,
  listSessions,
} = await import('../sessionManager.js')

// ── helpers ───────────────────────────────────────────────────────────────
function resetEvHandlers() {
  Object.keys(evHandlers).forEach((k) => delete evHandlers[k])
}

async function createAndAuthenticate(sessionId) {
  await createSession(sessionId)
  // simula conexão aberta (autenticação bem-sucedida)
  await evHandlers['connection.update']?.({ connection: 'open' })
}

function makeFetchOk(data = Buffer.from('fake')) {
  mockFetch.mockResolvedValue({
    ok: true,
    arrayBuffer: jest.fn().mockResolvedValue(data.buffer ?? new ArrayBuffer(8)),
  })
}

// ── limpeza entre testes ──────────────────────────────────────────────────
beforeEach(() => {
  resetEvHandlers()
  jest.clearAllMocks()
  mockFs.existsSync.mockReturnValue(false)
  mockQrToDataURL.mockResolvedValue('data:image/png;base64,QRTEST')
})

afterEach(() => {
  // remove todas as sessões criadas neste teste
  for (const { sessionId } of listSessions()) {
    destroySession(sessionId)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
describe('getSessionStatus', () => {
  it('retorna not_found para sessao inexistente', () => {
    expect(getSessionStatus('inexistente')).toEqual({ status: 'not_found' })
  })

  it('retorna waiting_scan logo apos createSession', async () => {
    await createSession('s1')
    const result = getSessionStatus('s1')
    expect(result.status).toBe('waiting_scan')
  })

  it('retorna qrBase64 e phone null antes da autenticacao', async () => {
    await createSession('s2')
    const result = getSessionStatus('s2')
    expect(result.qrBase64).toBeNull()
    expect(result.phone).toBeNull()
  })

  it('retorna authenticated e phone apos conexao aberta', async () => {
    await createAndAuthenticate('s3')
    const result = getSessionStatus('s3')
    expect(result.status).toBe('authenticated')
    expect(result.phone).toBe('5511999998888')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('listSessions', () => {
  it('retorna lista vazia inicialmente', () => {
    expect(listSessions()).toEqual([])
  })

  it('lista sessao criada com campos corretos', async () => {
    await createSession('ls1')
    const list = listSessions()
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual({ sessionId: 'ls1', status: 'waiting_scan', phone: null })
  })

  it('lista multiplas sessoes', async () => {
    await createSession('ls2')
    await createSession('ls3')
    const ids = listSessions().map((s) => s.sessionId)
    expect(ids).toContain('ls2')
    expect(ids).toContain('ls3')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('createSession', () => {
  it('retorna qr_generated para nova sessao', async () => {
    const result = await createSession('new-1')
    expect(result).toEqual({ status: 'qr_generated', sessionId: 'new-1' })
  })

  it('retorna already_authenticated se sessao ja esta autenticada', async () => {
    await createAndAuthenticate('auth-1')
    const result = await createSession('auth-1')
    expect(result).toEqual({ status: 'already_authenticated', phone: '5511999998888' })
  })

  it('retorna qr_generated sem recriar se sessao esta waiting_scan', async () => {
    await createSession('wq-1')
    jest.clearAllMocks()
    const result = await createSession('wq-1')
    expect(result).toEqual({ status: 'qr_generated', sessionId: 'wq-1' })
    // makeWASocket nao deve ter sido chamado novamente
    const { default: makeWASocket } = await import('@whiskeysockets/baileys')
    expect(makeWASocket).not.toHaveBeenCalled()
  })

  it('destroi sessao desconectada e recria', async () => {
    await createAndAuthenticate('dc-1')
    // simula disconnect manual (status fica disconnected)
    getSessionStatus('dc-1')  // estado antes
    // destroi e recria
    destroySession('dc-1')
    const result = await createSession('dc-1')
    expect(result.status).toBe('qr_generated')
  })

  it('gera QR code ao receber evento qr', async () => {
    await createSession('qr-1')
    await evHandlers['connection.update']?.({ qr: 'qr-string-123' })
    expect(mockQrToDataURL).toHaveBeenCalledWith('qr-string-123')
    const { qrBase64 } = getSessionStatus('qr-1')
    expect(qrBase64).toBe('data:image/png;base64,QRTEST')
  })

  it('atualiza QR via qrUpdate', async () => {
    await createSession('qru-1')
    await evHandlers['connection.update']?.({ qrUpdate: 'updated-qr' })
    expect(mockQrToDataURL).toHaveBeenCalledWith('updated-qr')
  })

  it('nao crasha se toDataURL falhar ao gerar QR', async () => {
    mockQrToDataURL.mockRejectedValueOnce(new Error('QR fail'))
    await createSession('qr-fail')
    await expect(
      evHandlers['connection.update']?.({ qr: 'bad-qr' })
    ).resolves.not.toThrow()
  })

  it('destrói sessao ao receber close com loggedOut (401)', async () => {
    await createAndAuthenticate('lo-1')
    await evHandlers['connection.update']?.({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    })
    expect(getSessionStatus('lo-1').status).toBe('not_found')
  })

  it('destrói sessao ao receber close com forbidden (403)', async () => {
    await createAndAuthenticate('fb-1')
    await evHandlers['connection.update']?.({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 403 } } },
    })
    expect(getSessionStatus('fb-1').status).toBe('not_found')
  })

  it('agenda reconexao apos close com erro generico', async () => {
    jest.useFakeTimers()
    await createSession('rc-1')

    await evHandlers['connection.update']?.({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    })

    // sessao deve ter sido removida do mapa
    expect(listSessions().find((s) => s.sessionId === 'rc-1')).toBeUndefined()
    // timer de reconexao deve estar agendado
    expect(jest.getTimerCount()).toBeGreaterThanOrEqual(1)
    jest.useRealTimers()
  })

  it('nao faz nada ao receber close com connectionReplaced (409)', async () => {
    await createSession('cr-1')
    await evHandlers['connection.update']?.({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 409 } } },
    })
    // sessao permanece no mapa
    expect(getSessionStatus('cr-1').status).not.toBe('not_found')
  })

  it('registra listener creds.update no socket', async () => {
    await createSession('cu-1')
    expect(mockSocket.ev.on).toHaveBeenCalledWith('creds.update', expect.any(Function))
  })

  it('chama attachMessageMonitor ao criar sessao', async () => {
    const { attachMessageMonitor } = await import('../messageMonitor.js')
    await createSession('mm-1')
    expect(attachMessageMonitor).toHaveBeenCalledWith(mockSocket, 'mm-1')
  })

  it('ignora connection.update se a sessao nao existe mais', async () => {
    await createSession('ghost-1')
    destroySession('ghost-1')
    // nao deve lancar erro
    await expect(
      evHandlers['connection.update']?.({ connection: 'open' })
    ).resolves.toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('destroySession', () => {
  it('remove sessao do mapa', async () => {
    await createSession('d1')
    destroySession('d1')
    expect(getSessionStatus('d1').status).toBe('not_found')
  })

  it('chama socket.end()', async () => {
    await createSession('d2')
    destroySession('d2')
    expect(mockSocket.end).toHaveBeenCalled()
  })

  it('remove diretorio de auth se existir', async () => {
    mockFs.existsSync.mockReturnValue(true)
    await createSession('d3')
    destroySession('d3')
    expect(mockFs.rmSync).toHaveBeenCalledWith(expect.stringContaining('d3'), { recursive: true, force: true })
  })

  it('nao lanca erro para sessao inexistente', () => {
    expect(() => destroySession('inexistente')).not.toThrow()
  })

  it('nao chama rmSync se diretorio nao existir', async () => {
    mockFs.existsSync.mockReturnValue(false)
    await createSession('d4')
    destroySession('d4')
    expect(mockFs.rmSync).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('checkPhoneNumber', () => {
  const SID = 'cp-session'

  beforeEach(async () => { await createAndAuthenticate(SID) })
  afterEach(() => { destroySession(SID) })

  it('lanca erro se sessao nao existir', async () => {
    await expect(checkPhoneNumber('nao-existe', '5511')).rejects.toThrow('Session not authenticated')
  })

  it('lanca erro se sessao nao estiver autenticada', async () => {
    await createSession('cp-notauth')
    await expect(checkPhoneNumber('cp-notauth', '5511')).rejects.toThrow('Session not authenticated')
    destroySession('cp-notauth')
  })

  it('normaliza numero removendo caracteres nao-numericos', async () => {
    mockSocket.onWhatsApp.mockResolvedValue([{ exists: true, jid: '5511@s.whatsapp.net' }])
    await checkPhoneNumber(SID, '+55 (11) 99999-8888')
    // '+55 (11) 99999-8888' → remove não-dígitos → '5511999998888' (13 dígitos)
    expect(mockSocket.onWhatsApp).toHaveBeenCalledWith('5511999998888')
  })

  it('retorna exists:true com jid quando numero existe', async () => {
    mockSocket.onWhatsApp.mockResolvedValue([{ exists: true, jid: '5511@s.whatsapp.net' }])
    const result = await checkPhoneNumber(SID, '5511999998888')
    expect(result.exists).toBe(true)
    expect(result.jid).toBe('5511@s.whatsapp.net')
    expect(result.phone).toBe('5511999998888')
  })

  it('retorna exists:false quando numero nao existe (array vazio)', async () => {
    mockSocket.onWhatsApp.mockResolvedValue([])
    const result = await checkPhoneNumber(SID, '5511000000000')
    expect(result.exists).toBe(false)
    expect(result.jid).toBe('5511000000000@s.whatsapp.net')
  })

  it('retorna exists:false quando resultado e null', async () => {
    mockSocket.onWhatsApp.mockResolvedValue(null)
    const result = await checkPhoneNumber(SID, '5511000000001')
    expect(result.exists).toBe(false)
  })

  it('usa jid gerado quando result nao tem jid', async () => {
    mockSocket.onWhatsApp.mockResolvedValue([{ exists: true }])
    const result = await checkPhoneNumber(SID, '5511999997777')
    expect(result.jid).toBe('5511999997777@s.whatsapp.net')
  })

  it('aceita resultado direto (nao-array)', async () => {
    mockSocket.onWhatsApp.mockResolvedValue({ exists: true, jid: '5511@s.whatsapp.net' })
    const result = await checkPhoneNumber(SID, '5511')
    expect(result.exists).toBe(true)
  })

  it('encapsula erro do onWhatsApp', async () => {
    mockSocket.onWhatsApp.mockRejectedValue(new Error('Timeout'))
    await expect(checkPhoneNumber(SID, '5511')).rejects.toThrow('WhatsApp check failed: Timeout')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('createGroup', () => {
  const SID = 'cg-session'

  beforeEach(async () => {
    await createAndAuthenticate(SID)
    mockSocket.groupCreate.mockResolvedValue({ id: '999@g.us' })
    mockSocket.groupInviteCode.mockResolvedValue('INVITECODE123')
  })
  afterEach(() => { destroySession(SID) })

  it('lanca erro se sessao nao autenticada', async () => {
    await expect(createGroup('nao-existe', 'Test', ['jid@s.whatsapp.net']))
      .rejects.toThrow('Session not authenticated')
  })

  it('lanca erro se lista de participantes estiver vazia', async () => {
    await expect(createGroup(SID, 'Grupo', [])).rejects.toThrow('pelo menos 1 participante')
  })

  it('lanca erro se participantes for somente strings vazias', async () => {
    await expect(createGroup(SID, 'Grupo', ['', null, undefined])).rejects.toThrow('pelo menos 1 participante')
  })

  it('cria grupo e retorna groupId e inviteLink', async () => {
    const result = await createGroup(SID, 'Meu Grupo', ['5511@s.whatsapp.net'])
    expect(result.groupId).toBe('999@g.us')
    expect(result.inviteLink).toBe('https://chat.whatsapp.com/INVITECODE123')
  })

  it('normaliza numero de telefone puro para JID', async () => {
    await createGroup(SID, 'G', ['5511999998888'])
    const [, participants] = mockSocket.groupCreate.mock.calls[0]
    expect(participants).toContain('5511999998888@s.whatsapp.net')
  })

  it('mantem JID valido sem modificar', async () => {
    await createGroup(SID, 'G', ['5511@s.whatsapp.net'])
    const [, participants] = mockSocket.groupCreate.mock.calls[0]
    expect(participants).toContain('5511@s.whatsapp.net')
  })

  it('define foto de perfil quando profilePicUrl fornecida', async () => {
    makeFetchOk()
    await createGroup(SID, 'G', ['5511@s.whatsapp.net'], 'https://example.com/pic.jpg')
    expect(mockSocket.updateProfilePicture).toHaveBeenCalledWith('999@g.us', expect.any(Buffer))
  })

  it('nao quebra se updateProfilePicture falhar', async () => {
    makeFetchOk()
    mockSocket.updateProfilePicture.mockRejectedValue(new Error('Foto falhou'))
    const result = await createGroup(SID, 'G', ['5511@s.whatsapp.net'], 'https://example.com/pic.jpg')
    expect(result.groupId).toBe('999@g.us')
  })

  it('nao chama updateProfilePicture quando profilePicUrl e null', async () => {
    await createGroup(SID, 'G', ['5511@s.whatsapp.net'], null)
    expect(mockSocket.updateProfilePicture).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('sendTextMessage', () => {
  const SID = 'st-session'

  beforeEach(async () => { await createAndAuthenticate(SID) })
  afterEach(() => { destroySession(SID) })

  it('lanca erro se sessao nao autenticada', async () => {
    await expect(sendTextMessage('nao-existe', 'gid', 'oi')).rejects.toThrow('Session not authenticated')
  })

  it('chama sendMessage com text correto', async () => {
    mockSocket.sendMessage.mockResolvedValue({})
    await sendTextMessage(SID, '123@g.us', 'Olá grupo!')
    expect(mockSocket.sendMessage).toHaveBeenCalledWith('123@g.us', { text: 'Olá grupo!' })
  })

  it('retorna true em caso de sucesso', async () => {
    mockSocket.sendMessage.mockResolvedValue({})
    const result = await sendTextMessage(SID, '123@g.us', 'msg')
    expect(result).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('sendImageMessage', () => {
  const SID = 'si-session'

  beforeEach(async () => {
    await createAndAuthenticate(SID)
    mockSocket.sendMessage.mockResolvedValue({})
  })
  afterEach(() => { destroySession(SID) })

  it('lanca erro se sessao nao autenticada', async () => {
    await expect(sendImageMessage('nao-existe', 'gid', 'http://x.com/img.jpg'))
      .rejects.toThrow('Session not authenticated')
  })

  it('envia imagem via URL (usa fetchImageBuffer)', async () => {
    makeFetchOk(Buffer.from('img-from-url'))
    await sendImageMessage(SID, '123@g.us', 'http://img.example.com/a.jpg', 'caption')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [, content] = mockSocket.sendMessage.mock.calls[0]
    expect(content.image).toBeInstanceOf(Buffer)
    expect(content.caption).toBe('caption')
  })

  it('envia imagem via base64 (nao usa fetch)', async () => {
    const b64 = Buffer.from('raw-image').toString('base64')
    await sendImageMessage(SID, '123@g.us', null, 'leg', b64)
    expect(mockFetch).not.toHaveBeenCalled()
    const [, content] = mockSocket.sendMessage.mock.calls[0]
    expect(content.image).toBeInstanceOf(Buffer)
  })

  it('usa caption vazia se nao informada', async () => {
    makeFetchOk()
    await sendImageMessage(SID, '123@g.us', 'http://img.example.com/b.jpg')
    const [, content] = mockSocket.sendMessage.mock.calls[0]
    expect(content.caption).toBe('')
  })

  it('retorna true em sucesso', async () => {
    makeFetchOk()
    const result = await sendImageMessage(SID, '123@g.us', 'http://img.example.com/c.jpg')
    expect(result).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('getGroupParticipantCount', () => {
  const SID = 'gc-session'

  beforeEach(async () => { await createAndAuthenticate(SID) })
  afterEach(() => { destroySession(SID) })

  it('lanca erro se sessao nao autenticada', async () => {
    await expect(getGroupParticipantCount('nao-existe', 'gid')).rejects.toThrow('Session not authenticated')
  })

  it('retorna contagem de participantes', async () => {
    mockSocket.groupMetadata.mockResolvedValue({
      participants: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    })
    const count = await getGroupParticipantCount(SID, '456@g.us')
    expect(count).toBe(3)
    expect(mockSocket.groupMetadata).toHaveBeenCalledWith('456@g.us')
  })

  it('retorna 0 quando grupo nao tem participantes', async () => {
    mockSocket.groupMetadata.mockResolvedValue({ participants: [] })
    expect(await getGroupParticipantCount(SID, 'x@g.us')).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('getGroupInviteLink', () => {
  const SID = 'gi-session'

  beforeEach(async () => { await createAndAuthenticate(SID) })
  afterEach(() => { destroySession(SID) })

  it('lanca erro se sessao nao autenticada', async () => {
    await expect(getGroupInviteLink('nao-existe', 'gid')).rejects.toThrow('Session not authenticated')
  })

  it('retorna link de convite formatado', async () => {
    mockSocket.groupInviteCode.mockResolvedValue('CODE456')
    const link = await getGroupInviteLink(SID, '789@g.us')
    expect(link).toBe('https://chat.whatsapp.com/CODE456')
    expect(mockSocket.groupInviteCode).toHaveBeenCalledWith('789@g.us')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('listGroups', () => {
  const SID = 'lg-session'

  beforeEach(async () => { await createAndAuthenticate(SID) })
  afterEach(() => { destroySession(SID) })

  it('lanca erro se sessao nao autenticada', async () => {
    await expect(listGroups('nao-existe')).rejects.toThrow('Session not authenticated')
  })

  it('retorna lista de grupos formatada', async () => {
    mockSocket.groupFetchAllParticipating.mockResolvedValue({
      'g1@g.us': { id: 'g1@g.us', subject: 'Grupo 1', participants: [{ id: 'a' }, { id: 'b' }] },
      'g2@g.us': { id: 'g2@g.us', subject: 'Grupo 2', participants: [{ id: 'c' }] },
    })
    const groups = await listGroups(SID)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual({ groupId: 'g1@g.us', name: 'Grupo 1', participants: 2 })
    expect(groups[1]).toEqual({ groupId: 'g2@g.us', name: 'Grupo 2', participants: 1 })
  })

  it('usa (sem nome) quando subject e undefined', async () => {
    mockSocket.groupFetchAllParticipating.mockResolvedValue({
      'g3@g.us': { id: 'g3@g.us', participants: [] },
    })
    const groups = await listGroups(SID)
    expect(groups[0].name).toBe('(sem nome)')
  })

  it('usa 0 quando participants e undefined', async () => {
    mockSocket.groupFetchAllParticipating.mockResolvedValue({
      'g4@g.us': { id: 'g4@g.us', subject: 'G4' },
    })
    const groups = await listGroups(SID)
    expect(groups[0].participants).toBe(0)
  })

  it('retorna lista vazia quando nao ha grupos', async () => {
    mockSocket.groupFetchAllParticipating.mockResolvedValue({})
    expect(await listGroups(SID)).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('fetchImageBuffer (via sendImageMessage)', () => {
  const SID = 'fb-session'

  beforeEach(async () => {
    await createAndAuthenticate(SID)
    mockSocket.sendMessage.mockResolvedValue({})
  })
  afterEach(() => { destroySession(SID) })

  it('lanca erro HTTP nao-ok ao baixar imagem', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 })
    await expect(sendImageMessage(SID, 'g@g.us', 'http://x.com/img.jpg'))
      .rejects.toThrow('HTTP 404')
  })

  it('usa fallback S3 direto quando CDN retorna ENOTFOUND', async () => {
    const netErr = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    mockFetch
      .mockRejectedValueOnce(netErr)
      .mockResolvedValueOnce({ ok: true, arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)) })

    await sendImageMessage(SID, 'g@g.us', 'https://cdn.example.com/img/test.jpg')
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const s3Call = mockFetch.mock.calls[1][0]
    expect(s3Call).toContain('s3.us-east-1.amazonaws.com')
    expect(s3Call).toContain('/img/test.jpg')
  })

  it('usa fallback S3 quando mensagem de erro contem ENOTFOUND', async () => {
    const netErr = new Error('ENOTFOUND cdn.example.com')
    mockFetch
      .mockRejectedValueOnce(netErr)
      .mockResolvedValueOnce({ ok: true, arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)) })

    await sendImageMessage(SID, 'g@g.us', 'https://cdn.example.com/foto.jpg')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('relanca erro nao-relacionado a rede', async () => {
    mockFetch.mockRejectedValue(new Error('Unexpected error'))
    await expect(sendImageMessage(SID, 'g@g.us', 'http://x.com/img.jpg'))
      .rejects.toThrow('Unexpected error')
  })
})

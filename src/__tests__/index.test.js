import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import supertest from 'supertest'

// ── env: porta 0 evita conflito e dotenv nao sobrescreve ───────────────────
process.env.PORT       = '0'
process.env.API_SECRET = 'test-secret-xyz'

// ── pino: silence ─────────────────────────────────────────────────────────
jest.unstable_mockModule('pino', () => ({
  default: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(() => ({ level: 'silent' })),
  })),
}))

// ── dotenv: nao carrega .env real nos testes ──────────────────────────────
jest.unstable_mockModule('dotenv/config', () => ({}))

// ── fs: impede restauração de sessoes do disco ─────────────────────────────
const mockFs = {
  existsSync:  jest.fn().mockReturnValue(false),
  readdirSync: jest.fn().mockReturnValue([]),
  mkdirSync:   jest.fn(),
  rmSync:      jest.fn(),
}
jest.unstable_mockModule('fs', () => ({ default: mockFs, ...mockFs }))

// ── sessionManager: todas as funções são mocks controlados ────────────────
const mockSM = {
  createSession:           jest.fn(),
  getSessionStatus:        jest.fn(),
  listSessions:            jest.fn().mockReturnValue([]),
  destroySession:          jest.fn(),
  checkPhoneNumber:        jest.fn(),
  createGroup:             jest.fn(),
  listGroups:              jest.fn(),
  getGroupParticipantCount: jest.fn(),
  getGroupInviteLink:      jest.fn(),
  getGroupInfo:            jest.fn(),
  sendTextMessage:         jest.fn(),
  sendImageMessage:        jest.fn(),
}
jest.unstable_mockModule('../sessionManager.js', () => mockSM)

// ── import real do módulo após mocks ─────────────────────────────────────
const { app, server } = await import('../index.js')
const request = supertest(app)
const AUTH    = { 'x-api-secret': 'test-secret-xyz' }
const WRONG   = { 'x-api-secret': 'wrong' }

afterAll(() => { server.close() })
beforeEach(() => { jest.clearAllMocks() })

// ═══════════════════════════════════════════════════════════════════════════
describe('Middleware de autenticação', () => {
  it('retorna 401 quando header x-api-secret esta ausente', async () => {
    const res = await request.get('/health')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Unauthorized')
  })

  it('retorna 401 quando x-api-secret esta errado', async () => {
    const res = await request.get('/health').set(WRONG)
    expect(res.status).toBe(401)
  })

  it('permite requisicao com secret correto', async () => {
    const res = await request.get('/health').set(AUTH)
    expect(res.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('GET /health', () => {
  it('retorna status ok e contagem de sessoes', async () => {
    mockSM.listSessions.mockReturnValue([{ sessionId: 'a' }, { sessionId: 'b' }])
    const res = await request.get('/health').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok', sessions: 2 })
  })

  it('retorna sessions:0 quando nao ha sessoes', async () => {
    mockSM.listSessions.mockReturnValue([])
    const res = await request.get('/health').set(AUTH)
    expect(res.body.sessions).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('POST /sessions', () => {
  it('retorna 400 quando sessionId nao informado', async () => {
    const res = await request.post('/sessions').set(AUTH).send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/sessionId/)
  })

  it('retorna 201 e resultado do createSession', async () => {
    mockSM.createSession.mockResolvedValue({ status: 'qr_generated', sessionId: 's1' })
    const res = await request.post('/sessions').set(AUTH).send({ sessionId: 's1' })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ status: 'qr_generated', sessionId: 's1' })
    expect(mockSM.createSession).toHaveBeenCalledWith('s1')
  })

  it('retorna 500 quando createSession lanca erro', async () => {
    mockSM.createSession.mockRejectedValue(new Error('Baileys down'))
    const res = await request.post('/sessions').set(AUTH).send({ sessionId: 'err' })
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Baileys down')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('GET /sessions/:sessionId', () => {
  it('retorna status da sessao', async () => {
    mockSM.getSessionStatus.mockReturnValue({ status: 'waiting_scan', qrBase64: null, phone: null })
    const res = await request.get('/sessions/my-sess').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('waiting_scan')
    expect(mockSM.getSessionStatus).toHaveBeenCalledWith('my-sess')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('GET /sessions', () => {
  it('retorna lista de sessoes', async () => {
    mockSM.listSessions.mockReturnValue([{ sessionId: 'a', status: 'authenticated', phone: '55' }])
    const res = await request.get('/sessions').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].sessionId).toBe('a')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('DELETE /sessions/:sessionId', () => {
  it('retorna 204 e chama destroySession', async () => {
    const res = await request.delete('/sessions/del-sess').set(AUTH)
    expect(res.status).toBe(204)
    expect(mockSM.destroySession).toHaveBeenCalledWith('del-sess')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('POST /check-number', () => {
  it('retorna 400 quando sessionId ausente', async () => {
    const res = await request.post('/check-number').set(AUTH).send({ phone: '5511' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/sessionId/)
  })

  it('retorna 400 quando phone ausente', async () => {
    const res = await request.post('/check-number').set(AUTH).send({ sessionId: 's1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/phone/)
  })

  it('retorna resultado do checkPhoneNumber', async () => {
    mockSM.checkPhoneNumber.mockResolvedValue({ exists: true, jid: '55@s.whatsapp.net', phone: '55' })
    const res = await request.post('/check-number').set(AUTH).send({ sessionId: 's1', phone: '55' })
    expect(res.status).toBe(200)
    expect(res.body.exists).toBe(true)
  })

  it('retorna 500 quando checkPhoneNumber lanca erro', async () => {
    mockSM.checkPhoneNumber.mockRejectedValue(new Error('Session not authenticated'))
    const res = await request.post('/check-number').set(AUTH).send({ sessionId: 's1', phone: '55' })
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Session not authenticated')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('POST /groups', () => {
  it('retorna 400 quando sessionId ausente', async () => {
    const res = await request.post('/groups').set(AUTH).send({ groupName: 'G' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/sessionId/)
  })

  it('retorna 400 quando groupName ausente', async () => {
    const res = await request.post('/groups').set(AUTH).send({ sessionId: 's1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/groupName/)
  })

  it('cria grupo e retorna 201', async () => {
    mockSM.createGroup.mockResolvedValue({ groupId: 'g1@g.us', inviteLink: 'https://chat.whatsapp.com/X' })
    const res = await request.post('/groups').set(AUTH).send({
      sessionId: 's1',
      groupName: 'Grupo Teste',
      participants: ['55@s.whatsapp.net'],
      profilePicUrl: 'https://example.com/pic.jpg',
    })
    expect(res.status).toBe(201)
    expect(res.body.groupId).toBe('g1@g.us')
    expect(mockSM.createGroup).toHaveBeenCalledWith(
      's1', 'Grupo Teste', ['55@s.whatsapp.net'], 'https://example.com/pic.jpg'
    )
  })

  it('usa defaults quando participants e profilePicUrl ausentes', async () => {
    mockSM.createGroup.mockResolvedValue({ groupId: 'g2@g.us', inviteLink: 'https://chat.whatsapp.com/Y' })
    await request.post('/groups').set(AUTH).send({ sessionId: 's1', groupName: 'G' })
    expect(mockSM.createGroup).toHaveBeenCalledWith('s1', 'G', [], null)
  })

  it('retorna 500 quando createGroup lanca erro', async () => {
    mockSM.createGroup.mockRejectedValue(new Error('Sem participantes'))
    const res = await request.post('/groups').set(AUTH).send({ sessionId: 's1', groupName: 'G' })
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Sem participantes')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('GET /sessions/:sessionId/groups', () => {
  it('retorna lista de grupos', async () => {
    mockSM.listGroups.mockResolvedValue([{ groupId: 'g1@g.us', name: 'G1', participants: 3 }])
    const res = await request.get('/sessions/sess1/groups').set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(mockSM.listGroups).toHaveBeenCalledWith('sess1')
  })

  it('retorna 500 quando listGroups lanca erro', async () => {
    mockSM.listGroups.mockRejectedValue(new Error('Session not authenticated'))
    const res = await request.get('/sessions/sess1/groups').set(AUTH)
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Session not authenticated')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('GET /groups/:groupId/participants/count', () => {
  it('retorna 400 quando sessionId ausente', async () => {
    const res = await request.get('/groups/g1@g.us/participants/count').set(AUTH)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/sessionId/)
  })

  it('retorna contagem de participantes', async () => {
    mockSM.getGroupParticipantCount.mockResolvedValue(42)
    const res = await request
      .get('/groups/g1@g.us/participants/count')
      .query({ sessionId: 's1' })
      .set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ count: 42 })
    expect(mockSM.getGroupParticipantCount).toHaveBeenCalledWith('s1', 'g1@g.us')
  })

  it('retorna 500 quando getGroupParticipantCount lanca erro', async () => {
    mockSM.getGroupParticipantCount.mockRejectedValue(new Error('fail'))
    const res = await request
      .get('/groups/g1@g.us/participants/count')
      .query({ sessionId: 's1' })
      .set(AUTH)
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('GET /groups/:groupId/invite-link', () => {
  it('retorna 400 quando sessionId ausente', async () => {
    const res = await request.get('/groups/g1@g.us/invite-link').set(AUTH)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/sessionId/)
  })

  it('retorna link de convite', async () => {
    mockSM.getGroupInviteLink.mockResolvedValue('https://chat.whatsapp.com/CODE')
    const res = await request
      .get('/groups/g1@g.us/invite-link')
      .query({ sessionId: 's1' })
      .set(AUTH)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ inviteLink: 'https://chat.whatsapp.com/CODE' })
    expect(mockSM.getGroupInviteLink).toHaveBeenCalledWith('s1', 'g1@g.us')
  })

  it('retorna 500 quando getGroupInviteLink lanca erro', async () => {
    mockSM.getGroupInviteLink.mockRejectedValue(new Error('fail'))
    const res = await request
      .get('/groups/g1@g.us/invite-link')
      .query({ sessionId: 's1' })
      .set(AUTH)
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('POST /messages/text', () => {
  it('retorna 400 quando sessionId ausente', async () => {
    const res = await request.post('/messages/text').set(AUTH).send({ groupId: 'g', text: 'hi' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/sessionId/)
  })

  it('retorna 400 quando groupId ausente', async () => {
    const res = await request.post('/messages/text').set(AUTH).send({ sessionId: 's', text: 'hi' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/groupId/)
  })

  it('retorna 400 quando text ausente', async () => {
    const res = await request.post('/messages/text').set(AUTH).send({ sessionId: 's', groupId: 'g' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/text/)
  })

  it('envia mensagem e retorna success:true', async () => {
    mockSM.sendTextMessage.mockResolvedValue(true)
    const res = await request
      .post('/messages/text')
      .set(AUTH)
      .send({ sessionId: 's1', groupId: 'g1@g.us', text: 'Olá!' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(mockSM.sendTextMessage).toHaveBeenCalledWith('s1', 'g1@g.us', 'Olá!')
  })

  it('retorna 500 quando sendTextMessage lanca erro', async () => {
    mockSM.sendTextMessage.mockRejectedValue(new Error('fail'))
    const res = await request
      .post('/messages/text')
      .set(AUTH)
      .send({ sessionId: 's1', groupId: 'g1', text: 'msg' })
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('POST /messages/image', () => {
  it('retorna 400 quando sessionId ausente', async () => {
    const res = await request.post('/messages/image').set(AUTH)
      .send({ groupId: 'g', imageUrl: 'http://x.com/a.jpg' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/sessionId/)
  })

  it('retorna 400 quando groupId ausente', async () => {
    const res = await request.post('/messages/image').set(AUTH)
      .send({ sessionId: 's', imageUrl: 'http://x.com/a.jpg' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/groupId/)
  })

  it('retorna 400 quando imageUrl e imageBase64 ausentes', async () => {
    const res = await request.post('/messages/image').set(AUTH)
      .send({ sessionId: 's', groupId: 'g' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/imageUrl/)
  })

  it('envia imagem por URL e retorna success:true', async () => {
    mockSM.sendImageMessage.mockResolvedValue(true)
    const res = await request.post('/messages/image').set(AUTH).send({
      sessionId: 's1',
      groupId: 'g1@g.us',
      imageUrl: 'http://x.com/img.jpg',
      caption: 'legenda',
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(mockSM.sendImageMessage).toHaveBeenCalledWith(
      's1', 'g1@g.us', 'http://x.com/img.jpg', 'legenda', null
    )
  })

  it('envia imagem por base64', async () => {
    mockSM.sendImageMessage.mockResolvedValue(true)
    const res = await request.post('/messages/image').set(AUTH).send({
      sessionId: 's1',
      groupId: 'g1@g.us',
      imageBase64: 'abc123==',
    })
    expect(res.status).toBe(200)
    expect(mockSM.sendImageMessage).toHaveBeenCalledWith('s1', 'g1@g.us', null, undefined, 'abc123==')
  })

  it('retorna 500 quando sendImageMessage lanca erro', async () => {
    mockSM.sendImageMessage.mockRejectedValue(new Error('fail'))
    const res = await request.post('/messages/image').set(AUTH).send({
      sessionId: 's1',
      groupId: 'g1',
      imageUrl: 'http://x.com/img.jpg',
    })
    expect(res.status).toBe(500)
  })
})

describe('GET /sessions/:sessionId/groups/:groupId', () => {
  it('retorna info do grupo com sucesso', async () => {
    const info = {
      groupId: '123@g.us',
      name: 'Treino Fofo #1',
      participants: 42,
      profilePicUrl: 'https://pic.url/g.jpg',
      inviteLink: 'https://chat.whatsapp.com/ABC',
    }
    mockSM.getGroupInfo.mockResolvedValue(info)

    const res = await request.get('/sessions/sess1/groups/123@g.us').set(AUTH)

    expect(res.status).toBe(200)
    expect(res.body.groupId).toBe('123@g.us')
    expect(res.body.name).toBe('Treino Fofo #1')
    expect(res.body.participants).toBe(42)
    expect(mockSM.getGroupInfo).toHaveBeenCalledWith('sess1', '123@g.us')
  })

  it('retorna 500 quando getGroupInfo lanca erro', async () => {
    mockSM.getGroupInfo.mockRejectedValue(new Error('Session not authenticated'))

    const res = await request.get('/sessions/sess1/groups/999@g.us').set(AUTH)

    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Session not authenticated')
  })

  it('retorna 401 sem autenticacao', async () => {
    const res = await request.get('/sessions/sess1/groups/123@g.us').set(WRONG)
    expect(res.status).toBe(401)
  })
})

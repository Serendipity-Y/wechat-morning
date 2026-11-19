const test = require("node:test")
const assert = require("node:assert/strict")
const {
  readOwnerBindingRevision,
  getNextOwnerBindingRevision,
  getInviteOwnerBindingRevisionDecision,
  getPartnerBindingDecision,
  getUnbindPartnerDecision,
  canAccessMorningAsMember,
} = require("../cloudfunctions/morningService/partnerBindingState")

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0)
const OWNER_OPENID = "owner-openid"
const PARTNER_OPENID = "partner-openid"
const CANDIDATE_OPENID = "candidate-openid"

const createMockedMorningService = ({ onQr, onUpload, onTempUrl, onRetry } = {}) => {
  const servicePath = require.resolve("../cloudfunctions/morningService/index.js")
  const cloud = require(require.resolve("wx-server-sdk", { paths: [servicePath] }))
  const priorService = require.cache[servicePath]
  const original = {
    init: cloud.init,
    getWXContext: cloud.getWXContext,
    database: cloud.database,
    openapi: cloud.openapi,
    uploadFile: cloud.uploadFile,
    getTempFileURL: cloud.getTempFileURL,
  }
  const records = {
    appUsers: [{
      _id: "owner-id",
      openid: OWNER_OPENID,
      role: "owner",
      status: "active",
    }],
    morningSettings: [{
      _id: "settings-id",
      ownerOpenid: OWNER_OPENID,
      partnerOpenid: "",
    }],
    morningInvites: [],
  }
  let currentOpenid = OWNER_OPENID
  let inTransaction = false
  let queue = Promise.resolve()
  let retryPending = Boolean(onRetry)
  const collection = (name) => ({
    where(query) {
      const matching = () => (records[name] || []).filter((record) => (
        Object.entries(query).every(([key, value]) => record[key] === value)
      ))
      return {
        limit(max) {
          return { get: async () => ({ data: matching().slice(0, max) }) }
        },
      }
    },
    doc(id) {
      return {
        get: async () => ({ data: (records[name] || []).find((record) => record._id === id) || null }),
        update: async ({ data }) => {
          const target = (records[name] || []).find((record) => record._id === id)
          if (!target) throw new Error("missing mocked document")
          for (const [key, value] of Object.entries(data)) {
            target[key] = value && value.mockIncrement !== undefined
              ? (target[key] || 0) + value.mockIncrement
              : value
          }
          return { stats: { updated: 1 } }
        },
      }
    },
    add: async ({ data }) => {
      const saved = { ...data, _id: data._id || `${name}-${records[name].length + 1}` }
      records[name].push(saved)
      return { _id: saved._id }
    },
  })
  const database = {
    command: { inc: (value) => ({ mockIncrement: value }) },
    serverDate: () => {
      assert.equal(inTransaction, false, "serverDate cannot run inside a transaction")
      return new Date()
    },
    collection,
    runTransaction(callback) {
      const result = queue.then(async () => {
        let snapshot = structuredClone(records)
        inTransaction = true
        try {
          if (retryPending) {
            retryPending = false
            await callback({ collection })
            Object.assign(records, structuredClone(snapshot))
            onRetry(records)
            snapshot = structuredClone(records)
          }
          return await callback({ collection })
        } catch (error) {
          Object.assign(records, snapshot)
          throw error
        } finally {
          inTransaction = false
        }
      })
      queue = result.catch(() => {})
      return result
    },
  }

  cloud.init = () => ({})
  cloud.getWXContext = () => ({ OPENID: currentOpenid })
  cloud.database = () => database
  cloud.openapi = {
    wxacode: {
      getUnlimited: async (...args) => {
        assert.equal(inTransaction, false, "QR generation cannot run inside a transaction")
        if (onQr) return onQr({ records, args })
        return { buffer: Buffer.from("mock-qr") }
      },
    },
  }
  cloud.uploadFile = async (...args) => {
    assert.equal(inTransaction, false, "upload cannot run inside a transaction")
    if (onUpload) return onUpload({ records, args })
    return { fileID: "mock-file-id" }
  }
  cloud.getTempFileURL = async (...args) => {
    assert.equal(inTransaction, false, "temporary URL cannot run inside a transaction")
    if (onTempUrl) return onTempUrl({ records, args })
    return { fileList: [{ tempFileURL: "https://example.invalid/mock-qr.png" }] }
  }
  delete require.cache[servicePath]

  return {
    records,
    setOpenid(openid) { currentOpenid = openid },
    service: require(servicePath),
    restore() {
      cloud.init = original.init
      cloud.getWXContext = original.getWXContext
      cloud.database = original.database
      cloud.openapi = original.openapi
      cloud.uploadFile = original.uploadFile
      cloud.getTempFileURL = original.getTempFileURL
      delete require.cache[servicePath]
      if (priorService) require.cache[servicePath] = priorService
    },
  }
}

const owner = {
  openid: OWNER_OPENID,
  role: "owner",
  status: "active",
}

const invite = {
  _id: "invite-id",
  ownerOpenid: OWNER_OPENID,
  active: true,
  expiresAt: NOW + 60_000,
}

const unboundCaller = {
  openid: CANDIDATE_OPENID,
  role: "unbound",
  status: "inactive",
}

const getDecision = (overrides = {}) => getPartnerBindingDecision({
  invite,
  callerOpenid: CANDIDATE_OPENID,
  caller: unboundCaller,
  owner,
  activePartner: null,
  settings: { ownerOpenid: OWNER_OPENID, partnerOpenid: "" },
  now: NOW,
  ...overrides,
})

test("missing owner binding revisions remain compatible while explicit invalid revisions reject", () => {
  assert.equal(readOwnerBindingRevision({}), 0)
  assert.equal(readOwnerBindingRevision({ ownerBindingRevision: 4 }), 4)
  for (const invalid of [undefined, null, -1, 1.5, "4", Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => readOwnerBindingRevision({ ownerBindingRevision: invalid }),
      /绑定版本无效/,
    )
  }
})

test("the next owner binding revision is monotonic and refuses overflow", () => {
  assert.equal(getNextOwnerBindingRevision({}), 1)
  assert.equal(getNextOwnerBindingRevision({ ownerBindingRevision: 4 }), 5)
  assert.throws(
    () => getNextOwnerBindingRevision({ ownerBindingRevision: Number.MAX_SAFE_INTEGER }),
    /绑定版本已达到上限/,
  )
})

test("explicit invite revisions must match the current owner revision, with legacy missing fields allowed", () => {
  const ownerWithRevision = { ...owner, ownerBindingRevision: 4 }

  assert.deepEqual(getInviteOwnerBindingRevisionDecision({}, ownerWithRevision), {
    allowed: true,
    ownerBindingRevision: 4,
  })
  assert.deepEqual(getInviteOwnerBindingRevisionDecision({ ownerBindingRevision: 4 }, ownerWithRevision), {
    allowed: true,
    ownerBindingRevision: 4,
  })
  assert.deepEqual(getInviteOwnerBindingRevisionDecision({ ownerBindingRevision: 3 }, ownerWithRevision), {
    allowed: false,
    reason: "invite_owner_binding_revision_conflict",
    ownerBindingRevision: 4,
  })
  for (const invalid of [undefined, null, -1, 1.5, "4", Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => getInviteOwnerBindingRevisionDecision({ ownerBindingRevision: invalid }, ownerWithRevision),
      /绑定版本无效/,
    )
  }
})

test("a fresh invitation allows one unbound candidate to bind", () => {
  assert.deepEqual(getDecision(), {
    allowed: true,
    reason: "binding_allowed",
  })
})

test("inactive, expired, and consumed invites are never bindable", () => {
  const cases = [
    [{ active: false }, "invite_inactive"],
    [{ expiresAt: NOW - 1 }, "invite_expired"],
    [{ usedAt: new Date(NOW - 1) }, "invite_already_used"],
  ]

  cases.forEach(([invitePatch, reason]) => {
    assert.deepEqual(getDecision({ invite: { ...invite, ...invitePatch } }), {
      allowed: false,
      reason,
    })
  })
})

test("an active partner or configured settings partner blocks another bind", () => {
  assert.deepEqual(getDecision({
    activePartner: { openid: PARTNER_OPENID, role: "partner", status: "active" },
  }), {
    allowed: false,
    reason: "active_partner_exists",
  })

  assert.deepEqual(getDecision({
    settings: { ownerOpenid: OWNER_OPENID, partnerOpenid: PARTNER_OPENID },
  }), {
    allowed: false,
    reason: "settings_partner_exists",
  })
})

test("the owner cannot bind with their own invitation", () => {
  assert.deepEqual(getDecision({
    callerOpenid: OWNER_OPENID,
    caller: { openid: OWNER_OPENID, role: "unbound", status: "inactive" },
  }), {
    allowed: false,
    reason: "owner_self_binding",
  })
})

test("an existing active caller keeps their existing role instead of creating a partner", () => {
  assert.deepEqual(getDecision({
    caller: { openid: CANDIDATE_OPENID, role: "owner", status: "active" },
  }), {
    allowed: false,
    reason: "caller_already_active",
    role: "owner",
  })

  assert.deepEqual(getDecision({
    caller: { openid: CANDIDATE_OPENID, role: "partner", status: "active" },
  }), {
    allowed: false,
    reason: "caller_already_active",
    role: "partner",
  })
})

test("an active caller with an invalid role is rejected instead of being returned to the client", () => {
  assert.deepEqual(getDecision({
    caller: { openid: CANDIDATE_OPENID, role: "unbound", status: "active" },
  }), {
    allowed: false,
    reason: "caller_role_invalid",
  })
})

test("any malformed or active partner record blocks another bind", () => {
  assert.deepEqual(getDecision({
    activePartners: [
      { openid: "", role: "partner", status: "active" },
      { openid: PARTNER_OPENID, role: "partner", status: "active" },
    ],
  }), {
    allowed: false,
    reason: "active_partner_data_invalid",
  })

  assert.deepEqual(getDecision({
    activePartners: [{ openid: PARTNER_OPENID, role: "partner", status: "active" }],
  }), {
    allowed: false,
    reason: "active_partner_exists",
  })
})

test("unbind only mutates a consistent current partner relation", () => {
  const validSettings = { ownerOpenid: OWNER_OPENID, partnerOpenid: PARTNER_OPENID }
  const validPartner = { openid: PARTNER_OPENID, role: "partner", status: "active" }

  assert.deepEqual(getUnbindPartnerDecision({ settings: validSettings, activePartners: [validPartner] }), {
    allowed: true,
    alreadyUnbound: false,
    partnerOpenid: PARTNER_OPENID,
  })
  assert.deepEqual(getUnbindPartnerDecision({ settings: { ownerOpenid: OWNER_OPENID, partnerOpenid: "" }, activePartners: [] }), {
    allowed: true,
    alreadyUnbound: true,
    partnerOpenid: "",
  })
  for (const input of [
    { settings: { ownerOpenid: OWNER_OPENID, partnerOpenid: "" }, activePartners: [validPartner] },
    { settings: validSettings, activePartners: [] },
    { settings: validSettings, activePartners: [{ openid: "another-partner", role: "partner", status: "active" }] },
    { settings: validSettings, activePartners: [validPartner, { openid: "second", role: "partner", status: "active" }] },
  ]) {
    assert.deepEqual(getUnbindPartnerDecision(input), {
      allowed: false,
      reason: "binding_state_mismatch",
    })
  }
})

test("only the configured current owner or partner has morning member access", () => {
  const settings = {
    ownerOpenid: OWNER_OPENID,
    partnerOpenid: PARTNER_OPENID,
  }

  assert.equal(canAccessMorningAsMember({
    user: owner,
    settings,
    openid: OWNER_OPENID,
  }), true)
  assert.equal(canAccessMorningAsMember({
    user: { openid: PARTNER_OPENID, role: "partner", status: "active" },
    settings,
    openid: PARTNER_OPENID,
  }), true)
  assert.equal(canAccessMorningAsMember({
    user: { openid: "old-partner", role: "partner", status: "active" },
    settings,
    openid: "old-partner",
  }), false)
  assert.equal(canAccessMorningAsMember({
    user: { openid: OWNER_OPENID, role: "owner", status: "active" },
    settings: { ...settings, ownerOpenid: "another-owner" },
    openid: OWNER_OPENID,
  }), false)
  assert.equal(canAccessMorningAsMember({
    user: { openid: PARTNER_OPENID, role: "partner", status: "inactive" },
    settings,
    openid: PARTNER_OPENID,
  }), false)
})

test("an invitation remains unusable until its QR side effects complete and the activation transaction succeeds", async () => {
  const fixture = createMockedMorningService({
    onQr: async ({ records }) => {
      assert.equal(records.morningInvites.length, 1)
      assert.equal(records.morningInvites[0].active, false)
      assert.equal(records.morningInvites[0].qrFileId, "")
      return { buffer: Buffer.from("mock-qr") }
    },
  })

  try {
    const result = await fixture.service.main({ action: "createInvite" })
    assert.equal(typeof result.code, "string")
    assert.match(result.token, /^[0-9a-f]{24}$/)
    assert.equal(result.code, result.token)
    assert.equal(result.qrFileId, "mock-file-id")
    assert.equal(fixture.records.morningInvites.length, 1)
    assert.equal(fixture.records.morningInvites[0].active, true)
    assert.equal(fixture.records.morningInvites[0].qrFileId, "mock-file-id")
    assert.equal(fixture.records.appUsers[0].ownerBindingRevision, 1)
  } finally {
    fixture.restore()
  }
})

test("a QR failure leaves only an inactive invitation draft and does not advance the owner gate", async () => {
  const fixture = createMockedMorningService({
    onQr: async ({ records }) => {
      assert.equal(records.morningInvites.length, 1)
      assert.equal(records.morningInvites[0].active, false)
      throw new Error("mock QR failure")
    },
  })

  try {
    await assert.rejects(
      fixture.service.main({ action: "createInvite" }),
      /mock QR failure/,
    )
    assert.equal(fixture.records.morningInvites.length, 1)
    assert.equal(fixture.records.morningInvites[0].active, false)
    assert.equal(Object.hasOwn(fixture.records.appUsers[0], "ownerBindingRevision"), false)
  } finally {
    fixture.restore()
  }
})

test("a missing temporary QR URL keeps the invitation draft inactive", async () => {
  const fixture = createMockedMorningService({
    onTempUrl: async ({ records }) => {
      assert.equal(records.morningInvites.length, 1)
      assert.equal(records.morningInvites[0].active, false)
      return { fileList: [] }
    },
  })

  try {
    await assert.rejects(
      fixture.service.main({ action: "createInvite" }),
      /二维码临时地址生成失败/,
    )
    assert.equal(fixture.records.morningInvites.length, 1)
    assert.equal(fixture.records.morningInvites[0].active, false)
    assert.equal(Object.hasOwn(fixture.records.appUsers[0], "ownerBindingRevision"), false)
  } finally {
    fixture.restore()
  }
})

test("upload failures cannot activate drafts or invalidate the previous usable invite", async () => {
  const fixture = createMockedMorningService({ onUpload: async () => { throw new Error("upload failed") } })
  fixture.records.morningInvites.push({ ...invite, _id: "old-invite", expiresAt: Date.now() + 60_000 })
  try {
    await assert.rejects(fixture.service.main({ action: "createInvite" }), /upload failed/)
    assert.deepEqual(fixture.records.morningInvites.map((record) => record.active), [true, false])
  } finally {
    fixture.restore()
  }
})

test("a new invite invalidates the old invite and only one competing candidate can bind", async () => {
  const fixture = createMockedMorningService()
  try {
    const firstInvite = await fixture.service.main({ action: "createInvite" })
    const secondInvite = await fixture.service.main({ action: "createInvite" })
    assert.deepEqual(fixture.records.morningInvites.map((record) => record.active), [false, true])
    fixture.setOpenid(CANDIDATE_OPENID)
    await assert.rejects(fixture.service.main({ action: "bindPartner", token: firstInvite.token }), /无效|过期/)

    // Seed a second historical invite to exercise two distinct candidate IDs at the transaction boundary.
    fixture.records.morningInvites.push({
      ...fixture.records.morningInvites[1], _id: "legacy-other-invite", token: "b0123456789abcdef0123456",
    })
    const firstBinding = fixture.service.main({ action: "bindPartner", code: secondInvite.code.toUpperCase() })
    fixture.setOpenid("other-candidate")
    const secondBinding = fixture.service.main({ action: "bindPartner", token: "b0123456789abcdef0123456" })
    const results = await Promise.allSettled([firstBinding, secondBinding])
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
    const partners = fixture.records.appUsers.filter((record) => record.role === "partner" && record.status === "active")
    assert.equal(partners.length, 1)
    assert.equal(fixture.records.morningSettings[0].partnerOpenid, partners[0].openid)
    assert.equal(fixture.records.morningInvites.some((record) => record.active), false)

    fixture.setOpenid(OWNER_OPENID)
    assert.deepEqual(await fixture.service.main({ action: "unbindPartner", confirm: true }), {
      success: true, alreadyUnbound: false,
    })
    assert.equal(fixture.records.appUsers.filter((record) => record.role === "partner" && record.status === "active").length, 0)
    assert.equal(fixture.records.morningSettings[0].partnerOpenid, "")
    assert.equal(fixture.records.morningSettings[0].subscriptionCount, 0)
    fixture.setOpenid(partners[0].openid)
    await assert.rejects(fixture.service.main({ action: "bindPartner", token: secondInvite.token }), /无效|过期/)
  } finally {
    fixture.restore()
  }
})

test("mismatched partners cannot read morning data, edit content, or add subscription credits", async () => {
  const fixture = createMockedMorningService()
  fixture.records.morningSettings[0].partnerOpenid = PARTNER_OPENID
  fixture.records.morningSettings[0].subscriptionCount = 2
  fixture.records.appUsers.push({ _id: "orphan", openid: "orphan-partner", role: "partner", status: "active" })
  fixture.setOpenid("orphan-partner")
  try {
    assert.deepEqual(await fixture.service.main({ action: "getProfile" }), { role: "unbound", bound: false })
    for (const action of ["getMorning", "getCompanionLists", "getCompanionContentEditor", "saveCompanionContent", "recordSubscription"]) {
      await assert.rejects(fixture.service.main({ action }), /不是已绑定/)
    }
    assert.equal(fixture.records.morningSettings[0].subscriptionCount, 2)
  } finally {
    fixture.restore()
  }
})

test("current partners retain content access and subscription response compatibility", async () => {
  const fixture = createMockedMorningService()
  Object.assign(fixture.records.morningSettings[0], {
    partnerOpenid: PARTNER_OPENID, memoryFragments: ["记忆"], meetingWishes: ["见面"], littleThings: ["小事"], subscriptionCount: 2,
  })
  fixture.records.appUsers.push({ _id: "current", openid: PARTNER_OPENID, role: "partner", status: "active" })
  fixture.setOpenid(PARTNER_OPENID)
  try {
    assert.deepEqual(await fixture.service.main({ action: "getProfile" }), { role: "partner", bound: true })
    assert.deepEqual(await fixture.service.main({ action: "getCompanionLists" }), {
      memoryFragments: ["记忆"], meetingWishes: ["见面"], littleThings: ["小事"],
    })
    assert.deepEqual(await fixture.service.main({ action: "recordSubscription" }), { success: true })
    assert.equal(fixture.records.morningSettings[0].subscriptionCount, 3)
  } finally {
    fixture.restore()
  }
})

test("duplicate owners, duplicate settings and mismatched relations fail without changing data", async () => {
  for (const corrupt of [
    (records) => records.appUsers.push({ _id: "second-owner", openid: "second-owner", role: "owner", status: "active" }),
    (records) => records.morningSettings.push({ ...records.morningSettings[0], _id: "duplicate-settings" }),
    (records) => records.appUsers.push({ _id: "orphan", openid: "orphan", role: "partner", status: "active" }),
  ]) {
    const fixture = createMockedMorningService()
    corrupt(fixture.records)
    const before = structuredClone(fixture.records)
    try {
      await assert.rejects(fixture.service.main({ action: "unbindPartner", confirm: true }), /异常/)
      assert.deepEqual(fixture.records, before)
    } finally {
      fixture.restore()
    }
  }
})

test("malformed active partner records and invalid caller roles cannot create another binding", async () => {
  const fixture = createMockedMorningService()
  fixture.records.morningInvites.push({ ...invite, token: "c0123456789abcdef0123456", expiresAt: Date.now() + 60_000 })
  fixture.records.appUsers.push({ _id: "malformed", openid: "", role: "partner", status: "active" })
  fixture.setOpenid(CANDIDATE_OPENID)
  try {
    await assert.rejects(fixture.service.main({ action: "bindPartner", token: "c0123456789abcdef0123456" }), /数据异常/)
    fixture.records.appUsers.push({ _id: "bad-role", openid: CANDIDATE_OPENID, role: "unbound", status: "active" })
    await assert.rejects(fixture.service.main({ action: "bindPartner", token: "c0123456789abcdef0123456" }), /角色状态异常/)
    assert.equal(fixture.records.morningInvites[0].active, true)
    assert.equal(fixture.records.morningSettings[0].partnerOpenid, "")
  } finally {
    fixture.restore()
  }
})

test("a binding transaction retry rechecks a competing committed partner instead of recreating its first attempt", async () => {
  const fixture = createMockedMorningService({
    onRetry(records) {
      records.appUsers.push({ _id: "winner", openid: "winner", role: "partner", status: "active" })
      records.appUsers[0].ownerBindingRevision = 1
      records.morningSettings[0].partnerOpenid = "winner"
      records.morningInvites[0].active = false
      records.morningInvites[0].usedAt = new Date()
    },
  })
  fixture.records.morningInvites.push({ ...invite, token: "c0123456789abcdef0123456", expiresAt: Date.now() + 60_000 })
  fixture.setOpenid(CANDIDATE_OPENID)
  try {
    await assert.rejects(fixture.service.main({ action: "bindPartner", token: "c0123456789abcdef0123456" }), /无效|过期|使用/)
    const activePartners = fixture.records.appUsers.filter((record) => record.role === "partner" && record.status === "active")
    assert.deepEqual(activePartners.map((record) => record.openid), ["winner"])
    assert.equal(fixture.records.morningSettings[0].partnerOpenid, "winner")
  } finally {
    fixture.restore()
  }
})

test("invite activation retries do not repeat QR side effects or overwrite a newer binding revision", async () => {
  let qrCalls = 0
  let uploadCalls = 0
  const fixture = createMockedMorningService({
    onQr: async () => { qrCalls += 1; return { buffer: Buffer.from("mock-qr") } },
    onUpload: async () => { uploadCalls += 1; return { fileID: "mock-file-id" } },
    onRetry(records) { records.appUsers[0].ownerBindingRevision = 1 },
  })
  try {
    await assert.rejects(fixture.service.main({ action: "createInvite" }), /绑定状态已变化/)
    assert.equal(qrCalls, 1)
    assert.equal(uploadCalls, 1)
    assert.equal(fixture.records.morningInvites[0].active, false)
    assert.equal(fixture.records.appUsers[0].ownerBindingRevision, 1)
  } finally {
    fixture.restore()
  }
})

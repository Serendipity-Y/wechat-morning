const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { canEditCompanionContent } = require("../cloudfunctions/morningService/companionEditor")

const settings = {
  ownerOpenid: "owner-openid",
  partnerOpenid: "partner-openid",
}

test("the configured owner and partner can edit companion content", () => {
  assert.equal(canEditCompanionContent(
    { openid: "owner-openid", role: "owner" },
    settings,
    "owner-openid",
  ), true)
  assert.equal(canEditCompanionContent(
    { openid: "partner-openid", role: "partner" },
    settings,
    "partner-openid",
  ), true)
})

test("unbound, mismatched, and spoofed callers cannot edit companion content", () => {
  assert.equal(canEditCompanionContent(
    { openid: "partner-openid", role: "partner" },
    { ...settings, partnerOpenid: "another-partner" },
    "partner-openid",
  ), false)
  assert.equal(canEditCompanionContent(
    { openid: "partner-openid", role: "partner" },
    settings,
    "spoofed-openid",
  ), false)
  assert.equal(canEditCompanionContent(
    { openid: "unbound-openid", role: "unbound" },
    settings,
    "unbound-openid",
  ), false)
})

test("the morning service exposes restricted companion content actions", () => {
  const source = fs.readFileSync(path.join(__dirname, "../cloudfunctions/morningService/index.js"), "utf8")
  const saveStart = source.indexOf("const saveCompanionContent")
  const saveEnd = source.indexOf("const saveSettings", saveStart)
  const saveSource = source.slice(saveStart, saveEnd)

  assert.match(source, /case "getCompanionContentEditor":\s+return getCompanionContentEditor\(OPENID\)/)
  assert.match(source, /case "saveCompanionContent":\s+return saveCompanionContent\(OPENID, event\.values \|\| \{\}, event\.expectedCompanionContentRevision\)/)
  assert.match(saveSource, /memoryFragments:/)
  assert.match(saveSource, /meetingWishes:/)
  assert.match(saveSource, /littleThings:/)
  assert.doesNotMatch(saveSource, /templateId|reminderEnabled/)
})

test("owner and partner content saves share a transaction-bound expected revision", () => {
  const source = fs.readFileSync(path.join(__dirname, "../cloudfunctions/morningService/index.js"), "utf8")

  assert.match(source, /requireExpectedCompanionContentRevision/)
  assert.match(source, /getCompanionContentCommitDecision/)
  assert.match(source, /const commitCompanionContent = async \(/)
  assert.match(source, /db\.runTransaction\(async \(transaction\) =>/)
  assert.match(source, /const decision = getCompanionContentCommitDecision\(current, expectedRevision\)/)
  assert.match(source, /companionContentRevision: decision\.companionContentRevision/)
  assert.match(source, /const now = new Date\(\)/)
  assert.match(source, /updatedAt: now/)
  assert.match(source, /case "saveSettings":\s+await requireRole\(OPENID, \["owner"\]\)\s+return saveSettings\(OPENID, event\.values \|\| \{\}, event\.expectedCompanionContentRevision\)/)
  assert.match(source, /case "saveCompanionContent":\s+return saveCompanionContent\(OPENID, event\.values \|\| \{\}, event\.expectedCompanionContentRevision\)/)
})

test("getCompanionContentEditor executes the revision return path", async () => {
  const servicePath = require.resolve("../cloudfunctions/morningService/index.js")
  const cloud = require(require.resolve("wx-server-sdk", { paths: [servicePath] }))
  const priorService = require.cache[servicePath]
  const original = {
    init: cloud.init,
    getWXContext: cloud.getWXContext,
    database: cloud.database,
  }
  const owner = { _id: "owner-id", openid: "owner-openid", role: "owner", status: "active" }
  const settings = {
    _id: "settings-id",
    ownerOpenid: "owner-openid",
    partnerOpenid: "partner-openid",
    memoryFragments: ["记忆"],
    meetingWishes: ["见面"],
    littleThings: ["小事"],
    companionContentRevision: 7,
  }
  const dataFor = (collection, query) => {
    if (collection === "appUsers" && query.openid === owner.openid) return [owner]
    if (collection === "appUsers" && query.role === "owner") return [owner]
    if (collection === "morningSettings" && query.ownerOpenid === owner.openid) return [settings]
    return []
  }

  try {
    cloud.init = () => ({})
    cloud.getWXContext = () => ({ OPENID: owner.openid })
    cloud.database = () => ({
      command: {},
      serverDate: () => new Date(),
      collection(collection) {
        return {
          where(query) {
            return {
              limit() {
                return { get: async () => ({ data: dataFor(collection, query) }) }
              },
            }
          },
        }
      },
    })
    delete require.cache[servicePath]
    const service = require(servicePath)

    assert.deepEqual(await service.main({ action: "getCompanionContentEditor" }), {
      memoryFragments: ["记忆"],
      memoryFragmentEntries: [{
        id: "legacy-0",
        text: "记忆",
        publishedAt: null,
        updatedAt: null,
        legacy: true,
      }],
      meetingWishes: ["见面"],
      littleThings: ["小事"],
      companionContentRevision: 7,
    })
  } finally {
    cloud.init = original.init
    cloud.getWXContext = original.getWXContext
    cloud.database = original.database
    delete require.cache[servicePath]
    if (priorService) require.cache[servicePath] = priorService
  }
})

test("a stale owner save cannot overwrite a partner transaction that upgraded a legacy revision", async () => {
  const servicePath = require.resolve("../cloudfunctions/morningService/index.js")
  const cloud = require(require.resolve("wx-server-sdk", { paths: [servicePath] }))
  const priorService = require.cache[servicePath]
  const original = {
    init: cloud.init,
    getWXContext: cloud.getWXContext,
    database: cloud.database,
  }
  let currentOpenid = "partner-openid"
  const records = {
    appUsers: [
      { _id: "owner-id", openid: "owner-openid", role: "owner", status: "active" },
      { _id: "partner-id", openid: "partner-openid", role: "partner", status: "active" },
    ],
    morningSettings: [{
      _id: "settings-id",
      ownerOpenid: "owner-openid",
      partnerOpenid: "partner-openid",
      memoryFragments: ["旧记忆"],
      meetingWishes: ["旧见面"],
      littleThings: ["旧小事"],
    }],
  }
  const collection = (name) => ({
    where(query) {
      const matching = () => (records[name] || []).filter((record) => (
        Object.entries(query).every(([key, value]) => record[key] === value)
      ))
      return {
        limit() {
          return { get: async () => ({ data: matching() }) }
        },
      }
    },
    doc(id) {
      return {
        get: async () => ({ data: (records[name] || []).find((record) => record._id === id) || null }),
        update: async ({ data }) => {
          const target = (records[name] || []).find((record) => record._id === id)
          if (!target) throw new Error("missing mocked document")
          Object.assign(target, data)
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
    command: {},
    serverDate: () => new Date(),
    collection,
    runTransaction: async (callback) => callback({ collection }),
  }

  try {
    cloud.init = () => ({})
    cloud.getWXContext = () => ({ OPENID: currentOpenid })
    cloud.database = () => database
    delete require.cache[servicePath]
    const service = require(servicePath)

    const partnerResult = await service.main({
      action: "saveCompanionContent",
      expectedCompanionContentRevision: 0,
      values: {
        memoryFragments: ["伴侣的新记忆"],
        meetingWishes: ["伴侣的新见面"],
        littleThings: ["伴侣的新小事"],
      },
    })
    assert.equal(partnerResult.saved, true)
    assert.equal(partnerResult.companionContentRevision, 1)
    assert.deepEqual(records.morningSettings[0].memoryFragments, ["伴侣的新记忆"])

    currentOpenid = "owner-openid"
    const staleOwnerResult = await service.main({
      action: "saveSettings",
      expectedCompanionContentRevision: 0,
      values: {
        templateId: "",
        reminderEnabled: true,
        memoryFragments: ["主人过期草稿"],
        meetingWishes: ["主人过期见面"],
        littleThings: ["主人过期小事"],
      },
    })
    assert.deepEqual(staleOwnerResult, {
      saved: false,
      reason: "companion_content_revision_conflict",
      companionContentRevision: 1,
    })
    assert.deepEqual(records.morningSettings[0].memoryFragments, ["伴侣的新记忆"])
    assert.equal(records.morningSettings[0].companionContentRevision, 1)
  } finally {
    cloud.init = original.init
    cloud.getWXContext = original.getWXContext
    cloud.database = original.database
    delete require.cache[servicePath]
    if (priorService) require.cache[servicePath] = priorService
  }
})

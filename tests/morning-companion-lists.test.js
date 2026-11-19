const test = require("node:test")
const assert = require("node:assert/strict")
const {
  getMemoryFragmentEntries,
  sanitizeMemoryFragmentInput,
  selectCompanionLists,
} = require("../cloudfunctions/morningService").__test__

const settings = {
  memoryFragments: ["记忆"],
  meetingWishes: ["见面"],
  littleThings: ["小事"],
}

test("companion list reads keep the complete legacy response when no list key is supplied", () => {
  assert.deepEqual(selectCompanionLists(settings), settings)
})

test("companion list reads return only the whitelisted requested list", () => {
  assert.deepEqual(selectCompanionLists(settings, "memoryFragments"), { memoryFragments: ["记忆"] })
  assert.deepEqual(selectCompanionLists(settings, "meetingWishes"), { meetingWishes: ["见面"] })
  assert.deepEqual(selectCompanionLists(settings, "littleThings"), { littleThings: ["小事"] })
})

test("legacy memory strings stay explicitly undated unless metadata is requested", () => {
  const entries = getMemoryFragmentEntries(settings)
  assert.equal(entries[0].text, "记忆")
  assert.equal(entries[0].publishedAt, null)
  assert.equal(entries[0].legacy, true)
  assert.deepEqual(selectCompanionLists(settings, "memoryFragments"), { memoryFragments: ["记忆"] })
  assert.deepEqual(selectCompanionLists(settings, "memoryFragments", { includeMemoryMetadata: true }), {
    memoryFragments: ["记忆"],
    memoryFragmentEntries: entries,
  })
})

test("memory fragment saves preserve known publication time and mark new entries with server time", () => {
  const publishedAt = new Date("2026-09-15T00:19:48.555+08:00")
  const now = new Date("2026-09-22T09:30:00.000+08:00")
  const result = sanitizeMemoryFragmentInput({
    memoryFragmentEntries: [
      { id: "known", text: "修改后的记忆" },
      { id: "history", text: "历史记忆", legacy: true },
      { id: "new", text: "新写的记忆" },
    ],
  }, {
    memoryFragmentEntries: [{ id: "known", text: "原来的记忆", publishedAt, updatedAt: publishedAt }],
  }, now)

  assert.deepEqual(result.memoryFragments, ["修改后的记忆", "历史记忆", "新写的记忆"])
  assert.equal(result.memoryFragmentEntries[0].publishedAt, publishedAt)
  assert.equal(result.memoryFragmentEntries[0].updatedAt, now)
  assert.equal(result.memoryFragmentEntries[1].publishedAt, null)
  assert.equal(result.memoryFragmentEntries[2].publishedAt, now)
  assert.equal(result.memoryFragmentEntries[2].updatedAt, now)
})

test("memory fragment saves never reuse one stored ID for two submitted rows", () => {
  const now = new Date("2026-09-22T09:30:00.000+08:00")
  const result = sanitizeMemoryFragmentInput({
    memoryFragmentEntries: [
      { id: "known", text: "第一条" },
      { id: "known", text: "第二条" },
    ],
  }, {
    memoryFragmentEntries: [{ id: "known", text: "原来的记忆", publishedAt: now }],
  }, now)

  assert.equal(result.memoryFragmentEntries[0].id, "known")
  assert.notEqual(result.memoryFragmentEntries[1].id, "known")
  assert.notEqual(result.memoryFragmentEntries[0].id, result.memoryFragmentEntries[1].id)
})

test("companion list reads reject unknown list keys instead of expanding the response", () => {
  assert.throws(() => selectCompanionLists(settings, "__proto__"), /无效内容分类/)
  assert.throws(() => selectCompanionLists(settings, "unknown"), /无效内容分类/)
})

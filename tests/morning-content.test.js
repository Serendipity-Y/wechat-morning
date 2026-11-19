const test = require("node:test")
const assert = require("node:assert/strict")
const source = require("../cloudfunctions/shared/morningContent")
const morningServiceContent = require("../cloudfunctions/morningService/morningContent")
const reminderContent = require("../cloudfunctions/sendMorningReminder/morningContent")

test("morning content has the expected name rotation and love texts", () => {
  assert.equal(source.PARTNER_NAME_RECENT_DAYS, 3)
  assert.equal(source.PARTNER_NAMES.length, 30)
  assert.equal(new Set(source.PARTNER_NAMES).size, 30)
  assert.deepEqual(Object.values(source.PARTNER_NAME_GROUPS).map((group) => group.length), [10, 10, 10])
  assert.equal(source.LOVE_TEXTS.length, 30)
})

test("deployed function copies match the canonical morning content", () => {
  const copies = [morningServiceContent, reminderContent]
  copies.forEach((content) => {
    assert.equal(content.PARTNER_NAME_RECENT_DAYS, source.PARTNER_NAME_RECENT_DAYS)
    assert.deepEqual(content.PARTNER_NAME_GROUPS, source.PARTNER_NAME_GROUPS)
    assert.deepEqual(content.PARTNER_NAMES, source.PARTNER_NAMES)
    assert.deepEqual(content.LOVE_TEXTS, source.LOVE_TEXTS)
  })
})

test("recent three-day names are excluded from candidates", () => {
  const recentNames = new Set(source.PARTNER_NAMES.slice(0, 3))
  const candidates = source.getPartnerNameCandidates(recentNames)

  assert.ok(candidates.every((name) => !recentNames.has(name)))
})

const test = require("node:test")
const assert = require("node:assert/strict")

const {
  isCompanionContentRevision,
  readCompanionContentRevision,
  requireExpectedCompanionContentRevision,
  getCompanionContentCommitDecision,
} = require("../cloudfunctions/morningService/contentRevision")

test("missing companion content revisions are read as the legacy starting version", () => {
  assert.equal(readCompanionContentRevision({}), 0)
  assert.equal(readCompanionContentRevision({ companionContentRevision: 0 }), 0)
  assert.equal(readCompanionContentRevision({ companionContentRevision: 7 }), 7)
})

test("stored companion content revisions reject malformed values instead of silently resetting", () => {
  for (const invalid of [-1, 1.5, "1", Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isCompanionContentRevision(invalid), false)
    assert.throws(() => readCompanionContentRevision({ companionContentRevision: invalid }), /内容版本异常/)
  }
})

test("save requests require a non-negative safe expected companion content revision", () => {
  assert.equal(requireExpectedCompanionContentRevision(0), 0)
  assert.equal(requireExpectedCompanionContentRevision(8), 8)
  for (const invalid of [undefined, null, -1, 2.5, "2", Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => requireExpectedCompanionContentRevision(invalid), /内容版本无效/)
  }
})

test("matching versions are the only versions allowed to create the next content revision", () => {
  assert.deepEqual(getCompanionContentCommitDecision({}, 0), {
    saved: true,
    companionContentRevision: 1,
  })
  assert.deepEqual(getCompanionContentCommitDecision({ companionContentRevision: 4 }, 4), {
    saved: true,
    companionContentRevision: 5,
  })
  assert.deepEqual(getCompanionContentCommitDecision({ companionContentRevision: 5 }, 4), {
    saved: false,
    reason: "companion_content_revision_conflict",
    companionContentRevision: 5,
  })
})

test("revision overflow remains an explicit save failure", () => {
  assert.throws(
    () => getCompanionContentCommitDecision({ companionContentRevision: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER),
    /内容版本已达到上限/,
  )
})

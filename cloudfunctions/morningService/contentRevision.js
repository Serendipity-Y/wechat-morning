const isCompanionContentRevision = (value) => Number.isSafeInteger(value) && value >= 0

const readCompanionContentRevision = (settings = {}) => {
  if (!Object.hasOwn(settings, "companionContentRevision")) return 0
  if (!isCompanionContentRevision(settings.companionContentRevision)) {
    throw new Error("内容版本异常")
  }
  return settings.companionContentRevision
}

const requireExpectedCompanionContentRevision = (value) => {
  if (!isCompanionContentRevision(value)) {
    throw new Error("内容版本无效，请重新加载后再保存")
  }
  return value
}

const getCompanionContentCommitDecision = (settings, expectedCompanionContentRevision) => {
  const currentRevision = readCompanionContentRevision(settings)
  const expectedRevision = requireExpectedCompanionContentRevision(expectedCompanionContentRevision)

  if (expectedRevision !== currentRevision) {
    return {
      saved: false,
      reason: "companion_content_revision_conflict",
      companionContentRevision: currentRevision,
    }
  }
  if (currentRevision === Number.MAX_SAFE_INTEGER) {
    throw new Error("内容版本已达到上限")
  }
  return { saved: true, companionContentRevision: currentRevision + 1 }
}

module.exports = {
  isCompanionContentRevision,
  readCompanionContentRevision,
  requireExpectedCompanionContentRevision,
  getCompanionContentCommitDecision,
}

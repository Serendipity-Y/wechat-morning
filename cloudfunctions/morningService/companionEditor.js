const canEditCompanionContent = (user, settings, openid) => {
  if (!user || !settings || user.openid !== openid) return false
  if (user.role === "owner") return settings.ownerOpenid === openid
  return user.role === "partner" && settings.partnerOpenid === openid
}

module.exports = { canEditCompanionContent }

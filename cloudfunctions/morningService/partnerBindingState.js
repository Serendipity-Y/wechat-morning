const readOpenid = (value) => typeof value === "string" ? value.trim() : ""

const readTimestamp = (value) => {
  const timestamp = value instanceof Date ? value.getTime() : value
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null
}

const hasOwn = (value, key) => Boolean(value) && Object.prototype.hasOwnProperty.call(value, key)

const readOwnerBindingRevision = (owner = {}) => {
  if (!hasOwn(owner, "ownerBindingRevision")) return 0
  const revision = owner.ownerBindingRevision
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("绑定版本无效")
  return revision
}

const getNextOwnerBindingRevision = (owner = {}) => {
  const revision = readOwnerBindingRevision(owner)
  if (revision >= Number.MAX_SAFE_INTEGER) throw new Error("绑定版本已达到上限")
  return revision + 1
}

const getInviteOwnerBindingRevisionDecision = (invite = {}, owner = {}) => {
  const ownerBindingRevision = readOwnerBindingRevision(owner)
  if (!hasOwn(invite, "ownerBindingRevision")) {
    return { allowed: true, ownerBindingRevision }
  }
  const inviteBindingRevision = readOwnerBindingRevision({
    ownerBindingRevision: invite.ownerBindingRevision,
  })
  if (inviteBindingRevision !== ownerBindingRevision) {
    return {
      allowed: false,
      reason: "invite_owner_binding_revision_conflict",
      ownerBindingRevision,
    }
  }
  return { allowed: true, ownerBindingRevision }
}

const isActiveIdentity = (user) => Boolean(
  user
  && user.status === "active"
  && readOpenid(user.openid)
  && typeof user.role === "string"
  && user.role.trim(),
)

const getExistingCallerRole = (caller, callerOpenid) => {
  if (!isActiveIdentity(caller) || readOpenid(caller.openid) !== callerOpenid) return ""
  return caller.role
}

const isInviteUsed = (invite) => Boolean(
  invite
  && Object.prototype.hasOwnProperty.call(invite, "usedAt")
  && invite.usedAt !== null
  && typeof invite.usedAt !== "undefined",
)

const hasActivePartner = (partner) => isActiveIdentity(partner) && partner.role === "partner"

const hasConfiguredPartner = (settings) => Boolean(readOpenid(settings?.partnerOpenid))

const isCurrentOwner = (owner, ownerOpenid) =>
  isActiveIdentity(owner)
  && owner.role === "owner"
  && readOpenid(owner.openid) === ownerOpenid

const getPartnerBindingDecision = ({
  invite,
  callerOpenid,
  caller,
  owner,
  activePartner,
  activePartners,
  settings,
  now,
} = {}) => {
  const currentOpenid = readOpenid(callerOpenid)
  if (!currentOpenid) return { allowed: false, reason: "caller_openid_missing" }

  const existingRole = getExistingCallerRole(caller, currentOpenid)
  if (existingRole) {
    if (!["owner", "partner"].includes(existingRole)) {
      return { allowed: false, reason: "caller_role_invalid" }
    }
    return { allowed: false, reason: "caller_already_active", role: existingRole }
  }

  if (!invite) return { allowed: false, reason: "invite_missing" }
  if (invite.active !== true) return { allowed: false, reason: "invite_inactive" }
  if (isInviteUsed(invite)) return { allowed: false, reason: "invite_already_used" }

  const expiresAt = readTimestamp(invite.expiresAt)
  const currentTime = readTimestamp(now)
  if (expiresAt === null || currentTime === null || expiresAt <= currentTime) {
    return { allowed: false, reason: "invite_expired" }
  }

  const ownerOpenid = readOpenid(invite.ownerOpenid)
  if (!ownerOpenid || !isCurrentOwner(owner, ownerOpenid)) {
    return { allowed: false, reason: "owner_not_active" }
  }
  if (ownerOpenid === currentOpenid) return { allowed: false, reason: "owner_self_binding" }
  const partners = Array.isArray(activePartners)
    ? activePartners
    : (activePartner ? [activePartner] : [])
  if (partners.some((partner) => !hasActivePartner(partner))) {
    return { allowed: false, reason: "active_partner_data_invalid" }
  }
  if (partners.length) return { allowed: false, reason: "active_partner_exists" }
  if (hasConfiguredPartner(settings)) return { allowed: false, reason: "settings_partner_exists" }

  return { allowed: true, reason: "binding_allowed" }
}

const getUnbindPartnerDecision = ({ settings, activePartners } = {}) => {
  const partners = Array.isArray(activePartners) ? activePartners : []
  if (partners.some((partner) => !hasActivePartner(partner))) {
    return { allowed: false, reason: "binding_state_mismatch" }
  }
  const partnerOpenid = readOpenid(settings?.partnerOpenid)
  if (!partnerOpenid && !partners.length) {
    return { allowed: true, alreadyUnbound: true, partnerOpenid: "" }
  }
  if (partners.length !== 1 || !partnerOpenid || readOpenid(partners[0].openid) !== partnerOpenid) {
    return { allowed: false, reason: "binding_state_mismatch" }
  }
  return { allowed: true, alreadyUnbound: false, partnerOpenid }
}

const canAccessMorningAsMember = ({ user, settings, openid } = {}) => {
  const currentOpenid = readOpenid(openid)
  if (!currentOpenid || !isActiveIdentity(user) || readOpenid(user.openid) !== currentOpenid) {
    return false
  }
  if (user.role === "owner") return readOpenid(settings?.ownerOpenid) === currentOpenid
  if (user.role === "partner") return readOpenid(settings?.partnerOpenid) === currentOpenid
  return false
}

module.exports = {
  readOwnerBindingRevision,
  getNextOwnerBindingRevision,
  getInviteOwnerBindingRevisionDecision,
  getPartnerBindingDecision,
  getUnbindPartnerDecision,
  canAccessMorningAsMember,
}

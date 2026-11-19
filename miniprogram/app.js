// app.js
const ROLE_BOUND_STATES = { owner: true, partner: true, unbound: false }

const hasKnownRole = (role) => Object.prototype.hasOwnProperty.call(ROLE_BOUND_STATES, role)

const requireRoleProfilePayload = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasKnownRole(value.role) || value.bound !== ROLE_BOUND_STATES[value.role]) {
    throw new Error("role profile status unconfirmed")
  }
  return value
}

App({
  globalData: {
    openid: "",
    openidPromise: null,
    role: "",
  },
  onLaunch() {
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力")
    } else {
      wx.cloud.init({
        env: "YOUR_CLOUD_ENV_ID",
        traceUser: true,
      })
    }
  },
  getOpenId() {
    if (this.globalData.openid) {
      return Promise.resolve(this.globalData.openid)
    }
    if (!this.globalData.openidPromise) {
      this.globalData.openidPromise = wx.cloud
        .callFunction({ name: "getOpenId" })
        .then((res) => {
          const openid = String(res?.result?.openid || "").trim()
          if (!openid) throw new Error("getOpenId returned an empty openid")
          this.globalData.openid = openid
          return openid
        })
        .catch((err) => {
          console.error("getOpenId failed", err)
          this.globalData.openid = ""
          this.globalData.openidPromise = null
          throw err
        })
    }
    return this.globalData.openidPromise
  },
  getRoleProfile(force = false) {
    if (!force && hasKnownRole(this.globalData.role)) {
      return Promise.resolve({
        role: this.globalData.role,
        bound: ROLE_BOUND_STATES[this.globalData.role],
      })
    }
    return wx.cloud.callFunction({
      name: "morningService",
      data: { action: "getProfile" },
    }).then((res) => {
      const profile = requireRoleProfilePayload(res?.result)
      this.globalData.role = profile.role
      return profile
    })
  },
})

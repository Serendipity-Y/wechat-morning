const app = getApp()

const requireBindingRolePayload = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || !["owner", "partner"].includes(value.role)) {
    throw new Error("binding status unconfirmed")
  }
  return value
}

Page({
  data: { code: "", binding: false },
  onLoad(options) {
    if (options.scene) {
      this.bindAccount(options.scene)
    }
  },
  onCodeInput(e) { this.setData({ code: e.detail.value.toLowerCase().replace(/[^a-f0-9]/g, "").slice(0, 24) }) },
  bindAccount(token = "") {
    const sceneToken = typeof token === "string" ? token : ""
    if ((!sceneToken && this.data.code.length !== 24) || this.data.binding) {
      wx.showToast({ title: "请输入 24 位绑定码", icon: "none" })
      return
    }
    this.setData({ binding: true })
    return wx.cloud.callFunction({
      name: "morningService",
      data: { action: "bindPartner", code: this.data.code, token: sceneToken },
    }).then((res) => {
      const result = requireBindingRolePayload(res?.result)
      app.globalData.role = result.role
      wx.reLaunch({
        url: result.role === "owner" ? "/pages/morningAdmin/morningAdmin" : "/pages/morningHome/morningHome",
      })
    }).catch((err) => {
      console.error("bind partner failed", err)
      const message = err?.errMsg || err?.message || ""
      const title = message === "binding status unconfirmed"
        ? "绑定状态未确认，请重新进入查看"
        : message.includes("专属账号已经绑定")
        ? "已有账号绑定，请先由主人解绑"
        : message.includes("过期") || message.includes("无效")
          ? "绑定码无效或已过期"
          : "绑定失败，请重新确认"
      wx.showToast({ title, icon: "none", duration: 3000 })
    }).finally(() => this.setData({ binding: false }))
  },
})

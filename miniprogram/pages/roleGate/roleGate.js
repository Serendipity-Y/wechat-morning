const app = getApp()

Page({
  onLoad() {
    this.routeByRole()
  },

  routeByRole() {
    app.getRoleProfile(true)
      .then(({ role }) => {
        const routes = {
          owner: "/pages/morningAdmin/morningAdmin",
          partner: "/pages/morningHome/morningHome",
          unbound: "/pages/bindPartner/bindPartner",
        }
        wx.reLaunch({ url: routes[role] || routes.unbound })
      })
      .catch((err) => {
        console.error("load role failed", err)
        wx.showModal({
          title: "暂时无法进入",
          content: "请检查网络和 morningService 云函数是否已部署。",
          showCancel: false,
          confirmText: "重新尝试",
          success: () => this.routeByRole(),
        })
      })
  },
})

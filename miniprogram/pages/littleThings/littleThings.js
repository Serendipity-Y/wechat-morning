const DEFAULT_THINGS = [
  "早餐给对方留一份。",
  "出门前看看天气。",
]

Page({
  data: {
    loading: true,
    things: [],
  },

  onLoad() {
    this.loadThings()
  },

  loadThings() {
    return wx.cloud.callFunction({ name: "morningService", data: { action: "getCompanionLists", listKey: "littleThings" } })
      .then((res) => {
        const things = res.result?.littleThings
        this.setData({ things: Array.isArray(things) && things.length ? things : DEFAULT_THINGS })
      })
      .catch((err) => {
        console.error("load little things failed", err)
        this.setData({ things: DEFAULT_THINGS })
        wx.showToast({ title: "先看默认小事", icon: "none" })
      })
      .finally(() => this.setData({ loading: false }))
  },
})

const DEFAULT_WISHES = [
  "一起逛周末市集。",
  "挑一个晴天去看展。",
]

Page({
  data: {
    loading: true,
    wishes: [],
  },

  onLoad() {
    this.loadWishes()
  },

  loadWishes() {
    return wx.cloud.callFunction({ name: "morningService", data: { action: "getCompanionLists", listKey: "meetingWishes" } })
      .then((res) => {
        const wishes = res.result?.meetingWishes
        this.setData({ wishes: Array.isArray(wishes) && wishes.length ? wishes : DEFAULT_WISHES })
      })
      .catch((err) => {
        console.error("load meeting wishes failed", err)
        this.setData({ wishes: DEFAULT_WISHES })
        wx.showToast({ title: "先看默认愿望", icon: "none" })
      })
      .finally(() => this.setData({ loading: false }))
  },
})

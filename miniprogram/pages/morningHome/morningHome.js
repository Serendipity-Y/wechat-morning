const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value)
const hasText = (value) => typeof value === "string" && Boolean(value.trim())
const isWeatherValue = (value) => value === "--" || (typeof value === "number" && Number.isFinite(value))

const requireMorningPayload = (response) => {
  const result = response?.result
  const settings = result?.settings
  const weather = result?.weather
  if (!isRecord(result) || !isRecord(settings) || !isRecord(weather)) {
    throw new Error("早安数据格式异常")
  }
  if (
    ![settings.city, settings.partnerName, settings.loveText, settings.anniversary, settings.firstDate].every(hasText)
    || !Array.isArray(settings.careItems)
    || ![weather.date, weather.condition, weather.note, weather.clothing].every(hasText)
    || ![weather.min, weather.max, weather.rain].every(isWeatherValue)
  ) {
    throw new Error("早安数据不完整")
  }
  return { settings, weather }
}

Page({
  data: {
    loading: true,
    loadError: "",
    preview: false,
    settings: {},
    weather: {},
    greeting: "早上好",
    mode: "morning",
    modeTitle: "MORNING STUDIO",
    daysTogether: 0,
    loveDays: 0,
    firstDateText: "2026.6.17",
    subscribing: false,
  },

  onLoad(options) {
    const modeInfo = this.getModeInfo()
    this.setData({ preview: options.preview === "1", ...modeInfo })
    this.loadMorning()
  },

  getModeInfo() {
    const hour = new Date().getHours()
    if (hour >= 18 || hour < 5) {
      return { mode: "night", modeTitle: "GOOD NIGHT", greeting: "晚上好" }
    }
    if (hour >= 11) {
      return { mode: "day", modeTitle: "DAYLIGHT NOTE", greeting: "下午好" }
    }
    return { mode: "morning", modeTitle: "MORNING STUDIO", greeting: "早上好" }
  },

  loadMorning() {
    return wx.cloud.callFunction({ name: "morningService", data: { action: "getMorning", includeContentLists: false } })
      .then((res) => {
        const { settings: rawSettings, weather } = requireMorningPayload(res)
        const {
          memoryFragments,
          meetingWishes,
          littleThings,
          ...settings
        } = rawSettings
        this.setData({
          settings,
          weather,
          daysTogether: this.getDaysTogether(settings.anniversary),
          loveDays: this.getDaysTogether(settings.firstDate),
          firstDateText: this.formatDateText(settings.firstDate),
          loading: false,
          loadError: "",
        })
      })
      .catch((err) => {
        console.error("load morning failed", err)
        this.setData({ loading: false, loadError: "今日早安暂时加载失败，请检查网络后重试" })
        wx.showToast({ title: "今日天气暂时走丢了", icon: "none" })
      })
  },

  retryMorning() {
    if (this.data.loading) return Promise.resolve()
    this.setData({ loading: true, loadError: "" })
    return this.loadMorning()
  },

  getDaysTogether(date) {
    if (!date) return 0
    const start = new Date(`${date}T00:00:00`)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return Math.max(0, Math.floor((today - start) / 86400000) + 1)
  },

  formatDateText(date) {
    if (!date) return "2026.6.17"
    const parts = String(date).split("-")
    if (parts.length !== 3) return date
    return `${Number(parts[0])}.${Number(parts[1])}.${Number(parts[2])}`
  },

  subscribeTomorrow() {
    if (this.data.preview) {
      wx.showToast({ title: "预览模式不预约", icon: "none" })
      return
    }
    const templateId = this.data.settings.templateId
    if (!templateId || this.data.subscribing) {
      wx.showToast({ title: templateId ? "请稍候" : "提醒功能还在准备中", icon: "none" })
      return
    }
    this.setData({ subscribing: true })
    return wx.requestSubscribeMessage({ tmplIds: [templateId] })
      .then((result) => {
        if (result[templateId] !== "accept") throw new Error("subscription denied")
        return wx.cloud.callFunction({ name: "morningService", data: { action: "recordSubscription" } })
      })
      .then((res) => {
        if (res?.result?.success !== true) throw new Error("subscription status unconfirmed")
        wx.showToast({ title: "明早的小温柔已安排", icon: "success" })
      })
      .catch((err) => {
        console.error("subscribe morning failed", err)
        const title = err?.message === "subscription status unconfirmed"
          ? "预约状态未确认，请稍后再看"
          : "这次没有开启提醒"
        wx.showToast({ title, icon: "none" })
      })
      .finally(() => this.setData({ subscribing: false }))
  },

  goMemory() { wx.navigateTo({ url: "/pages/morningMemory/morningMemory" }) },
  goMeeting() { wx.navigateTo({ url: "/pages/meetingWishes/meetingWishes" }) },
  goLittleThings() { wx.navigateTo({ url: "/pages/littleThings/littleThings" }) },
  goContentEditor() { wx.navigateTo({ url: "/pages/morningAdmin/morningAdmin?contentEditor=1" }) },
})

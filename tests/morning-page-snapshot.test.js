const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { hasWeatherSnapshot, getCachedWeather, toPublicSettings } = require("../cloudfunctions/morningService").__test__

let morningHome
const originalPage = global.Page

try {
  global.Page = (definition) => { morningHome = definition }
  require("../miniprogram/pages/morningHome/morningHome.js")
} finally {
  if (originalPage === undefined) delete global.Page
  else global.Page = originalPage
}

test("morning home can reuse a complete daily weather snapshot", () => {
  assert.equal(hasWeatherSnapshot({
    date: "2026-08-04",
    condition: "雷雨",
    min: 28.1,
    max: 35.5,
    rain: 60,
    clothing: "清凉短袖并带伞",
  }), true)
})

test("morning home refetches when a stored weather snapshot is incomplete", () => {
  assert.equal(hasWeatherSnapshot({
    date: "2026-08-04",
    condition: "雷雨",
    min: 28.1,
    max: 35.5,
    rain: 0,
  }), false)
  assert.equal(hasWeatherSnapshot(null), false)
})

test("fallback weather is never treated as a reusable daily snapshot", () => {
  assert.equal(hasWeatherSnapshot({
    date: "2026-08-04",
    condition: "天气多变",
    min: "--",
    max: "--",
    rain: "--",
    clothing: "出门前再看一眼天气",
    fallback: true,
  }), false)
})

test("morning home reuses only a complete weather snapshot for the requested date", () => {
  const weather = {
    date: "2026-09-05",
    condition: "雷雨",
    min: 28.1,
    max: 35.5,
    rain: 60,
    clothing: "清凉短袖并带伞",
  }

  assert.equal(getCachedWeather({ weather }, "2026-09-05"), weather)
  assert.equal(getCachedWeather({ weather }, "2026-09-06"), null)
  assert.equal(getCachedWeather({ weather: { ...weather, fallback: true } }, "2026-09-05"), null)
})

test("morning response keeps full content lists by default for older clients", () => {
  const settings = {
    memoryFragments: ["记忆"],
    meetingWishes: ["见面"],
    littleThings: ["小事"],
    templateId: "template-id",
    reminderEnabled: true,
  }
  const dailyContent = { partnerName: "晨光", loveText: "早安", careItems: [] }

  const result = toPublicSettings(settings, dailyContent)
  assert.deepEqual(result.memoryFragments, ["记忆"])
  assert.deepEqual(result.meetingWishes, ["见面"])
  assert.deepEqual(result.littleThings, ["小事"])
})

test("morning response omits only detail lists when the new client requests it", () => {
  const settings = {
    memoryFragments: ["记忆"],
    meetingWishes: ["见面"],
    littleThings: ["小事"],
    templateId: "template-id",
    reminderEnabled: true,
  }
  const dailyContent = {
    partnerName: "晨光",
    loveText: "早安",
    careItems: ["喝水"],
    memoryText: "今日记忆",
    meetingWish: "今日愿望",
    comfortText: "今日哄哄",
  }

  const result = toPublicSettings(settings, dailyContent, { includeContentLists: false })
  assert.equal(result.partnerName, "晨光")
  assert.equal(result.templateId, "template-id")
  assert.deepEqual(result.careItems, ["喝水"])
  assert.equal(Object.hasOwn(result, "memoryFragments"), false)
  assert.equal(Object.hasOwn(result, "meetingWishes"), false)
  assert.equal(Object.hasOwn(result, "littleThings"), false)
})

test("morning home passes the first daily read into daily-content creation", () => {
  const source = fs.readFileSync(path.join(__dirname, "../cloudfunctions/morningService/index.js"), "utf8")
  assert.match(source, /getOrCreateDailyContent\(settings, date, weather, storedDailyContent\)/)
  assert.match(source, /const existing = storedDailyContent \|\| \(await db\.collection\(DAILY\)/)
  assert.match(source, /const cachedWeather = getCachedWeather\(storedDailyContent, date\)/)
  assert.match(source, /if \(hasWeatherSnapshotForDate\(weather, date\)\) content\.weather = weather/)
  assert.match(source, /!hasWeatherSnapshotForDate\(existing\.weather, date\)/)
})

test("morning home keeps only displayed settings after loading", async () => {
  const originalWx = global.wx
  const calls = []
  global.wx = {
    cloud: {
      callFunction(request) {
        calls.push(request)
        return Promise.resolve({
          result: {
            settings: {
              city: "北京市",
              partnerName: "晨光",
              loveText: "早安呀",
              templateId: "template-id",
              anniversary: "2024-01-01",
              firstDate: "2024-02-01",
              careItems: [],
              memoryFragments: ["不应进入首页 settings"],
              meetingWishes: ["不应进入首页 settings"],
              littleThings: ["不应进入首页 settings"],
            },
            weather: { date: "2026-09-05", condition: "晴", note: "阳光正好", clothing: "短袖", min: 20, max: 30, rain: 0 },
          },
        })
      },
    },
    showToast() {},
  }

  const context = {
    data: {},
    setData(patch) { Object.assign(this.data, patch) },
    getDaysTogether(date) { return date === "2024-01-01" ? 127 : 81 },
    formatDateText(date) { return `日期-${date}` },
  }

  try {
    await morningHome.loadMorning.call(context)
  } finally {
    if (originalWx === undefined) delete global.wx
    else global.wx = originalWx
  }

  assert.equal(context.data.settings.city, "北京市")
  assert.equal(context.data.settings.partnerName, "晨光")
  assert.equal(context.data.settings.templateId, "template-id")
  assert.deepEqual(context.data.weather, { date: "2026-09-05", condition: "晴", note: "阳光正好", clothing: "短袖", min: 20, max: 30, rain: 0 })
  assert.equal(context.data.daysTogether, 127)
  assert.equal(context.data.loveDays, 81)
  assert.equal(context.data.firstDateText, "日期-2024-02-01")
  assert.equal(Object.hasOwn(context.data.settings, "memoryFragments"), false)
  assert.equal(Object.hasOwn(context.data.settings, "meetingWishes"), false)
  assert.equal(Object.hasOwn(context.data.settings, "littleThings"), false)
  assert.deepEqual(calls, [{
    name: "morningService",
    data: { action: "getMorning", includeContentLists: false },
  }])
})

test("morning home exposes a retryable error instead of rendering an empty response", async () => {
  const originalWx = global.wx
  let attempts = 0
  global.wx = {
    cloud: {
      callFunction() {
        attempts += 1
        if (attempts === 1) return Promise.reject(new Error("offline"))
        return Promise.resolve({
          result: {
            settings: {
              city: "北京市",
              partnerName: "晨光",
              loveText: "早安呀",
              anniversary: "2024-01-01",
              firstDate: "2024-02-01",
              careItems: [],
            },
            weather: { date: "2026-09-05", condition: "晴", note: "阳光正好", clothing: "短袖", min: 20, max: 30, rain: 0 },
          },
        })
      },
    },
    showToast() {},
  }

  const context = {
    data: { loading: true, loadError: "", settings: {}, weather: {} },
    setData(patch) { Object.assign(this.data, patch) },
    loadMorning: morningHome.loadMorning,
    getDaysTogether() { return 1 },
    formatDateText() { return "2026.6.17" },
  }

  const originalConsoleError = console.error
  console.error = () => {}
  try {
    await morningHome.loadMorning.call(context)
    assert.equal(context.data.loading, false)
    assert.equal(context.data.loadError, "今日早安暂时加载失败，请检查网络后重试")

    await morningHome.retryMorning.call(context)
  } finally {
    console.error = originalConsoleError
    if (originalWx === undefined) delete global.wx
    else global.wx = originalWx
  }

  const template = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/morningHome/morningHome.wxml"), "utf8")
  assert.equal(context.data.loadError, "")
  assert.equal(context.data.settings.partnerName, "晨光")
  assert.match(template, /wx:elif="\{\{loadError\}\}" class="load-error-card"/)
  assert.match(template, /bindtap="retryMorning"/)
})

test("a malformed successful morning response becomes retryable instead of rendering blank content", async () => {
  const originalWx = global.wx
  let attempts = 0
  global.wx = {
    cloud: {
      callFunction() {
        attempts += 1
        if (attempts === 1) return Promise.resolve({ result: {} })
        return Promise.resolve({
          result: {
            settings: {
              city: "北京市",
              partnerName: "晨光",
              loveText: "早安呀",
              anniversary: "2024-01-01",
              firstDate: "2024-02-01",
              careItems: [],
            },
            weather: { date: "2026-09-05", condition: "晴", note: "阳光正好", clothing: "短袖", min: 20, max: 30, rain: 0 },
          },
        })
      },
    },
    showToast() {},
  }

  const context = {
    data: {
      loading: true,
      loadError: "",
      settings: { partnerName: "之前的称呼" },
      weather: { condition: "旧天气" },
    },
    setData(patch) { Object.assign(this.data, patch) },
    loadMorning: morningHome.loadMorning,
    getDaysTogether() { return 1 },
    formatDateText() { return "2026.6.17" },
  }

  const originalConsoleError = console.error
  console.error = () => {}
  try {
    await morningHome.loadMorning.call(context)
    assert.equal(context.data.loading, false)
    assert.equal(context.data.loadError, "今日早安暂时加载失败，请检查网络后重试")
    assert.equal(context.data.settings.partnerName, "之前的称呼")
    assert.equal(context.data.weather.condition, "旧天气")

    await morningHome.retryMorning.call(context)
  } finally {
    console.error = originalConsoleError
    if (originalWx === undefined) delete global.wx
    else global.wx = originalWx
  }

  assert.equal(context.data.loadError, "")
  assert.equal(context.data.settings.partnerName, "晨光")
  assert.equal(context.data.weather.condition, "晴")
})

test("morning subscription reports success only after the cloud function confirms the increment", async () => {
  const originalWx = global.wx
  const toasts = []
  global.wx = {
    requestSubscribeMessage() { return Promise.resolve({ "template-id": "accept" }) },
    cloud: {
      callFunction() { return Promise.resolve({ result: { success: true } }) },
    },
    showToast(options) { toasts.push(options) },
  }

  const context = {
    data: { preview: false, settings: { templateId: "template-id" }, subscribing: false },
    setData(patch) { Object.assign(this.data, patch) },
  }

  try {
    await morningHome.subscribeTomorrow.call(context)
  } finally {
    if (originalWx === undefined) delete global.wx
    else global.wx = originalWx
  }

  assert.equal(context.data.subscribing, false)
  assert.deepEqual(toasts, [{ title: "明早的小温柔已安排", icon: "success" }])
})

test("an unconfirmed or denied morning subscription never claims success", async () => {
  const originalWx = global.wx
  const toasts = []
  const calls = []
  global.wx = {
    requestSubscribeMessage({ tmplIds }) {
      return Promise.resolve({ [tmplIds[0]]: calls.length ? "reject" : "accept" })
    },
    cloud: {
      callFunction(request) {
        calls.push(request)
        return Promise.resolve({ result: {} })
      },
    },
    showToast(options) { toasts.push(options) },
  }

  const originalConsoleError = console.error
  console.error = () => {}
  try {
    const malformedContext = {
      data: { preview: false, settings: { templateId: "template-id" }, subscribing: false },
      setData(patch) { Object.assign(this.data, patch) },
    }
    await morningHome.subscribeTomorrow.call(malformedContext)
    assert.equal(malformedContext.data.subscribing, false)

    const deniedContext = {
      data: { preview: false, settings: { templateId: "template-id" }, subscribing: false },
      setData(patch) { Object.assign(this.data, patch) },
    }
    await morningHome.subscribeTomorrow.call(deniedContext)
    assert.equal(deniedContext.data.subscribing, false)
  } finally {
    console.error = originalConsoleError
    if (originalWx === undefined) delete global.wx
    else global.wx = originalWx
  }

  assert.deepEqual(calls, [{ name: "morningService", data: { action: "recordSubscription" } }])
  assert.deepEqual(toasts, [
    { title: "预约状态未确认，请稍后再看", icon: "none" },
    { title: "这次没有开启提醒", icon: "none" },
  ])
})

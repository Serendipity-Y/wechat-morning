const cloud = require("wx-server-sdk")
const https = require("https")
const crypto = require("crypto")

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const command = db.command

const USERS = "appUsers"
const SETTINGS = "morningSettings"
const INVITES = "morningInvites"
const DAILY = "morningDaily"
const REMINDER_LOG_CHANNEL = "miniProgramReminderLog"
const MAX_ACTIVE_BINDING_RECORDS = 20
// 免费体验版云函数只有约 3 秒执行时间：首页不能因天气接口慢而返回空数据。
const WEATHER_REQUEST_ATTEMPTS = 1
const WEATHER_REQUEST_TIMEOUT_MS = 1200
const {
  PARTNER_NAME_RECENT_DAYS,
  PARTNER_NAMES,
  LOVE_TEXTS,
  dateOffset,
  randomItem,
  getPartnerNameCandidates,
} = require("./morningContent")
const { canEditCompanionContent } = require("./companionEditor")
const {
  readOwnerBindingRevision,
  getNextOwnerBindingRevision,
  getInviteOwnerBindingRevisionDecision,
  getPartnerBindingDecision,
  getUnbindPartnerDecision,
  canAccessMorningAsMember,
} = require("./partnerBindingState")
const {
  readCompanionContentRevision,
  requireExpectedCompanionContentRevision,
  getCompanionContentCommitDecision,
} = require("./contentRevision")

const CARE_POOLS = {
  rain: ["喝杯水，吃点早餐。"],
  sun: ["忙里留一点休息时间。"],
  cloudy: ["记得看看今天的天气。"],
  workday: ["喝杯水，吃点早餐。"],
}

const MEMORY_FRAGMENTS = [
  "散步时遇见了一只晒太阳的猫。",
  "在旧书店找到一本喜欢的诗集。",
]

const MEETING_WISHES = [
  "一起逛周末市集。",
  "挑一个晴天去看展。",
]

const COMFORT_TEXTS = [
  "日子慢慢过，先照顾好自己。",
  "累了就停一会儿。",
]

const LITTLE_THINGS = [
  "早餐给对方留一份。",
  "出门前看看天气。",
]

const FIXED_SETTINGS = {
  city: "北京市",
  latitude: 39.9042,
  longitude: 116.4074,
  anniversary: "2024-01-01",
  firstDate: "2024-02-01",
  partnerNames: PARTNER_NAMES,
  loveTexts: LOVE_TEXTS,
}

const DEFAULT_SETTINGS = {
  partnerName: PARTNER_NAMES[0],
  loveText: LOVE_TEXTS[0],
  memoryFragments: MEMORY_FRAGMENTS,
  meetingWishes: MEETING_WISHES,
  littleThings: LITTLE_THINGS,
  ...FIXED_SETTINGS,
  templateId: "",
  reminderEnabled: false,
  companionContentRevision: 0,
}

const weatherMap = {
  0: ["晴", "阳光很好"],
  1: ["晴间多云", "阳光偶尔露面"],
  2: ["多云", "云层较多"],
  3: ["阴", "天空偏阴"],
  45: ["有雾", "能见度较低"],
  48: ["雾凇", "路面可能湿滑"],
  51: ["小毛毛雨", "可能有零星小雨"],
  53: ["毛毛雨", "外出建议带伞"],
  55: ["较强毛毛雨", "记得带伞"],
  61: ["小雨", "外出记得带伞"],
  63: ["中雨", "外出务必带伞"],
  65: ["大雨", "尽量减少户外停留"],
  71: ["小雪", "注意保暖和路滑"],
  73: ["中雪", "穿暖一些并注意路滑"],
  75: ["大雪", "非必要尽量少外出"],
  80: ["阵雨", "雨来得快，记得带伞"],
  81: ["较强阵雨", "建议携带雨具"],
  82: ["强阵雨", "注意避雨和出行安全"],
  95: ["雷雨", "远离空旷和高处"],
  96: ["雷雨伴冰雹", "尽量留在室内"],
  99: ["强雷雨伴冰雹", "注意安全，减少外出"],
}

const requestJson = (url) =>
  new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: WEATHER_REQUEST_TIMEOUT_MS }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => { body += chunk })
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`weather api status ${res.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch (err) {
          reject(err)
        }
      })
    })
    req.on("timeout", () => req.destroy(new Error("weather api timeout")))
    req.on("error", reject)
  })

const getShanghaiDate = () =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())

const trimError = (err) => String(err?.message || err || "").slice(0, 160)

const getUser = async (openid) => {
  const result = await db.collection(USERS).where({ openid, status: "active" }).limit(2).get()
  if (result.data.length > 1) throw new Error("账号数据异常")
  return result.data[0] || null
}

const requireRole = async (openid, roles) => {
  const user = await getUser(openid)
  if (!user || !roles.includes(user.role)) {
    throw new Error("无权执行此操作")
  }
  if (user.role === "owner") {
    const owner = await getOwner()
    if (!owner || owner._id !== user._id) throw new Error("主人账号状态异常")
  }
  return user
}

const getOwner = async () => {
  const result = await db.collection(USERS).where({ role: "owner", status: "active" }).limit(2).get()
  if (result.data.length > 1) throw new Error("主人账号状态异常")
  return result.data[0] || null
}

const getSettings = async () => {
  const owner = await getOwner()
  if (!owner) return { ...DEFAULT_SETTINGS }
  const result = await db.collection(SETTINGS).where({ ownerOpenid: owner.openid }).limit(2).get()
  if (result.data.length > 1) throw new Error("专属设置数据异常")
  return { ...DEFAULT_SETTINGS, ...(result.data[0] || {}), ...FIXED_SETTINGS, ownerOpenid: owner.openid }
}

const requireCurrentMorningMember = async (openid, roles = ["owner", "partner"]) => {
  const user = await requireRole(openid, roles)
  const settings = await getSettings()
  if (!canAccessMorningAsMember({ user, settings, openid })) {
    throw new Error("当前账号不是已绑定的早安成员")
  }
  return { user, settings }
}

const toCompanionEditorContent = (settings = {}) => ({
  memoryFragments: getMemoryFragments(settings),
  memoryFragmentEntries: getMemoryFragmentEntries(settings),
  meetingWishes: getMeetingWishes(settings),
  littleThings: getLittleThings(settings),
  companionContentRevision: readCompanionContentRevision(settings),
})

const getCompanionEditorContext = async (openid) => {
  const { user, settings } = await requireCurrentMorningMember(openid)
  if (!canEditCompanionContent(user, settings, openid)) {
    throw new Error("当前账号不是这份专属内容的编辑者")
  }
  return { settings, user }
}

const getCompanionContentEditor = async (openid) => {
  const { settings } = await getCompanionEditorContext(openid)
  return toCompanionEditorContent(settings)
}

const commitCompanionContent = async ({
  openid,
  user,
  ownerOpenid,
  expectedCompanionContentRevision,
  safe,
}) => {
  const expectedRevision = requireExpectedCompanionContentRevision(expectedCompanionContentRevision)
  return db.runTransaction(async (transaction) => {
    const result = await transaction.collection(SETTINGS).where({ ownerOpenid }).limit(2).get()
    if (result.data.length > 1) throw new Error("专属设置数据异常")
    const current = result.data[0] || null

    if (!current) {
      if (user.role !== "owner" || user.openid !== ownerOpenid || expectedRevision !== 0) {
        return {
          saved: false,
          reason: "companion_content_revision_conflict",
          companionContentRevision: 0,
        }
      }
      const decision = getCompanionContentCommitDecision({}, expectedRevision)
      const ownerResult = await transaction.collection(USERS).where({
        openid: ownerOpenid,
        role: "owner",
        status: "active",
      }).limit(2).get()
      if (ownerResult.data.length !== 1) throw new Error("主人账号状态异常")
      const now = new Date()
      const { memoryFragmentInput, ...safeValues } = safe
      const created = {
        ...DEFAULT_SETTINGS,
        ...safeValues,
        ...sanitizeMemoryFragmentInput(memoryFragmentInput, null, now),
        ownerOpenid,
        subscriptionCount: 0,
        companionContentRevision: decision.companionContentRevision,
        updatedAt: now,
      }
      await transaction.collection(SETTINGS).add({ data: created })
      await touchOwnerSettingsCreationGate(transaction, ownerResult.data[0], now)
      return { saved: true, settings: created }
    }

    if (!canEditCompanionContent(user, current, openid)) {
      throw new Error("当前账号不是这份专属内容的编辑者")
    }

    const decision = getCompanionContentCommitDecision(current, expectedRevision)
    if (!decision.saved) return decision

    const now = new Date()
    const { memoryFragmentInput, ...safeValues } = safe
    const patch = {
      ...safeValues,
      ...sanitizeMemoryFragmentInput(memoryFragmentInput, current, now),
      companionContentRevision: decision.companionContentRevision,
      updatedAt: now,
    }
    await transaction.collection(SETTINGS).doc(current._id).update({ data: patch })
    return { saved: true, settings: { ...current, ...patch } }
  })
}

const saveCompanionContent = async (openid, values, expectedCompanionContentRevision) => {
  const { settings, user } = await getCompanionEditorContext(openid)
  const safe = {
    memoryFragmentInput: {
      memoryFragments: values.memoryFragments,
      memoryFragmentEntries: values.memoryFragmentEntries,
    },
    meetingWishes: sanitizeTextList(values.meetingWishes, MEETING_WISHES, 80, 80),
    littleThings: sanitizeTextList(values.littleThings, LITTLE_THINGS, 120, 80),
  }
  const result = await commitCompanionContent({
    openid,
    user,
    ownerOpenid: settings.ownerOpenid,
    expectedCompanionContentRevision,
    safe,
  })
  if (!result.saved) return result
  return { saved: true, ...toCompanionEditorContent(result.settings) }
}

const saveSettings = async (ownerOpenid, values, expectedCompanionContentRevision) => {
  const safe = {
    ...FIXED_SETTINGS,
    partnerName: PARTNER_NAMES[0],
    loveText: LOVE_TEXTS[0],
    memoryFragmentInput: {
      memoryFragments: values.memoryFragments,
      memoryFragmentEntries: values.memoryFragmentEntries,
    },
    meetingWishes: sanitizeTextList(values.meetingWishes, MEETING_WISHES, 80, 80),
    littleThings: sanitizeTextList(values.littleThings, LITTLE_THINGS, 120, 80),
    templateId: String(values.templateId || "").trim().slice(0, 80),
    reminderEnabled: values.reminderEnabled !== false,
  }
  const result = await commitCompanionContent({
    openid: ownerOpenid,
    user: { openid: ownerOpenid, role: "owner" },
    ownerOpenid,
    expectedCompanionContentRevision,
    safe,
  })
  if (!result.saved) return result
  return {
    ...DEFAULT_SETTINGS,
    ...result.settings,
    ...FIXED_SETTINGS,
    ownerOpenid,
    saved: true,
  }
}

const initializeFixedContent = async (ownerOpenid) => {
  const current = await db.collection(SETTINGS).where({ ownerOpenid }).limit(1).get()
  if (!current.data.length) throw new Error("请先完成专属设置")
  await db.collection(SETTINGS).doc(current.data[0]._id).update({
    data: {
      ...FIXED_SETTINGS,
      partnerName: PARTNER_NAMES[0],
      loveText: LOVE_TEXTS[0],
      updatedAt: db.serverDate(),
    },
  })
  return {
    city: FIXED_SETTINGS.city,
    anniversary: FIXED_SETTINGS.anniversary,
    partnerNameCount: PARTNER_NAMES.length,
    loveTextCount: LOVE_TEXTS.length,
  }
}

const randomItems = (items, count) => {
  const pool = [...items]
  const result = []
  while (pool.length && result.length < count) {
    const index = Math.floor(Math.random() * pool.length)
    result.push(pool.splice(index, 1)[0])
  }
  return result
}

const sanitizeTextList = (value, fallback, maxItems = 80, maxLength = 120) => {
  const source = Array.isArray(value) ? value : String(value || "").split(/\r?\n/)
  const seen = new Set()
  const items = []
  source.forEach((item) => {
    const text = String(item || "").trim().slice(0, maxLength)
    if (!text || seen.has(text)) return
    seen.add(text)
    items.push(text)
  })
  return items.length ? items.slice(0, maxItems) : fallback
}

const sanitizeStoredMemoryFragmentEntries = (value) => {
  if (!Array.isArray(value)) return []
  const seenIds = new Set()
  const seenTexts = new Set()
  const entries = []
  value.forEach((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return
    const id = String(item.id || "").trim().slice(0, 80)
    const text = String(item.text || "").trim().slice(0, 120)
    if (!id || !text || seenIds.has(id) || seenTexts.has(text)) return
    seenIds.add(id)
    seenTexts.add(text)
    entries.push({
      id,
      text,
      publishedAt: item.publishedAt || null,
      updatedAt: item.updatedAt || null,
    })
  })
  return entries.slice(0, 80)
}

const getMemoryFragmentEntries = (settings = {}) => {
  const storedEntries = sanitizeStoredMemoryFragmentEntries(settings.memoryFragmentEntries)
  if (storedEntries.length) return storedEntries
  return sanitizeTextList(settings.memoryFragments, MEMORY_FRAGMENTS, 80, 120)
    .map((text, index) => ({
      id: `legacy-${index}`,
      text,
      publishedAt: null,
      updatedAt: null,
      legacy: true,
    }))
}

const getMemoryFragments = (settings = {}) => getMemoryFragmentEntries(settings).map((entry) => entry.text)

const createMemoryFragmentId = () => crypto.randomBytes(12).toString("hex")

const sanitizeMemoryFragmentInput = (input = {}, current = null, now = new Date()) => {
  const currentEntries = current ? sanitizeStoredMemoryFragmentEntries(current.memoryFragmentEntries) : []
  const currentById = new Map(currentEntries.map((entry) => [entry.id, entry]))
  const currentByText = new Map()
  currentEntries.forEach((entry) => {
    const matches = currentByText.get(entry.text) || []
    matches.push(entry)
    currentByText.set(entry.text, matches)
  })

  const submittedEntries = Array.isArray(input.memoryFragmentEntries)
    ? input.memoryFragmentEntries
    : sanitizeTextList(input.memoryFragments, MEMORY_FRAGMENTS, 80, 120)
      .map((text) => ({ text, legacy: true }))
  const seenTexts = new Set()
  const usedIds = new Set()
  const entries = []
  submittedEntries.forEach((item) => {
    const source = item && typeof item === "object" && !Array.isArray(item) ? item : { text: item }
    const text = String(source.text || "").trim().slice(0, 120)
    if (!text || seenTexts.has(text) || entries.length >= 80) return
    seenTexts.add(text)

    const suppliedId = String(source.id || "").trim()
    let previous = currentById.get(suppliedId) || null
    if (previous && usedIds.has(previous.id)) previous = null
    if (!previous && !Array.isArray(input.memoryFragmentEntries)) {
      const matches = currentByText.get(text) || []
      previous = matches.shift() || null
    }

    if (previous) {
      usedIds.add(previous.id)
      entries.push({
        id: previous.id,
        text,
        publishedAt: previous.publishedAt || null,
        updatedAt: previous.text === text ? previous.updatedAt || null : now,
      })
      return
    }

    const historical = source.legacy === true
    let id = createMemoryFragmentId()
    while (usedIds.has(id)) id = createMemoryFragmentId()
    usedIds.add(id)
    entries.push({
      id,
      text,
      publishedAt: historical ? null : now,
      updatedAt: historical ? null : now,
    })
  })

  const fallback = entries.length
    ? entries
    : MEMORY_FRAGMENTS.map((text, index) => ({
      id: `default-${index}`,
      text,
      publishedAt: null,
      updatedAt: null,
    }))
  return {
    memoryFragments: fallback.map((entry) => entry.text),
    memoryFragmentEntries: fallback,
  }
}

const getMeetingWishes = (settings = {}) => sanitizeTextList(settings.meetingWishes, MEETING_WISHES, 80, 80)

const getLittleThings = (settings = {}) => sanitizeTextList(settings.littleThings, LITTLE_THINGS, 120, 80)

const COMPANION_LIST_READERS = Object.freeze({
  memoryFragments: getMemoryFragments,
  meetingWishes: getMeetingWishes,
  littleThings: getLittleThings,
})

const selectCompanionLists = (settings = {}, listKey, { includeMemoryMetadata = false } = {}) => {
  if (typeof listKey === "undefined") {
    return {
      memoryFragments: getMemoryFragments(settings),
      meetingWishes: getMeetingWishes(settings),
      littleThings: getLittleThings(settings),
    }
  }
  const reader = Object.prototype.hasOwnProperty.call(COMPANION_LIST_READERS, listKey)
    ? COMPANION_LIST_READERS[listKey]
    : null
  if (!reader) throw new Error("无效内容分类")
  const selected = { [listKey]: reader(settings) }
  if (listKey === "memoryFragments" && includeMemoryMetadata) {
    selected.memoryFragmentEntries = getMemoryFragmentEntries(settings)
  }
  return selected
}

const toAdminSettings = (settings = {}) => ({
  ...settings,
  memoryFragments: getMemoryFragments(settings),
  memoryFragmentEntries: getMemoryFragmentEntries(settings),
})

const getWeatherCareItems = (weather = {}, date) => {
  const condition = String(weather.condition || "")
  const rain = Number(weather.rain || 0)
  const isRain = rain >= 50 || condition.includes("雨")
  const isSunny = condition.includes("晴")
  const weatherItems = isRain ? CARE_POOLS.rain : isSunny ? CARE_POOLS.sun : CARE_POOLS.cloudy
  const day = new Date(`${date}T12:00:00+08:00`).getDay()
  const extraItems = day >= 1 && day <= 5 ? CARE_POOLS.workday : []
  return randomItems([...weatherItems, ...extraItems], 3)
}

const buildCompanionContent = (settings, weather, date) => ({
  careItems: getWeatherCareItems(weather, date),
  memoryText: randomItem(getMemoryFragments(settings)),
  meetingWish: getMeetingWishes(settings)[0],
  comfortText: randomItem(COMFORT_TEXTS),
})

const getOrCreateDailyContent = async (settings, date, weather = {}, storedDailyContent = null) => {
  const contentOpenid = settings.partnerOpenid || settings.ownerOpenid
  const dailyId = `${date}_${contentOpenid}`
  const existing = storedDailyContent || (await db.collection(DAILY).where({ _id: dailyId }).limit(1).get()).data[0]
  if (existing) {
    const patch = {}
    const memoryPool = getMemoryFragments(settings)
    const meetingPool = getMeetingWishes(settings)
    if (!existing.partnerName || !PARTNER_NAMES.includes(existing.partnerName)) patch.partnerName = randomItem(PARTNER_NAMES)
    if (!Array.isArray(existing.careItems) || !existing.careItems.length) patch.careItems = getWeatherCareItems(weather, date)
    if (!existing.loveText || !LOVE_TEXTS.includes(existing.loveText)) patch.loveText = randomItem(LOVE_TEXTS)
    if (!existing.memoryText || !memoryPool.includes(existing.memoryText)) patch.memoryText = randomItem(memoryPool)
    if (!existing.meetingWish || existing.meetingWish !== meetingPool[0]) patch.meetingWish = meetingPool[0]
    if (!existing.comfortText) patch.comfortText = randomItem(COMFORT_TEXTS)
    if (hasWeatherSnapshotForDate(weather, date) && !hasWeatherSnapshotForDate(existing.weather, date)) patch.weather = weather
    if (Object.keys(patch).length) {
      await db.collection(DAILY).doc(dailyId).update({ data: { ...patch, updatedAt: db.serverDate() } })
      return { ...existing, ...patch }
    }
    return existing
  }

  const previousResults = await Promise.all(
    Array.from({ length: PARTNER_NAME_RECENT_DAYS }, (_, index) => dateOffset(date, -(index + 1)))
      .map((previousDate) => db.collection(DAILY).where({ date: previousDate }).limit(20).get()),
  )
  const recentNames = new Set(
    previousResults.flatMap((result) => result.data)
      .filter((item) => item.partnerOpenid === contentOpenid && item.partnerName)
      .map((item) => item.partnerName),
  )
  const candidates = getPartnerNameCandidates(recentNames)
  const content = {
    partnerOpenid: contentOpenid,
    date,
    city: FIXED_SETTINGS.city,
    partnerName: randomItem(candidates.length ? candidates : PARTNER_NAMES),
    loveText: randomItem(LOVE_TEXTS),
    ...buildCompanionContent(settings, weather, date),
    status: "prepared",
    createdAt: db.serverDate(),
  }
  if (hasWeatherSnapshotForDate(weather, date)) content.weather = weather
  await db.collection(DAILY).doc(dailyId).set({ data: content })
  return { ...content, _id: dailyId }
}

const hasWeatherSnapshot = (weather) => {
  if (!weather || typeof weather !== "object") return false
  if (weather.fallback === true) return false
  const hasText = ["date", "condition", "clothing"]
    .every((key) => String(weather[key] || "").trim())
  const hasNumbers = ["min", "max", "rain"].every((key) => Number.isFinite(Number(weather[key])))
  return hasText && hasNumbers
}

const hasWeatherSnapshotForDate = (weather, date) =>
  hasWeatherSnapshot(weather) && weather.date === date

const getCachedWeather = (dailyContent, date) => {
  const weather = dailyContent?.weather
  return hasWeatherSnapshotForDate(weather, date) ? weather : null
}

const getDailyContentForDate = async (settings, date) => {
  const contentOpenid = settings.partnerOpenid || settings.ownerOpenid
  if (!contentOpenid) return null
  const result = await db.collection(DAILY).where({ _id: `${date}_${contentOpenid}` }).limit(1).get()
  return result.data[0] || null
}

const getClothingAdvice = (min, max, rain) => {
  if (max <= 8) return "羽绒服或厚外套，围巾也带上"
  if (max <= 15) return "毛衣配外套，早晚注意保暖"
  if (max <= 22) return "长袖或薄外套，体感比较舒服"
  if (max <= 28) return rain >= 50 ? "短袖加轻薄外套，记得带伞" : "短袖或薄长袖，早晚可备外套"
  return rain >= 50 ? "轻薄短袖，注意防晒并带伞" : "清凉短袖，注意补水和防晒"
}

const fetchWeatherFromOpenMeteo = async (settings) => {
  const params = new URLSearchParams({
    latitude: String(settings.latitude),
    longitude: String(settings.longitude),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "Asia/Shanghai",
    forecast_days: "1",
  })
  const json = await requestJson(`https://api.open-meteo.com/v1/forecast?${params.toString()}`)
  const daily = json.daily || {}
  const code = Number(daily.weather_code?.[0])
  const min = Number(daily.temperature_2m_min?.[0])
  const max = Number(daily.temperature_2m_max?.[0])
  const rain = Number(daily.precipitation_probability_max?.[0] || 0)
  if (![code, min, max, rain].every(Number.isFinite)) throw new Error("天气数据格式异常")
  const [condition, note] = weatherMap[code] || ["天气多变", "出门前再看一眼天空"]
  return {
    date: daily.time?.[0] || "",
    condition,
    note,
    min,
    max,
    rain,
    clothing: getClothingAdvice(min, max, rain),
  }
}

const fallbackWeather = (err) => ({
  date: getShanghaiDate(),
  condition: "天气多变",
  note: "天气接口暂时不稳定，出门前再看一眼天空",
  min: "--",
  max: "--",
  rain: "--",
  clothing: "今天先按体感穿，出门前再看一眼实时天气",
  fallback: true,
  error: trimError(err),
})

const fetchWeather = async (settings) => {
  let lastError = null
  for (let attempt = 1; attempt <= WEATHER_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await fetchWeatherFromOpenMeteo(settings)
    } catch (err) {
      lastError = err
      console.warn("weather fetch failed", { attempt, error: trimError(err) })
    }
  }
  return fallbackWeather(lastError)
}

const getProfile = async (openid) => {
  const user = await getUser(openid)
  if (user?.role === "owner") {
    const owner = await getOwner()
    if (!owner || owner._id !== user._id) throw new Error("主人账号状态异常")
  }
  if (user && !["owner", "partner"].includes(user.role)) throw new Error("账号角色状态异常")
  if (user?.role === "partner") {
    const settings = await getSettings()
    if (!canAccessMorningAsMember({ user, settings, openid })) {
      return { role: "unbound", bound: false }
    }
  }
  return { role: user?.role || "unbound", bound: Boolean(user) }
}

const toPublicSettings = (settings, dailyContent, { includeContentLists = true } = {}) => {
  const publicSettings = {
    partnerName: dailyContent.partnerName,
    city: FIXED_SETTINGS.city,
    anniversary: FIXED_SETTINGS.anniversary,
    firstDate: FIXED_SETTINGS.firstDate,
    loveText: dailyContent.loveText,
    careItems: Array.isArray(dailyContent.careItems) ? dailyContent.careItems : [],
    memoryText: dailyContent.memoryText || "",
    meetingWish: dailyContent.meetingWish || "",
    comfortText: dailyContent.comfortText || "",
    templateId: settings.templateId,
    reminderEnabled: settings.reminderEnabled,
  }
  if (includeContentLists) {
    publicSettings.memoryFragments = getMemoryFragments(settings)
    publicSettings.meetingWishes = getMeetingWishes(settings)
    publicSettings.littleThings = getLittleThings(settings)
  }
  return publicSettings
}

const getTransactionBindingContext = async (transaction, ownerOpenid) => {
  const ownerResult = await transaction.collection(USERS).where({
    role: "owner",
    status: "active",
  }).limit(2).get()
  if (ownerResult.data.length !== 1 || ownerResult.data[0].openid !== ownerOpenid) {
    throw new Error("主人账号状态异常")
  }

  const settingsResult = await transaction.collection(SETTINGS).where({ ownerOpenid }).limit(2).get()
  if (settingsResult.data.length > 1) throw new Error("专属设置数据异常")

  const activePartnerResult = await transaction.collection(USERS).where({
    role: "partner",
    status: "active",
  }).limit(MAX_ACTIVE_BINDING_RECORDS + 1).get()
  if (activePartnerResult.data.length > MAX_ACTIVE_BINDING_RECORDS) {
    throw new Error("活跃专属账号数量异常，请先人工核验")
  }

  return {
    owner: ownerResult.data[0],
    settings: settingsResult.data[0] || null,
    activePartners: activePartnerResult.data,
  }
}

const getActiveOwnerInvites = async (transaction, ownerOpenid) => {
  const result = await transaction.collection(INVITES).where({ ownerOpenid, active: true })
    .limit(MAX_ACTIVE_BINDING_RECORDS + 1)
    .get()
  if (result.data.length > MAX_ACTIVE_BINDING_RECORDS) {
    throw new Error("有效邀请码数量异常，请先人工核验")
  }
  return result.data
}

const touchOwnerBindingGate = async (transaction, owner, now, { settingsCreated = false } = {}) =>
  transaction.collection(USERS).doc(owner._id).update({
    data: {
      ownerBindingRevision: getNextOwnerBindingRevision(owner),
      ownerBindingUpdatedAt: now,
      ...(settingsCreated ? {
        morningSettingsCreationRevision: command.inc(1),
        morningSettingsCreationUpdatedAt: now,
      } : {}),
    },
  })

const touchOwnerSettingsCreationGate = async (transaction, owner, now) =>
  transaction.collection(USERS).doc(owner._id).update({
    data: {
      morningSettingsCreationRevision: command.inc(1),
      morningSettingsCreationUpdatedAt: now,
    },
  })

const invalidateActiveOwnerInvites = async (transaction, ownerOpenid, now, usedInviteId = "") => {
  const activeInvites = await getActiveOwnerInvites(transaction, ownerOpenid)
  let usedInviteFound = !usedInviteId
  for (const activeInvite of activeInvites) {
    const data = {
      active: false,
      invalidatedAt: now,
    }
    if (activeInvite._id === usedInviteId) {
      usedInviteFound = true
      data.usedAt = now
      delete data.invalidatedAt
    }
    await transaction.collection(INVITES).doc(activeInvite._id).update({ data })
  }
  if (!usedInviteFound) throw new Error("绑定码状态已变化，请重新扫码")
}

const throwPartnerBindingDecisionError = (decision) => {
  const messages = {
    caller_openid_missing: "无法识别当前微信用户",
    caller_already_active: "当前账号已完成绑定",
    caller_role_invalid: "账号角色状态异常，请人工核验",
    active_partner_data_invalid: "活跃专属账号数据异常，请人工核验",
    invite_missing: "绑定码无效或已过期",
    invite_inactive: "绑定码无效或已过期",
    invite_already_used: "绑定码已被使用",
    invite_expired: "绑定码无效或已过期",
    owner_not_active: "主人账号状态异常",
    owner_self_binding: "主人账号不能绑定为伴侣",
    active_partner_exists: "专属账号已经绑定",
    settings_partner_exists: "专属账号已经绑定",
  }
  throw new Error(messages[decision.reason] || "绑定状态异常")
}

const createInvite = async (openid) => {
  const owner = await requireRole(openid, ["owner"])
  const expectedOwnerBindingRevision = readOwnerBindingRevision(owner)
  const token = crypto.randomBytes(12).toString("hex")
  const code = token
  const inviteId = crypto.randomBytes(12).toString("hex")
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000

  // 草稿从创建起就不能用于绑定；二维码、上传或后续事务任一步失败时，最多留下不可用草稿。
  await db.collection(INVITES).add({
    data: {
      _id: inviteId,
      ownerOpenid: openid,
      code,
      token,
      active: false,
      expiresAt,
      qrFileId: "",
      ownerBindingRevision: expectedOwnerBindingRevision,
      createdAt: new Date(),
    },
  })

  // 二维码和文件上传是不可重试的外部副作用，必须在事务外完成。
  const qrResult = await cloud.openapi.wxacode.getUnlimited({
    scene: token,
    page: "pages/bindPartner/bindPartner",
    checkPath: false,
    envVersion: ["develop", "trial", "release"].includes(process.env.MINI_PROGRAM_VERSION)
      ? process.env.MINI_PROGRAM_VERSION
      : "release",
    width: 430,
  })
  const cloudPath = `morning-invites/${inviteId}.png`
  const uploadResult = await cloud.uploadFile({ cloudPath, fileContent: qrResult.buffer })
  if (!uploadResult?.fileID) throw new Error("二维码上传失败")
  const urlResult = await cloud.getTempFileURL({ fileList: [uploadResult.fileID] })
  const qrUrl = urlResult.fileList?.[0]?.tempFileURL || ""
  if (!qrUrl) throw new Error("二维码临时地址生成失败")

  await db.runTransaction(async (transaction) => {
    const context = await getTransactionBindingContext(transaction, openid)
    const draftResult = await transaction.collection(INVITES).doc(inviteId).get()
    const draft = draftResult.data || null
    if (context.owner._id !== owner._id || context.activePartners.length || context.settings?.partnerOpenid) {
      throw new Error("专属账号已经绑定，请先解除当前绑定")
    }
    if (readOwnerBindingRevision(context.owner) !== expectedOwnerBindingRevision) {
      throw new Error("绑定状态已变化，请重新生成二维码")
    }
    if (
      !draft
      || draft.ownerOpenid !== openid
      || draft.active !== false
      || draft.code !== code
      || draft.token !== token
      || Number(draft.expiresAt) !== expiresAt
      || draft.expiresAt <= Date.now()
    ) {
      throw new Error("绑定码草稿状态已变化，请重新生成二维码")
    }
    const now = new Date()
    const nextOwnerBindingRevision = getNextOwnerBindingRevision(context.owner)
    await invalidateActiveOwnerInvites(transaction, openid, now)
    await transaction.collection(INVITES).doc(inviteId).update({
      data: {
        active: true,
        qrFileId: uploadResult.fileID,
        ownerBindingRevision: nextOwnerBindingRevision,
        activatedAt: now,
      },
    })
    await touchOwnerBindingGate(transaction, context.owner, now)
  })

  return { code, token, expiresAt, qrFileId: uploadResult.fileID, qrUrl }
}

const bindPartner = async (openid, code, token) => {
  const existing = await getUser(openid)
  if (existing) {
    if (existing.role === "owner") {
      await requireRole(openid, ["owner"])
      return { role: "owner" }
    }
    if (existing.role !== "partner") throw new Error("账号角色状态异常，请人工核验")
    const settings = await getSettings()
    if (canAccessMorningAsMember({ user: existing, settings, openid })) return { role: "partner" }
    throw new Error("当前账号不是已绑定的专属账号，请让主人先解除后重新绑定")
  }

  const inviteToken = String(token || code || "").trim().toLowerCase()
  if (!/^[0-9a-f]{24}$/.test(inviteToken)) throw new Error("绑定码无效或已过期")
  const query = { token: inviteToken, active: true }
  const result = await db.collection(INVITES).where(query).limit(2).get()
  if (result.data.length > 1) throw new Error("绑定码不唯一，请使用二维码或重新生成")
  const candidateInvite = result.data[0]
  if (!candidateInvite?._id) throw new Error("绑定码无效或已过期")

  return db.runTransaction(async (transaction) => {
    const inviteResult = await transaction.collection(INVITES).doc(candidateInvite._id).get()
    const invite = inviteResult.data || null
    const context = invite?.ownerOpenid
      ? await getTransactionBindingContext(transaction, invite.ownerOpenid)
      : { owner: null, settings: null, activePartners: [] }
    const callerResult = await transaction.collection(USERS).where({ openid, status: "active" }).limit(2).get()
    if (callerResult.data.length > 1) throw new Error("账号数据异常")
    const caller = callerResult.data[0] || null
    const decision = getPartnerBindingDecision({
      invite,
      callerOpenid: openid,
      caller,
      owner: context.owner,
      activePartners: context.activePartners,
      settings: context.settings,
      now: Date.now(),
    })
    if (!decision.allowed) {
      if (decision.reason === "caller_already_active" && decision.role !== "partner") {
        return { role: decision.role }
      }
      if (decision.reason === "caller_already_active" && canAccessMorningAsMember({
        user: caller,
        settings: context.settings,
        openid,
      })) {
        return { role: "partner" }
      }
      throwPartnerBindingDecisionError(decision)
    }
    const revisionDecision = getInviteOwnerBindingRevisionDecision(invite, context.owner)
    if (!revisionDecision.allowed) {
      throw new Error("绑定码状态已变化，请重新扫码")
    }

    const now = new Date()
    await transaction.collection(USERS).add({
      data: { openid, role: "partner", status: "active", createdAt: now },
    })
    await invalidateActiveOwnerInvites(transaction, invite.ownerOpenid, now, invite._id)
    if (context.settings?._id) {
      await transaction.collection(SETTINGS).doc(context.settings._id).update({
        data: { partnerOpenid: openid, updatedAt: now },
      })
    } else {
      await transaction.collection(SETTINGS).add({
        data: {
          ...DEFAULT_SETTINGS,
          ownerOpenid: invite.ownerOpenid,
          partnerOpenid: openid,
          subscriptionCount: 0,
          updatedAt: now,
        },
      })
      await touchOwnerBindingGate(transaction, context.owner, now, { settingsCreated: true })
      return { role: "partner" }
    }
    await touchOwnerBindingGate(transaction, context.owner, now)
    return { role: "partner" }
  })
}

const unbindPartner = async (ownerOpenid, confirmed) =>
  db.runTransaction(async (transaction) => {
    const context = await getTransactionBindingContext(transaction, ownerOpenid)
    const decision = getUnbindPartnerDecision(context)
    if (!decision.allowed) throw new Error("绑定关系数据异常，请先人工核验")
    const { alreadyUnbound } = decision

    if (alreadyUnbound && !confirmed) {
      return { success: true, alreadyUnbound: true }
    }
    if (!confirmed) {
      return { success: false, requiresConfirmation: true, partnerBound: true }
    }

    const now = new Date()
    for (const partner of context.activePartners) {
      await transaction.collection(USERS).doc(partner._id).update({
        data: {
          status: "inactive",
          unboundAt: now,
          unboundBy: ownerOpenid,
        },
      })
    }
    if (context.settings?._id) {
      await transaction.collection(SETTINGS).doc(context.settings._id).update({
        data: {
          partnerOpenid: "",
          subscriptionCount: 0,
          unboundAt: now,
          updatedAt: now,
        },
      })
    }
    await invalidateActiveOwnerInvites(transaction, ownerOpenid, now)
    await touchOwnerBindingGate(transaction, context.owner, now)
    return { success: true, alreadyUnbound }
  })

const recordSubscription = async (openid) =>
  db.runTransaction(async (transaction) => {
    const callerResult = await transaction.collection(USERS).where({ openid, status: "active" }).limit(2).get()
    if (callerResult.data.length !== 1 || callerResult.data[0].role !== "partner") {
      throw new Error("无权执行此操作")
    }
    const ownerResult = await transaction.collection(USERS).where({
      role: "owner",
      status: "active",
    }).limit(2).get()
    if (ownerResult.data.length !== 1) throw new Error("主人账号状态异常")
    const settingsResult = await transaction.collection(SETTINGS).where({
      ownerOpenid: ownerResult.data[0].openid,
    }).limit(2).get()
    if (settingsResult.data.length !== 1) throw new Error("请先完成专属设置")

    const user = callerResult.data[0]
    const settings = settingsResult.data[0]
    if (!canAccessMorningAsMember({ user, settings, openid })) {
      throw new Error("当前账号不是已绑定的早安成员")
    }
    await transaction.collection(SETTINGS).doc(settings._id).update({
      data: {
        subscriptionCount: command.inc(1),
        subscribedAt: new Date(),
      },
    })
    return { success: true }
  })

const getReminderLogs = async () => {
  const result = await db.collection(DAILY)
    .where({ channel: REMINDER_LOG_CHANNEL })
    .orderBy("createdAt", "desc")
    .limit(10)
    .get()
  return {
    logs: result.data.map((item) => ({
      mode: item.mode || "",
      sendStrategy: item.sendStrategy || "",
      transport: item.transport || "",
      status: item.status || "",
      reason: item.reason || "",
      date: item.date || "",
      checks: item.checks || null,
      subscriptionCountBefore: Number(item.subscriptionCountBefore || 0),
      subscriptionCountAfter: item.subscriptionCountAfter,
      error: item.error || "",
      createdAt: item.createdAt || null,
    })),
  }
}

const getCompanionLists = async (openid, listKey, includeMemoryMetadata) => {
  const { settings } = await requireCurrentMorningMember(openid)
  return selectCompanionLists(settings, listKey, { includeMemoryMetadata })
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) throw new Error("无法识别当前微信用户")

  switch (event.action) {
    case "getProfile":
      return getProfile(OPENID)
    case "getAdminSettings":
      await requireRole(OPENID, ["owner"])
      return toAdminSettings(await getSettings())
    case "getCompanionContentEditor":
      return getCompanionContentEditor(OPENID)
    case "saveSettings":
      await requireRole(OPENID, ["owner"])
      return saveSettings(OPENID, event.values || {}, event.expectedCompanionContentRevision)
    case "saveCompanionContent":
      return saveCompanionContent(OPENID, event.values || {}, event.expectedCompanionContentRevision)
    case "initializeFixedContent":
      await requireRole(OPENID, ["owner"])
      return initializeFixedContent(OPENID)
    case "createInvite":
      return createInvite(OPENID)
    case "bindPartner":
      return bindPartner(OPENID, event.code, event.token)
    case "unbindPartner":
      await requireRole(OPENID, ["owner"])
      return unbindPartner(OPENID, event.confirm === true)
    case "getMorning": {
      const { settings } = await requireCurrentMorningMember(OPENID)
      const date = getShanghaiDate()
      const storedDailyContent = await getDailyContentForDate(settings, date)
      // 推送成功后已保存同日快照：首页复用它，避免重复外网请求超时并保持消息与页面一致。
      const cachedWeather = getCachedWeather(storedDailyContent, date)
      const weather = cachedWeather || await fetchWeather(settings)
      const dailyContent = await getOrCreateDailyContent(settings, date, weather, storedDailyContent)
      return {
        settings: toPublicSettings(settings, dailyContent, {
          includeContentLists: event.includeContentLists !== false,
        }),
        weather,
      }
    }
    case "getCompanionLists":
      return getCompanionLists(OPENID, event.listKey, event.includeMemoryMetadata === true)
    case "recordSubscription":
      return recordSubscription(OPENID)
    case "getReminderLogs":
      await requireRole(OPENID, ["owner"])
      return getReminderLogs()
    default:
      throw new Error("未知操作")
  }
}

exports.__test__ = {
  hasWeatherSnapshot,
  getCachedWeather,
  getMemoryFragmentEntries,
  sanitizeMemoryFragmentInput,
  selectCompanionLists,
  toPublicSettings,
}

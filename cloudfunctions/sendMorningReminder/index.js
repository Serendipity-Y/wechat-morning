const cloud = require("wx-server-sdk")
const https = require("https")

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const command = db.command
const DAILY = "morningDaily"
const LOG_CHANNEL = "miniProgramReminderLog"
const USERS = "appUsers"
const SETTINGS = "morningSettings"
// 免费体验版函数实际只有约 3 秒执行时间；定时发送给天气预留单次受限预算。
const WEATHER_REQUEST_ATTEMPTS = 1
const WEATHER_REQUEST_TIMEOUT_MS = 1200
const TIMER_CLAIM_TTL_MS = 15 * 60 * 1000
const {
  PARTNER_NAME_RECENT_DAYS,
  PARTNER_NAMES,
  LOVE_TEXTS,
  dateOffset,
  randomItem,
  getPartnerNameCandidates,
} = require("./morningContent")

const envValue = (name) => String(process.env[name] || "").trim()

const getMiniProgramAppId = () => envValue("MINI_PROGRAM_APP_ID")

const getMiniProgramAppSecret = () =>
  envValue("MINI_PROGRAM_APP_SECRET") || envValue("WECHAT_MINIPROGRAM_APP_SECRET") || envValue("WX_MINI_PROGRAM_APP_SECRET")

const getMessageTargetState = () => {
  const version = envValue("MINI_PROGRAM_VERSION")
  if (version === "develop") return "developer"
  if (version === "trial") return "trial"
  return "formal"
}

const getSendStrategy = () => (getMiniProgramAppSecret() ? "wechat-http" : "cloud-openapi")

const requestJson = (url, options = {}) =>
  new Promise((resolve, reject) => {
    const requestBody = options.body ? JSON.stringify(options.body) : ""
    const req = https.request(url, {
      method: options.method || "GET",
      timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000,
      headers: requestBody
        ? {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(requestBody),
          }
        : undefined,
    }, (res) => {
      let responseBody = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => { responseBody += chunk })
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`request status ${res.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(responseBody))
        } catch (err) {
          reject(err)
        }
      })
    })
    req.on("timeout", () => req.destroy(new Error("request timeout")))
    req.on("error", reject)
    if (requestBody) req.write(requestBody)
    req.end()
  })

const getShanghaiDate = () =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())

const conditionText = (code) => {
  if (code === 0) return "晴"
  if ([1, 2].includes(code)) return "晴间多云"
  if (code === 3) return "阴"
  if ([45, 48].includes(code)) return "有雾"
  if (code >= 51 && code <= 67) return "有雨"
  if (code >= 71 && code <= 77) return "有雪"
  if (code >= 80 && code <= 82) return "阵雨"
  if (code >= 95) return "雷雨"
  return "天气多变"
}

const clothingText = (max, rain) => {
  if (max <= 8) return "厚外套，注意保暖"
  if (max <= 15) return "毛衣配外套"
  if (max <= 22) return "长袖或薄外套"
  if (max <= 28) return rain >= 50 ? "短袖，记得带伞" : "短袖，可备薄外套"
  return rain >= 50 ? "清凉短袖并带伞" : "清凉短袖，注意防晒"
}

const getWeatherFromOpenMeteo = async (settings) => {
  const params = new URLSearchParams({
    latitude: String(settings.latitude),
    longitude: String(settings.longitude),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "Asia/Shanghai",
    forecast_days: "1",
  })
  const json = await requestJson(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
    timeoutMs: WEATHER_REQUEST_TIMEOUT_MS,
  })
  const daily = json.daily || {}
  const code = Number(daily.weather_code?.[0])
  const min = Number(daily.temperature_2m_min?.[0])
  const max = Number(daily.temperature_2m_max?.[0])
  const rain = Number(daily.precipitation_probability_max?.[0] || 0)
  if (![code, min, max, rain].every(Number.isFinite)) throw new Error("天气数据格式异常")
  return { date: daily.time?.[0] || "", condition: conditionText(code), min, max, rain, clothing: clothingText(max, rain) }
}

const trimWeatherError = (err) => String(err?.message || err || "").slice(0, 160)

const fallbackWeather = (err) => ({
  date: getShanghaiDate(),
  condition: "天气多变",
  min: "--",
  max: "--",
  rain: "--",
  clothing: "出门前再看一眼天气",
  fallback: true,
  error: trimWeatherError(err),
})

const getWeather = async (settings) => {
  let lastError = null
  for (let attempt = 1; attempt <= WEATHER_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await getWeatherFromOpenMeteo(settings)
    } catch (err) {
      lastError = err
      console.warn("weather fetch failed", { attempt, error: trimWeatherError(err) })
    }
  }
  return fallbackWeather(lastError)
}

const hasWeatherSnapshot = (weather) => {
  if (!weather || typeof weather !== "object" || weather.fallback === true) return false
  const hasText = ["date", "condition", "clothing"]
    .every((key) => String(weather[key] || "").trim())
  const hasNumbers = ["min", "max", "rain"].every((key) => Number.isFinite(Number(weather[key])))
  return hasText && hasNumbers
}

const getCachedWeather = (dailyContent, date) => {
  const weather = dailyContent?.weather
  return hasWeatherSnapshot(weather) && weather.date === date ? weather : null
}

const trimThing = (value) => String(value || "").slice(0, 20)
const trimLog = (value, length = 300) => String(value || "").slice(0, length)

const getMode = (event = {}) => {
  if (event.diagnose === true) return "diagnose"
  if (event.manual === true) return "manual"
  return "timer"
}

const assertCaller = async (mode) => {
  const { OPENID } = cloud.getWXContext()
  if (mode === "timer") {
    if (OPENID || process.env.TRIGGER_SRC !== "timer") {
      throw new Error("定时发送仅允许云平台定时触发器调用")
    }
    return
  }
  if (!OPENID) throw new Error("仅主人账号可以测试推送")
  const ownerResult = await db.collection("appUsers").where({
    openid: OPENID,
    role: "owner",
    status: "active",
  }).limit(2).get()
  if (ownerResult.data.length !== 1) throw new Error("仅主人账号可以测试推送")
}

const buildChecks = (settings, mode) => {
  const checks = {
    reminderEnabled: Boolean(settings && settings.reminderEnabled !== false),
    partnerBound: Boolean(settings?.partnerOpenid),
    templateConfigured: Boolean(settings?.templateId),
    subscriptionAvailable: Number(settings?.subscriptionCount || 0) > 0,
    timerCredentialConfigured: Boolean(getMiniProgramAppSecret() ? getMiniProgramAppId() : mode === "manual"),
  }
  const missing = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)
  return { checks, missing }
}

const getActiveOwnerSettings = async () => {
  const ownerResult = await db.collection(USERS).where({
    role: "owner",
    status: "active",
  }).limit(2).get()
  if (ownerResult.data.length > 1) throw new Error("主人账号状态异常")
  const owner = ownerResult.data[0]
  if (!owner) return null

  const settingsResult = await db.collection(SETTINGS).where({
    ownerOpenid: owner.openid,
  }).limit(2).get()
  if (settingsResult.data.length > 1) throw new Error("早安设置状态异常")
  const settings = settingsResult.data[0]
  return settings ? { ...settings, ownerOpenid: owner.openid } : null
}

const getMiniProgramAccessToken = async () => {
  const secret = getMiniProgramAppSecret()
  if (!getMiniProgramAppId()) throw new Error("missing MINI_PROGRAM_APP_ID")
  if (!secret) throw new Error("missing MINI_PROGRAM_APP_SECRET")

  const params = new URLSearchParams({
    grant_type: "client_credential",
    appid: getMiniProgramAppId(),
    secret,
  })
  const result = await requestJson(`https://api.weixin.qq.com/cgi-bin/token?${params.toString()}`)
  if (!result.access_token) {
    throw new Error(`获取小程序 access_token 失败：${result.errcode || "unknown"} ${result.errmsg || ""}`.trim())
  }
  return result.access_token
}

const messageData = (settings, weather, dailyContent) => ({
  time1: { value: `${weather.date} 07:30:00` },
  thing2: { value: trimThing(`${dailyContent.partnerName}，${settings.city}${weather.condition}，${weather.min}~${weather.max}℃`) },
  thing3: { value: trimThing(weather.clothing || clothingText(weather.max, weather.rain)) },
})

const sendSubscribeMessageByHttp = async (settings, weather, dailyContent) => {
  const accessToken = await getMiniProgramAccessToken()
  const result = await requestJson(
    `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: "POST",
      body: {
        touser: settings.partnerOpenid,
        template_id: settings.templateId,
        page: "pages/morningHome/morningHome",
        miniprogram_state: getMessageTargetState(),
        lang: "zh_CN",
        data: messageData(settings, weather, dailyContent),
      },
    },
  )
  if (Number(result.errcode || 0) !== 0) {
    throw new Error(`订阅消息 HTTP 发送失败：${result.errcode} ${result.errmsg || ""}`.trim())
  }
  return { transport: "wechat-http" }
}

const sendSubscribeMessageByCloudOpenapi = async (settings, weather, dailyContent) => {
  await cloud.openapi.subscribeMessage.send({
    touser: settings.partnerOpenid,
    page: "pages/morningHome/morningHome",
    templateId: settings.templateId,
    miniprogramState: getMessageTargetState(),
    lang: "zh_CN",
    data: messageData(settings, weather, dailyContent),
  })
  return { transport: "cloud-openapi" }
}

const sendSubscribeMessage = (settings, weather, dailyContent) => {
  if (getMiniProgramAppSecret()) {
    return sendSubscribeMessageByHttp(settings, weather, dailyContent)
  }
  return sendSubscribeMessageByCloudOpenapi(settings, weather, dailyContent)
}

const saveLog = async (data) => {
  try {
    await db.collection(DAILY).add({
      data: {
        ...data,
        channel: LOG_CHANNEL,
        createdAt: db.serverDate(),
      },
    })
  } catch (err) {
    console.error("save morning reminder log failed", err)
  }
}

const getOrCreateDailyContent = async (settings, date) => {
  const partnerNames = PARTNER_NAMES
  const loveTexts = LOVE_TEXTS
  if (!partnerNames.length || loveTexts.length !== 30) {
    throw new Error("早安随机内容尚未初始化")
  }

  const dailyId = `${date}_${settings.partnerOpenid}`
  const todayResult = await db.collection(DAILY).where({ _id: dailyId }).limit(1).get()
  const existing = todayResult.data[0]
  if (existing) {
    if (!existing.loveText || !loveTexts.includes(existing.loveText)) {
      const loveText = randomItem(loveTexts)
      await db.collection(DAILY).doc(dailyId).update({
        data: { loveText, updatedAt: db.serverDate() },
      })
      return { ...existing, loveText }
    }
    return existing
  }

  const previousResults = await Promise.all(
    Array.from({ length: PARTNER_NAME_RECENT_DAYS }, (_, index) => dateOffset(date, -(index + 1)))
      .map((previousDate) => db.collection(DAILY).where({ date: previousDate }).limit(20).get()),
  )
  const recentNames = new Set(
    previousResults.flatMap((result) => result.data)
      .filter((item) => item.partnerOpenid === settings.partnerOpenid && item.partnerName)
      .map((item) => item.partnerName),
  )
  const candidates = getPartnerNameCandidates(recentNames)
  const content = {
    partnerOpenid: settings.partnerOpenid,
    date,
    city: settings.city,
    partnerName: randomItem(candidates.length ? candidates : partnerNames),
    loveText: randomItem(loveTexts),
    status: "prepared",
    createdAt: db.serverDate(),
  }
  await db.collection(DAILY).doc(dailyId).set({ data: content })
  return { ...content, _id: dailyId }
}

const getTimerClaimDecision = (dailyContent, now = Date.now()) => {
  if (dailyContent?.status === "sent") return { claimed: false, reason: "already sent today" }
  if (dailyContent?.status !== "sending") return { claimed: true }

  const sendingAt = new Date(dailyContent.sendingAt).getTime()
  if (Number.isFinite(sendingAt) && now - sendingAt < TIMER_CLAIM_TTL_MS) {
    return { claimed: false, reason: "send already in progress" }
  }
  return { claimed: true, recovered: true }
}

const claimTimerSend = async (dailyId) =>
  db.runTransaction(async (transaction) => {
    const result = await transaction.collection(DAILY).doc(dailyId).get()
    const dailyContent = result.data
    if (!dailyContent) throw new Error("missing daily reminder content")

    const decision = getTimerClaimDecision(dailyContent)
    if (!decision.claimed) return decision

    await transaction.collection(DAILY).doc(dailyId).update({
      data: {
        status: "sending",
        sendingAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    })
    return { ...decision, dailyContent: { ...dailyContent, _id: dailyId } }
  })

exports.main = async (event = {}) => {
  const mode = getMode(event)
  await assertCaller(mode)

  const settings = await getActiveOwnerSettings()
  const { checks, missing } = buildChecks(settings, mode)
  const baseLog = {
    mode,
    sendStrategy: getSendStrategy(),
    partnerOpenid: settings?.partnerOpenid || "",
    subscriptionCountBefore: Number(settings?.subscriptionCount || 0),
    checks,
  }

  if (missing.length) {
    const reason = `missing ${missing.join(", ")}`
    await saveLog({ ...baseLog, status: "skipped", reason })
    return { sent: false, mode, reason, checks, subscriptionCount: Number(settings?.subscriptionCount || 0) }
  }

  if (mode === "diagnose") {
    const weather = await getWeather(settings)
    await saveLog({ ...baseLog, status: "diagnosed", date: weather.date, weather })
    return {
      sent: false,
      mode,
      wouldSend: true,
      date: weather.date,
      checks,
      subscriptionCount: Number(settings.subscriptionCount || 0),
      weather,
    }
  }

  const date = getShanghaiDate()
  let dailyContent = await getOrCreateDailyContent(settings, date)
  if (mode === "timer") {
    const claim = await claimTimerSend(dailyContent._id)
    if (!claim.claimed) {
      await saveLog({ ...baseLog, status: "skipped", reason: claim.reason, date, dailyId: dailyContent._id })
      return { sent: false, mode, reason: claim.reason, date }
    }
    dailyContent = claim.dailyContent
  }

  const cachedWeather = getCachedWeather(dailyContent, date)
  const weather = cachedWeather || await getWeather(settings)
  const freshWeatherSnapshot = !cachedWeather && hasWeatherSnapshot(weather)

  if (mode !== "timer") {
    await db.collection(DAILY).doc(dailyContent._id).update({
      data: {
        status: "sending",
        sendingAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    })
  }
  await saveLog({ ...baseLog, status: "sending", date: weather.date, dailyId: dailyContent._id, weather })

  try {
    const sendResult = await sendSubscribeMessage(settings, weather, dailyContent)
    await saveLog({ ...baseLog, status: "sent_transport", date: weather.date, dailyId: dailyContent._id, transport: sendResult.transport })
  } catch (err) {
    const error = trimLog(err.message || err)
    await db.collection(DAILY).doc(dailyContent._id).update({
      data: { status: "failed", error, failedAt: db.serverDate() },
    })
    await saveLog({ ...baseLog, status: "failed", date: weather.date, dailyId: dailyContent._id, error })
    throw err
  }

  await db.collection(SETTINGS).doc(settings._id).update({
    data: {
      subscriptionCount: command.inc(-1),
      lastSentAt: db.serverDate(),
    },
  })
  await db.collection(DAILY).doc(dailyContent._id).update({
    data: {
      status: "sent",
      sentAt: db.serverDate(),
      ...(freshWeatherSnapshot ? { weather } : {}),
    },
  })
  await saveLog({
    ...baseLog,
    status: "sent",
    date: weather.date,
    dailyId: dailyContent._id,
    subscriptionCountAfter: Number(settings.subscriptionCount || 0) - 1,
  })
  return {
    sent: true,
    mode,
    date: weather.date,
    partnerName: dailyContent.partnerName,
    loveText: dailyContent.loveText,
  }
}

exports.__test__ = {
  getTimerClaimDecision,
  hasWeatherSnapshot,
  getCachedWeather,
  weatherRequestPolicy: {
    attempts: WEATHER_REQUEST_ATTEMPTS,
    timeoutMs: WEATHER_REQUEST_TIMEOUT_MS,
  },
}

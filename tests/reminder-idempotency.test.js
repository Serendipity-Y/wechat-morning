const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const {
  getTimerClaimDecision,
  getCachedWeather,
  weatherRequestPolicy,
} = require("../cloudfunctions/sendMorningReminder").__test__

test("scheduled reminder skips a successfully sent day", () => {
  assert.deepEqual(getTimerClaimDecision({ status: "sent" }), {
    claimed: false,
    reason: "already sent today",
  })
})

test("scheduled reminder skips another active send claim", () => {
  const now = Date.parse("2026-07-15T07:30:00+08:00")
  const result = getTimerClaimDecision({
    status: "sending",
    sendingAt: new Date(now - 60 * 1000),
  }, now)

  assert.deepEqual(result, { claimed: false, reason: "send already in progress" })
})

test("an expired send claim is safely recoverable", () => {
  const now = Date.parse("2026-07-15T07:30:00+08:00")
  const result = getTimerClaimDecision({
    status: "sending",
    sendingAt: new Date(now - 16 * 60 * 1000),
  }, now)

  assert.deepEqual(result, { claimed: true, recovered: true })
})

test("scheduled reminder reuses only a complete non-fallback weather snapshot", () => {
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
  assert.equal(getCachedWeather({ weather: { ...weather, clothing: "" } }, "2026-09-05"), null)
})

test("scheduled reminder claims before a cache-miss weather request and keeps a short weather budget", () => {
  const source = fs.readFileSync(path.join(__dirname, "../cloudfunctions/sendMorningReminder/index.js"), "utf8")
  const claimIndex = source.indexOf("const claim = await claimTimerSend(dailyContent._id)")
  const weatherIndex = source.indexOf("const weather = cachedWeather || await getWeather(settings)")

  assert.ok(claimIndex >= 0)
  assert.ok(weatherIndex > claimIndex)
  assert.match(source, /timeoutMs: WEATHER_REQUEST_TIMEOUT_MS/)
  assert.match(source, /sentAt: db\.serverDate\(\),\n      \.\.\.\(freshWeatherSnapshot \? \{ weather \} : \{\}\)/)
  assert.deepEqual(weatherRequestPolicy, { attempts: 1, timeoutMs: 1200 })
})

const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")

const functionPath = path.join(__dirname, "../cloudfunctions/sendMorningReminder")
const cloud = require(require.resolve("wx-server-sdk", { paths: [functionPath] }))
const { main } = require(functionPath)

test("timer mode requires a platform timer without an interactive caller", async (t) => {
  const previousSource = process.env.TRIGGER_SRC
  t.after(() => {
    if (previousSource === undefined) delete process.env.TRIGGER_SRC
    else process.env.TRIGGER_SRC = previousSource
  })

  t.mock.method(cloud, "getWXContext", () => ({}))
  delete process.env.TRIGGER_SRC
  await assert.rejects(main(), /仅允许云平台定时触发器调用/)

  process.env.TRIGGER_SRC = "timer"
  cloud.getWXContext.mock.mockImplementation(() => ({ OPENID: "fixture-member" }))
  await assert.rejects(main(), /仅允许云平台定时触发器调用/)
})

test("interactive reminder modes require an authenticated WeChat identity", async (t) => {
  t.mock.method(cloud, "getWXContext", () => ({}))
  await assert.rejects(main({ manual: true }), /仅主人账号可以测试推送/)
  await assert.rejects(main({ diagnose: true }), /仅主人账号可以测试推送/)
})

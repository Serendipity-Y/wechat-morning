const test = require("node:test")
const assert = require("node:assert/strict")

let pageDefinition
const app = { globalData: {} }
const originalPage = global.Page
const originalGetApp = global.getApp

try {
  global.getApp = () => app
  global.Page = (definition) => { pageDefinition = definition }
  require("../miniprogram/pages/bindPartner/bindPartner.js")
} finally {
  if (originalPage === undefined) delete global.Page
  else global.Page = originalPage
  if (originalGetApp === undefined) delete global.getApp
  else global.getApp = originalGetApp
}

const createContext = () => ({
  data: { code: "", binding: false },
  setData(patch) { Object.assign(this.data, patch) },
})

test("partner binding changes local role only after the cloud function confirms partner", async () => {
  const originalWx = global.wx
  const calls = []
  const launches = []
  app.globalData.role = "unbound"
  global.wx = {
    cloud: {
      callFunction({ data }) {
        calls.push(data)
        return Promise.resolve({ result: { role: "partner" } })
      },
    },
    reLaunch(options) { launches.push(options) },
    showToast() {},
  }

  const context = createContext()
  try {
    await pageDefinition.bindAccount.call(context, "scene-token")
  } finally {
    if (originalWx === undefined) delete global.wx
    else global.wx = originalWx
  }

  assert.deepEqual(calls, [{ action: "bindPartner", code: "", token: "scene-token" }])
  assert.equal(app.globalData.role, "partner")
  assert.deepEqual(launches, [{ url: "/pages/morningHome/morningHome" }])
  assert.equal(context.data.binding, false)
})

test("an existing owner response keeps the confirmed owner role and returns to the owner home", async () => {
  const originalWx = global.wx
  const launches = []
  app.globalData.role = ""
  global.wx = {
    cloud: {
      callFunction() { return Promise.resolve({ result: { role: "owner" } }) },
    },
    reLaunch(options) { launches.push(options) },
    showToast() {},
  }

  const context = createContext()
  try {
    await pageDefinition.bindAccount.call(context, "scene-token")
  } finally {
    if (originalWx === undefined) delete global.wx
    else global.wx = originalWx
  }

  assert.equal(app.globalData.role, "owner")
  assert.deepEqual(launches, [{ url: "/pages/morningAdmin/morningAdmin" }])
  assert.equal(context.data.binding, false)
})

test("unconfirmed or unknown binding responses do not change local role or navigate", async () => {
  const originalWx = global.wx
  const calls = []
  const launches = []
  const toasts = []
  const responses = [undefined, {}, { role: "unbound" }]
  app.globalData.role = "unbound"
  global.wx = {
    cloud: {
      callFunction({ data }) {
        calls.push(data)
        return Promise.resolve({ result: responses.shift() })
      },
    },
    reLaunch(options) { launches.push(options) },
    showToast(options) { toasts.push(options) },
  }

  const originalConsoleError = console.error
  console.error = () => {}
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const context = createContext()
      await pageDefinition.bindAccount.call(context, "scene-token")
      assert.equal(context.data.binding, false)
      assert.equal(app.globalData.role, "unbound")
    }
  } finally {
    console.error = originalConsoleError
    if (originalWx === undefined) delete global.wx
    else global.wx = originalWx
  }

  assert.equal(calls.length, 3)
  assert.deepEqual(launches, [])
  assert.deepEqual(toasts.map((toast) => toast.title), [
    "绑定状态未确认，请重新进入查看",
    "绑定状态未确认，请重新进入查看",
    "绑定状态未确认，请重新进入查看",
  ])
})

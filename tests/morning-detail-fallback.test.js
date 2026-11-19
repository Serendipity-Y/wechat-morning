const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")

const loadPageDefinition = (pageName) => {
  const pagePath = path.join(__dirname, `../miniprogram/pages/${pageName}/${pageName}.js`)
  const originalPage = global.Page
  let definition
  try {
    global.Page = (pageDefinition) => { definition = pageDefinition }
    delete require.cache[require.resolve(pagePath)]
    require(pagePath)
  } finally {
    if (originalPage === undefined) delete global.Page
    else global.Page = originalPage
  }
  return definition
}

const memoryPage = loadPageDefinition("morningMemory")
const wishesPage = loadPageDefinition("meetingWishes")
const littleThingsPage = loadPageDefinition("littleThings")

const withWx = async (callFunction, run) => {
  const originalWx = global.wx
  const toasts = []
  global.wx = {
    cloud: { callFunction },
    showToast(options) { toasts.push(options) },
  }
  try {
    await run(toasts)
  } finally {
    if (originalWx === undefined) delete global.wx
    else global.wx = originalWx
  }
}

const createContext = (listKey) => ({
  data: { loading: true, [listKey]: [] },
  setData(patch) { Object.assign(this.data, patch) },
})

const DETAIL_PAGES = [
  {
    label: "meeting wishes",
    page: wishesPage,
    loader: "loadWishes",
    listKey: "wishes",
    responseKey: "meetingWishes",
    defaultFirst: "一起逛周末市集。",
    toast: "先看默认愿望",
  },
  {
    label: "little things",
    page: littleThingsPage,
    loader: "loadThings",
    listKey: "things",
    responseKey: "littleThings",
    defaultFirst: "早餐给对方留一份。",
    toast: "先看默认小事",
  },
]

const createMemoryContext = () => ({
  data: {
    loading: true,
    memoryGroups: [],
    visibleMemoryGroups: [],
    visibleGroupCount: 5,
    searchText: "",
  },
  setData(patch) { Object.assign(this.data, patch) },
})

test("memory fragments keep legacy entries undated and request metadata only for the new page", async () => {
  const calls = []
  await withWx(
    (request) => {
      calls.push(request)
      return Promise.resolve({ result: { memoryFragments: ["历史记忆"] } })
    },
    async () => {
      const context = createMemoryContext()
      await memoryPage.loadMemories.call(context)
      assert.equal(context.data.loading, false)
      assert.equal(context.data.memoryGroups[0].label, "发布时间未知")
      assert.equal(context.data.visibleMemoryGroups[0].visibleItems[0].text, "历史记忆")
    },
  )
  assert.deepEqual(calls, [{
    name: "morningService",
    data: { action: "getCompanionLists", listKey: "memoryFragments", includeMemoryMetadata: true },
  }])
})

test("memory fragments group server publication timestamps in China time and reveal long groups on demand", async () => {
  const fragments = Array.from({ length: 8 }, (_, index) => `九月十五日记忆 ${index + 1}`)
  const entries = fragments.map((text, index) => ({
    id: `entry-${index}`,
    text,
    publishedAt: "2026-09-14T16:19:48.555Z",
  }))
  await withWx(
    () => Promise.resolve({ result: { memoryFragments: fragments, memoryFragmentEntries: entries } }),
    async () => {
      const context = createMemoryContext()
      await memoryPage.loadMemories.call(context)
      assert.equal(context.data.memoryGroups[0].label, "2026年9月15日")
      assert.equal(context.data.visibleMemoryGroups[0].visibleItems.length, 6)
      memoryPage.showMoreInGroup.call(context, { currentTarget: { dataset: { id: "date-2026-09-15" } } })
      assert.equal(context.data.visibleMemoryGroups[0].visibleItems.length, 8)
      memoryPage.searchMemories.call(context, { detail: { value: "记忆 8" } })
      assert.equal(context.data.matchedMemoryCount, 1)
      assert.equal(context.data.visibleMemoryGroups[0].visibleItems[0].text, "九月十五日记忆 8")
    },
  )
})

test("memory fragments still use visible defaults after a failed load", async () => {
  const originalConsoleError = console.error
  console.error = () => {}
  try {
    await withWx(
      () => Promise.reject(new Error("offline")),
      async (toasts) => {
        const context = createMemoryContext()
        await memoryPage.loadMemories.call(context)
        assert.equal(context.data.loading, false)
        assert.equal(context.data.memoryGroups[0].label, "发布时间未知")
        assert.equal(context.data.visibleMemoryGroups[0].visibleItems[0].text, "散步时遇见了一只晒太阳的猫。")
        assert.equal(toasts.at(-1).title, "先看默认记忆")
      },
    )
  } finally {
    console.error = originalConsoleError
  }
})

DETAIL_PAGES.forEach(({ label, page, loader, listKey, responseKey, defaultFirst, toast }) => {
  test(`${label} show defaults for an empty successful response`, async () => {
    const calls = []
    await withWx(
      (request) => {
        calls.push(request)
        return Promise.resolve({ result: { [responseKey]: [] } })
      },
      async () => {
        const context = createContext(listKey)
        await page[loader].call(context)
        assert.equal(context.data.loading, false)
        assert.equal(context.data[listKey][0], defaultFirst)
      },
    )
    assert.deepEqual(calls, [{
      name: "morningService",
      data: { action: "getCompanionLists", listKey: responseKey },
    }])
  })

  test(`${label} keep returned non-empty content and fall back after a rejection`, async () => {
    await withWx(
      () => Promise.resolve({ result: { [responseKey]: ["云端内容"] } }),
      async () => {
        const context = createContext(listKey)
        await page[loader].call(context)
        assert.deepEqual(context.data[listKey], ["云端内容"])
      },
    )

    const originalConsoleError = console.error
    console.error = () => {}
    try {
      await withWx(
        () => Promise.reject(new Error("offline")),
        async (toasts) => {
          const context = createContext(listKey)
          await page[loader].call(context)
          assert.equal(context.data.loading, false)
          assert.equal(context.data[listKey][0], defaultFirst)
          assert.equal(toasts.at(-1).title, toast)
        },
      )
    } finally {
      console.error = originalConsoleError
    }
  })
})

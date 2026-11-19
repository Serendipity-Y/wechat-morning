const DEFAULT_MEMORIES = [
  "散步时遇见了一只晒太阳的猫。",
  "在旧书店找到一本喜欢的诗集。",
]

const INITIAL_VISIBLE_GROUPS = 5
const INITIAL_VISIBLE_ITEMS = 6
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

const getTimestamp = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime()
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (value && typeof value === "object") {
    if (typeof value.getTime === "function") {
      const timestamp = value.getTime()
      return Number.isFinite(timestamp) ? timestamp : null
    }
    if (typeof value.$date === "number") return value.$date
    if (typeof value.seconds === "number") return value.seconds * 1000
  }
  return null
}

const toShanghaiDate = (value) => {
  const timestamp = getTimestamp(value)
  if (timestamp === null) return null
  const date = new Date(timestamp + SHANGHAI_OFFSET_MS)
  if (Number.isNaN(date.getTime())) return null
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, "0")
  return {
    key: `${year}-${month}-${day}`,
    label: `${year}年${Number(month)}月${Number(day)}日`,
    timestamp,
  }
}

const normalizeMemoryEntries = (memoryFragments, memoryFragmentEntries) => {
  const texts = Array.isArray(memoryFragments) ? memoryFragments : []
  const entries = Array.isArray(memoryFragmentEntries) ? memoryFragmentEntries : []
  return texts.map((value, index) => {
    const text = String(value || "").trim()
    const entry = entries[index]
    if (entry && typeof entry === "object" && String(entry.text || "").trim() === text) {
      return { id: String(entry.id || `legacy-${index}`), text, publishedAt: entry.publishedAt || null }
    }
    return { id: `legacy-${index}`, text, publishedAt: null }
  }).filter((entry) => entry.text)
}

const createMemoryGroups = (entries) => {
  const groups = new Map()
  entries.forEach((entry, index) => {
    const published = toShanghaiDate(entry.publishedAt)
    const id = published ? `date-${published.key}` : "unknown"
    const group = groups.get(id) || {
      id,
      label: published ? published.label : "发布时间未知",
      timestamp: published ? published.timestamp : -1,
      collapsed: true,
      showAllItems: false,
      items: [],
    }
    group.items.push({ ...entry, order: index + 1 })
    groups.set(id, group)
  })
  const result = [...groups.values()].sort((left, right) => right.timestamp - left.timestamp)
  if (result.length) result[0].collapsed = false
  return result
}

const buildMemoryView = ({ groups, searchText, visibleGroupCount }) => {
  const keyword = String(searchText || "").trim().toLowerCase()
  const matchingGroups = groups.map((group) => ({
    ...group,
    matchedItems: keyword ? group.items.filter((item) => item.text.toLowerCase().includes(keyword)) : group.items,
  })).filter((group) => group.matchedItems.length)
  const visibleGroups = (keyword ? matchingGroups : matchingGroups.slice(0, visibleGroupCount)).map((group) => {
    const expanded = keyword || !group.collapsed
    const visibleItems = expanded
      ? group.matchedItems.slice(0, keyword || group.showAllItems ? group.matchedItems.length : INITIAL_VISIBLE_ITEMS)
      : []
    return {
      ...group,
      visibleItems,
      hasMoreItems: expanded && !keyword && !group.showAllItems && group.matchedItems.length > visibleItems.length,
      remainingItemCount: Math.max(0, group.matchedItems.length - visibleItems.length),
    }
  })
  return {
    visibleMemoryGroups: visibleGroups,
    matchedMemoryCount: matchingGroups.reduce((total, group) => total + group.matchedItems.length, 0),
    hasMoreMemoryGroups: !keyword && matchingGroups.length > visibleGroups.length,
  }
}

Page({
  data: {
    loading: true,
    searchText: "",
    memoryGroups: [],
    visibleMemoryGroups: [],
    visibleGroupCount: INITIAL_VISIBLE_GROUPS,
    hasMoreMemoryGroups: false,
    matchedMemoryCount: 0,
  },

  onLoad() {
    this.loadMemories()
  },

  loadMemories() {
    return wx.cloud.callFunction({
      name: "morningService",
      data: { action: "getCompanionLists", listKey: "memoryFragments", includeMemoryMetadata: true },
    })
      .then((res) => {
        const rawMemories = res.result?.memoryFragments
        const memories = Array.isArray(rawMemories) && rawMemories.length ? rawMemories : DEFAULT_MEMORIES
        const groups = createMemoryGroups(normalizeMemoryEntries(memories, res.result?.memoryFragmentEntries))
        const visibleGroupCount = INITIAL_VISIBLE_GROUPS
        this.setData({ memoryGroups: groups, visibleGroupCount, ...buildMemoryView({ groups, searchText: "", visibleGroupCount }) })
      })
      .catch((err) => {
        console.error("load memory fragments failed", err)
        const groups = createMemoryGroups(normalizeMemoryEntries(DEFAULT_MEMORIES, []))
        const visibleGroupCount = INITIAL_VISIBLE_GROUPS
        this.setData({ memoryGroups: groups, visibleGroupCount, ...buildMemoryView({ groups, searchText: "", visibleGroupCount }) })
        wx.showToast({ title: "先看默认记忆", icon: "none" })
      })
      .finally(() => this.setData({ loading: false }))
  },

  searchMemories(e) {
    const searchText = e.detail.value || ""
    const { memoryGroups, visibleGroupCount } = this.data
    this.setData({ searchText, ...buildMemoryView({ groups: memoryGroups, searchText, visibleGroupCount }) })
  },

  toggleMemoryGroup(e) {
    const id = e.currentTarget.dataset.id
    const groups = this.data.memoryGroups.map((group) => (group.id === id ? { ...group, collapsed: !group.collapsed } : group))
    this.setData({ memoryGroups: groups, ...buildMemoryView({ groups, searchText: this.data.searchText, visibleGroupCount: this.data.visibleGroupCount }) })
  },

  showMoreInGroup(e) {
    const id = e.currentTarget.dataset.id
    const groups = this.data.memoryGroups.map((group) => (group.id === id ? { ...group, showAllItems: true, collapsed: false } : group))
    this.setData({ memoryGroups: groups, ...buildMemoryView({ groups, searchText: this.data.searchText, visibleGroupCount: this.data.visibleGroupCount }) })
  },

  loadMoreGroups() {
    const visibleGroupCount = this.data.visibleGroupCount + INITIAL_VISIBLE_GROUPS
    this.setData({ visibleGroupCount, ...buildMemoryView({ groups: this.data.memoryGroups, searchText: this.data.searchText, visibleGroupCount }) })
  },
})

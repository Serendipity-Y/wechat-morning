const DRAG_ROW_HEIGHT_RPX = 132
const TOPPABLE_LIST_KEYS = new Set(["memoryItems", "meetingItems", "littleItems"])
const COMPANION_CONTENT_KEYS = ["memoryFragments", "meetingWishes", "littleThings"]
const REMINDER_DIAGNOSIS_CHECK_KEYS = [
  "reminderEnabled",
  "partnerBound",
  "templateConfigured",
  "subscriptionAvailable",
  "timerCredentialConfigured",
]
const COMPANION_CONTENT_CONFLICT_REASON = "companion_content_revision_conflict"

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value)
const isCompanionContentRevision = (value) => Number.isSafeInteger(value) && value >= 0

const createCompanionContentConflictError = () => {
  const error = new Error("内容已被另一位编辑者更新，请重新加载后合并再保存")
  error.code = COMPANION_CONTENT_CONFLICT_REASON
  return error
}

const requireCompanionContentPayload = (value) => {
  if (
    !isRecord(value)
    || !COMPANION_CONTENT_KEYS.every((key) => Array.isArray(value[key]))
    || !isCompanionContentRevision(value.companionContentRevision)
  ) {
    throw new Error("内容数据格式异常")
  }
  return value
}

const requireAdminSettingsPayload = (value) => {
  const settings = requireCompanionContentPayload(value)
  if (!String(settings.city || "").trim() || typeof settings.templateId !== "string" || typeof settings.reminderEnabled !== "boolean") {
    throw new Error("设置数据格式异常")
  }
  return settings
}

const requireSavedContentPayload = (value, contentEditor, expectedCompanionContentRevision) => {
  if (isRecord(value) && value.saved === false && value.reason === COMPANION_CONTENT_CONFLICT_REASON) {
    if (!isCompanionContentRevision(value.companionContentRevision)) {
      throw new Error("保存结果异常")
    }
    throw createCompanionContentConflictError()
  }

  const result = contentEditor
    ? requireCompanionContentPayload(value)
    : requireAdminSettingsPayload(value)
  if (
    result.saved !== true
    || result.companionContentRevision !== expectedCompanionContentRevision + 1
  ) {
    throw new Error("保存结果异常")
  }
  return result
}

const requireReminderLogsPayload = (value) => {
  if (!isRecord(value) || !Array.isArray(value.logs) || !value.logs.every(isRecord)) {
    throw new Error("日志数据格式异常")
  }
  return value.logs
}

const requireReminderDiagnosisPayload = (value) => {
  if (
    !isRecord(value)
    || value.mode !== "diagnose"
    || value.sent !== false
    || !isRecord(value.checks)
    || !REMINDER_DIAGNOSIS_CHECK_KEYS.every((key) => typeof value.checks[key] === "boolean")
    || !Number.isFinite(value.subscriptionCount)
    || value.subscriptionCount < 0
  ) {
    throw new Error("推送检查结果格式异常")
  }

  const allChecksPassed = REMINDER_DIAGNOSIS_CHECK_KEYS.every((key) => value.checks[key])
  if (value.wouldSend === true) {
    if (!allChecksPassed || typeof value.date !== "string" || !value.date.trim() || !isRecord(value.weather)) {
      throw new Error("推送检查结果格式异常")
    }
    return value
  }

  if ((value.wouldSend === undefined || value.wouldSend === false) && !allChecksPassed && typeof value.reason === "string" && value.reason.trim()) {
    return value
  }
  throw new Error("推送检查结果格式异常")
}

const requireManualReminderPayload = (value) => {
  if (!isRecord(value) || value.sent !== true || value.mode !== "manual") {
    throw new Error("推送结果未确认，请查看已绑定微信和推送日志，暂勿重复发送")
  }
  return value
}

const createListItemId = (index = "") => `${Date.now()}_${index}_${Math.random().toString(16).slice(2)}`

const makeListItems = (list) => (Array.isArray(list) ? list : []).map((text, index) => ({
  id: createListItemId(index),
  text,
}))

const makeMemoryItems = (memoryFragments, memoryFragmentEntries) => {
  const texts = Array.isArray(memoryFragments) ? memoryFragments : []
  const entries = Array.isArray(memoryFragmentEntries) ? memoryFragmentEntries : []
  return texts.map((value, index) => {
    const text = String(value || "")
    const entry = entries[index]
    if (entry && typeof entry === "object" && String(entry.text || "") === text) {
      return {
        id: String(entry.id || createListItemId(index)),
        text,
        legacy: entry.legacy === true || !entry.publishedAt,
      }
    }
    return { id: createListItemId(index), text, legacy: true }
  })
}

const parseMemoryItems = (items) => {
  const seen = {}
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      id: String(item.id || ""),
      text: String(item.text || "").trim(),
      legacy: item.legacy === true,
    }))
    .filter((item) => {
      if (!item.text || seen[item.text]) return false
      seen[item.text] = true
      return true
    })
}

const splitSettingsAndContent = (source) => {
  const raw = source && typeof source === "object" ? source : {}
  const {
    memoryFragments = [],
    memoryFragmentEntries = [],
    meetingWishes = [],
    littleThings = [],
    companionContentRevision = null,
    saved,
    ...settings
  } = raw
  return {
    settings,
    companionContentRevision,
    memoryItems: makeMemoryItems(memoryFragments, memoryFragmentEntries),
    meetingItems: makeListItems(meetingWishes),
    littleItems: makeListItems(littleThings),
  }
}

Page({
  data: {
    loading: true,
    loadError: "",
    saving: false,
    saveConflict: false,
    saveConflictRefreshing: false,
    saveConflictRefreshError: "",
    companionContentRevision: null,
    contentEditor: false,
    unbinding: false,
    testingReminder: false,
    diagnosingReminder: false,
    logsLoading: false,
    logsLoaded: false,
    logsLoadError: "",
    logsCollapsed: true,
    settings: {
      city: "北京市",
      anniversary: "2024-01-01",
      firstDate: "2024-02-01",
      templateId: "",
      reminderEnabled: true,
    },
    memoryItems: [],
    meetingItems: [],
    littleItems: [],
    collapsedSections: {
      memoryItems: true,
      meetingItems: true,
      littleItems: true,
    },
    dragState: null,
    reminderLogs: [],
    invite: null,
    partnerBound: false,
  },

  onLoad(options = {}) {
    const contentEditor = options.contentEditor === "1"
    this.setData({ contentEditor })
    if (contentEditor) {
      this.loadContentEditor()
      return
    }
    this.loadSettings()
  },

  loadContentEditor({ preserveDraft = false } = {}) {
    return wx.cloud.callFunction({ name: "morningService", data: { action: "getCompanionContentEditor" } })
      .then((res) => {
        const content = splitSettingsAndContent(requireCompanionContentPayload(res?.result))
        this.setData({
          ...content,
          loading: false,
          loadError: "",
          saveConflict: false,
          saveConflictRefreshing: false,
          saveConflictRefreshError: "",
        })
      })
      .catch((err) => {
        console.error("load companion content editor failed", err)
        if (preserveDraft) {
          this.setData({
            saveConflictRefreshing: false,
            saveConflictRefreshError: "最新内容加载失败，当前草稿仍未保存",
          })
          wx.showToast({ title: "最新内容加载失败", icon: "none" })
          return
        }
        this.setData({ loading: false, loadError: "内容加载失败，请检查网络后重试" })
        wx.showToast({ title: "内容加载失败", icon: "none" })
      })
  },

  loadSettings({ preserveDraft = false } = {}) {
    return wx.cloud.callFunction({ name: "morningService", data: { action: "getAdminSettings" } })
      .then((res) => {
        const content = splitSettingsAndContent(requireAdminSettingsPayload(res?.result))
        this.setData({
          ...content,
          partnerBound: Boolean(content.settings.partnerOpenid),
          loading: false,
          loadError: "",
          saveConflict: false,
          saveConflictRefreshing: false,
          saveConflictRefreshError: "",
        })
      })
      .catch((err) => {
        console.error("load morning settings failed", err)
        if (preserveDraft) {
          this.setData({
            saveConflictRefreshing: false,
            saveConflictRefreshError: "最新内容加载失败，当前草稿仍未保存",
          })
          wx.showToast({ title: "最新内容加载失败", icon: "none" })
          return
        }
        this.setData({ loading: false, loadError: "设置加载失败，请检查网络后重试" })
        wx.showToast({ title: "设置加载失败", icon: "none" })
      })
  },

  retryLoad() {
    if (this.data.loading || this.data.saveConflictRefreshing) return Promise.resolve()
    const preserveDraft = this.data.saveConflict
    if (preserveDraft) {
      this.setData({ saveConflictRefreshing: true, saveConflictRefreshError: "" })
    } else {
      this.setData({ loading: true, loadError: "" })
    }
    return this.data.contentEditor
      ? this.loadContentEditor({ preserveDraft })
      : this.loadSettings({ preserveDraft })
  },

  updateField(e) {
    if (this.data.saving || this.data.saveConflictRefreshing) return
    const field = e.currentTarget.dataset.field
    this.setData({ [`settings.${field}`]: e.detail.value })
  },

  toggleSection(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    this.setData({ [`collapsedSections.${key}`]: !this.data.collapsedSections[key] })
  },

  setAllSectionsCollapsed(collapsed) {
    this.setData({
      collapsedSections: {
        memoryItems: collapsed,
        meetingItems: collapsed,
        littleItems: collapsed,
      },
    })
  },

  expandAllSections() { this.setAllSectionsCollapsed(false) },

  collapseAllSections() { this.setAllSectionsCollapsed(true) },

  toggleLogs() {
    const logsCollapsed = !this.data.logsCollapsed
    this.setData({ logsCollapsed })
    if (!logsCollapsed && !this.data.logsLoaded && !this.data.logsLoading && !this.data.logsLoadError) this.loadReminderLogs()
  },

  updateListItem(e) {
    if (this.data.saving || this.data.saveConflictRefreshing) return
    const listKey = e.currentTarget.dataset.list
    const index = Number(e.currentTarget.dataset.index)
    if (!TOPPABLE_LIST_KEYS.has(listKey) || !Number.isInteger(index) || !this.data[listKey]?.[index]) return
    this.setData({ [`${listKey}[${index}].text`]: e.detail.value })
  },

  addListItem(e) {
    if (this.data.saving || this.data.saveConflictRefreshing) return
    const listKey = e.currentTarget.dataset.list
    const list = [...(this.data[listKey] || [])]
    list.push({
      id: createListItemId(),
      text: "",
      legacy: listKey === "memoryItems" ? false : undefined,
    })
    this.setData({ [listKey]: list })
  },

  removeListItem(e) {
    if (this.data.saving || this.data.saveConflictRefreshing) return
    const listKey = e.currentTarget.dataset.list
    const index = Number(e.currentTarget.dataset.index)
    const list = [...(this.data[listKey] || [])]
    list.splice(index, 1)
    this.setData({ [listKey]: list })
  },

  moveListItemToTop(e) {
    if (this.data.saving || this.data.saveConflictRefreshing) return
    const listKey = e.currentTarget.dataset.list
    if (!TOPPABLE_LIST_KEYS.has(listKey)) return
    const index = Number(e.currentTarget.dataset.index)
    const list = [...(this.data[listKey] || [])]
    if (!Number.isInteger(index) || index <= 0 || index >= list.length) return
    const [item] = list.splice(index, 1)
    this.setData({ [listKey]: [item, ...list] })
  },

  getDragRowHeightPx() {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    return DRAG_ROW_HEIGHT_RPX * info.windowWidth / 750
  },

  startListDrag(e) {
    if (this.data.saving || this.data.saveConflictRefreshing) return
    const listKey = e.currentTarget.dataset.list
    const index = Number(e.currentTarget.dataset.index)
    const touch = e.touches && e.touches[0]
    if (!listKey || !touch) return
    this.setData({
      dragState: {
        listKey,
        startIndex: index,
        currentIndex: index,
        startY: touch.pageY,
        rowHeight: this.getDragRowHeightPx(),
      },
    })
  },

  moveListDrag(e) {
    if (this.data.saving || this.data.saveConflictRefreshing) return
    const drag = this.data.dragState
    const touch = e.touches && e.touches[0]
    if (!drag || !touch) return
    const list = [...(this.data[drag.listKey] || [])]
    if (!list.length) return
    const offset = Math.round((touch.pageY - drag.startY) / drag.rowHeight)
    const targetIndex = Math.max(0, Math.min(list.length - 1, drag.startIndex + offset))
    if (targetIndex === drag.currentIndex) return

    const [moving] = list.splice(drag.currentIndex, 1)
    list.splice(targetIndex, 0, moving)
    this.setData({
      [drag.listKey]: list,
      "dragState.currentIndex": targetIndex,
    })
  },

  endListDrag() {
    if (this.data.dragState) this.setData({ dragState: null })
  },

  parseEditorItems(items) {
    const seen = {}
    return (Array.isArray(items) ? items : [])
      .map((item) => String(item.text || "").trim())
      .filter((text) => {
        if (!text || seen[text]) return false
        seen[text] = true
        return true
      })
  },

  onReminderChange(e) {
    if (this.data.saving || this.data.saveConflictRefreshing) return
    this.setData({ "settings.reminderEnabled": e.detail.value })
  },

  saveSettings() {
    if (this.data.saving || this.data.loading || this.data.loadError) return
    if (this.data.saveConflict) {
      wx.showToast({ title: "请先重新加载并合并内容", icon: "none" })
      return
    }
    if (!isCompanionContentRevision(this.data.companionContentRevision)) {
      wx.showToast({ title: "内容版本未确认，请重新加载", icon: "none" })
      return
    }
    this.setData({ saving: true, dragState: null })
    const contentEditor = this.data.contentEditor
    const expectedCompanionContentRevision = this.data.companionContentRevision
    const companionContent = {
      memoryFragments: this.parseEditorItems(this.data.memoryItems),
      memoryFragmentEntries: parseMemoryItems(this.data.memoryItems),
      meetingWishes: this.parseEditorItems(this.data.meetingItems),
      littleThings: this.parseEditorItems(this.data.littleItems),
    }
    const values = contentEditor
      ? companionContent
      : { ...this.data.settings, ...companionContent }
    const action = contentEditor ? "saveCompanionContent" : "saveSettings"
    return wx.cloud.callFunction({
      name: "morningService",
      data: { action, values, expectedCompanionContentRevision },
    }).then((res) => {
      const result = requireSavedContentPayload(res?.result, contentEditor, expectedCompanionContentRevision)
      const content = splitSettingsAndContent({ ...this.data.settings, ...result })
      this.setData({
        ...content,
        saveConflict: false,
        saveConflictRefreshing: false,
        saveConflictRefreshError: "",
      })
      wx.showToast({ title: "设置已保存", icon: "success" })
    }).catch((err) => {
      console.error("save morning settings failed", err)
      if (err?.code === COMPANION_CONTENT_CONFLICT_REASON) {
        this.setData({
          saveConflict: true,
          saveConflictRefreshing: false,
          saveConflictRefreshError: "",
        })
        wx.showToast({ title: "内容已被另一位编辑者更新", icon: "none" })
        return
      }
      const title = /数据格式异常|保存结果异常/.test(String(err?.message || err?.errMsg || ""))
        ? "保存结果异常，请重新加载确认"
        : "保存失败，请检查输入"
      wx.showToast({ title, icon: "none" })
    }).finally(() => this.setData({ saving: false }))
  },

  createInvite() {
    if (this.data.partnerBound) {
      wx.showToast({ title: "请先解除当前绑定", icon: "none" })
      return
    }
    wx.cloud.callFunction({ name: "morningService", data: { action: "createInvite" } })
      .then((res) => this.setData({ invite: res.result }))
      .catch((err) => {
        console.error("create invite failed", err)
        wx.showToast({ title: "生成绑定码失败", icon: "none" })
      })
  },

  copyInvite() {
    if (!this.data.invite?.code) return
    wx.setClipboardData({ data: this.data.invite.code })
  },

  shareInviteQr() {
    const qrUrl = this.data.invite?.qrUrl
    if (!qrUrl) return
    wx.downloadFile({
      url: qrUrl,
      success: ({ statusCode, tempFilePath }) => {
        if (statusCode !== 200) {
          wx.showToast({ title: "二维码下载失败", icon: "none" })
          return
        }
        if (wx.showShareImageMenu) {
          wx.showShareImageMenu({ path: tempFilePath })
        } else {
          wx.previewImage({ urls: [qrUrl] })
        }
      },
      fail: () => wx.showToast({ title: "二维码下载失败", icon: "none" }),
    })
  },

  previewInviteQr() {
    const qrUrl = this.data.invite?.qrUrl
    if (qrUrl) wx.previewImage({ urls: [qrUrl] })
  },

  previewMorning() { wx.navigateTo({ url: "/pages/morningHome/morningHome?preview=1" }) },

  unbindPartner() {
    if (!this.data.partnerBound || this.data.unbinding) return
    wx.showModal({
      title: "解除当前绑定",
      content: "旧账号将无法再进入专属早安页，订阅次数会清零。历史早安记录会保留。",
      confirmText: "确认解绑",
      confirmColor: "#c04f3c",
      success: ({ confirm }) => {
        if (!confirm) return
        this.setData({ unbinding: true })
        wx.cloud.callFunction({
          name: "morningService",
          data: { action: "unbindPartner", confirm: true },
        }).then(() => {
          this.setData({
            partnerBound: false,
            invite: null,
            "settings.partnerOpenid": "",
            "settings.subscriptionCount": 0,
          })
          wx.showModal({
            title: "解绑成功",
            content: "现在可以生成新的绑定二维码，让伴侣使用自己的微信完成绑定。",
            showCancel: false,
          })
        }).catch((err) => {
          console.error("unbind partner failed", err)
          wx.showModal({ title: "解绑失败", content: err?.errMsg || "请稍后重试。", showCancel: false })
        }).finally(() => this.setData({ unbinding: false }))
      },
    })
  },

  testReminder() {
    if (this.data.testingReminder) return
    if (!this.data.partnerBound) {
      wx.showToast({ title: "请先绑定专属账号", icon: "none" })
      return
    }
    if (!Number(this.data.settings.subscriptionCount || 0)) {
      wx.showModal({
        title: "暂无订阅次数",
        content: "请让已绑定账号先点击“预约明早 7:30 提醒”并允许通知，再回来测试推送。",
        showCancel: false,
      })
      return
    }
    wx.showModal({
      title: "立即测试推送",
      content: "将向已绑定账号发送一次真实订阅消息，并消耗 1 次订阅额度。",
      confirmText: "发送测试",
      success: ({ confirm }) => {
        if (!confirm) return
        this.setData({ testingReminder: true })
        wx.cloud.callFunction({
          name: "sendMorningReminder",
          data: { manual: true },
        }).then((res) => {
          const result = res?.result
          if (isRecord(result) && result.sent === false && result.mode === "manual" && typeof result.reason === "string" && result.reason.trim()) {
            throw new Error(result.reason)
          }
          requireManualReminderPayload(result)
          this.setData({ "settings.subscriptionCount": Math.max(0, Number(this.data.settings.subscriptionCount || 0) - 1) })
          this.loadReminderLogs()
          wx.showModal({ title: "推送成功", content: "请在已绑定微信中查看订阅消息。", showCancel: false })
        }).catch((err) => {
          console.error("test morning reminder failed", err)
          this.loadReminderLogs()
          wx.showModal({
            title: "推送失败",
            content: err?.message || "请检查订阅额度和云函数日志。",
            showCancel: false,
          })
        }).finally(() => this.setData({ testingReminder: false }))
      },
    })
  },

  diagnoseReminder() {
    if (this.data.diagnosingReminder) return Promise.resolve()
    this.setData({ diagnosingReminder: true })
    return wx.cloud.callFunction({
      name: "sendMorningReminder",
      data: { diagnose: true },
    }).then((res) => {
      const result = requireReminderDiagnosisPayload(res?.result)
      this.loadReminderLogs()
      if (result.wouldSend === true) {
        wx.showModal({
          title: "自动推送条件正常",
          content: `明早可自动发送。当前剩余订阅次数：${result.subscriptionCount || 0}。`,
          showCancel: false,
        })
        return
      }

      const failed = REMINDER_DIAGNOSIS_CHECK_KEYS.filter((key) => !result.checks[key]).join("、") || result.reason
      wx.showModal({
        title: "自动推送不会发送",
        content: `原因：${failed}。请确认已绑定、模板有效、提醒开启，并且她已预约通知。`,
        showCancel: false,
      })
    }).catch((err) => {
      console.error("diagnose morning reminder failed", err)
      this.loadReminderLogs()
      wx.showModal({ title: "检查失败", content: err?.message || err?.errMsg || "请查看云函数日志。", showCancel: false })
    }).finally(() => this.setData({ diagnosingReminder: false }))
  },

  loadReminderLogs() {
    if (this.data.logsLoading) return Promise.resolve()
    this.setData({ logsLoading: true, logsLoadError: "" })
    return wx.cloud.callFunction({ name: "morningService", data: { action: "getReminderLogs" } })
      .then((res) => {
        const logs = requireReminderLogsPayload(res?.result)
        this.setData({
          reminderLogs: logs.map((item, index) => this.formatReminderLog(item, index)),
          logsLoaded: true,
          logsLoadError: "",
        })
      })
      .catch((err) => {
        console.error("load reminder logs failed", err)
        this.setData({ logsLoadError: "日志读取失败，请稍后重试" })
        wx.showToast({ title: "日志读取失败", icon: "none" })
      })
      .finally(() => this.setData({ logsLoading: false }))
  },

  formatReminderLog(item, index) {
    const statusMap = {
      diagnosed: "检查通过",
      skipped: "未发送",
      sending: "发送中",
      sent_transport: "通道成功",
      sent: "已发送",
      failed: "发送失败",
    }
    const modeMap = { timer: "自动", manual: "手动", diagnose: "检查" }
    const before = Number(item.subscriptionCountBefore || 0)
    const after = item.subscriptionCountAfter === undefined ? "" : ` → ${item.subscriptionCountAfter}`
    return {
      ...item,
      logId: `${index}_${item.status || "log"}_${item.date || ""}`,
      statusText: statusMap[item.status] || item.status || "未知",
      modeText: modeMap[item.mode] || item.mode || "未知",
      timeText: this.formatTime(item.createdAt),
      quotaText: `订阅次数 ${before}${after}`,
      reasonText: item.reason || item.error || "",
    }
  },

  formatTime(value) {
    if (!value) return ""
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) return ""
    const pad = (number) => String(number).padStart(2, "0")
    return `${date.getMonth() + 1}-${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  },
})

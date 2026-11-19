const PARTNER_NAME_RECENT_DAYS = 3

const PARTNER_NAME_GROUPS = {
  king: ["晨跑搭子", "早餐搭子", "散步搭子", "咖啡搭子", "读书搭子", "逛展搭子", "观星搭子", "旅行搭子", "看海搭子", "看电影搭子"],
  sweet: ["晨光", "微风", "晴天", "星光", "小月亮", "小太阳", "蓝莓", "柚子", "桃子", "橙子"],
  cute: ["小熊", "小鹿", "小猫", "小兔", "小羊", "小松鼠", "小海豹", "小企鹅", "小浣熊", "小狐狸"],
}

const PARTNER_NAMES = Object.values(PARTNER_NAME_GROUPS).flat()

const LOVE_TEXTS = [
  "早上好，今天也慢慢来。",
  "起床先喝杯水。",
  "今天选一首喜欢的歌出门。",
  "给自己留一点吃早餐的时间。",
  "忙完了记得休息一会儿。",
  "今天有空就去晒晒太阳。",
  "试着留意路上的一朵花。",
  "今天想穿什么就穿什么。",
  "周末可以一起去散步。",
  "愿今天遇到一件小事让你开心。",
  "想休息的时候就休息。",
  "傍晚有空一起看云。",
  "今天记得吃顿热饭。",
  "路上别着急。",
  "留一分钟听听窗外。",
  "下班后给自己泡杯茶。",
  "希望你今天睡得够。",
  "觉得冷就多带件外套。",
  "好好享受今天的第一口咖啡。",
  "今天也可以给自己放空一会儿。",
  "下雨就带上一把喜欢的伞。",
  "有空给我讲讲今天的小事。",
  "周末想去哪里走走？",
  "今天挑个喜欢的杯子喝水。",
  "如果很忙，就从眼前一件事开始。",
  "今天可以早点回家休息。",
  "希望今天的路上有一点绿意。",
  "晚点一起听首歌。",
  "今天也记得给自己留点时间。",
  "早安，愿你过一个自在的上午。",
]

const dateOffset = (date, days) => {
  const value = new Date(`${date}T12:00:00+08:00`)
  value.setDate(value.getDate() + days)
  return value.toISOString().slice(0, 10)
}

const randomItem = (items) => items[Math.floor(Math.random() * items.length)]

const getPartnerNameCandidates = (recentNames) => {
  const roll = Math.random()
  const preferredGroup = roll < 0.35 ? "king" : roll < 0.7 ? "sweet" : "cute"
  const preferred = PARTNER_NAME_GROUPS[preferredGroup].filter((name) => !recentNames.has(name))
  if (preferred.length) return preferred
  const allCandidates = PARTNER_NAMES.filter((name) => !recentNames.has(name))
  return allCandidates.length ? allCandidates : PARTNER_NAMES
}

module.exports = {
  PARTNER_NAME_RECENT_DAYS,
  PARTNER_NAME_GROUPS,
  PARTNER_NAMES,
  LOVE_TEXTS,
  dateOffset,
  randomItem,
  getPartnerNameCandidates,
}

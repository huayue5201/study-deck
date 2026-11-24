import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Lang = 'zh' | 'en'

const STORAGE_KEY = 'studydeck.language'
const COOKIE_KEY = 'studydeck_language'

function readSavedLang(): Lang {
  const cookie = document.cookie
    .split('; ')
    .find((item) => item.startsWith(`${COOKIE_KEY}=`))
    ?.split('=')[1]
  if (cookie === 'en' || cookie === 'zh') return cookie
  const saved = localStorage.getItem(STORAGE_KEY)
  return saved === 'en' ? 'en' : 'zh'
}

function persistLang(lang: Lang) {
  localStorage.setItem(STORAGE_KEY, lang)
  document.cookie = `${COOKIE_KEY}=${lang}; path=/; max-age=31536000; SameSite=Lax`
}

const EN: Record<string, string> = {
  // shell / common
  '新会话': 'New chat',
  '新课程': 'New course',
  '搜索专题或会话': 'Search topics or chats',
  '专题': 'Topic',
  '课程': 'Course',
  '最近': 'Recent',
  '本地工作区 · 自动保存': 'Local workspace · Autosaved',
  '设置': 'Settings',
  '更多': 'More',
  '复习': 'Review',
  '路径': 'Path',
  '来自': 'From',
  '衍生': 'Leads to',
  '记得': 'Remembered',
  '忘了': 'Forgot',
  '刷新': 'Refresh',
  '第 {n} 次': 'Round {n}',
  '今天没有到期的条目。': 'Nothing due today.',
  '按间隔重复排期；记得就拉长，忘了回到 1 天': 'Spaced repetition: remembering doubles the gap, forgetting resets to 1 day',
  '遇到过 {n} 次': 'Seen {n} times',
  '没有更早的记录。': 'No earlier records.',
  '第 {n} 层': 'Level {n}',
  '主线': 'Main thread',
  '回到：{text}': 'Back to: {text}',
  '关闭整叠（Esc）': 'Close the stack (Esc)',
  '已深入 {n} 层，注意上下文与成本': 'Level {n} deep — watch context and cost',
  '账本': 'Ledger',
  '本会话累计 token': 'Tokens used in this chat',
  '收起账本': 'Close ledger',
  '会话': 'Chat',
  '当前对话模型': 'Current model',
  '未配置模型': 'No model configured',
  '未命名': 'Untitled',
  '发送': 'Send',
  '保存': 'Save',
  '取消': 'Cancel',
  '确认': 'Confirm',
  '删除': 'Delete',
  '关闭': 'Close',
  '返回会话': 'Back to chat',
  '解释选中内容': 'Explain selection',
  '输入问题…（Enter 发送，Shift+Enter 换行）': 'Ask something… (Enter to send, Shift+Enter for a new line)',
  '从一个具体问题开始': 'Start with a concrete question',
  '选中回答中的任意内容，可打开卡片就地解释；主线对话不会被打断。':
    'Select any part of an answer to open a card and explain it in place, without interrupting the main thread.',
  '演示模式：后端未配置模型，返回的是脚本内容':
    'Demo mode: no model is configured, so scripted responses are returned.',
  '今天有 {n} 个学习任务待完成：': 'You have {n} study task(s) due today: ',
  '查看': 'View',
  '项目读取失败': 'Project read failed',
  '已完成项目读取': 'Project read complete',
  '正在读取 {path}…': 'Reading {path}…',
  '正在查看目录 {path}…': 'Listing {path}…',
  '正在搜索「{query}」…': 'Searching for “{query}”…',
  '正在获取时间…': 'Checking the time…',
  '正在使用 {name}…': 'Using {name}…',

  '接口地址': 'Base URL',
  '测试中…': 'Testing…',
  '已保存，留空表示不修改': 'Saved; leave blank to keep it',
  'Key 只存在这台机器：优先写入系统钥匙串': 'The key stays on this machine and is stored in the system keychain when available',
  '（当前为本地文件，权限 600）': ' (currently a local 600 file)',
  '保存并开始': 'Save and start',
  '欢迎使用 StudyDeck': 'Welcome to StudyDeck',
  '这是一个本地学习工具：对话直接发给你自己填的模型服务商，不经过任何中转。填一次就能开始用。':
    'A local study tool: chats go directly to the provider you configure, with no relay. Set it up once and start.',
  '先逛逛（演示模式，返回的是脚本内容）': 'Explore first (demo mode with scripted responses)',
  '服务商': 'Provider',
  '模型': 'Model',

  '升级为专题': 'Promote to topic',
  '归入专题': 'Add to topic',
  '新建专题': 'New topic',
  '新专题名': 'New topic name',
  '比如：采样定理': 'e.g. Sampling theorem',
  '会新建一个主线会话，并从《{parent}》的「{quote}」带上起点上下文。原卡片和来源消息都会保留回链。':
    'Creates a new main chat seeded from “{quote}” in {parent}. The card and source message keep their backlinks.',
  '会在这个专题下新建一个会话，并保留这张卡片的来源。':
    'Creates a chat under this topic and keeps this card’s source.',
  '会新建专题和会话。创建后可在顶部点「生成学习地图」。':
    'Creates a topic and chat. After that, use “Generate learning map” at the top.',
  '创建专题': 'Create topic',
  '创建中…': 'Creating…',
  '生成学习地图': 'Generate learning map',
  '来源': 'Source',

  '{n} 个会话': '{n} chat(s)',
  '加载专题…': 'Loading topic…',
  '加载课程…': 'Loading course…',
  '来自卡片的前置依赖：': 'Suggested prerequisites: ',
  '关联已有会话…': 'Attach existing chat…',
  '专题名，不存在会自动创建': 'Topic name; created if missing',
  '新建': 'New',
  '关联已有会话': 'Attach existing chat',
  '关联': 'Attach',
  '移出': 'Detach',
  '学习地图': 'Learning map',
  '学习节点': 'Learning nodes',
  '从地图拆成节点': 'Extract nodes',
  '添加一个学习节点': 'Add a learning node',
  '添加': 'Add',
  '关系': 'Relations',
  '先修': 'Prerequisites',
  '后续': 'Unlocks',
  '相关': 'Related',
  '其它': 'Other',
  '移除': 'Remove',
  '删除专题《{title}》': 'Delete topic “{title}”',
  '将删除 {nodes} 个学习节点、{relations} 条关系{extra}。账本条目会保留。':
    'This will delete {nodes} learning node(s), {relations} relation(s){extra}. Ledger entries are kept.',
  '，并从 {n} 个课程中移除': ', and remove it from {n} course(s)',
  '保留 {n} 个会话，转为普通会话': 'Keep {n} chat(s) as regular chats',
  '推荐；对话、卡片和账本都不删除。': 'Recommended; chats, cards and ledger are kept.',
  '同时删除 {n} 个会话': 'Delete {n} chat(s) too',
  '会删除这些会话的消息和卡片；账本保留。': 'Deletes these chats’ messages and cards; the ledger is kept.',
  '确认删除': 'Delete',
  '手动创建的专题，没有阅读来源。': 'Manual topic; no reading source.',
  '来源：{title} 中的「{quote}」': 'Source: “{quote}” in {title}',
  '还没有会话。': 'No chats yet.',
  '还没有节点。生成地图后点「从地图拆成节点」。':
    'No nodes yet. Generate a map, then choose “Extract nodes”.',
  '拖动排序': 'Drag to reorder',
  '预计分钟': 'Estimated minutes',
  '从课程移除，不删除专题': 'Remove from course; topic is kept',
  '先修未满足：': 'Unmet prerequisites: ',
  '还没有排期。先在学习路径里加入专题并设置日期。':
    'No schedule yet. Add topics to the path and set dates.',
  '未排期': 'Unscheduled',
  '项': 'items',
  '排期设置': 'Schedule settings',
  '导出到日历': 'Export to calendar',
  '每天': 'Daily',
  '分钟': 'min',
  '完成': 'done',
  '选择专题加入课程…': 'Choose a topic to add…',
  '加入': 'Add',
  '课程还是空的，先加入一个专题。': 'The course is empty. Add a topic first.',
  '删除课程《{title}》？专题和会话不会被删除。':
    'Delete course “{title}”? Topics and chats will not be deleted.',
  '删除课程': 'Delete course',
  '按先修排序': 'Sort by prerequisites',
  '自动排期': 'Auto-schedule',
  '学习路径': 'Path',
  '课表': 'Schedule',
  '新建课程': 'New course',
  '课程名': 'Course name',
  '目标': 'Goal',
  '开始': 'Start',
  '结束': 'End',
  '每天可用分钟': 'Minutes per day',
  '学习日': 'Study days',
  '创建课程': 'Create course',
  '课程只组织专题，不复制会话或账本。': 'Courses organize topics; they do not copy chats or the ledger.',

  '先生成一个学习地图，或在这里手写：3–5 条路线、先修关系、目标深度。':
    'Generate a map, or write one here: 3–5 items, prerequisites, target depth.',

  '{done}/{total} 完成': '{done}/{total} done',
  '开始 {date}': 'Starts {date}',
  '结束 {date}': 'Ends {date}',
  '计划日期，可留空': 'Planned date (optional)',
  '比如：数字信号处理': 'e.g. Digital signal processing',
  '学完能做什么': 'What will you be able to do?',
  '一': 'Mon',
  '二': 'Tue',
  '三': 'Wed',
  '四': 'Thu',
  '五': 'Fri',
  '六': 'Sat',
  '日': 'Sun',

  '保存中…': 'Saving…',
  '（其它专题）': ' (other topic)',
  '点击切换状态': 'Click to change status',

  '搜索所有对话内容…': 'Search all conversations…',
  '没有匹配的消息。': 'No matching messages.',
  '未命名会话': 'Untitled chat',
  '你': 'You',
  '助教': 'Tutor',
  '跳到这段': 'Jump to this passage',
  '合并 {n} 条': 'Merge {n}',
  '确认删除？': 'Delete?',

  // sidebar
  '文件': 'file',
  '项目': 'project',
  '重命名会话': 'Rename chat',
  '比如：Rust 所有权': 'e.g. Rust ownership',
  '请解释这段内容。': 'Explain the selected content.',
  '请重新解释这段内容。': 'Explain the selected content again.',
  '请基于这个专题起点，先给我一个 3–5 条的学习地图：每条只写主题、与其它条目的先修关系和目标深度；先不要展开正文，等我确认。':
    'Based on this topic origin, first give me a 3–5 item learning map: each item only needs the subject, its prerequisite relation, and target depth. Do not expand the body yet; wait for my confirmation.',
  '讲讲采样定理，并指出哪些概念我现在可以不懂':
    'Explain the sampling theorem, and point out which concepts I can safely skip for now.',
  '帮我理解 React 的 key 到底在解决什么问题':
    'Help me understand what problem React keys actually solve.',
  '我在学 Rust 所有权，给一个我能跑的小例子':
    'I am learning Rust ownership. Give me a small example I can run.',
  '还没有会话': 'No chats yet.',
  '条': 'msgs',
  '刚刚': 'just now',
  '{n} 分钟前': '{n}m ago',
  '{n} 小时前': '{n}h ago',
  '{n} 天前': '{n}d ago',
  '原会话': 'original chat',
  '选中即解释，理解可沉淀': 'Explain in place. Keep what you learn.',
  '重命名': 'Rename',
  '再点一次确认删除': 'Click again to confirm delete',
  '来自：{title}': 'From: {title}',
  '主线对话': 'the main thread',
  '支线': 'Branch',
  '分钟前': '{n}m ago',
  '小时前': '{n}h ago',
  '天前': '{n}d ago',

  // card
  '继续追问（仅限当前卡片上下文）': 'Follow up (this card only)',
  '保存到账本': 'Save to ledger',
  '已保存': 'Saved',
  '重新生成': 'Regenerate',
  '如需系统学习，可升级为专题': 'For systematic study, promote this to a topic',
  '生成完成后可升级为专题': 'Promotion is available after generation',
  '打开专题': 'Open topic',
  '拖动卡片可移动': 'Drag to move',
  '出错': 'Error',

  // depth / mastery
  '能调': 'Use',
  '能改': 'Tune',
  '能推': 'Derive',
  '未标记': 'Unmarked',
  '在学': 'Learning',
  '已掌握': 'Mastered',
  '未开始': 'Not started',
  '已完成': 'Done',
  '目标 {depth}': 'Goal: {depth}',
  '目标深度': 'Target depth',

  // topic page
  '删除专题': 'Delete topic',
  '专题名': 'Topic name',
  '前置依赖': 'Prerequisites',
  '专题起点': 'Topic origin',
  '已删除专题': 'Deleted topic',
  '导出账本：': 'Export ledger: ',
  '数据只存在本机。': 'Data stays on this machine.',
  '清除已保存的 Key': 'Clear saved key',
  '界面语言': 'Interface language',
  '中文': '中文',
  'English': 'English',
  '语言': 'Language',
  'API Key': 'API Key',
  '测试连接': 'Test connection',

  // ledger
  '搜索': 'Search',
  '搜索术语或结论…': 'Search terms or notes…',
  '还没有条目。关掉一张卡片就会自动记账。':
    'No entries yet. Closing a card records it automatically.',
  '点击切换掌握程度': 'Click to change mastery',
  '回到来源': 'Back to source',
  '消息': 'Message',
  '编辑': 'Edit',
  '卡片模板': 'Card templates',
  '模板': 'Template',
  '模板名': 'Name',
  '轴名称': 'Axis name',
  '字数上限': 'Max characters',
  '默认档位': 'Default level',
  '档位': 'Levels',
  '小节 / 结构': 'Sections',
  '高级：系统提示词': 'Advanced: system prompt',
  '设为默认': 'Set as default',
  '另存为副本': 'Save as a copy',
  '当前默认': 'Default',
  '默认': 'Default',
  '上移': 'Move up',
  '下移': 'Move down',
  '删除这一档': 'Delete this level',
  '删除这个小节': 'Delete this section',
  '加一档': 'Add level',
  '加一个小节': 'Add section',
  '至少保留两档': 'Keep at least two levels',
  '最多九档': 'At most nine levels',
  '至少保留一个小节': 'Keep at least one section',
  '至少保留一个模板': 'Keep at least one template',
  '当前默认模板不能删除': 'The default template cannot be deleted',
  '再点一次「删除」确认': 'Click delete again to confirm',
  '会删除这个模板': 'This removes the template',
  '已设为默认': 'Set as default',
  '已删除': 'Deleted',
  '已创建副本': 'Copy created',
  '已创建模板': 'Template created',
  '新模板': 'New template',
  '未命名模板': 'Untitled template',
  '处理中…': 'Working…',
  '还没有模板。': 'No templates yet.',
  '还没有可复制的模板': 'No template to copy from',
  '模板列表加载失败，后端可能还没就绪': 'Could not load templates; the backend may not be ready yet',
  '后端就绪后，这里会列出内置模板。': 'Built-in templates show up here once the backend is ready.',
  '模板决定卡片的轴与小节': 'Templates decide the card axis and sections',
  '比如：理解深度': 'e.g. Depth of understanding',
  '比如：理解深度（可留空）': 'e.g. Depth of understanding (optional)',
  '留空用默认 260': 'Leave blank for 260',
  '比如：一句话定义': 'e.g. One-line definition',
  '比如：能调': 'e.g. Can use',
  '比如：法律': 'e.g. Law',
  '讲到哪停：只要会用就说到…': 'Where to stop: for “can use”, say just enough…',
  '由名称生成，稳定且唯一': 'Generated from the name; stable and unique',
  '会按这个顺序注入「严格按以下小节输出」': 'Injected in this order as “output strictly in these sections”',
  '你是「卡片」…': 'You are the card…',
  '卡片堆（{n} 层）': 'Card stack ({n})',
  '掀开卡片堆': 'Fan out the pile',
  '这条卡有 {n} 个分支': 'This card has {n} branches',
  '卡片链': 'Card chain',
  '第 {n} 层：{text}': 'Level {n}: {text}',
  '切到分支：{text}': 'Switch to branch: {text}',
}

function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `{${key}}`))
}

interface I18nValue {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (zh: string, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readSavedLang)

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
    persistLang(lang)
  }, [lang])

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      setLang: setLangState,
      t: (zh, vars) => {
        const text = lang === 'en' ? (EN[zh] ?? zh) : zh
        return interpolate(text, vars)
      },
    }),
    [lang],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) {
    throw new Error('useI18n must be used inside I18nProvider')
  }
  return value
}

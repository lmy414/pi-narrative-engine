/**
 * 模拟后端数据层
 * 按 frontend-requirements.md 的数据模型构造
 */

const MOCK_PROJECTS = [
  {
    dir: 'D:\\novels\\xing-chen-zhi-hai',
    relativePath: 'xing-chen-zhi-hai',
    chapterCount: 24,
    lastModified: '2026-08-02T01:30:00Z',
    needsMigration: false,
    stats: { entityCount: 128, eventCount: 342 },
    meta: { name: '星辰之海', worldGraphDir: '.pi/world-graph-v3', chaptersDir: '正文', storyTimeFormat: 'ch<NNN>.ev<NNN>' }
  },
  {
    dir: 'D:\\novels\\wu-du-mi-an',
    relativePath: 'wu-du-mi-an',
    chapterCount: 18,
    lastModified: '2026-07-25T14:20:00Z',
    needsMigration: true,
    stats: { entityCount: 86, eventCount: 215 },
    meta: { name: '雾都迷案', worldGraphDir: '.pi/world-graph-v3', chaptersDir: '正文', storyTimeFormat: 'ch<NNN>.ev<NNN>' }
  },
  {
    dir: 'D:\\novels\\shi-guang-ka-fei-guan',
    relativePath: 'shi-guang-ka-fei-guan',
    chapterCount: 12,
    lastModified: '2026-07-30T09:15:00Z',
    needsMigration: false,
    stats: { entityCount: 52, eventCount: 128 },
    meta: { name: '时光咖啡馆', worldGraphDir: '.pi/world-graph-v3', chaptersDir: '正文', storyTimeFormat: 'ch<NNN>.ev<NNN>' }
  },
  {
    dir: 'D:\\novels\\chang-an-yue-xia',
    relativePath: 'chang-an-yue-xia',
    chapterCount: 48,
    lastModified: '2026-08-01T22:00:00Z',
    needsMigration: false,
    stats: { entityCount: 203, eventCount: 567 },
    meta: { name: '长安月下', worldGraphDir: '.pi/world-graph-v3', chaptersDir: '正文', storyTimeFormat: 'ch<NNN>.ev<NNN>' }
  }
];

const ENTITY_TYPES = {
  character: { label: '角色', color: '#c96442', bg: '#fbf2ed' },
  location: { label: '地点', color: '#788c5d', bg: '#f0f3ea' },
  item: { label: '物品', color: '#9c87f5', bg: '#f3f0ff' },
  concept: { label: '概念', color: '#d97757', bg: '#ffedd5' }
};

const MOCK_ENTITIES = [
  { entityId: 'char-01', entityType: 'character', summary: '年轻的星舰舰长，执着于寻找失踪的父亲', properties: { name: '林远航', age: 28, gender: '男', faction: '星际联盟', role: '主角' }, alive: true },
  { entityId: 'char-02', entityType: 'character', summary: '神秘的导航员，似乎知道舰长父亲的下落', properties: { name: '艾莉亚', age: 26, gender: '女', faction: '游商公会', role: '女主' }, alive: true },
  { entityId: 'char-03', entityType: 'character', summary: '星际联盟退役上将，林远航的导师', properties: { name: '老陈', age: 58, gender: '男', faction: '星际联盟', role: '导师' }, alive: true },
  { entityId: 'loc-01', entityType: 'location', summary: '人类在猎户座旋臂边缘的前哨站', properties: { name: '第七星港', region: '猎户座旋臂', type: '太空站' }, alive: true },
  { entityId: 'loc-02', entityType: 'location', summary: '传说中藏有远古文明遗迹的星云', properties: { name: '迷雾星云', region: '未知星域', type: '星云' }, alive: true },
  { entityId: 'item-01', entityType: 'item', summary: '父亲留下的星图碎片，指向迷雾星云深处', properties: { name: '破碎星图', owner: '林远航', type: '遗物' }, alive: true },
  { entityId: 'item-02', entityType: 'item', summary: '可穿透星云干扰的稀有矿石', properties: { name: '共鸣水晶', type: '材料' }, alive: true },
  { entityId: 'concept-01', entityType: 'concept', summary: '一种古老的星际航行技术', properties: { name: '星门协议', type: '知识' }, alive: true }
];

const MOCK_RELATIONS = [
  { sourceId: 'char-01', targetId: 'char-02', label: '同行', storyTime: 'ch001.ev001', closed: false },
  { sourceId: 'char-01', targetId: 'char-03', label: '师从', storyTime: 'ch001.ev001', closed: false },
  { sourceId: 'char-01', targetId: 'item-01', label: '持有', storyTime: 'ch001.ev002', closed: false },
  { sourceId: 'char-02', targetId: 'loc-01', label: '来自', storyTime: 'ch001.ev001', closed: false },
  { sourceId: 'char-01', targetId: 'loc-02', label: '前往', storyTime: 'ch003.ev005', closed: false },
  { sourceId: 'item-01', targetId: 'loc-02', label: '指向', storyTime: 'ch001.ev002', closed: false },
  { sourceId: 'item-02', targetId: 'concept-01', label: '关联', storyTime: 'ch002.ev003', closed: false },
  { sourceId: 'char-03', targetId: 'concept-01', label: '研究', storyTime: 'ch002.ev003', closed: true, closedAt: 'ch004.ev006' }
];

const MOCK_EVENTS = [
  { eventId: 'evt-01', type: 'birth', storyTime: 'ch001.ev001', entityId: 'char-01', entityType: 'character', summary: '林远航登上「曙光号」，开始寻找父亲的旅程', source: 'user', newFacts: [{ entityId: 'char-01', property: 'location', value: '第七星港', modality: 'fact' }], causes: [], recordedAt: '2026-07-15T10:00:00Z' },
  { eventId: 'evt-02', type: 'birth', storyTime: 'ch001.ev001', entityId: 'char-02', entityType: 'character', summary: '艾莉亚以导航员身份加入曙光号', source: 'engine', newFacts: [{ entityId: 'char-02', property: 'faction', value: '游商公会', modality: 'fact' }], causes: [], recordedAt: '2026-07-15T10:05:00Z' },
  { eventId: 'evt-03', type: 'change', storyTime: 'ch001.ev002', entityId: 'char-01', entityType: 'character', summary: '林远航从遗物箱中发现父亲留下的破碎星图', source: 'engine', newFacts: [{ entityId: 'char-01', property: 'hasItem', value: '破碎星图', modality: 'fact' }], invalidated: [{ declarationId: 'decl-01', property: 'hasItem' }], causes: ['evt-01'], recordedAt: '2026-07-15T11:00:00Z' },
  { eventId: 'evt-04', type: 'change', storyTime: 'ch002.ev003', entityId: 'item-02', entityType: 'item', summary: '在第七星港黑市获得共鸣水晶样本', source: 'engine', newFacts: [{ entityId: 'item-02', property: 'owner', value: '林远航', modality: 'fact' }], causes: ['evt-01'], recordedAt: '2026-07-16T09:30:00Z' },
  { eventId: 'evt-05', type: 'change', storyTime: 'ch003.ev005', entityId: 'char-01', entityType: 'character', summary: '曙光号启程前往迷雾星云', source: 'user', newFacts: [{ entityId: 'char-01', property: 'location', value: '迷雾星云', modality: 'fact' }], invalidated: [{ declarationId: 'decl-02', property: 'location' }], causes: ['evt-03'], recordedAt: '2026-07-17T14:00:00Z' },
  { eventId: 'evt-06', type: 'death', storyTime: 'ch004.ev006', entityId: 'char-03', entityType: 'character', summary: '老陈为掩护曙光号撤离，留在第七星港', source: 'engine', newFacts: [{ entityId: 'char-03', property: 'alive', value: false, modality: 'fact' }], causes: ['evt-04'], recordedAt: '2026-07-18T20:00:00Z' },
  { eventId: 'evt-07', type: 'birth', storyTime: 'ch005.ev007', entityId: 'loc-02', entityType: 'location', summary: '迷雾星云深处发现远古星门遗迹', source: 'engine', newFacts: [{ entityId: 'loc-02', property: 'hasRuin', value: true, modality: 'fact' }], causes: ['evt-05'], recordedAt: '2026-07-20T08:00:00Z' }
];

const MOCK_DECLARATIONS = [
  { declarationId: 'decl-01', entityId: 'char-01', property: 'hasItem', value: null, modality: 'fact', source: 'engine', validFrom: 'ch001.ev001', validTo: 'ch001.ev002', closeReason: 'ev002 发现破碎星图（hasItem 转移）' },
  { declarationId: 'decl-02', entityId: 'char-01', property: 'location', value: '第七星港', modality: 'fact', source: 'engine', validFrom: 'ch001.ev001', validTo: 'ch003.ev005', closeReason: 'ev005 启程前往迷雾星云' },
  { declarationId: 'decl-03', entityId: 'char-01', property: 'location', value: '迷雾星云', modality: 'fact', source: 'engine', validFrom: 'ch003.ev005', validTo: 'Infinity' },
  { declarationId: 'decl-04', entityId: 'char-02', property: 'faction', value: '游商公会', modality: 'fact', source: 'user', validFrom: 'ch001.ev001', validTo: 'Infinity' },
  { declarationId: 'decl-05', entityId: 'char-03', property: 'alive', value: true, modality: 'fact', source: 'user', validFrom: 'ch001.ev001', validTo: 'ch004.ev006', closeReason: 'ev006 为掩护曙光号撤离' }
];

const MOCK_VISIBILITY = [
  { characterId: 'char-01', declarationId: 'decl-04', state: 'known', confidence: 0.9, source: 'informed', validFrom: 'ch001.ev001', validTo: 'Infinity' },
  { characterId: 'char-02', declarationId: 'decl-02', state: 'known', confidence: 1.0, source: 'witnessed', validFrom: 'ch001.ev001', validTo: 'Infinity' },
  { characterId: 'char-03', declarationId: 'decl-03', state: 'known', confidence: 0.7, source: 'informed', validFrom: 'ch003.ev005', validTo: 'Infinity' },
  // 缺少有效 known 记录的角色在矩阵中显示为 unknown。
  { characterId: 'char-01', declarationId: 'decl-02', state: 'known', confidence: 1.0, source: 'witnessed', validFrom: 'ch001.ev001', validTo: 'Infinity' },
  { characterId: 'char-01', declarationId: 'decl-03', state: 'known', confidence: 1.0, source: 'witnessed', validFrom: 'ch003.ev005', validTo: 'Infinity' },
  { characterId: 'char-02', declarationId: 'decl-01', state: 'known', confidence: 0.85, source: 'informed', validFrom: 'ch001.ev002', validTo: 'Infinity' },
  { characterId: 'char-03', declarationId: 'decl-02', state: 'known', confidence: 0.8, source: 'witnessed', validFrom: 'ch001.ev001', validTo: 'Infinity' },
  { characterId: 'char-01', declarationId: 'decl-05', state: 'known', confidence: 1.0, source: 'witnessed', validFrom: 'ch001.ev001', validTo: 'Infinity' }
];

const MOCK_CHAT_SESSIONS = [
  { id: 'session-03', name: '第24次编排', created: '2026-08-02T02:00:00Z', modified: '2026-08-02T03:30:00Z', messageCount: 24, firstMessage: '让艾莉亚在第七星港触发身世线索', live: true },
  { id: 'session-05', name: '新增角色墨先生', created: '2026-08-02T02:24:00Z', modified: '2026-08-02T02:50:00Z', messageCount: 6, firstMessage: '引入一个神秘商人角色' },
  { id: 'session-04', name: '角色对峙场景讨论', created: '2026-08-02T00:40:00Z', modified: '2026-08-02T01:20:00Z', messageCount: 12, firstMessage: '林远航与老陈的争执场景' },
  { id: 'session-06', name: '迷雾星云初登场策划', created: '2026-08-01T14:00:00Z', modified: '2026-08-01T15:30:00Z', messageCount: 9, firstMessage: '规划曙光号进入迷雾星云' },
  { id: 'session-07', name: '世界观基础设定', created: '2026-08-01T08:00:00Z', modified: '2026-08-01T09:12:00Z', messageCount: 15, firstMessage: '星门协议是什么' },
  { id: 'session-01', name: '第一章 启程', created: '2026-07-15T10:00:00Z', modified: '2026-07-15T12:00:00Z', messageCount: 8, firstMessage: '帮我规划第一章' },
  { id: 'session-02', name: '迷雾星云设定', created: '2026-07-18T09:00:00Z', modified: '2026-07-18T10:30:00Z', messageCount: 5, firstMessage: '设计迷雾星云的环境' }
];

const MOCK_CHAT_MESSAGES = {
  'session-01': [
    { role: 'user', text: '帮我规划第一章', ts: '2026-07-15T10:00:00Z' },
    { role: 'assistant', text: '第一章可以从林远航在第七星港接收父亲遗物开始。关键事件：\n1. 登上曙光号\n2. 遇到艾莉亚\n3. 发现破碎星图\n\n需要我展开哪个部分？', ts: '2026-07-15T10:01:00Z' }
  ],
  'session-02': [
    { role: 'user', text: '设计迷雾星云的环境', ts: '2026-07-18T09:00:00Z' },
    { role: 'assistant', text: '迷雾星云是一片充满电磁干扰的星域，内部漂浮着远古文明的碎片。', ts: '2026-07-18T09:01:00Z' }
  ],
  'session-03': [
    { role: 'user', text: '接下来让艾莉亚在第七星港遇到一个神秘商人，触发她的身世线索。', ts: '2026-08-02T03:00:00Z' },
    {
      role: 'assistant',
      text: '好的，我来规划这段剧情。先让我检索一下世界图中第七星港和艾莉亚的当前状态。',
      ts: '2026-08-02T03:00:02Z',
      toolCalls: [
        { id: 'tool-01', name: '检索世界图', status: 'done', isError: false },
        { id: 'tool-02', name: '调用编排器', status: 'done', isError: false }
      ]
    },
    { role: 'system', text: 'AI 触发编排 · 多代理协作中', ts: '2026-08-02T03:00:05Z' },
    { role: 'assistant', text: '已生成编排计划（计划 plan-01），等待你的确认。', ts: '2026-08-02T03:00:08Z' }
  ],
  'session-04': [
    { role: 'user', text: '林远航与老陈的争执场景', ts: '2026-08-02T00:40:00Z' },
    { role: 'assistant', text: '建议在迷雾星云外围设置一次补给站冲突：老陈坚持返航，林远航执意深入。', ts: '2026-08-02T00:40:30Z' }
  ],
  'session-05': [
    { role: 'user', text: '引入一个神秘商人角色', ts: '2026-08-02T02:24:00Z' },
    { role: 'assistant', text: '新角色「墨先生」：第七星港黑市的古董商，掌握远古遗物的线索，与艾莉亚的身世存在隐秘关联。', ts: '2026-08-02T02:24:40Z' }
  ],
  'session-06': [
    { role: 'user', text: '规划曙光号进入迷雾星云', ts: '2026-08-01T14:00:00Z' },
    { role: 'assistant', text: '进入迷雾星云的三个关键节点：电磁干扰爆发、远古星门显形、第一次遭遇未知信号。', ts: '2026-08-01T14:01:00Z' }
  ],
  'session-07': [
    { role: 'user', text: '星门协议是什么', ts: '2026-08-01T08:00:00Z' },
    { role: 'assistant', text: '星门协议是一种古老的星际航行技术，据说能折叠空间，但完整的协议早已失传。', ts: '2026-08-01T08:01:00Z' }
  ]
};

const MOCK_SCHEDULER_STATUS = {
  // G1-1/G1-2：mock 同步加 active 字段（pending+running 数；初始全为已完成项）
  // G1-6：预置 1 个 error 条目，演示队列错误可见化（派发失败文案展示）
  queue: { length: 1, active: 0, items: [
    { queueId: 'plan-demo-err', mode: 'yolo', status: 'error', error: 'retrieval_plan 参数非法：characterIds 为空', storyTime: 'ch006.ev008' }
  ] },
  plans: [
    {
      planId: 'plan-01',
      storyTime: 'ch006.ev008',
      mode: 'plan',
      characterIds: ['char-01', 'char-02'],
      outputCount: 3,
      errorCount: 0
    }
  ],
  defaultMode: 'plan'
};

const MOCK_PLAN_DETAILS = {
  'plan-01': {
    planId: 'plan-01', storyTime: 'ch006.ev008', mode: 'plan', characterIds: ['char-01', 'char-02'],
    cast: [
      { characterId: 'char-01', name: '林远航', summary: '年轻的星舰舰长' },
      { characterId: 'char-02', name: '艾莉亚', summary: '神秘的导航员' }
    ],
    outputs: [
      { actor: '林远航', action: '质问商人水晶的来历', thought: '这件遗物与父亲有关', emotion: '警觉', state_changes: [], knowledge_gained: ['共鸣水晶来自旧族'] },
      { actor: '艾莉亚', action: '观察水晶上的旧族纹章', thought: '纹章与自己的身世有关', emotion: '震动', state_changes: [], knowledge_gained: ['商人掌握旧族线索'] }
    ],
    retrievalPlan: { query: '第七星港 艾莉亚 共鸣水晶' }, errors: [],
    stages: [
      { stage: 'planner', agent: '策划代理', status: 'done', durationMs: 4200, provider: 'pi', model: 'default' },
      { stage: 'role', agent: '角色代理', status: 'done', durationMs: 2800, provider: 'pi', model: 'default' }
    ]
  }
};

const MOCK_DEBUG_EVENTS = [
  { id: 'debug-01', ts: 1785640500000, traceId: 'trace-01', stage: 'orchestrator', status: 'start', input: { instruction: '推进第六章' } },
  { id: 'debug-02', ts: 1785640501000, traceId: 'trace-01', stage: 'planner', status: 'start', input: { storyTime: 'ch006.ev008' }, parentId: 'debug-01' },
  { id: 'debug-03', ts: 1785640503000, traceId: 'trace-01', stage: 'planner', status: 'end', output: { eventCount: 3 }, durationMs: 1200, parentId: 'debug-01' },
  { id: 'debug-04', ts: 1785640504000, traceId: 'trace-01', stage: 'role', status: 'start', input: { characterIds: ['char-01', 'char-02'] }, parentId: 'debug-01' },
  { id: 'debug-05', ts: 1785640507000, traceId: 'trace-01', stage: 'role', status: 'end', output: { outputCount: 2 }, durationMs: 2500, parentId: 'debug-01' },
  { id: 'debug-06', ts: 1785640522000, traceId: 'trace-02', stage: 'renderer', status: 'error', input: { chapterPath: '正文/ch007.md' }, durationMs: 30000, error: '模型响应超时' }
];

const MOCK_FILES = [
  { type: 'dir', name: '正文', path: '正文', children: [
    { type: 'file', name: 'ch001.md', path: '正文/ch001.md', mtime: '2026-07-15T12:00:00Z', content: '# 第一章 启程\n\n第七星港的清晨总是带着金属与机油的味道。林远航站在曙光号的舷梯前，手里紧握着父亲留下的遗物箱。' },
    { type: 'file', name: 'ch002.md', path: '正文/ch002.md', mtime: '2026-07-16T10:00:00Z', content: '# 第二章 导航员\n\n艾莉亚的出现像一颗不期而至的流星。' },
    { type: 'file', name: 'ch003.md', path: '正文/ch003.md', mtime: '2026-07-17T15:00:00Z', content: '# 第三章 星图\n\n破碎星图在灯光下泛着幽蓝的光泽。' },
    { type: 'file', name: 'ch006.md', path: '正文/ch006.md', mtime: '2026-08-02T03:15:00Z', content: '# 第六章 星门遗迹\n\n迷雾星云深处，远古星门的轮廓逐渐清晰。' }
  ]},
  { type: 'dir', name: '.pi', path: '.pi', children: [
    { type: 'dir', name: 'world-graph-v3', path: '.pi/world-graph-v3', children: [
      { type: 'file', name: 'world.db', path: '.pi/world-graph-v3/world.db', mtime: '2026-08-02T03:15:00Z', content: '// 世界图数据库二进制文件' }
    ]}
  ]},
  { type: 'file', name: 'novel.json', path: 'novel.json', mtime: '2026-07-15T09:00:00Z', content: '{\n  "name": "星辰之海",\n  "chaptersDir": "正文",\n  "storyTimeFormat": "ch<NNN>.ev<NNN>"\n}' },
  { type: 'file', name: '规则集.md', path: '规则集.md', mtime: '2026-07-15T09:00:00Z', content: '# 渲染规则集\n\n1. 保持第三人称 Limited 视角\n2. 对话自然，避免解释性台词\n3. 每章结尾留悬念钩子' },
  { type: 'file', name: '角色规则集.md', path: '角色规则集.md', mtime: '2026-07-15T09:00:00Z', content: '# 角色规则集\n\n- 林远航：坚定但内心孤独\n- 艾莉亚：神秘、善于观察\n- 老陈：睿智、有牺牲精神' },
  { type: 'file', name: 'planner 规则集.md', path: 'planner 规则集.md', mtime: '2026-07-15T09:00:00Z', content: '# 规划规则集\n\n- 每个事件只聚焦一个核心冲突\n- 保持角色动机一致性\n- 事件之间形成因果链' }
];

const MOCK_LLM_STATUS = {
  default: { configured: { provider: 'pi', model: 'default' }, resolved: { provider: 'pi', model: 'default' }, source: 'slot', hasKey: true },
  planner: { configured: null, resolved: { provider: 'pi', model: 'default' }, source: 'default', hasKey: true },
  role: { configured: null, resolved: { provider: 'pi', model: 'default' }, source: 'default', hasKey: true },
  reasoning: { configured: { provider: 'pi', model: 'reasoning' }, resolved: { provider: 'pi', model: 'reasoning' }, source: 'slot', hasKey: true },
  renderer: { configured: null, resolved: { provider: 'pi', model: 'default' }, source: 'default', hasKey: true }
};

const MOCK_APP_CONFIG = {
  launcher: { defaultScanRoots: ['D:\\novels'] },
  embedder: { model: 'Xenova/all-MiniLM-L6-v2' },
  theme: 'light',
  editorFontSize: 16,
  autosave: true,
  autosaveInterval: 30
};

const MOCK_RULESETS = {
  render: '# 渲染规则集\n\n1. 保持第三人称 Limited 视角\n2. 对话自然，避免解释性台词\n3. 每章结尾留悬念钩子',
  role: '# 角色规则集\n\n- 林远航：坚定但内心孤独\n- 艾莉亚：神秘、善于观察\n- 老陈：睿智、有牺牲精神',
  planner: '# 规划规则集\n\n- 每个事件只聚焦一个核心冲突\n- 保持角色动机一致性\n- 事件之间形成因果链'
};

const MOCK_NOVEL_JSON = {
  name: '星辰之海',
  chaptersDir: '正文',
  storyTimeFormat: 'ch<NNN>.ev<NNN>'
};

const MOCK_ENV_CONFIG = {
  HF_ENDPOINT: '',
  PI_DEBUG: 'on',
  PI_EMBEDDER_MODEL: 'Xenova/all-MiniLM-L6-v2'
};

const MOCK_EMBEDDER_STATUS = {
  model: 'Xenova/all-MiniLM-L6-v2',
  isDefault: true,
  dim: 384,
  cachePresent: true,
  cachePath: '.pi/cache/embedder',
  cacheSizeBytes: 131072
};

const MOCK_VERSION = { local: '2.0.0', remote: '2.0.0', updateAvailable: false };

const MOCK_DOCTOR = {
  checks: [
    { name: 'Node.js', status: 'ok' },
    { name: '世界图数据库', status: 'ok' },
    { name: '模板文件', status: 'ok' },
    { name: '向量缓存', status: 'ok' }
  ],
  failures: 0,
  warnings: 0,
  passed: 4,
  ok: true
};

// 模拟状态（会在运行时被修改）
let activeProject = MOCK_PROJECTS[0];
let currentStoryTime = 'ch005.ev007';
let openFiles = [];
let fileContents = {};
let chatSessions = JSON.parse(JSON.stringify(MOCK_CHAT_SESSIONS));
let chatMessages = JSON.parse(JSON.stringify(MOCK_CHAT_MESSAGES));
let schedulerStatus = JSON.parse(JSON.stringify(MOCK_SCHEDULER_STATUS));
let schedulerPlans = JSON.parse(JSON.stringify(MOCK_PLAN_DETAILS));
let debugEvents = JSON.parse(JSON.stringify(MOCK_DEBUG_EVENTS));
// 应用配置运行态：优先从 localStorage 恢复（刷新后保留主题等偏好），损坏/缺失时回退 mock 默认值
let appConfig = (() => {
  const defaults = JSON.parse(JSON.stringify(MOCK_APP_CONFIG));
  try {
    const saved = JSON.parse(localStorage.getItem('ne-demo-app-config') || 'null');
    if (saved && typeof saved === 'object') return { ...defaults, ...saved };
  } catch (e) { /* 忽略损坏数据 */ }
  return defaults;
})();
let llmStatus = JSON.parse(JSON.stringify(MOCK_LLM_STATUS));
let rulesets = JSON.parse(JSON.stringify(MOCK_RULESETS));
let novelJson = JSON.parse(JSON.stringify(MOCK_NOVEL_JSON));
let envConfig = JSON.parse(JSON.stringify(MOCK_ENV_CONFIG));
let nextEventId = 100;

// 初始化文件内容
function initFileContents() {
  function walk(nodes) {
    for (const node of nodes) {
      if (node.type === 'file') fileContents[node.path] = node.content || '';
      if (node.children) walk(node.children);
    }
  }
  walk(MOCK_FILES);
}
initFileContents();

const storyTimes = ['ch001.ev001', 'ch001.ev002', 'ch002.ev003', 'ch003.ev005', 'ch004.ev006', 'ch005.ev007', 'ch006.ev008'];

# 网页采集配置管理工具

离线版采集配置管理工具，涵盖站点管理、抽取模板编排、代理池配置、限速策略、重试机制、增量采集与数据落盘规则，所有配置持久化到浏览器本地存储。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 站点管理 | `site` | 采集站点 | 站点编号、域名地址、站点类型 |
| 抽取模板 | `template` | 网页模板 | 模板编号、入口地址、列表选择器 |
| 代理池管理 | `proxy` | 代理节点 | 节点编号、代理地址、代理协议 |
| 采集任务 | `spider` | 采集作业 | 作业编号、目标站点、抽取模板 |
| 调度策略 | `schedule` | 调度规则 | 规则编号、关联站点、调度表达式 |
| 反爬对抗 | `antibot` | 对抗策略 | 策略编号、验证码类型、识别服务 |
| 限速控制 | `ratelimit` | 限速配置 | 配置编号、目标站点、每秒请求上限 |
| 失败重试 | `retry` | 重试策略 | 策略编号、关联任务、最大重试次数 |
| 字段映射 | `extractor` | 映射规则 | 规则编号、源字段名称、目标字段名称 |
| 采集流水线 | `pipeline` | 流水线步骤 | 步骤编号、步骤名称、输入数据源 |
| 结果校验 | `validator` | 校验规则 | 规则编号、校验对象、校验类型 |
| 数据落盘 | `storage` | 存储配置 | 配置编号、存储类型、输出路径 |
| 采集监控 | `monitor` | 监控指标 | 指标编号、关联任务、指标名称 |
| 数据清洗 | `cleanse` | 清洗规则 | 规则编号、目标字段、空值替换 |
| 增量采集 | `delta` | 增量游标 | 游标编号、目标站点、增量字段 |
| 数据分发 | `export` | 分发通道 | 通道编号、输出数据集、目标系统 |
| RPA流程 | `rpaflow` | 自动化流程 | 流程编号、目标页面、操作序列 |
| 登录凭证 | `auth` | 凭证配置 | 凭证编号、目标站点、认证方式 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `scraper-config-studio:entries` 这一项，或调用 `resetModule(模块)`。

## 结果校验批次引擎（VAL-51）

结果校验页保存的 VAL-51 规则由独立的批次引擎执行，代码在：

- `frontend/src/data/validation-types.ts`：规则口径版本、校验批次、样例证据、落盘清单类型。
- `frontend/src/data/sample-dataset.ts`：订单支付抽样表（列名 `amount_cents`、`phone_e164`），
  源表 500 行、采样比例 80%（每 5 行抽 4 行），每窗口 250 源行抽 200 行，数据按行号确定性生成。
- `frontend/src/data/validation-store.ts`：引擎持久化（`localStorage` 键
  `scraper-config-studio:validation`），原子读改写。
- `frontend/src/api/validation-service.ts`：生成批次、分块执行、断点恢复、口径版本、阻断同步。

行为约定：

- **幂等生成**：批次键 = 规则 + 口径版本 + 数据窗口指纹，并发/重复提交同一数据只生成一批；
  校验额度按批次台账记账（`quotaLedger[批次号] = 已处理样本数`），重复提交不重复扣减。
- **断点恢复**：批次按 50 行分块执行，每块落账（`nextSampleIndex`）；服务中断（或页面关闭）
  后批次为「已中断」，恢复时从下一样本继续，已判定样本与扣减保持不变。
- **阻断落盘**：异常数超过阈值即置「已阻断」，批次保留最多 10 条样例证据（原行号 + 原值），
  落盘清单同步为「已阻断」，数据落盘页与数据分发页的清单禁止其落盘。
- **口径版本**：判定口径变化生成新版本，生效起始样本 = 下一个未校验源行，只对之后样本使用
  新判定；旧批次的范围边界与判定口径以快照保存，旧证据保留原范围，可逐行复核。
- 引擎单测：`cd frontend && npm test`（vitest，`src/api/validation-service.test.ts`）。

领域：数据工程
子方向：数据采集、爬虫与RPA

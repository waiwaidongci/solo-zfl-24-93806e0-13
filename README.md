# 赛鸽登记站 · 跨棚调运与疫病接触链管控

纯 Node.js（无第三方运行时依赖）实现，数据落 `data/pigeons.json`。

## 运行

```bash
npm start            # http://localhost:3024
PORT=4000 npm start  # 自定义端口
DATA_DIR=/tmp/x npm start  # 自定义数据目录（测试隔离用）
```

右上角可切换演示身份：

| 身份 | 权限 |
| --- | --- |
| 管理员·赵站 | 发起调运、登记确诊、解除观察复核、查审计 |
| 北岸棚 / 南湾棚 / 育种棚经办人 | 处理**发到本棚**的调运单（验收/拒收/退回）、为本棚鸽申请解除观察 |

## 业务规则

**跨棚调运**（`POST /api/shipments`，仅管理员）
- 必须选已建档鸽只、来源棚（须为鸽只当前所在棚）、不同的目标棚，附健康证明编号与检疫有效期（不得早于当天）。
- 一只鸽同一时刻只能有一张进行中（待验收/冻结）的调运单；观察期鸽只禁止调运。
- 发起后鸽只置为「在途」，验收后落地目标棚；拒收退回来源棚；验收后可再退回（须填原因）。
- 状态机：`pending → accepted → returned`；`pending → rejected`；疫病期间 `pending ⇄ frozen`。非法跳转一律 422。
- 目标棚只能操作发给自己的单；每次流转带 `version` 乐观锁，过期版本返回 409。

**疫病接触链**（`POST /api/disease-events`，仅管理员）
- 登记确诊后自动观察：指标鸽 + 同批次 + 同棚（含刚自该棚调出仍在途）+ 显式接触鸽。
- 涉观察鸽只的在途调运单自动冻结，冻结期间禁止任何流转。
- 解除观察须先申请、管理员复核（驳回需意见、回到观察中）；复核通过后相关冻结单自动解冻回待验收。

**审计**：每次变化写入经办人、时间、动作与前后值（`GET /api/audit`，仅管理员；支持 `?entity=&entityId=` 过滤）。

**一致性**：所有写操作经串行写锁执行；校验失败整体回滚不落盘；落盘采用「写临时文件 + rename 原子替换」，不存在半条记录。

## 测试

```bash
npm test                 # API 层：越权/非法跳转/过期证明/并发争抢/回滚/重启持久化（34 项）
node tests/browser.test.mjs   # Playwright 真实浏览器：发起→验收→追踪→冻结→解除（截图存 tests/screenshots）
```

> 极简环境运行浏览器测试若提示缺系统库，已在本机将 arm64 依赖解包到 `/tmp/pwlibs`，用
> `LD_LIBRARY_PATH=/tmp/pwlibs/usr/lib/aarch64-linux-gnu:/tmp/pwlibs/lib/aarch64-linux-gnu node tests/browser.test.mjs`
> 运行（测试服务使用随机端口与独立数据目录，互不干扰）。

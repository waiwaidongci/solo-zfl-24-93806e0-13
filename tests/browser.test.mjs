// 真实浏览器（Chromium）端到端走查：发起、验收、追踪、冻结、解除
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import { createServer } from "node:net";

async function freePort() {
  return new Promise(resolve => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = "/tmp/pigeon-browser-data";
const SHOTS = "/workspace/tests/screenshots";

let server, log = "";
async function startServer() {
  await rm(DATA_DIR, { recursive: true, force: true });
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(SHOTS, { recursive: true });
  server = spawn(process.execPath, ["server.js"], {
    cwd: "/workspace",
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stderr.on("data", d => { log += d; });
  server.on("error", e => { throw e; });
  server.unref();
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + "/api/meta");
      if (r.ok && (await r.json()).users?.length) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server start failed: " + log);
}
function stopServer() { return new Promise(res => { server.on("exit", res); server.kill("SIGTERM"); setTimeout(() => { try { server.kill("SIGKILL"); } catch {} res(); }, 3000).unref(); }); }

let failures = 0;
async function expect(name, cond) {
  if (cond) { console.log("  ✓ " + name); }
  else { failures++; console.log("  ✗ " + name); }
}

await startServer();
const browser = await chromium.launch({ args: ["--disable-gpu", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", e => errors.push(String(e)));
// 统一处理 confirm/prompt：测试通过 onNextDialog 注册下一个弹窗的响应
const dialogQueue = [];
function onNextDialog(fn) { dialogQueue.push(fn); }
page.on("dialog", async d => {
  const h = dialogQueue.shift();
  if (h) return h(d);
  return d.type() === "prompt" ? d.accept("") : d.accept();
});

try {
  console.log("1) 管理员发起调运（CHN-2026-007 北岸→南湾）");
  await page.goto(BASE);
  await page.waitForSelector("#shCreate");
  await page.selectOption("#userSel", "admin");
  await page.selectOption("#shPigeon", "CHN-2026-007");
  await page.selectOption("#shTo", "south");
  await page.fill("#shCert", "HC-2026-0001");
  await page.fill("#shUntil", "2026-12-31");
  // 故意先用过期日期触发一次拒绝
  await page.fill("#shUntil", "2026-01-01");
  await page.click("#shCreate");
  await page.waitForTimeout(150);
  await expect("过期证明被页面拒绝并提示", (await page.locator("#shErr").textContent()).includes("已过期"));
  // 改回有效期后成功发起
  await page.fill("#shUntil", "2026-12-31");
  await page.click("#shCreate");
  await page.waitForTimeout(300);
  const shipBlock = page.locator(".ship", { hasText: "CHN-2026-007" }).first();
  await expect("调运单出现且状态为待验收", await shipBlock.locator(".pill").textContent() === "待验收");
  await expect("时间线含 created", (await shipBlock.textContent()).includes("created"));
  await page.screenshot({ path: `${SHOTS}/1-发起调运.png`, fullPage: true });

  console.log("2) 越权拦截：北岸棚看不到验收按钮；切到南湾棚完成验收");
  await page.selectOption("#userSel", "north");
  await page.waitForTimeout(300);
  const blockAsNorth = page.locator(".ship", { hasText: "CHN-2026-007" }).first();
  await expect("来源棚身份下无验收按钮（越权在 UI 即被屏蔽）", await blockAsNorth.locator('[data-act="accept"]').count() === 0);
  await page.selectOption("#userSel", "south");
  await page.waitForTimeout(300);
  onNextDialog(d => d.accept());
  const blockAsSouth = page.locator(".ship", { hasText: "CHN-2026-007" }).first();
  await blockAsSouth.locator('[data-act="accept"]').click();
  await page.waitForTimeout(400);
  const after = page.locator(".ship", { hasText: "CHN-2026-007" }).first();
  await expect("验收成功，状态已验收", (await after.locator(".pill").first().textContent()) === "已验收");
  await page.click('[data-tab="pigeons"]');
  await expect("鸽只档案显示已落地南湾棚", (await page.locator(".card", { hasText: "CHN-2026-007" }).textContent()).includes("南湾棚"));
  await page.screenshot({ path: `${SHOTS}/2-验收落地.png`, fullPage: true });

  console.log("3) 审计追踪页可查经办人/时间/前后值");
  await page.selectOption("#userSel", "admin");
  await page.waitForTimeout(300);
  await page.click('[data-tab="audit"]');
  await page.waitForSelector("#tab-audit tbody tr", { timeout: 5000 });
  await page.waitForTimeout(200);
  const auditText = await page.locator("#tab-audit").textContent();
  await expect("审计含管理员·赵站 created 与 南湾棚·孙六 accept",
    auditText.includes("管理员·赵站") && auditText.includes("created") && auditText.includes("accept") && auditText.includes("南湾棚·孙六"));
  await page.screenshot({ path: `${SHOTS}/3-审计追踪.png`, fullPage: true });

  console.log("4) 第二张调运 + 管理员登记确诊 → 自动观察、冻结");
  await page.selectOption("#userSel", "admin");
  await page.click('[data-tab="ship"]');
  await page.selectOption("#shPigeon", "CHN-2026-008");
  await page.selectOption("#shTo", "south");
  await page.fill("#shCert", "HC-2026-0002");
  await page.fill("#shUntil", "2026-12-31");
  await page.click("#shCreate");
  await page.waitForTimeout(300);
  await expect("第二张调运单待验收", (await page.locator(".ship", { hasText: "CHN-2026-008" }).first().locator(".pill").first().textContent()) === "待验收");
  // 登记确诊：指标鸽 001，批次 B2026-04（007 同批），008 与指标同棚且在途
  await page.selectOption("#dzPigeon", "CHN-2026-001");
  await page.fill("#dzName", "鸽新城疫");
  await page.fill("#dzBatch", "B2026-04");
  await page.check('#dzContacts input[value="CHN-2023-512"]');
  await page.click("#dzCreate");
  await page.waitForTimeout(400);
  const frozenBlock = page.locator(".ship", { hasText: "CHN-2026-008" }).first();
  await expect("008 调运单显示已冻结", (await frozenBlock.locator(".pill").first().textContent()) === "已冻结");
  await expect("展示冻结原因", (await frozenBlock.textContent()).includes("接触链冻结"));
  await page.selectOption("#userSel", "south");
  await page.waitForTimeout(300);
  const frozenSouth = page.locator(".ship", { hasText: "CHN-2026-008" }).first();
  await expect("冻结状态下南湾棚无验收按钮", await frozenSouth.locator('[data-act="accept"]').count() === 0);
  await page.screenshot({ path: `${SHOTS}/4-疫病冻结.png`, fullPage: true });

  console.log("5) 解除观察需申请+管理员复核，复核后解冻并可验收");
  await page.click('[data-tab="obs"]');
  await page.waitForTimeout(200);
  const obsText0 = await page.locator("#tab-obs").textContent();
  await expect("观察名单含指标鸽001、同批007、同棚008、接触512",
    ["CHN-2026-001", "CHN-2026-007", "CHN-2026-008", "CHN-2023-512"].every(r => obsText0.includes(r)));
  // 南湾棚为 008 申请解除（prompt 填理由）
  onNextDialog(d => d.accept("两次核酸阴性"));
  await page.locator("#tab-obs .ship", { hasText: "CHN-2026-008" }).locator("[data-req]").click();
  await page.waitForTimeout(300);
  const requested = page.locator("#tab-obs .ship", { hasText: "CHN-2026-008" });
  await expect("申请后状态变为待复核", (await requested.locator(".pill").first().textContent()) === "待复核");
  // 棚身份不能复核：无复核按钮
  await expect("南湾棚身份下无复核按钮", await requested.locator("[data-rev]").count() === 0);
  // 管理员复核通过
  await page.selectOption("#userSel", "admin");
  await page.waitForTimeout(300);
  const obsBlock = page.locator("#tab-obs .ship", { hasText: "CHN-2026-008" });
  await obsBlock.locator('[data-cmt]').fill("复核通过，准予解除");
  await obsBlock.locator('[data-rev="approve"]').click();
  await page.waitForTimeout(400);
  await expect("观察状态已解除", (await page.locator("#tab-obs .ship", { hasText: "CHN-2026-008" }).locator(".pill").first().textContent()) === "已解除");
  // 调运单解冻
  await page.click('[data-tab="ship"]');
  const unfrozen = page.locator(".ship", { hasText: "CHN-2026-008" }).first();
  await expect("调运单解冻回到待验收", (await unfrozen.locator(".pill").first().textContent()) === "待验收");
  // 南湾棚验收
  await page.selectOption("#userSel", "south");
  await page.waitForTimeout(300);
  onNextDialog(d => d.accept());
  await page.locator(".ship", { hasText: "CHN-2026-008" }).first().locator('[data-act="accept"]').click();
  await page.waitForTimeout(400);
  await expect("解冻后验收成功，状态已验收", (await page.locator(".ship", { hasText: "CHN-2026-008" }).first().locator(".pill").first().textContent()) === "已验收");
  await page.screenshot({ path: `${SHOTS}/5-解除验收.png`, fullPage: true });

  await expect("浏览器控制台无 JS 报错", errors.length === 0);
  if (errors.length) console.log("    " + errors.join("\n    "));
} catch (e) {
  failures++;
  console.log("  ✗ 走查中断: " + (e.message || e).toString().split("\n").slice(0, 3).join("\n    "));
  await page.screenshot({ path: `${SHOTS}/failure.png`, fullPage: true }).catch(() => {});
}
console.log(`\n${failures === 0 ? "浏览器走查全部通过" : failures + " 项浏览器断言失败"}`);
// 不走 CDP 优雅关闭（headless-shell 在该环境关闭管道时会产生 SIGPIPE）：
// 直接结束子进程树，再按断言结果退出
function killTree(pid) {
  try { process.kill(pid, "SIGKILL"); } catch {}
}
try { if (browser?.process?.()) killTree(browser.process().pid); } catch {}
try { server.kill("SIGKILL"); } catch {}
process.exit(failures ? 1 : 0);

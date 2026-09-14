// API 层验证：非法输入拒绝、越权、并发争抢、回滚完整性、重启持久化
import { spawn } from "node:child_process";
import { rm, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { strict as assert } from "node:assert";
import { createServer } from "node:net";

const freePort = () => new Promise(resolve => {
  const srv = createServer();
  srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = "/tmp/pigeon-test-data";

let server, log = "";
async function startServer(wipe = false) {
  if (wipe) {
    await rm(DATA_DIR, { recursive: true, force: true });
    await mkdir(DATA_DIR, { recursive: true });
  }
  server = spawn(process.execPath, ["server.js"], {
    cwd: "/workspace",
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", d => { log += d; });
  server.stderr.on("data", d => { log += d; });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + "/api/meta"); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server did not start:\n" + log);
}
function stopServer() { return new Promise(res => { if (!server || server.killed) return res(); server.on("exit", res); server.kill("SIGTERM"); }); }

function req(method, path, user, body) {
  return fetch(BASE + path, {
    method,
    headers: { "X-User-Id": user || "admin", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
}
const J = r => r.json();
let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { console.log("  ✗ " + name + "\n    " + (e.message || e).toString().split("\n").join("\n    ")); failures++; }
}
let failures = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- 阶段 A：基础非法输入 / 越权 ---------------- */
async function phaseA() {
  console.log("A. 非法输入与越权拒绝");
  const cert = { healthCertNo: "HC-1", quarantineUntil: "2026-12-31" };

  await check("棚经办人不能发起调运 (403 forbidden)", async () => {
    const r = await req("POST", "/api/shipments", "north", { ringNo: "CHN-2026-008", fromLoftId: "north", toLoftId: "south", ...cert });
    assert.equal(r.status, 403); assert.equal((await J(r)).error, "forbidden");
  });
  await check("未知身份被拒 (401)", async () => {
    const r = await req("POST", "/api/shipments", "ghost", { ringNo: "x", fromLoftId: "a", toLoftId: "b", ...cert });
    assert.equal(r.status, 401);
  });
  await check("过期检疫证明被拒 (422 quarantine_expired)", async () => {
    const r = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-008", fromLoftId: "north", toLoftId: "south", healthCertNo: "HC-x", quarantineUntil: "2026-01-01" });
    assert.equal(r.status, 422); assert.equal((await J(r)).error, "quarantine_expired");
  });
  await check("来源棚与目标棚相同被拒", async () => {
    const r = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-008", fromLoftId: "north", toLoftId: "north", ...cert });
    assert.equal(r.status, 422);
  });
  await check("鸽只不在所选来源棚被拒", async () => {
    const r = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-008", fromLoftId: "breed", toLoftId: "south", ...cert });
    assert.equal(r.status, 422); assert.equal((await J(r)).error, "pigeon_not_in_source");
  });
  await check("未建档鸽只被拒 (404)", async () => {
    const r = await req("POST", "/api/shipments", "admin", { ringNo: "NO-SUCH", fromLoftId: "north", toLoftId: "south", ...cert });
    assert.equal(r.status, 404);
  });
  await check("缺字段被拒 (400)", async () => {
    const r = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-008" });
    assert.equal(r.status, 400);
  });
}

/* ---------------- 阶段 B：正常流程 + 重复验收/非法跳转 ---------------- */
let shipId = null;
async function phaseB() {
  console.log("B. 正常发起→验收→追踪 + 重复验收/非法跳转/越权");
  await check("管理员发起调运成功 (201)", async () => {
    const r = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-007", fromLoftId: "north", toLoftId: "south", healthCertNo: "HC-100", quarantineUntil: "2026-12-31", note: "浏览器外 API 验证" });
    assert.equal(r.status, 201);
    const s = await J(r);
    shipId = s.id;
    assert.equal(s.status, "pending");
    assert.equal(s.version, 1);
  });
  await check("发起后鸽只处于在途（无棚、带在途单）", async () => {
    const ps = (await J(await req("GET", "/api/pigeons", "admin"))).find(p => p.ringNo === "CHN-2026-007");
    assert.equal(ps.loftId, null);
    assert.equal(ps.inTransitShipmentId, shipId);
  });
  await check("同一只鸽重复发起进行中调运被拒 (409)", async () => {
    const r = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-007", fromLoftId: "north", toLoftId: "breed", healthCertNo: "HC-101", quarantineUntil: "2026-12-31" });
    assert.equal(r.status, 409); assert.equal((await J(r)).error, "shipment_already_active");
  });
  await check("来源棚不能验收目标棚的单 (403)", async () => {
    const r = await req("POST", `/api/shipments/${shipId}/accept`, "north", { version: 1 });
    assert.equal(r.status, 403);
  });
  await check("未验收直接退回属非法跳转 (422 illegal_transition)", async () => {
    const r = await req("POST", `/api/shipments/${shipId}/return`, "south", { version: 1, reason: "x" });
    assert.equal(r.status, 422); assert.equal((await J(r)).error, "illegal_transition");
  });
  await check("目标棚验收成功，鸽只落地南湾棚", async () => {
    const r = await req("POST", `/api/shipments/${shipId}/accept`, "south", { version: 1 });
    assert.equal(r.status, 200);
    const s = await J(r);
    assert.equal(s.status, "accepted"); assert.equal(s.version, 2);
    const ps = (await J(await req("GET", "/api/pigeons", "admin"))).find(p => p.ringNo === "CHN-2026-007");
    assert.equal(ps.loftId, "south");
    assert.equal(ps.inTransitShipmentId, null);
  });
  await check("重复验收被拒 (422)", async () => {
    const r = await req("POST", `/api/shipments/${shipId}/accept`, "south", { version: 2 });
    assert.equal(r.status, 422);
  });
  await check("基于旧版本号操作被拒 (409 version_conflict)", async () => {
    const r = await req("POST", `/api/shipments/${shipId}/return`, "south", { version: 1, reason: "旧版本" });
    assert.equal(r.status, 409); assert.equal((await J(r)).error, "version_conflict");
  });
  await check("退回必须填写原因 (400)", async () => {
    const r = await req("POST", `/api/shipments/${shipId}/return`, "south", { version: 2 });
    assert.equal(r.status, 400);
  });
  await check("当前版本退回成功，鸽只回来源棚", async () => {
    const r = await req("POST", `/api/shipments/${shipId}/return`, "south", { version: 2, reason: "复核发现状态不佳" });
    assert.equal(r.status, 200);
    const ps = (await J(await req("GET", "/api/pigeons", "admin"))).find(p => p.ringNo === "CHN-2026-007");
    assert.equal(ps.loftId, "north");
  });
  await check("时间线记录了每次状态变化", async () => {
    const s = (await J(await req("GET", "/api/shipments", "admin"))).find(x => x.id === shipId);
    assert.deepEqual(s.events.map(e => e.action), ["created", "accept", "return"]);
    assert.ok(s.events[2].reason.includes("状态不佳"));
  });
}

/* ---------------- 阶段 C：并发争抢 ---------------- */
async function phaseC() {
  console.log("C. 并发争抢");
  // 先建一张 pending 单（CHN-2026-007 已退回北棚，可重新调运）
  const cr = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-007", fromLoftId: "north", toLoftId: "south", healthCertNo: "HC-C", quarantineUntil: "2026-12-31" });
  assert.equal(cr.status, 201, "setup create failed");
  const id = (await J(cr)).id;

  await check("两个目标棚并发验收：恰一个成功", async () => {
    const [r1, r2] = await Promise.all([
      req("POST", `/api/shipments/${id}/accept`, "south", { version: 1 }),
      req("POST", `/api/shipments/${id}/accept`, "south", { version: 1 })
    ]);
    const codes = [r1.status, r2.status].sort().join(",");
    assert.ok(codes === "200,409" || codes === "200,422", "期望 200+409 或 200+422，实际 " + codes);
    const s = (await J(await req("GET", "/api/shipments", "admin"))).find(x => x.id === id);
    assert.equal(s.version, 2);
    assert.equal(s.events.filter(e => e.action === "accept").length, 1, "只能有一次验收事件");
  });
  await check("对同一鸽并发发起第二张在途单：被唯一约束挡下", async () => {
    // 当前单已 accepted，需一张 pending 单：用另一只鸽 CHN-2026-008
    const results = await Promise.all([
      req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-008", fromLoftId: "north", toLoftId: "south", healthCertNo: "HC-C1", quarantineUntil: "2026-12-31" }),
      req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-008", fromLoftId: "north", toLoftId: "breed", healthCertNo: "HC-C2", quarantineUntil: "2026-12-31" })
    ]);
    const status = results.map(r => r.status).sort().join(",");
    assert.ok(status === "201,409", "期望 201+409，实际 " + status);
    const all = await J(await req("GET", "/api/shipments", "admin"));
    const pending = all.filter(s => s.ringNo === "CHN-2026-008" && ["pending", "frozen"].includes(s.status));
    assert.equal(pending.length, 1, "进行中调运单必须只剩一张");
  });
  return id;
}

/* ---------------- 阶段 D：疫病接触链 / 冻结 / 解除复核 ---------------- */
async function phaseD(acceptedId) {
  console.log("D. 疫病确诊 → 自动观察 → 冻结 → 解除复核");
  // CHN-2026-008 在 north→south 途中(pending)；同批次 B2026-04 的还有 CHN-2026-001/007
  let evId;
  await check("棚经办人不能登记确诊 (403)", async () => {
    const r = await req("POST", "/api/disease-events", "south", { ringNo: "CHN-2026-001", disease: "鸽新城疫" });
    assert.equal(r.status, 403);
  });
  await check("登记确诊：同批次+同棚自动观察，在途单冻结", async () => {
    const r = await req("POST", "/api/disease-events", "admin", { ringNo: "CHN-2026-001", disease: "鸽新城疫", batch: "B2026-04", diagnosedAt: "2026-09-13", contactRingNos: ["CHN-2023-512"] });
    assert.equal(r.status, 201);
    const ev = await J(r); evId = ev.id;
    // 指标 001 + 同批次 007 + 同棚 008 + 额外接触 512
    for (const ring of ["CHN-2026-001", "CHN-2026-007", "CHN-2026-008", "CHN-2023-512"])
      assert.ok(ev.affectedRingNos.includes(ring), ring + " 应在观察链");
    assert.ok(ev.frozenShipmentIds.length >= 1, "应冻结在途调运单");
  });
  await check("008 的在途调运单状态为 frozen", async () => {
    const all = await J(await req("GET", "/api/shipments", "admin"));
    const s = all.find(x => x.ringNo === "CHN-2026-008" && x.status === "frozen");
    assert.ok(s, "冻结单不存在");
    assert.ok(s.freezeReason.includes("鸽新城疫"));
  });
  await check("冻结期间目标棚验收被拒", async () => {
    const all = await J(await req("GET", "/api/shipments", "admin"));
    const s = all.find(x => x.ringNo === "CHN-2026-008" && x.status === "frozen");
    const r = await req("POST", `/api/shipments/${s.id}/accept`, "south", { version: s.version });
    assert.equal(r.status, 422);
  });
  await check("观察期鸽只禁止发起新调运 (423)", async () => {
    const r = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2023-512", fromLoftId: "breed", toLoftId: "south", healthCertNo: "HC-Z", quarantineUntil: "2026-12-31" });
    assert.equal(r.status, 423);
  });
  let obs008;
  await check("棚方申请解除 → 必须管理员复核", async () => {
    const obs = await J(await req("GET", "/api/observations", "admin"));
    obs008 = obs.find(o => o.ringNo === "CHN-2026-008" && o.status === "observing");
    assert.ok(obs008);
    const r1 = await req("POST", `/api/observations/${obs008.id}/review`, "south", { decision: "approve", comment: "越权" });
    assert.equal(r1.status, 403, "棚方不能复核");
    const r2 = await req("POST", `/api/observations/${obs008.id}/request-release`, "south", { comment: "两次核酸阴性" });
    assert.equal(r2.status, 200);
  });
  await check("复核驳回需意见，且回到观察中", async () => {
    const r1 = await req("POST", `/api/observations/${obs008.id}/review`, "admin", { decision: "reject" });
    assert.equal(r1.status, 400, "缺意见应 400");
    const r2 = await req("POST", `/api/observations/${obs008.id}/review`, "admin", { decision: "reject", comment: "再观察一周" });
    assert.equal(r2.status, 200);
    assert.equal((await J(r2)).status, "observing");
  });
  await check("重新申请→复核通过：观察解除，冻结单回到待验收", async () => {
    await req("POST", `/api/observations/${obs008.id}/request-release`, "south", { comment: "复检阴性" });
    const r = await req("POST", `/api/observations/${obs008.id}/review`, "admin", { decision: "approve", comment: "复核通过" });
    assert.equal(r.status, 200);
    assert.equal((await J(r)).status, "released");
    const all = await J(await req("GET", "/api/shipments", "admin"));
    const s = all.find(x => x.ringNo === "CHN-2026-008");
    assert.equal(s.status, "pending", "解冻后应回到待验收");
    // 解冻单可正常验收
    const ar = await req("POST", `/api/shipments/${s.id}/accept`, "south", { version: s.version });
    assert.equal(ar.status, 200);
  });
}

/* ---------------- 阶段 E：回滚完整性 ---------------- */
async function phaseE() {
  console.log("E. 失败回滚——不留下半条记录");
  const before = await J(await req("GET", "/api/shipments", "admin"));
  const beforeCount = before.length;

  await check("同批次含未建档接触鸽：整个确诊事件回滚（无事件、无观察、无冻结）", async () => {
    const obsBefore = (await J(await req("GET", "/api/observations", "admin"))).length;
    const r = await req("POST", "/api/disease-events", "admin", { ringNo: "CHN-2022-188", disease: "毛滴虫", batch: "B2022-01", contactRingNos: ["GHOST-RING"] });
    assert.equal(r.status, 404);
    const ev = await J(await req("GET", "/api/disease-events", "admin"));
    assert.ok(!ev.some(e => e.disease === "毛滴虫"), "失败事件不得入库");
    const obsAfter = (await J(await req("GET", "/api/observations", "admin"))).length;
    assert.equal(obsAfter, obsBefore, "不得产生半截观察记录");
    const ps = (await J(await req("GET", "/api/pigeons", "admin"))).find(p => p.ringNo === "CHN-2022-188");
    assert.equal(ps.underObservation, false, "指标鸽不应被标记观察");
  });
  await check("过期证明发起失败：无调运单、鸽只仍在原棚", async () => {
    const r = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2022-188", fromLoftId: "breed", toLoftId: "north", healthCertNo: "HC-BAD", quarantineUntil: "2020-01-01" });
    assert.equal(r.status, 422);
    const after = await J(await req("GET", "/api/shipments", "admin"));
    assert.equal(after.length, beforeCount, "失败不得新增调运单");
    const ps = (await J(await req("GET", "/api/pigeons", "admin"))).find(p => p.ringNo === "CHN-2022-188");
    assert.equal(ps.loftId, "breed");
    assert.ok(ps.inTransitShipmentId === null || ps.inTransitShipmentId === undefined);
  });
  await check("磁盘文件始终是合法 JSON（原子写）", async () => {
    const raw = await readFile(`${DATA_DIR}/pigeons.json`, "utf8");
    JSON.parse(raw); // 不抛错即可
    assert.ok(!existsSync(`${DATA_DIR}/pigeons.json.tmp`), "临时文件应已 rename 清除");
  });
}

/* ---------------- 阶段 F：审计 + 重启持久化 ---------------- */
async function phaseF() {
  console.log("F. 审计日志（经办人/时间/前后值）与重启持久化");
  await check("非管理员不能读取审计日志", async () => {
    const r = await req("GET", "/api/audit", "north");
    assert.equal(r.status, 403);
  });
  let snapshot;
  await check("审计记录含经办人、时间、前后值", async () => {
    const rows = await J(await req("GET", "/api/audit?entity=shipment", "admin"));
    const created = rows.find(a => a.action === "created");
    assert.ok(created, "存在 created 审计");
    assert.equal(created.actorName, "管理员·赵站");
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(created.at));
    assert.equal(created.before, null);
    assert.equal(created.after.status, "pending");
    const acc = rows.find(a => a.action === "accept");
    assert.equal(acc.before.status, "pending");
    assert.equal(acc.after.status, "accepted");
    snapshot = {
      shipments: (await J(await req("GET", "/api/shipments", "admin"))).length,
      observations: (await J(await req("GET", "/api/observations", "admin"))).length,
      events: (await J(await req("GET", "/api/disease-events", "admin"))).length,
      audit: (await J(await req("GET", "/api/audit", "admin"))).length
    };
  });

  await check("重启后全部数据与状态保持一致", async () => {
    await stopServer();
    await sleep(300);
    await startServer();
    const after = {
      shipments: (await J(await req("GET", "/api/shipments", "admin"))).length,
      observations: (await J(await req("GET", "/api/observations", "admin"))).length,
      events: (await J(await req("GET", "/api/disease-events", "admin"))).length,
      audit: (await J(await req("GET", "/api/audit", "admin"))).length
    };
    assert.deepEqual(after, snapshot);
    // 关键业务状态仍生效：观察期鸽只依然禁止调运
    const r = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-001", fromLoftId: "north", toLoftId: "south", healthCertNo: "HC-R", quarantineUntil: "2026-12-31" });
    assert.equal(r.status, 423, "重启后观察状态应仍生效");
  });
}

(async () => {
  await startServer(true);
  try {
    await phaseA();
    await phaseB();
    await phaseC();
    await phaseD();
    await phaseE();
    await phaseF();
  } finally {
    await stopServer();
  }
  console.log(`\n${failures === 0 ? "全部通过" : failures + " 项失败"}：${passed} passed`);
  process.exit(failures ? 1 : 0);
})();

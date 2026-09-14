import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ? process.env.DATA_DIR : join(__dirname, "data");
const dbPath = join(dataDir, "pigeons.json");
const tmpPath = dbPath + ".tmp";
const port = Number(process.env.PORT || 3024);
const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/* 身份 / 种子数据                                                      */
/* ------------------------------------------------------------------ */
// 演示用固定身份：1 名登记站管理员 + 3 个鸽棚经办人。前端通过 X-User-Id 切换。
const users = [
  { id: "admin", name: "管理员·赵站", role: "admin" },
  { id: "north", name: "北岸棚·钱五", role: "loft", loftId: "north" },
  { id: "south", name: "南湾棚·孙六", role: "loft", loftId: "south" },
  { id: "breed", name: "育种棚·周七", role: "loft", loftId: "breed" }
];

const seed = {
  version: 0,
  lofts: [
    { id: "breed", name: "育种棚" },
    { id: "north", name: "北岸棚" },
    { id: "south", name: "南湾棚" }
  ],
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "北岸棚", loftId: "north", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", batch: "B2026-04", vaccines: [{ date: "2026-04-01", name: "新城疫" }], transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }], races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }] },
    { ringNo: "CHN-2022-188", owner: "育种棚", loftId: "breed", fatherRing: "", motherRing: "", color: "雨点", batch: "B2022-01", vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", loftId: "breed", fatherRing: "", motherRing: "", color: "红轮", batch: "B2023-02", vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2026-007", owner: "北岸棚", loftId: "north", fatherRing: "CHN-2022-188", motherRing: "", color: "雨点", batch: "B2026-04", vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2026-008", owner: "北岸棚", loftId: "north", fatherRing: "", motherRing: "CHN-2023-512", color: "灰白条", batch: "B2026-05", vaccines: [], transfers: [], races: [] }
  ],
  shipments: [],
  diseaseEvents: [],
  observations: [],
  audit: []
};

/* ------------------------------------------------------------------ */
/* 存储：读缓存 + 写互斥锁 + 版本号 + 临时文件原子落盘                    */
/* ------------------------------------------------------------------ */
let cache = null;
let writeChain = Promise.resolve();

async function loadDb() {
  if (cache) return cache;
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  cache = JSON.parse(await readFile(dbPath, "utf8"));
  // 兼容旧库：补齐新集合
  for (const [k, v] of Object.entries(seed)) {
    if (!(k in cache)) cache[k] = Array.isArray(v) ? [] : v;
  }
  return cache;
}

async function persist(db) {
  const snapshot = JSON.stringify(db, null, 2);
  await writeFile(tmpPath, snapshot);   // 写临时文件
  await rename(tmpPath, dbPath);        // 同目录原子替换：失败不会留下半截主库
}

// 所有变更都经由 mutate 串行化：回调内对 db 做全部修改与校验，
// 抛错则不写盘（无半条记录）；返回值原样回传给调用方。
async function mutate(fn) {
  const run = writeChain.then(async () => {
    const db = await loadDb();
    const result = await fn(db);      // 校验失败应 throw HttpError，persist 不会执行
    db.version += 1;
    await persist(db);
    return result;
  });
  // 让链条在本次任务结束后继续，但失败不污染后续请求
  writeChain = run.then(() => {}, () => {});
  return run;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
class HttpError extends Error {
  constructor(status, code, detail) { super(code); this.status = status; this.code = code; this.detail = detail; }
}
function fail(status, code, detail) { throw new HttpError(status, code, detail); }

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return fail(400, "invalid_json");
  }
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function getUser(req) {
  const id = req.headers["x-user-id"] || "admin";
  return users.find(u => u.id === id) || fail(401, "unknown_user");
}
function audit(db, actor, entity, entityId, action, before, after, extra = {}) {
  db.audit.push({
    id: randomUUID(), at: nowIso(), actorId: actor.id, actorName: actor.name,
    entity, entityId, action, before: before ?? null, after: after ?? null, ...extra
  });
}
const SHIP_STATUS = { pending: "待验收", accepted: "已验收", rejected: "已拒收", returned: "已退回", frozen: "已冻结" };
const activeStatuses = new Set(["pending", "frozen"]);
function activeShipmentOf(db, ringNo, exceptId) {
  return db.shipments.find(s => s.ringNo === ringNo && activeStatuses.has(s.status) && s.id !== exceptId);
}
function observePigeon(db, { ringNo, reason, diseaseEventId, sourceShipmentId, actor }) {
  let obs = db.observations.find(o => o.ringNo === ringNo && o.status === "observing");
  if (obs) {
    const before = { status: obs.status, reasons: obs.reasons.map(r => r.reason) };
    obs.reasons.push({ reason, diseaseEventId: diseaseEventId || null, shipmentId: sourceShipmentId || null, at: nowIso() });
    audit(db, actor, "observation", obs.id, "observation_reason_added", before, { status: obs.status, reasons: obs.reasons.map(r => r.reason) }, { ringNo });
    return obs;
  }
  obs = {
    id: randomUUID(), ringNo,
    status: "observing",
    reasons: [{ reason, diseaseEventId: diseaseEventId || null, shipmentId: sourceShipmentId || null, at: nowIso() }],
    requestedAt: null, requestedBy: null,
    reviewedAt: null, reviewedBy: null, reviewComment: "",
    createdAt: nowIso(), createdBy: actor.id
  };
  db.observations.push(obs);
  audit(db, actor, "observation", obs.id, "observation_started", null, { status: "observing", reasons: [reason] }, { ringNo });
  return obs;
}

/* ------------------------------------------------------------------ */
/* 业务动作（均在 mutate 内执行）                                        */
/* ------------------------------------------------------------------ */
function createShipment(db, actor, input) {
  if (actor.role !== "admin") fail(403, "forbidden", "只有登记站管理员可以发起跨棚调运");
  const ringNo = String(input.ringNo || "").trim();
  const fromLoftId = String(input.fromLoftId || "").trim();
  const toLoftId = String(input.toLoftId || "").trim();
  const healthCertNo = String(input.healthCertNo || "").trim();
  const quarantineUntil = String(input.quarantineUntil || "").trim();
  if (!ringNo || !fromLoftId || !toLoftId || !healthCertNo || !quarantineUntil) fail(400, "missing_fields");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(quarantineUntil)) fail(400, "bad_date_format");
  if (quarantineUntil < today()) fail(422, "quarantine_expired", `检疫有效期 ${quarantineUntil} 已过期`);
  const from = db.lofts.find(l => l.id === fromLoftId) || fail(404, "loft_not_found", "来源棚不存在");
  const to = db.lofts.find(l => l.id === toLoftId) || fail(404, "loft_not_found", "目标棚不存在");
  if (from.id === to.id) fail(422, "same_loft", "来源棚与目标棚不能相同");
  const pigeon = db.pigeons.find(p => p.ringNo === ringNo) || fail(404, "pigeon_not_found");
  // 同一只鸽只能有一张进行中的调运单（优先于棚属校验：在途单的鸽 loftId 已为空）
  if (activeShipmentOf(db, ringNo)) fail(409, "shipment_already_active", "该鸽已有进行中的调运单");
  // 处于观察期的鸽只不得发起调运
  if (db.observations.some(o => o.ringNo === ringNo && o.status === "observing"))
    fail(423, "pigeon_under_observation", "该鸽处于疫病观察期，禁止调运");
  // 来源棚必须与鸽只当前所在棚一致，防止凭空调出
  if (pigeon.loftId !== from.id) fail(422, "pigeon_not_in_source", `该鸽当前不在${from.name}`);

  const beforePigeon = { loftId: pigeon.loftId, owner: pigeon.owner };
  const shipment = {
    id: randomUUID(),
    ringNo, fromLoftId, toLoftId, fromName: from.name, toName: to.name,
    healthCertNo, quarantineUntil,
    note: String(input.note || ""),
    status: "pending", version: 1,
    frozenByEventId: null, freezeReason: "",
    events: [{ at: nowIso(), by: actor.id, byName: actor.name, action: "created", fromStatus: null, toStatus: "pending", reason: "" }],
    createdAt: nowIso(), createdBy: actor.id
  };
  db.shipments.push(shipment);
  // 调运发起后鸽只归属“在途”：所在棚标记为 null，验收完成才落地目标棚
  pigeon.loftId = null;
  pigeon.inTransitShipmentId = shipment.id;
  pigeon.transfers.push({ date: today(), from: from.name, to: to.name, shipmentId: shipment.id, state: "in_transit" });
  audit(db, actor, "shipment", shipment.id, "created", null, { status: "pending", ringNo, fromLoftId, toLoftId, healthCertNo, quarantineUntil });
  audit(db, actor, "pigeon", ringNo, "pigeon_dispatched", beforePigeon, { loftId: null, inTransitShipmentId: shipment.id });
  return shipment;
}

function actOnShipment(db, actor, id, action, input = {}) {
  const s = db.shipments.find(x => x.id === id) || fail(404, "shipment_not_found");
  const pigeon = db.pigeons.find(p => p.ringNo === s.ringNo);
  // 目标棚经办人才能验收/拒收/退回；管理员不可代棚操作业务结论
  if (actor.role !== "loft" || actor.loftId !== s.toLoftId)
    fail(403, "forbidden", "只有目标棚经办人可以处理该调运单");
  // 乐观并发：前端须回传它看到的 version
  const expected = input.version === undefined ? null : Number(input.version);
  if (expected !== null && expected !== s.version)
    fail(409, "version_conflict", `单据已被他人更新（服务器版本 ${s.version}）`);

  const reason = String(input.reason || "").trim();
  const legal = {
    accept: { from: ["pending"], to: "accepted" },
    reject: { from: ["pending"], to: "rejected", needReason: true },
    return: { from: ["accepted"], to: "returned", needReason: true }
  }[action] || fail(400, "bad_action");
  if (!legal.from.includes(s.status))
    fail(422, "illegal_transition", `当前状态「${SHIP_STATUS[s.status]}」不能执行该操作（${legal.from.join("/")} → ${legal.to}）`);
  if (legal.needReason && !reason) fail(400, "reason_required", "拒收/退回必须填写原因");

  const beforeS = { status: s.status, version: s.version };
  const beforePigeon = pigeon ? { loftId: pigeon.loftId, owner: pigeon.owner } : null;
  s.status = legal.to;
  s.version += 1;
  s.events.push({ at: nowIso(), by: actor.id, byName: actor.name, action, fromStatus: beforeS.status, toStatus: legal.to, reason });

  const toLoft = db.lofts.find(l => l.id === s.toLoftId);
  const fromLoft = db.lofts.find(l => l.id === s.fromLoftId);
  const transfer = pigeon?.transfers.find(t => t.shipmentId === s.id && t.state === "in_transit");

  if (action === "accept") {
    if (pigeon) {
      pigeon.loftId = s.toLoftId;
      pigeon.owner = toLoft.name;
      pigeon.inTransitShipmentId = null;
    }
    if (transfer) { transfer.state = "landed"; transfer.to = toLoft.name; }
  }
  if (action === "reject") {
    // 拒收：鸽只退回来源棚，在途单关闭
    if (pigeon) {
      pigeon.loftId = s.fromLoftId;
      pigeon.owner = fromLoft.name;
      pigeon.inTransitShipmentId = null;
    }
    if (transfer) { transfer.state = "rejected"; transfer.to = fromLoft.name; }
  }
  if (action === "return") {
    // 验收后退回：鸽只回到来源棚
    if (pigeon) {
      pigeon.loftId = s.fromLoftId;
      pigeon.owner = fromLoft.name;
    }
    if (transfer) { transfer.state = "returned"; transfer.to = fromLoft.name; }
  }
  audit(db, actor, "shipment", s.id, action, beforeS, { status: s.status, version: s.version }, { ringNo: s.ringNo, reason });
  audit(db, actor, "pigeon", s.ringNo, `pigeon_${action}ed`, beforePigeon, pigeon ? { loftId: pigeon.loftId, owner: pigeon.owner } : null);
  return s;
}

function registerDisease(db, actor, input) {
  if (actor.role !== "admin") fail(403, "forbidden", "只有管理员可以登记确诊事件");
  const ringNo = String(input.ringNo || "").trim();
  const disease = String(input.disease || "").trim();
  const batch = String(input.batch || "").trim();
  let contactRingNos = Array.isArray(input.contactRingNos) ? input.contactRingNos.map(String) : [];
  if (!ringNo || !disease) fail(400, "missing_fields");
  const indexPigeon = db.pigeons.find(p => p.ringNo === ringNo) || fail(404, "pigeon_not_found");
  // 接触环号必须全部已建档
  for (const r of contactRingNos) if (!db.pigeons.some(p => p.ringNo === r)) fail(404, "contact_not_found", `接触鸽 ${r} 未建档`);

  const ev = {
    id: randomUUID(),
    indexRingNo: ringNo, disease, batch,
    diagnosedAt: String(input.diagnosedAt || today()),
    note: String(input.note || ""),
    affectedRingNos: [],
    frozenShipmentIds: [],
    createdAt: nowIso(), createdBy: actor.id
  };
  db.diseaseEvents.push(ev);
  audit(db, actor, "diseaseEvent", ev.id, "disease_confirmed", null, { indexRingNo: ringNo, disease, batch });

  // 接触链 = 同批次 + 显式接触者 + 与指标鸽有在途/近期调运接触的鸽只（去重、不含指标鸽本身）
  const chain = new Set(contactRingNos);
  if (batch) for (const p of db.pigeons) if (p.batch === batch && p.ringNo !== ringNo) chain.add(p.ringNo);
  // 与指标鸽同棚且未在途的同棚鸽视为密切接触；
  // 刚从指标鸽所在棚调出、仍在途（pending/frozen）的鸽只同样纳入
  const inTransitFromSameLoft = new Set();
  for (const sh of db.shipments) {
    if (activeStatuses.has(sh.status) && sh.fromLoftId === indexPigeon.loftId) inTransitFromSameLoft.add(sh.ringNo);
  }
  if (indexPigeon.loftId)
    for (const p of db.pigeons)
      if ((p.loftId === indexPigeon.loftId || inTransitFromSameLoft.has(p.ringNo)) && p.ringNo !== ringNo) chain.add(p.ringNo);
  chain.delete(ringNo);

  // 指标鸽本身与接触链全部进入观察
  observePigeon(db, { ringNo, reason: `确诊（${disease}）指标鸽`, diseaseEventId: ev.id, actor });
  for (const r of chain) {
    const cp = db.pigeons.find(p => p.ringNo === r);
    let why = "确诊接触链";
    if (cp && batch && cp.batch === batch) why = `同批次 ${batch}`;
    else if (cp && cp.loftId === indexPigeon.loftId) why = `同棚（${db.lofts.find(l => l.id === indexPigeon.loftId)?.name || indexPigeon.loftId}）接触`;
    else if (inTransitFromSameLoft.has(r)) why = `近期自同棚调出、在途接触`;
    observePigeon(db, { ringNo: r, reason: why, diseaseEventId: ev.id, actor });
  }
  ev.affectedRingNos = [ringNo, ...chain];

  // 冻结相关调运：涉及这些鸽只的一切在途单（pending/frozen），禁止验收流转
  for (const sh of db.shipments) {
    if (activeStatuses.has(sh.status) && ev.affectedRingNos.includes(sh.ringNo)) {
      const before = { status: sh.status, version: sh.version };
      sh.status = "frozen";
      sh.frozenByEventId = ev.id;
      sh.freezeReason = `确诊事件 ${disease} 接触链冻结`;
      sh.version += 1;
      sh.events.push({ at: nowIso(), by: actor.id, byName: actor.name, action: "frozen", fromStatus: before.status, toStatus: "frozen", reason: sh.freezeReason });
      ev.frozenShipmentIds.push(sh.id);
      audit(db, actor, "shipment", sh.id, "frozen", before, { status: "frozen", version: sh.version }, { ringNo: sh.ringNo, diseaseEventId: ev.id });
    }
  }
  return ev;
}

function requestRelease(db, actor, id, input = {}) {
  const o = db.observations.find(x => x.id === id) || fail(404, "observation_not_found");
  if (o.status !== "observing") fail(422, "illegal_transition", "只有观察中的记录可以申请解除");
  // 棚经办人只能为本棚鸽只申请；在途/刚调入的鸽只，来源棚或目标棚均可发起；指标鸽确诊须管理员
  const pigeon = db.pigeons.find(p => p.ringNo === o.ringNo);
  const isIndex = db.diseaseEvents.some(e => e.indexRingNo === o.ringNo);
  if (actor.role === "loft") {
    if (isIndex) fail(403, "forbidden", "确诊指标鸽的解除须由管理员办理");
    const myLoft = db.lofts.find(l => l.id === actor.loftId);
    const tied = pigeon && (pigeon.loftId === actor.loftId || pigeon.owner === myLoft?.name ||
      db.shipments.some(sh => sh.ringNo === o.ringNo && (sh.fromLoftId === actor.loftId || sh.toLoftId === actor.loftId)));
    if (!tied) fail(403, "forbidden", "只能为本棚或本棚调运相关鸽只申请解除观察");
  }
  const before = { status: o.status };
  o.status = "release_requested";
  o.requestedAt = nowIso();
  o.requestedBy = actor.id;
  o.requestComment = String(input.comment || "").trim();
  audit(db, actor, "observation", o.id, "release_requested", before, { status: o.status, requestedBy: actor.id }, { ringNo: o.ringNo });
  return o;
}

function reviewRelease(db, actor, id, input = {}) {
  if (actor.role !== "admin") fail(403, "forbidden", "解除观察须经管理员复核");
  const o = db.observations.find(x => x.id === id) || fail(404, "observation_not_found");
  if (o.status !== "release_requested") fail(422, "illegal_transition", "该记录尚未申请解除或已复核");
  const approve = input.decision === "approve";
  const reject = input.decision === "reject";
  if (!approve && !reject) fail(400, "bad_decision");
  const comment = String(input.comment || "").trim();
  if (!comment) fail(400, "comment_required", "复核必须填写意见");
  const before = { status: o.status };
  o.status = approve ? "released" : "observing";
  o.reviewedAt = nowIso();
  o.reviewedBy = actor.id;
  o.reviewComment = comment;
  audit(db, actor, "observation", o.id, approve ? "release_approved" : "release_rejected", before, { status: o.status, reviewComment: comment }, { ringNo: o.ringNo });

  // 解除观察且该鸽没有其它观察记录时：若其存在因疫病冻结的调运单，按事件解除冻结回到待验收（仍需目标棚自行验收）
  if (approve) {
    const stillObserving = db.observations.some(x => x.ringNo === o.ringNo && x.status === "observing");
    if (!stillObserving) {
      for (const sh of db.shipments) {
        if (sh.status === "frozen" && sh.ringNo === o.ringNo) {
          const beforeS = { status: sh.status, version: sh.version };
          sh.status = "pending";
          sh.frozenByEventId = null;
          sh.freezeReason = "";
          sh.version += 1;
          sh.events.push({ at: nowIso(), by: actor.id, byName: actor.name, action: "unfrozen", fromStatus: "frozen", toStatus: "pending", reason: `观察解除复核通过：${comment}` });
          audit(db, actor, "shipment", sh.id, "unfrozen", beforeS, { status: "pending", version: sh.version }, { ringNo: sh.ringNo, observationId: o.id });
        }
      }
    }
  }
  return o;
}

function createPigeon(db, actor, input) {
  const ringNo = String(input.ringNo || "").trim();
  if (!ringNo) fail(400, "missing_fields", "足环号必填");
  if (db.pigeons.some(p => p.ringNo === ringNo)) fail(409, "ring_exists");
  const pigeon = {
    ringNo,
    owner: String(input.owner || ""),
    loftId: actor.role === "loft" ? actor.loftId : (String(input.loftId || "") || null),
    fatherRing: String(input.fatherRing || ""),
    motherRing: String(input.motherRing || ""),
    color: String(input.color || ""),
    batch: String(input.batch || ""),
    vaccines: [], transfers: [], races: [],
    inTransitShipmentId: null
  };
  if (pigeon.loftId && !db.lofts.some(l => l.id === pigeon.loftId)) fail(400, "bad_loft");
  db.pigeons.unshift(pigeon);
  audit(db, actor, "pigeon", ringNo, "created", null, { ringNo, owner: pigeon.owner, loftId: pigeon.loftId, batch: pigeon.batch });
  return pigeon;
}

/* ------------------------------------------------------------------ */
/* HTTP 路由                                                            */
/* ------------------------------------------------------------------ */
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  if (req.method === "GET" && p === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }
  if (p === "/api/meta" && req.method === "GET") {
    const db = await loadDb();
    return sendJson(res, 200, { users, lofts: db.lofts, today: today() });
  }
  if (p === "/api/pigeons" && req.method === "GET") {
    const db = await loadDb();
    const obs = new Set(db.observations.filter(o => o.status === "observing").map(o => o.ringNo));
    return sendJson(res, 200, db.pigeons.map(x => ({ ...x, underObservation: obs.has(x.ringNo) })));
  }
  if (p === "/api/shipments" && req.method === "GET") {
    const db = await loadDb();
    return sendJson(res, 200, db.shipments);
  }
  if (p === "/api/disease-events" && req.method === "GET") {
    const db = await loadDb();
    return sendJson(res, 200, db.diseaseEvents);
  }
  if (p === "/api/observations" && req.method === "GET") {
    const db = await loadDb();
    return sendJson(res, 200, db.observations);
  }
  if (p === "/api/audit" && req.method === "GET") {
    const actor = getUser(req);
    if (actor.role !== "admin") fail(403, "forbidden", "审计日志仅管理员可查");
    const db = await loadDb();
    const entity = url.searchParams.get("entity");
    const entityId = url.searchParams.get("entityId");
    let rows = db.audit;
    if (entity) rows = rows.filter(a => a.entity === entity);
    if (entityId) rows = rows.filter(a => a.entityId === entityId);
    return sendJson(res, 200, rows.slice(-300).reverse());
  }

  // 以下均为写操作，需要身份
  const actor = getUser(req);

  if (p === "/api/pigeons" && req.method === "POST") {
    const input = await readBody(req);
    const pigeon = await mutate(db => createPigeon(db, actor, input));
    return sendJson(res, 201, pigeon);
  }
  if (p === "/api/shipments" && req.method === "POST") {
    const input = await readBody(req);
    const s = await mutate(db => createShipment(db, actor, input));
    return sendJson(res, 201, s);
  }
  const shipAction = p.match(/^\/api\/shipments\/([^/]+)\/(accept|reject|return)$/);
  if (shipAction && req.method === "POST") {
    const input = await readBody(req);
    const s = await mutate(db => actOnShipment(db, actor, decodeURIComponent(shipAction[1]), shipAction[2], input));
    return sendJson(res, 200, s);
  }
  if (p === "/api/disease-events" && req.method === "POST") {
    const input = await readBody(req);
    const ev = await mutate(db => registerDisease(db, actor, input));
    return sendJson(res, 201, ev);
  }
  const obsAction = p.match(/^\/api\/observations\/([^/]+)\/(request-release|review)$/);
  if (obsAction && req.method === "POST") {
    const input = await readBody(req);
    const o = await mutate(db => obsAction[2] === "request-release"
      ? requestRelease(db, actor, decodeURIComponent(obsAction[1]), input)
      : reviewRelease(db, actor, decodeURIComponent(obsAction[1]), input));
    return sendJson(res, 200, o);
  }
  if (p === "/api/_reset" && req.method === "POST") {
    // 仅测试环境使用：恢复种子库
    cache = null;
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    cache = JSON.parse(await readFile(dbPath, "utf8"));
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: "not_found" });
}

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (error) {
    if (error instanceof HttpError) return sendJson(res, error.status, { error: error.code, detail: error.detail });
    sendJson(res, 500, { error: "internal_error", detail: error.message });
  }
});

server.listen(port, () => console.log(`Racing pigeon registry app listening on http://localhost:${port}`));

/* ------------------------------------------------------------------ */
/* 前端页面                                                            */
/* ------------------------------------------------------------------ */
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>赛鸽登记站 · 跨棚调运与疫病管控</title>
<style>
:root{--bg:#eef1f5;--panel:#fff;--ink:#1f2833;--muted:#667585;--line:#d3dde6;--accent:#2f5f86;--red:#9c3f37;--amber:#9a6b1f;--green:#2f6d4b;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 Arial,"PingFang SC",sans-serif}
header{padding:16px 24px;background:#fff;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
h1{margin:0;font-size:21px}h2{margin:0 0 10px;font-size:16px}h3{margin:0;font-size:15px}
main{padding:18px 24px;display:grid;grid-template-columns:360px 1fr;gap:16px;align-items:start}
.panel,.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px}
.col{display:grid;gap:16px}label{display:block;margin:8px 0 3px;color:var(--muted);font-size:12px}
input,select,textarea{width:100%;border:1px solid var(--line);border-radius:7px;padding:8px;font:inherit}
button{border:0;border-radius:7px;background:var(--accent);color:#fff;padding:8px 12px;font-weight:700;cursor:pointer}
button.ghost{background:#e7edf2;color:var(--ink)}button.red{background:var(--red)}button.green{background:var(--green)}button.amber{background:var(--amber)}
button:disabled{opacity:.45;cursor:not-allowed}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:12px;background:#f6f8fa}
.pill.pending{color:var(--amber);border-color:var(--amber)}.pill.accepted,.pill.released{color:var(--green);border-color:var(--green)}
.pill.rejected,.pill.returned{color:var(--muted)}.pill.frozen,.pill.observing{color:var(--red);border-color:var(--red)}
.pill.requested{color:var(--accent);border-color:var(--accent)}
.meta{color:var(--muted);font-size:12px}.ship{display:grid;gap:8px;border-left:4px solid var(--line);padding-left:12px;margin:10px 0}
.ship.frozen{border-left-color:var(--red)}.ship.pending{border-left-color:var(--amber)}.ship.accepted{border-left-color:var(--green)}
.timeline{margin:6px 0 0;padding-left:18px}.timeline li{font-size:12px;color:var(--muted)}.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.tabs button{background:#e7edf2;color:var(--ink)}.tabs button.on{background:var(--accent);color:#fff}
.err{color:var(--red);font-size:12px;min-height:16px}.ok{color:var(--green);font-size:12px}
.tagobs{color:var(--red);font-weight:700}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
details{margin-top:8px}summary{cursor:pointer;font-weight:700}table{width:100%;border-collapse:collapse;font-size:12px}
td,th{border-bottom:1px solid var(--line);padding:5px 6px;text-align:left;vertical-align:top}
.chk{display:flex;flex-wrap:wrap;gap:6px}.chk label{display:flex;gap:4px;align-items:center;margin:0;border:1px solid var(--line);border-radius:999px;padding:3px 9px;font-size:12px;color:var(--ink)}
.chk input{width:auto}
@media(max-width:960px){main{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <div><h1>赛鸽登记站 · 跨棚调运与疫病接触链管控</h1><div class="meta" id="whoami"></div></div>
  <div class="row">
    <label style="margin:0">当前身份</label>
    <select id="userSel" style="width:auto"></select>
    <button class="ghost" id="reload">刷新</button>
  </div>
</header>
<main>
  <div class="col">
    <section class="panel">
      <h2>① 发起跨棚调运 <span class="meta">（管理员）</span></h2>
      <label>选择已建档鸽只</label><select id="shPigeon"></select>
      <div class="row"><div style="flex:1"><label>来源棚</label><select id="shFrom"></select></div><div style="flex:1"><label>目标棚</label><select id="shTo"></select></div></div>
      <label>健康证明编号</label><input id="shCert" placeholder="如 HC-2026-0913">
      <label>检疫有效期（不得早于今天）</label><input id="shUntil" type="date">
      <label>备注</label><input id="shNote">
      <div class="row" style="margin-top:10px"><button id="shCreate">发起调运</button></div>
      <div class="err" id="shErr"></div>
    </section>
    <section class="panel">
      <h2>② 疫病确诊登记 <span class="meta">（管理员）</span></h2>
      <label>确诊鸽（指标鸽）</label><select id="dzPigeon"></select>
      <div class="row"><div style="flex:1"><label>疫病名称</label><input id="dzName" placeholder="如 鸽新城疫"></div><div style="flex:1"><label>批次号</label><input id="dzBatch" placeholder="留空则不按批次扩散"></div></div>
      <label>额外接触鸽（同批次与同棚自动纳入）</label><div class="chk" id="dzContacts"></div>
      <div class="row" style="margin-top:10px"><button class="red" id="dzCreate">登记确诊并冻结</button></div>
      <div class="err" id="dzErr"></div>
    </section>
  </div>
  <div class="col">
    <section class="panel">
      <div class="tabs">
        <button data-tab="ship" class="on">调运单</button>
        <button data-tab="obs">观察名单</button>
        <button data-tab="dz">确诊事件</button>
        <button data-tab="pigeons">鸽只档案</button>
        <button data-tab="audit">审计追踪</button>
      </div>
      <div id="msg" class="meta"></div>
      <div id="tab-ship"></div>
      <div id="tab-obs" hidden></div>
      <div id="tab-dz" hidden></div>
      <div id="tab-pigeons" hidden></div>
      <div id="tab-audit" hidden></div>
    </section>
  </div>
</main>
<script>
let me = null, meta = { users: [], lofts: [] }, state = { pigeons: [], shipments: [], observations: [], disease: [], audit: [] };
const $ = s => document.querySelector(s);
function esc(s){ return String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
async function api(path, opt = {}) {
  const headers = { "X-User-Id": me.id };
  if (opt.body) { headers["Content-Type"] = "application/json"; }
  const res = await fetch(path, { ...opt, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error((data && data.detail) || (data && data.error) || "请求失败"); e.code = data && data.error; throw e; }
  return data;
}
function toast(ok, text){ const m = $("#msg"); m.className = ok ? "ok" : "err"; m.textContent = (ok ? "✓ " : "✗ ") + text; }
function loftName(id){ return (meta.lofts.find(l => l.id === id) || {}).name || id || "在途/未指定"; }
function pigeon(ring){ return state.pigeons.find(p => p.ringNo === ring); }

async function refresh() {
  state.pigeons = await api("/api/pigeons");
  state.shipments = await api("/api/shipments");
  state.observations = await api("/api/observations");
  state.disease = await api("/api/disease-events");
  if (me.role === "admin") { try { state.audit = await api("/api/audit"); } catch { state.audit = []; } }
  renderAll();
}
function renderAll() {
  renderSelects(); renderShipments(); renderObservations(); renderDisease(); renderPigeons(); renderAudit();
}
function setSelectIfValid(el, value) {
  if (value && [...el.options].some(o => o.value === value)) el.value = value;
}
function renderSelects() {
  // 保留用户已选值：异步 refresh 重渲染时不能把表单重置成第一项
  const prevPigeon = $("#shPigeon").value, prevFrom = $("#shFrom").value, prevTo = $("#shTo").value;
  const prevDzPigeon = $("#dzPigeon").value;
  const prevContacts = [...document.querySelectorAll('#dzContacts input:checked')].map(x => x.value);
  const free = state.pigeons.filter(p => !p.inTransitShipmentId);
  const opts = list => list.map(p => '<option value="'+esc(p.ringNo)+'">'+esc(p.ringNo)+' · '+esc(p.color||"")+' · '+esc(loftName(p.loftId))+'</option>').join("");
  $("#shPigeon").innerHTML = opts(free);
  $("#dzPigeon").innerHTML = opts(state.pigeons);
  $("#shFrom").innerHTML = meta.lofts.map(l => '<option value="'+l.id+'">'+esc(l.name)+'</option>').join("");
  $("#shTo").innerHTML = meta.lofts.map(l => '<option value="'+l.id+'">'+esc(l.name)+'</option>').join("");
  setSelectIfValid($("#shPigeon"), prevPigeon);
  setSelectIfValid($("#dzPigeon"), prevDzPigeon);
  // 来源棚跟随所选鸽只所在棚；目标棚保留已选（且不能与来源棚相同）
  const p = pigeon($("#shPigeon").value);
  if (p && p.loftId) $("#shFrom").value = p.loftId; else setSelectIfValid($("#shFrom"), prevFrom);
  setSelectIfValid($("#shTo"), prevTo);
  if ($("#shTo").value === $("#shFrom").value) {
    const other = meta.lofts.find(l => l.id !== $("#shFrom").value);
    if (other) $("#shTo").value = other.id;
  }
  $("#dzContacts").innerHTML = state.pigeons.map(p => '<label><input type="checkbox" value="'+esc(p.ringNo)+'"> '+esc(p.ringNo)+'</label>').join("");
  prevContacts.forEach(r => { const c = document.querySelector('#dzContacts input[value="'+CSS.escape(r)+'"]'); if (c) c.checked = true; });
}
function timeline(s){
  return '<ul class="timeline">' + s.events.map(e => '<li>'+esc(e.at.slice(0,16).replace("T"," "))+' '+esc(e.byName)+'：'+esc(e.action)+(e.reason?'（'+esc(e.reason)+'）':'')+'</li>').join("") + '</ul>';
}
function renderShipments() {
  const box = $("#tab-ship");
  if (!state.shipments.length) { box.innerHTML = '<p class="meta">暂无调运单。</p>'; return; }
  box.innerHTML = state.shipments.slice().reverse().map(s => {
    const canHandle = me.role === "loft" && me.loftId === s.toLoftId;
    const frozen = s.status === "frozen";
    let actions = "";
    if (canHandle && s.status === "pending")
      actions = '<div class="row"><button class="green" data-act="accept" data-id="'+s.id+'" data-ver="'+s.version+'">验收</button><button class="red" data-act="reject" data-id="'+s.id+'" data-ver="'+s.version+'">拒收</button></div><input data-reason="'+s.id+'" placeholder="拒收原因（必填）">';
    if (canHandle && s.status === "accepted")
      actions = '<input data-reason="'+s.id+'" placeholder="退回原因（必填）"><div class="row" style="margin-top:6px"><button class="amber" data-act="return" data-id="'+s.id+'" data-ver="'+s.version+'">退回来源棚</button></div>';
    if (frozen) actions = '<div class="meta tagobs">⛔ 已因疫病冻结，禁止验收流转</div>';
    return '<div class="ship '+s.status+'"><div class="row" style="justify-content:space-between"><b>'+esc(s.ringNo)+'</b><span class="pill '+s.status+'">'+
      {pending:"待验收",accepted:"已验收",rejected:"已拒收",returned:"已退回",frozen:"已冻结"}[s.status]+'</span></div>'+
      '<div class="meta">'+esc(s.fromName)+' → '+esc(s.toName)+' ｜ 证明 '+esc(s.healthCertNo)+' ｜ 检疫有效期至 '+esc(s.quarantineUntil)+' ｜ 版本 v'+s.version+'</div>'+
      (s.freezeReason ? '<div class="meta tagobs">冻结原因：'+esc(s.freezeReason)+'</div>' : '') + actions + timeline(s) + '</div>';
  }).join("");
  box.querySelectorAll("[data-act]").forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.id, reason = document.querySelector('[data-reason="'+id+'"]')?.value || "";
    const labels = { accept: "确认验收？鸽只将落地本棚。", reject: "确认拒收？鸽只退回来源棚。", return: "确认退回？鸽只退回来源棚。" };
    if (!confirm(labels[btn.dataset.act])) return;
    try {
      await api("/api/shipments/"+encodeURIComponent(id)+"/"+btn.dataset.act, { method:"POST", body: JSON.stringify({ version: Number(btn.dataset.ver), reason }) });
      toast(true, "操作成功"); await refresh();
    } catch (e) { toast(false, e.message); }
  });
}
function renderObservations() {
  const box = $("#tab-obs");
  if (!state.observations.length) { box.innerHTML = '<p class="meta">暂无观察记录。</p>'; return; }
  box.innerHTML = state.observations.slice().reverse().map(o => {
    const p = pigeon(o.ringNo);
    const label = { observing:"观察中", release_requested:"待复核", released:"已解除" }[o.status];
    let act = "";
    if (o.status === "observing") act = '<button class="ghost" data-req="'+o.id+'">申请解除</button>';
    if (o.status === "release_requested" && me.role === "admin")
      act = '<div class="row"><input data-cmt="'+o.id+'" placeholder="复核意见（必填）" style="flex:1"><button class="green" data-rev="approve" data-id="'+o.id+'">复核通过</button><button class="red" data-rev="reject" data-id="'+o.id+'">驳回</button></div>';
    return '<div class="ship '+(o.status==="observing"?"frozen":o.status==="released"?"accepted":"")+'"><div class="row" style="justify-content:space-between"><b>'+esc(o.ringNo)+'</b><span class="pill '+
      (o.status==="observing"?"observing":o.status==="released"?"released":"requested")+'">'+label+'</span></div>'+
      '<div class="meta">现棚：'+esc(p ? loftName(p.loftId) : "?")+' ｜ 事由：'+esc(o.reasons.map(r=>r.reason).join("；"))+'</div>'+
      (o.reviewComment ? '<div class="meta">复核意见：'+esc(o.reviewComment)+'</div>':'')+act+'</div>';
  }).join("");
  box.querySelectorAll("[data-req]").forEach(b => b.onclick = async () => {
    const cmt = prompt("申请解除理由（可留空）：") || "";
    try { await api("/api/observations/"+b.dataset.req+"/request-release", { method:"POST", body: JSON.stringify({ comment: cmt }) }); toast(true,"已提交，待管理员复核"); await refresh(); }
    catch (e) { toast(false, e.message); }
  });
  box.querySelectorAll("[data-rev]").forEach(b => b.onclick = async () => {
    const id = b.dataset.id, cmt = document.querySelector('[data-cmt="'+id+'"]').value;
    try { await api("/api/observations/"+id+"/review", { method:"POST", body: JSON.stringify({ decision: b.dataset.rev, comment: cmt }) }); toast(true,"复核完成"); await refresh(); }
    catch (e) { toast(false, e.message); }
  });
}
function renderDisease() {
  $("#tab-dz").innerHTML = state.disease.length ? state.disease.slice().reverse().map(e =>
    '<div class="ship frozen"><b>'+esc(e.disease)+'</b> <span class="meta">指标鸽 '+esc(e.indexRingNo)+(e.batch?' · 批次 '+esc(e.batch):"")+' · '+esc(e.diagnosedAt)+'</span>'+
    '<div class="meta">观察 '+e.affectedRingNos.length+' 只：'+esc(e.affectedRingNos.join("、"))+'</div>'+
    '<div class="meta">冻结调运单 '+e.frozenShipmentIds.length+' 张：'+esc(e.frozenShipmentIds.join("、")||"无")+'</div></div>').join("")
    : '<p class="meta">暂无确诊事件。</p>';
}
function renderPigeons() {
  $("#tab-pigeons").innerHTML = '<div class="grid">' + state.pigeons.map(p =>
    '<div class="card"><h3>'+esc(p.ringNo)+(p.underObservation?' <span class="pill observing">观察中</span>':'')+'</h3>'+
    '<div class="meta">'+esc(p.color||"")+' · 批次 '+esc(p.batch||"无")+'</div>'+
    '<div>所在棚：'+(p.inTransitShipmentId?'<span class="pill pending">在途</span>':esc(loftName(p.loftId)))+'</div>'+
    '<div class="meta">父 '+esc(p.fatherRing||"未登记")+' / 母 '+esc(p.motherRing||"未登记")+'</div></div>').join("") + '</div>';
}
function renderAudit() {
  const box = $("#tab-audit");
  if (me.role !== "admin") { box.innerHTML = '<p class="meta">审计日志仅管理员可见。</p>'; return; }
  if (!state.audit.length) { box.innerHTML = '<p class="meta">暂无审计记录。</p>'; return; }
  box.innerHTML = '<table><thead><tr><th>时间</th><th>经办人</th><th>对象</th><th>动作</th><th>前值 → 后值</th></tr></thead><tbody>' +
    state.audit.map(a => '<tr><td class="meta">'+esc(a.at.slice(0,19).replace("T"," "))+'</td><td>'+esc(a.actorName)+'</td><td>'+esc(a.entity)+":"+esc(a.entityId)+'</td><td>'+esc(a.action)+'</td><td class="meta">'+esc(JSON.stringify(a.before))+' → '+esc(JSON.stringify(a.after))+'</td></tr>').join("") + '</tbody></table>';
}

$("#userSel").onchange = async e => { me = meta.users.find(u => u.id === e.target.value); localStorage.userId = me.id; await refresh(); };
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => {
  document.querySelectorAll(".tabs button").forEach(x => x.classList.remove("on")); b.classList.add("on");
  ["ship","obs","dz","pigeons","audit"].forEach(t => $("#tab-"+t).hidden = t !== b.dataset.tab);
});
$("#shCreate").onclick = async () => {
  const contacts = [...document.querySelectorAll("#dzContacts input:checked")].map(x => x.value);
  try {
    await api("/api/shipments", { method:"POST", body: JSON.stringify({
      ringNo: $("#shPigeon").value, fromLoftId: $("#shFrom").value, toLoftId: $("#shTo").value,
      healthCertNo: $("#shCert").value, quarantineUntil: $("#shUntil").value, note: $("#shNote").value }) });
    $("#shErr").textContent = ""; toast(true,"调运单已创建"); await refresh();
  } catch (e) { $("#shErr").textContent = e.message; toast(false, e.message); }
};
$("#dzCreate").onclick = async () => {
  const contacts = [...document.querySelectorAll("#dzContacts input:checked")].map(x => x.value);
  try {
    await api("/api/disease-events", { method:"POST", body: JSON.stringify({
      ringNo: $("#dzPigeon").value, disease: $("#dzName").value, batch: $("#dzBatch").value, contactRingNos: contacts }) });
    $("#dzErr").textContent = ""; toast(true,"已登记，接触链进入观察，相关调运冻结"); await refresh();
  } catch (e) { $("#dzErr").textContent = e.message; toast(false, e.message); }
};
$("#reload").onclick = refresh;
(async function init(){
  meta = await (await fetch("/api/meta")).json();
  $("#userSel").innerHTML = meta.users.map(u => '<option value="'+u.id+'">'+esc(u.name)+'（'+(u.role==="admin"?"管理员":u.name)+'）</option>').join("");
  me = meta.users.find(u => u.id === localStorage.userId) || meta.users[0];
  $("#userSel").value = me.id; $("#shUntil").value = meta.today;
  $("#whoami").textContent = "当前：" + me.name;
  await refresh();
})();
</script>
</body>
</html>`;

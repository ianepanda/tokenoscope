'use strict';
// Сборка датасета для интерфейса из разобранных файлов: глобальный дедуп запросов,
// сессии, проекты, треды (основной поток, субагенты, агенты воркфлоу), колоночные массивы.
const fs = require('fs');
const path = require('path');
const { GROUPS } = require('./categories');

const KIND = { main: 0, sub: 1, wf: 2 };

class Interner {
  constructor(first) {
    this.list = [];
    this.map = new Map();
    if (first !== undefined) this.get(first);
  }

  get(s) {
    let i = this.map.get(s);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(s);
      this.map.set(s, i);
    }
    return i;
  }
}

// Ключ проекта: путь cwd без хвоста .claude\worktrees\<имя>.
function projectOf(cwd, projDir) {
  if (!cwd) return { key: 'dir:' + projDir, name: projDir, path: null };
  let p = String(cwd).replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+.*$/i, '');
  p = p.replace(/[\\/]+$/, '');
  const isWin = /^[A-Za-z]:/.test(p);
  const key = (projDir.startsWith('ssh-') ? 'ssh:' : '') + (isWin ? p.toLowerCase() : p);
  let name = p.split(/[\\/]/).filter(Boolean).pop() || p;
  if (/^[A-Za-z]:$/.test(name)) name = p;
  if (projDir.startsWith('ssh-')) name = 'ssh: ' + name;
  return { key, name, path: p };
}

function buildDataset(scan, sidebar) {
  const { found, results, scripts } = scan;
  const models = new Interner('?');
  const efforts = new Interner('—');
  const skills = new Interner('—');
  const mcps = new Interner('—');
  const cats = new Interner();

  // Сессии: основной файл + файлы субагентов.
  const sessMap = new Map();
  const sessionOf = (f) => {
    const key = f.root + '|' + f.projDir + '|' + f.sessionId;
    let s = sessMap.get(key);
    if (!s) {
      s = { id: f.sessionId, projDir: f.projDir, root: f.root, main: null, subs: [] };
      sessMap.set(key, s);
    }
    return s;
  };
  for (const f of found) {
    const r = results.get(f.path);
    if (!r) continue;
    const s = sessionOf(f);
    if (f.kind === 'main') s.main = { f, r };
    else s.subs.push({ f, r });
  }

  const projects = new Interner();
  const projectInfo = [];
  const sessions = [];
  const files = [];
  const fileResults = [];
  for (const s of sessMap.values()) {
    const mr = s.main ? s.main.r : null;
    const sb = sidebar ? sidebar.get(s.id) : null;
    let cwd = (mr && mr.cwd) || null;
    if (!cwd) {
      const withCwd = s.subs.find((x) => x.r.cwd);
      cwd = (withCwd && withCwd.r.cwd) || (sb && sb.cwd) || null;
    }
    const proj = projectOf(cwd, s.projDir);
    const before = projects.list.length;
    const pIdx = projects.get(proj.key);
    if (projects.list.length > before) projectInfo.push({ key: proj.key, name: proj.name, path: proj.path });

    let title = null;
    let titleSource = null;
    if (sb && sb.title) {
      title = sb.title;
      titleSource = 'desktop';
    } else if (mr && mr.titles.custom) {
      title = mr.titles.custom;
      titleSource = 'custom';
    } else if (mr && mr.titles.agentName) {
      title = mr.titles.agentName;
      titleSource = 'agent';
    } else if (mr && mr.titles.ai) {
      title = mr.titles.ai;
      titleSource = 'ai';
    } else if (mr && mr.firstPrompt) {
      title = mr.firstPrompt.slice(0, 90);
      titleSource = 'prompt';
    }

    const sIdx = sessions.length;
    const all = (s.main ? [s.main] : []).concat(s.subs);
    let firstTs = 0;
    let lastTs = 0;
    for (const { r } of all) {
      if (r.firstTs && (!firstTs || r.firstTs < firstTs)) firstTs = r.firstTs;
      if (r.lastTs > lastTs) lastTs = r.lastTs;
    }
    const sess = {
      id: s.id,
      project: pIdx,
      title: title || '(без названия)',
      titleSource,
      firstTs,
      lastTs,
      mainFile: -1,
      archived: sb ? sb.archived : false,
      accounts: sb ? sb.accounts : [],
      prLinks: mr ? mr.prLinks : [],
      artifacts: mr ? mr.artifacts : [],
      compactions: mr ? mr.compactions : [],
      turns: mr ? mr.turns : 0,
      firstPrompt: mr ? mr.firstPrompt : null,
      gitBranch: mr ? mr.gitBranch : null,
      cwd,
      version: mr ? mr.version : null,
      runs: [],
    };
    sessions.push(sess);

    // Прогоны воркфлоу: вызовы Workflow в основном потоке + имена скриптов.
    const runs = new Map();
    const scriptOf = (run) => scripts.find((x) => x.sessionId === s.id && run && (x.run.startsWith(run) || run.startsWith(x.run)));
    for (const { f } of s.subs) {
      if (f.kind !== 'wf' || runs.has(f.run)) continue;
      const call = mr ? mr.workflowCalls.find((c) => c.run && (c.run.startsWith(f.run) || f.run.startsWith(c.run))) : null;
      const sc = scriptOf(f.run);
      runs.set(f.run, {
        run: f.run,
        name: (sc && sc.name) || (call && call.name) || f.run,
        desc: (call && call.desc) || (sc && sc.desc) || null,
        ts: call ? call.ts : 0,
        script: sc ? sc.path : null,
        journal: (() => {
          const j = path.join(path.dirname(f.path), 'journal.jsonl');
          return fs.existsSync(j) ? j : null;
        })(),
      });
    }
    sess.runs = [...runs.values()];

    for (const { f, r } of all) {
      const meta = r.meta || {};
      const fIdx = files.length;
      if (f.kind === 'main') sess.mainFile = fIdx;
      files.push({
        session: sIdx,
        kind: KIND[f.kind],
        agentType: f.kind === 'main' ? null : (meta.agentType || null),
        label: f.kind === 'main' ? null : (meta.description || meta.label || (r.firstPrompt ? r.firstPrompt.slice(0, 90) : null)),
        phase: meta.workflowPhase || null,
        run: f.run || null,
        path: f.path,
        firstTs: r.firstTs,
        lastTs: r.lastTs,
        steps: 0,
        startCtx: r.startCtx,
        peakCtx: r.peakCtx,
        spawnDepth: meta.spawnDepth || 0,
        cwd: r.cwd,
      });
      fileResults.push(r);
    }
  }

  // Глобальный дедуп: копии запросов (например, после rewind история копируется в новый
  // транскрипт) достаются файлу, начавшемуся раньше.
  const order = files.map((_, i) => i).sort((a, b) => (files[a].firstTs || 0) - (files[b].firstTs || 0));
  const seen = new Set();
  const picked = []; // [fileIdx, msgIdx, attrStart]
  let dupes = 0;
  for (const fi of order) {
    const r = fileResults[fi];
    const M = r.msgs;
    let a = 0;
    for (let i = 0; i < M.id.length; i++) {
      const len = M.aLen[i];
      if (seen.has(M.id[i])) {
        dupes++;
      } else {
        seen.add(M.id[i]);
        picked.push([fi, i, a]);
      }
      a += len;
    }
  }
  picked.sort((x, y) => fileResults[x[0]].msgs.ts[x[1]] - fileResults[y[0]].msgs.ts[y[1]]);

  const n = picked.length;
  const rows = {
    ts: new Float64Array(n),
    file: new Uint32Array(n),
    model: new Uint16Array(n),
    inp: new Uint32Array(n),
    cw5m: new Uint32Array(n),
    cw1h: new Uint32Array(n),
    cr: new Uint32Array(n),
    out: new Uint32Array(n),
    think: new Uint32Array(n),
    effort: new Uint8Array(n),
    fast: new Uint8Array(n),
    skill: new Uint16Array(n),
    mcp: new Uint16Array(n),
    aOff: new Uint32Array(n + 1),
  };
  let attrTotal = 0;
  for (const [fi, i] of picked) attrTotal += fileResults[fi].msgs.aLen[i];
  const attrCat = new Uint16Array(attrTotal);
  const attrTok = new Float32Array(attrTotal);
  const catMaps = fileResults.map((r) => r.cats.map((k) => cats.get(k)));
  let ap = 0;
  for (let k = 0; k < n; k++) {
    const [fi, i, a] = picked[k];
    const M = fileResults[fi].msgs;
    rows.ts[k] = M.ts[i];
    rows.file[k] = fi;
    rows.model[k] = models.get(M.model[i] || '?');
    rows.inp[k] = M.inp[i];
    rows.cw5m[k] = M.cw5m[i];
    rows.cw1h[k] = M.cw1h[i];
    rows.cr[k] = M.cr[i];
    rows.out[k] = M.out[i];
    rows.think[k] = M.think[i];
    rows.effort[k] = efforts.get(M.effort[i] || '—');
    rows.fast[k] = M.fast[i];
    rows.skill[k] = skills.get(M.skill[i] || '—');
    rows.mcp[k] = mcps.get(M.mcp[i] || '—');
    rows.aOff[k] = ap;
    const len = M.aLen[i];
    const r = fileResults[fi];
    const cm = catMaps[fi];
    for (let j = 0; j < len; j++) {
      attrCat[ap] = cm[r.aCat[a + j]];
      attrTok[ap] = r.aTok[a + j];
      ap++;
    }
    files[fi].steps++;
  }
  rows.aOff[n] = ap;

  // Статистика инструментов по часам.
  let toolN = 0;
  for (const r of fileResults) toolN += r.tools.length;
  const tools = {
    file: new Uint32Array(toolN),
    hour: new Uint32Array(toolN),
    cat: new Uint16Array(toolN),
    calls: new Uint32Array(toolN),
    chars: new Float64Array(toolN),
  };
  let tp = 0;
  fileResults.forEach((r, fi) => {
    const cm = catMaps[fi];
    for (const [h, c, calls, chars] of r.tools) {
      tools.file[tp] = fi;
      tools.hour[tp] = h;
      tools.cat[tp] = cm[c];
      tools.calls[tp] = calls;
      tools.chars[tp] = chars;
      tp++;
    }
  });

  const heavy = [];
  fileResults.forEach((r, fi) => {
    const cm = catMaps[fi];
    for (const h of r.heavy) heavy.push({ file: fi, cat: cm[h.cat], desc: h.desc, chars: h.chars, est: h.est, steps: h.steps, tokSteps: h.tokSteps, ts: h.ts });
  });

  const catList = cats.list.map((key) => {
    const [group, detail] = key.split('\t');
    return { key, group, detail };
  });

  return {
    meta: {
      generatedAt: Date.now(),
      rows: n,
      dupes,
      files: files.length,
      sessions: sessions.length,
      badLines: fileResults.reduce((s, r) => s + (r.badLines || 0), 0),
    },
    groups: GROUPS,
    strings: { models: models.list, efforts: efforts.list, skills: skills.list, mcps: mcps.list },
    cats: catList,
    projects: projectInfo,
    sessions,
    files,
    rows,
    attr: { cat: attrCat, tok: attrTok },
    tools,
    heavy,
  };
}

module.exports = { buildDataset, projectOf };

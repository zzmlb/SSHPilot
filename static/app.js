/* ========== State ========== */
const P = {
    left:  { nodeId: null, nodeName: "", path: "/", entries: [], page: 1 },
    right: { nodeId: null, nodeName: "", path: "/", entries: [], page: 1 },
};
let activePanel = "left";
let showHidden = false;
let viewMode = "list";
let panelMode = localStorage.getItem("sfm_mode") || "";  // "", "single", "dual"
let monitorActive = false;
let monitorTimer = null;
let _localInfo = null;
const PAGE_SIZE = 10;

function ap() { return P[activePanel]; }
function otherSide(s) { return s === "left" ? "right" : "left"; }

/* ========== Mode Selection ========== */
function switchMode(mode) {
    panelMode = mode;
    localStorage.setItem("sfm_mode", mode);
    applyMode();
}

function toggleMode() {
    switchMode(panelMode === "dual" ? "single" : "dual");
}

function applyMode() {
    const overlay = document.getElementById("mode-overlay");
    const toolbar = document.getElementById("global-toolbar");
    const dualPanel = document.getElementById("dual-panel");
    const btn = document.getElementById("mode-toggle-btn");
    const txt = document.getElementById("mode-toggle-text");

    if (!panelMode) {
        overlay.classList.remove("hidden");
        toolbar.classList.add("hidden");
        dualPanel.classList.add("hidden");
        return;
    }

    overlay.classList.add("hidden");
    toolbar.classList.remove("hidden");
    dualPanel.classList.remove("hidden");

    if (panelMode === "single") {
        dualPanel.classList.add("single-mode");
        activePanel = "left";
        setActivePanel("left");
        txt.textContent = "双面板";
        btn.innerHTML = '<i class="fas fa-columns"></i> <span id="mode-toggle-text">双面板</span>';
    } else {
        dualPanel.classList.remove("single-mode");
        txt.textContent = "单面板";
        btn.innerHTML = '<i class="fas fa-desktop"></i> <span id="mode-toggle-text">单面板</span>';
    }
}

/* ========== API ========== */
async function api(url, opts = {}) {
    const res = await fetch(url, opts);
    if (res.status === 401) { window.location.href = "/"; throw new Error("Unauthorized"); }
    if (!res.ok) { const e = await res.json().catch(() => ({ detail: res.statusText })); throw new Error(e.detail || JSON.stringify(e)); }
    return res;
}
async function apiJson(url, opts = {}) { return (await api(url, opts)).json(); }

function toast(msg, type = "info") {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById("toast-container").appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

/* ========== Auth ========== */
async function doLogout() { await fetch("/api/logout", { method: "POST" }); window.location.href = "/"; }

/* ========== Sidebar Tab ========== */
function switchSidebarTab(tab) {
    document.getElementById("stab-nodes").classList.toggle("active", tab === "nodes");
    document.getElementById("stab-sshkeys").classList.toggle("active", tab === "sshkeys");
    document.getElementById("sidebar-nodes").classList.toggle("hidden", tab !== "nodes");
    document.getElementById("sidebar-sshkeys").classList.toggle("hidden", tab !== "sshkeys");
    if (tab === "sshkeys") loadLocalSSH();
}

let _sshCache = null;
let _scanCache = null;
async function loadLocalSSH() {
    const container = document.getElementById("ssh-keys-content");
    if (_sshCache) { renderSSHPanel(_sshCache, _scanCache, container); return; }
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim)"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>';
    try {
        _sshCache = await apiJson("/api/local-ssh");
        renderSSHPanel(_sshCache, _scanCache, container);
    } catch (e) {
        container.innerHTML = `<div class="ssh-empty"><i class="fas fa-exclamation-triangle"></i>${esc(e.message)}</div>`;
    }
}

async function scanSSHReachable() {
    const container = document.getElementById("ssh-scan-results");
    container.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-dim)"><i class="fas fa-spinner fa-spin"></i> 正在测试连通性...</div>';
    document.getElementById("ssh-scan-btn").disabled = true;
    try {
        _scanCache = await apiJson("/api/local-ssh/scan", { method: "POST" });
        renderScanResults(_scanCache, container);
    } catch (e) {
        container.innerHTML = `<div style="padding:12px;color:var(--danger);font-size:12px">${esc(e.message)}</div>`;
    } finally {
        document.getElementById("ssh-scan-btn").disabled = false;
    }
}

function renderScanResults(results, container) {
    if (!results.length) {
        container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-dim);font-size:12px">未发现可测试的主机<br><span style="font-size:11px">请先在 ~/.ssh/config 配置或添加密钥认证节点</span></div>';
        return;
    }
    const ok = results.filter(r => r.ok), fail = results.filter(r => !r.ok);
    let html = "";
    if (ok.length) {
        html += `<div class="ssh-section-title" style="color:var(--success)"><i class="fas fa-check-circle"></i> 可直连 <span class="ssh-section-count">${ok.length}</span></div>`;
        ok.forEach(r => {
            const srcTag = r.source === 'ssh_config' ? 'Config' : r.source === 'known_hosts' ? 'Known' : '节点';
            const srcCls = r.source === 'ssh_config' ? 'config' : r.source === 'known_hosts' ? 'known' : 'key';
            html += `<div class="ssh-item"><div class="ssh-item-info"><div class="ssh-item-name"><span class="scan-dot dot-ok"></span>${esc(r.alias || r.host)}</div><div class="ssh-item-meta">${esc(r.user)}@${esc(r.host)}:${r.port}</div><span class="ssh-item-tag ssh-tag-${srcCls}">${srcTag}</span></div><div class="ssh-item-actions"><button class="btn-icon" title="添加为节点" onclick="quickAddNode('${escJs(r.alias||r.host)}','${escJs(r.host)}',${r.port},'${escJs(r.user)}')"><i class="fas fa-plus-circle" style="color:var(--success)"></i></button></div></div>`;
        });
    }
    if (fail.length) {
        html += `<div class="ssh-section-title" style="color:var(--danger);margin-top:8px"><i class="fas fa-times-circle"></i> 不可达 <span class="ssh-section-count">${fail.length}</span></div>`;
        fail.forEach(r => {
            html += `<div class="ssh-item" style="opacity:.6"><div class="ssh-item-info"><div class="ssh-item-name"><span class="scan-dot dot-fail"></span>${esc(r.alias || r.host)}</div><div class="ssh-item-meta">${esc(r.user)}@${esc(r.host)}:${r.port}</div><div class="ssh-item-meta" style="color:var(--danger)">${esc(r.error)}</div></div></div>`;
        });
    }
    container.innerHTML = html;
}

function renderSSHPanel(data, scanData, container) {
    let html = "";

    // Scan section (top priority)
    html += `<div class="ssh-section"><div class="ssh-section-title" style="justify-content:space-between"><span><i class="fas fa-satellite-dish"></i> 可直连服务器</span><button class="btn-sm" id="ssh-scan-btn" onclick="scanSSHReachable()" style="font-size:10px;padding:2px 8px"><i class="fas fa-radar"></i> 扫描</button></div><div id="ssh-scan-results">`;
    if (scanData) {
        html += '</div></div>';
    } else {
        html += '<div style="padding:12px;text-align:center;color:var(--text-dim);font-size:11px">点击「扫描」测试哪些服务器可免密直连</div></div></div>';
    }

    // Keys section
    if (data.keys.length) {
        html += `<div class="ssh-section"><div class="ssh-section-title"><i class="fas fa-key"></i> 本机密钥 <span class="ssh-section-count">${data.keys.length}</span></div>`;
        data.keys.forEach(k => {
            html += `<div class="ssh-item"><div class="ssh-item-info"><div class="ssh-item-name">${esc(k.name)}</div><div class="ssh-item-meta">${esc(k.type || "unknown")}${k.comment ? " · " + esc(k.comment) : ""}</div><span class="ssh-item-tag ssh-tag-key">${k.has_private ? "有私钥" : "仅公钥"}</span></div></div>`;
        });
        html += `</div>`;
    }

    // Config section
    if (data.configs.length) {
        html += `<div class="ssh-section"><div class="ssh-section-title"><i class="fas fa-cog"></i> SSH Config <span class="ssh-section-count">${data.configs.length}</span></div>`;
        data.configs.forEach(c => {
            const host = c.hostname || c.alias;
            const user = c.user || "root";
            html += `<div class="ssh-item"><div class="ssh-item-info"><div class="ssh-item-name">${esc(c.alias)}</div><div class="ssh-item-meta">${esc(user)}@${esc(host)}:${c.port}</div>${c.identity_file ? `<div class="ssh-item-meta"><i class="fas fa-key" style="font-size:9px"></i> ${esc(c.identity_file)}</div>` : ""}<span class="ssh-item-tag ssh-tag-config">Config</span></div><div class="ssh-item-actions"><button class="btn-icon" title="添加为节点" onclick="quickAddNode('${escJs(c.alias)}','${escJs(host)}',${c.port},'${escJs(user)}')"><i class="fas fa-plus-circle" style="color:var(--success)"></i></button></div></div>`;
        });
        html += `</div>`;
    }

    // Known hosts
    const khTotal = data.known_hosts.length + (data.known_hosts_hashed || 0);
    if (khTotal > 0) {
        html += `<div class="ssh-section"><div class="ssh-section-title"><i class="fas fa-globe"></i> Known Hosts <span class="ssh-section-count">${khTotal}</span></div>`;
        if (data.known_hosts.length) {
            data.known_hosts.forEach(h => {
                html += `<div class="ssh-item"><div class="ssh-item-info"><div class="ssh-item-name">${esc(h.host)}</div><div class="ssh-item-meta">${esc(h.key_type)}${h.port !== 22 ? ` :${h.port}` : ""}</div><span class="ssh-item-tag ssh-tag-known">Known</span></div><div class="ssh-item-actions"><button class="btn-icon" title="添加为节点" onclick="quickAddNode('${escJs(h.host)}','${escJs(h.host)}',${h.port},'root')"><i class="fas fa-plus-circle" style="color:var(--success)"></i></button></div></div>`;
            });
        }
        if (data.known_hosts_hashed > 0) {
            html += `<div class="ssh-item"><div class="ssh-item-info"><div class="ssh-item-meta" style="font-style:italic"><i class="fas fa-lock" style="font-size:9px"></i> 另有 ${data.known_hosts_hashed} 条加密记录 (HashKnownHosts)</div></div></div>`;
        }
        html += `</div>`;
    }

    if (!data.keys.length && !data.configs.length && khTotal === 0) {
        html += '<div class="ssh-empty"><i class="fas fa-key"></i>未找到 SSH 密钥或连接记录<br>检查 ~/.ssh/ 目录</div>';
    }

    container.innerHTML = html;
    if (scanData) renderScanResults(scanData, document.getElementById("ssh-scan-results"));
}

function quickAddNode(name, host, port, user) {
    document.getElementById("node-modal-title").textContent = "添加节点";
    document.getElementById("node-form").reset();
    document.getElementById("node-edit-id").value = "";
    document.getElementById("node-name").value = name;
    document.getElementById("node-host").value = host;
    document.getElementById("node-port").value = port;
    document.getElementById("node-username").value = user;
    document.getElementById("node-auth-type").value = "key_file";
    toggleAuthFields();
    openModal("node-modal");
}

/* ========== Local Server ========== */
let _localMeta = null;

async function loadLocalInfo() {
    try {
        const [info, meta] = await Promise.all([apiJson("/api/local/info"), apiJson("/api/local/meta")]);
        _localInfo = info;
        _localMeta = meta;
    } catch (e) { /* ignore */ }
}

async function editLocalNode() {
    const m = _localMeta || {};
    document.getElementById("node-modal-title").textContent = "编辑本机节点";
    document.getElementById("node-form").reset();
    document.getElementById("node-edit-id").value = "local";
    document.getElementById("node-name").value = m.name || "本机";
    document.getElementById("node-host").value = _localInfo ? (_localInfo.exit_ip || _localInfo.hostname) : "";
    document.getElementById("node-host").disabled = true;
    document.getElementById("node-port").value = "22";
    document.getElementById("node-port").disabled = true;
    document.getElementById("node-username").value = "";
    document.getElementById("node-username").disabled = true;
    document.getElementById("node-auth-type").value = "key_file";
    document.getElementById("node-auth-type").disabled = true;
    document.getElementById("node-country").value = m.country || "";
    document.getElementById("node-provider").value = m.provider || "";
    document.getElementById("node-business").value = m.business || "";
    document.getElementById("node-expire-date").value = m.expire_date || "";
    document.getElementById("node-cost").value = m.cost || "";
    toggleAuthFields();
    openModal("node-modal");
}

async function connectLocalToPanel() {
    const side = activePanel;
    const p = P[side];
    p.nodeId = 0;
    p.nodeName = "本机";
    p.path = "/";
    p.page = 1;
    document.getElementById(`${side}-node-name`).textContent = "本机";
    try {
        await apiJson("/api/connect/0", { method: "POST" });
        toast("本机已连接到" + (side === "left" ? "左" : "右") + "面板", "success");
    } catch (e) { toast("连接失败: " + e.message, "error"); return; }
    updateLocalCardActive();
    loadNodes();
    refreshPanel(side);
}

function updateLocalCardActive() { /* handled in renderNodeList */ }

/* ========== Monitor ========== */
let _monStats = [], _monNodes = [];

function toggleMonitor() {
    monitorActive = !monitorActive;
    const btn = document.getElementById("monitor-btn");
    const panel = document.getElementById("dual-panel");
    const page = document.getElementById("monitor-page");
    btn.classList.toggle("active", monitorActive);
    if (monitorActive) {
        panel.classList.add("hidden");
        page.classList.remove("hidden");
        refreshMonitor();
        monitorTimer = setInterval(refreshMonitor, 8000);
    } else {
        panel.classList.remove("hidden");
        page.classList.add("hidden");
        if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
    }
}

function switchMonTab(tab) {
    document.getElementById("mtab-res").classList.toggle("active", tab === "res");
    document.getElementById("mtab-fin").classList.toggle("active", tab === "fin");
    document.getElementById("mon-tab-res").classList.toggle("hidden", tab !== "res");
    document.getElementById("mon-tab-fin").classList.toggle("hidden", tab !== "fin");
    if (tab === "fin") renderFinanceTab();
}

async function refreshMonitor() {
    try {
        const resp = await apiJson("/api/monitor");
        _monStats = resp.stats;
        _monNodes = resp.nodes;
        renderMonitorSummary(_monStats, _monNodes);
        renderMonitorGrid(_monStats);
        if (!document.getElementById("mon-tab-fin").classList.contains("hidden")) renderFinanceTab();
        document.getElementById("monitor-time").textContent = new Date().toLocaleTimeString("zh-CN");
    } catch (e) {
        document.getElementById("monitor-grid").innerHTML = `<div style="color:var(--danger);padding:20px">${esc(e.message)}</div>`;
    }
}

function renderMonitorSummary(stats, allNodes) {
    const online = stats.filter(d => !d.error && !d.offline);
    const totalCpu = online.reduce((s, d) => s + (d.cpu || 0), 0);
    const totalMem = online.reduce((s, d) => s + (d.mem_total || 0), 0);
    const totalMemUsed = online.reduce((s, d) => s + (d.mem_used || 0), 0);
    const totalDisk = online.reduce((s, d) => s + (d.disk_total || 0), 0);
    const totalDiskUsed = online.reduce((s, d) => s + (d.disk_used || 0), 0);
    const memPct = totalMem ? Math.round(totalMemUsed / totalMem * 100) : 0;
    const diskPct = totalDisk ? Math.round(totalDiskUsed / totalDisk * 100) : 0;

    document.getElementById("monitor-summary").innerHTML = `
        <div class="kpi-card kpi-blue"><div class="kpi-label">在线</div><div class="kpi-value">${online.length}<span style="font-size:12px;color:var(--text-dim)">/${allNodes.length + 1}</span></div></div>
        <div class="kpi-card kpi-blue"><div class="kpi-label">CPU 总核心</div><div class="kpi-value">${totalCpu}</div></div>
        <div class="kpi-card kpi-purple"><div class="kpi-label">内存 ${memPct}%</div><div class="kpi-value">${fmtBytes(totalMemUsed)}</div><div class="kpi-sub">/ ${fmtBytes(totalMem)}</div></div>
        <div class="kpi-card kpi-green"><div class="kpi-label">磁盘 ${diskPct}%</div><div class="kpi-value">${fmtBytes(totalDiskUsed)}</div><div class="kpi-sub">/ ${fmtBytes(totalDisk)}</div></div>`;
}

function renderMonitorGrid(data) {
    const grid = document.getElementById("monitor-grid");
    grid.innerHTML = "";
    data.forEach(d => {
        const isLocal = d.node_id === 0;
        const isOnline = !d.offline && !d.error;
        const tags = [d.country, d.provider].filter(Boolean);

        if (!isOnline) {
            grid.innerHTML += `<div class="srv-card offline">
                <div class="srv-header"><span class="srv-name"><span class="srv-dot off"></span> ${esc(d.name)}</span>
                <div class="srv-tags">${tags.map(t=>`<span class="srv-tag">${esc(t)}</span>`).join("")}</div></div>
                <div style="color:var(--text-dim);font-size:11px">${d.error ? '连接断开' : '未连接'}</div>
                ${d.cost||d.expire_date?`<div class="srv-footer">${d.cost?`<span class="srv-footer-tag" style="color:#b8a0ff">${esc(d.cost)}</span>`:''} ${d.expire_date?`<span class="srv-footer-tag" style="color:var(--text-dim)">${d.expire_date}</span>`:''}</div>`:''}
            </div>`;
            return;
        }

        const memPct = d.mem_total ? Math.round(d.mem_used / d.mem_total * 100) : 0;
        const diskPct = d.disk_total ? Math.round(d.disk_used / d.disk_total * 100) : 0;
        const loadVal = d.load && d.load[0] ? parseFloat(d.load[0]) : 0;
        const cpuPct = d.cpu ? Math.min(100, Math.round(loadVal / d.cpu * 100)) : 0;
        const clsFor = p => p > 80 ? "danger" : p > 50 ? "warn" : "";

        grid.innerHTML += `<div class="srv-card">
            <div class="srv-header">
                <span class="srv-name"><span class="srv-dot on"></span> ${esc(d.name)}${isLocal?' <span class="srv-tag" style="color:var(--accent);background:rgba(91,138,245,.15)">LOCAL</span>':''}</span>
                <span class="srv-uptime">${esc(d.uptime||'')}</span>
            </div>
            ${tags.length?`<div class="srv-tags" style="margin-bottom:8px">${tags.map(t=>`<span class="srv-tag">${esc(t)}</span>`).join("")}</div>`:''}
            <div class="srv-metrics">
                <div class="srv-metric">
                    <span class="srv-metric-label"><i class="fas fa-microchip"></i> CPU ${d.cpu}核</span>
                    <div class="srv-bar"><div class="srv-fill cpu ${clsFor(cpuPct)}" style="width:${cpuPct}%"></div></div>
                    <span class="srv-metric-val">${cpuPct}%</span>
                </div>
                <div class="srv-metric">
                    <span class="srv-metric-label"><i class="fas fa-memory"></i> 内存</span>
                    <div class="srv-bar"><div class="srv-fill mem ${clsFor(memPct)}" style="width:${memPct}%"></div></div>
                    <span class="srv-metric-val">${fmtBytes(d.mem_used)}/${fmtBytes(d.mem_total)}</span>
                </div>
                <div class="srv-metric">
                    <span class="srv-metric-label"><i class="fas fa-hdd"></i> 磁盘</span>
                    <div class="srv-bar"><div class="srv-fill disk ${clsFor(diskPct)}" style="width:${diskPct}%"></div></div>
                    <span class="srv-metric-val">${fmtBytes(d.disk_used)}/${fmtBytes(d.disk_total)}</span>
                </div>
            </div>
            ${d.load&&d.load.length?`<div class="srv-load"><span class="srv-load-label">负载</span>${d.load.map(l=>`<span class="srv-load-chip">${l}</span>`).join("")}</div>`:''}
            ${d.cost||d.expire_date?`<div class="srv-footer">${d.cost?`<span class="srv-footer-tag" style="color:#b8a0ff;background:rgba(168,130,255,.1)">${esc(d.cost)}</span>`:'<span></span>'} ${d.expire_date?(() => {const days=Math.ceil((new Date(d.expire_date)-new Date())/86400000);const c=days<7?'var(--danger)':days<30?'var(--warning)':'var(--success)';return `<span class="srv-footer-tag" style="color:${c};background:rgba(255,255,255,.05)">${days<0?'已过期'+(-days)+'天':days===0?'今天到期':'剩'+days+'天'}</span>`;})():''}</div>`:''}
        </div>`;
    });
}

function _getAllNodesMeta() {
    const all = [..._monNodes];
    if (_localMeta) all.unshift({ id: 0, name: _localMeta.name || "本机", expire_date: _localMeta.expire_date || "", cost: _localMeta.cost || "", country: _localMeta.country || "", provider: _localMeta.provider || "", business: _localMeta.business || "" });
    return all;
}

function _parseCost(s) { const m = (s || "").match(/([\d.]+)/); return m ? parseFloat(m[1]) : 0; }

function renderFinanceTab() {
    const all = _getAllNodesMeta();
    const withCost = all.filter(n => n.cost);
    const withExpiry = all.filter(n => n.expire_date).sort((a, b) => new Date(a.expire_date) - new Date(b.expire_date));
    const totalCost = withCost.reduce((s, n) => s + _parseCost(n.cost), 0);
    const expiring7 = all.filter(n => n.expire_date && Math.ceil((new Date(n.expire_date) - new Date()) / 86400000) <= 7).length;
    const expiring30 = all.filter(n => n.expire_date && Math.ceil((new Date(n.expire_date) - new Date()) / 86400000) <= 30).length;
    const expired = all.filter(n => n.expire_date && new Date(n.expire_date) < new Date()).length;

    // KPI
    document.getElementById("fin-summary").innerHTML = `
        <div class="kpi-card kpi-orange"><div class="kpi-label">月费合计</div><div class="kpi-value">${totalCost ? totalCost.toFixed(0) : '—'}</div></div>
        <div class="kpi-card kpi-orange"><div class="kpi-label">年费估算</div><div class="kpi-value">${totalCost ? (totalCost * 12).toFixed(0) : '—'}</div></div>
        <div class="kpi-card kpi-blue"><div class="kpi-label">已设费用</div><div class="kpi-value">${withCost.length}<span style="font-size:12px;color:var(--text-dim)">/${all.length}</span></div></div>
        <div class="kpi-card kpi-purple"><div class="kpi-label">均价/台</div><div class="kpi-value">${withCost.length ? (totalCost / withCost.length).toFixed(1) : '—'}</div></div>
        <div class="kpi-card ${expired?'kpi-red':'kpi-green'}"><div class="kpi-label">已过期</div><div class="kpi-value">${expired}</div></div>
        <div class="kpi-card ${expiring7?'kpi-red':expiring30?'kpi-orange':'kpi-green'}"><div class="kpi-label">≤30天到期</div><div class="kpi-value">${expiring30}</div></div>`;

    // Expiry table
    let expiryHtml = '<div class="fin-expiry-panel">';
    if (!withExpiry.length) {
        expiryHtml += '<div class="mon-empty">暂无到期数据，编辑节点可设置</div>';
    } else {
        withExpiry.forEach(n => {
            const days = Math.ceil((new Date(n.expire_date) - new Date()) / 86400000);
            const cls = days < 7 ? "bar-danger" : days < 30 ? "bar-warn" : "bar-ok";
            const label = days < 0 ? `已过期${-days}天` : days === 0 ? "今天到期" : `剩${days}天`;
            const pct = Math.max(3, Math.min(100, (Math.max(0, days) / 365) * 100));
            expiryHtml += `<div class="ec-row"><span class="ec-name">${esc(n.name)}</span><div class="ec-bar-wrap"><div class="ec-bar ${cls}" style="width:${pct}%"></div></div><span class="ec-label ${days<=7?'text-danger':days<=30?'text-warn':''}">${label}</span><span class="ec-date">${n.expire_date}</span></div>`;
        });
    }
    expiryHtml += '</div>';
    document.getElementById("fin-expiry").innerHTML = expiryHtml;

    // Multi-dimension charts
    const colors = ['#5b8af5','#a880ff','#4caf7a','#f5a623','#e74c5e','#5bc0de','#ff6b81','#7c5bf5'];
    let chartsHtml = '';

    // By node (cost distribution)
    chartsHtml += _buildFinPanel('fas fa-server', '各节点费用', withCost.map(n => ({ label: n.name, value: _parseCost(n.cost), display: n.cost })).sort((a,b) => b.value - a.value), colors[1]);

    // By provider
    const byProvider = {};
    withCost.forEach(n => { const k = n.provider || '未设置'; byProvider[k] = (byProvider[k] || { value: 0, count: 0 }); byProvider[k].value += _parseCost(n.cost); byProvider[k].count++; });
    chartsHtml += _buildFinPanel('fas fa-cloud', '按厂商', Object.entries(byProvider).map(([k, v]) => ({ label: k, value: v.value, count: v.count })).sort((a,b) => b.value - a.value), colors[0]);

    // By country
    const byCountry = {};
    withCost.forEach(n => { const k = n.country || '未设置'; byCountry[k] = (byCountry[k] || { value: 0, count: 0 }); byCountry[k].value += _parseCost(n.cost); byCountry[k].count++; });
    chartsHtml += _buildFinPanel('fas fa-globe', '按国家/地区', Object.entries(byCountry).map(([k, v]) => ({ label: k, value: v.value, count: v.count })).sort((a,b) => b.value - a.value), colors[2]);

    // By business
    const byBiz = {};
    withCost.forEach(n => { const k = n.business || '未设置'; byBiz[k] = (byBiz[k] || { value: 0, count: 0 }); byBiz[k].value += _parseCost(n.cost); byBiz[k].count++; });
    chartsHtml += _buildFinPanel('fas fa-briefcase', '按业务', Object.entries(byBiz).map(([k, v]) => ({ label: k, value: v.value, count: v.count })).sort((a,b) => b.value - a.value), colors[3]);

    document.getElementById("fin-charts").innerHTML = chartsHtml;
}

function _buildFinPanel(icon, title, items, color) {
    if (!items.length) return `<div class="fin-panel"><div class="fin-panel-head"><i class="${icon}" style="color:${color}"></i> ${title}</div><div class="fin-panel-body"><div class="mon-empty">暂无数据</div></div></div>`;
    const max = Math.max(...items.map(i => i.value), 1);
    let rows = '';
    items.forEach(i => {
        const pct = Math.max(3, (i.value / max) * 100);
        rows += `<div class="fin-row"><span class="fin-label">${esc(i.label)}</span><div class="fin-bar-wrap"><div class="fin-bar" style="width:${pct}%;background:${color}"></div></div><span class="fin-val" style="color:${color}">${i.display || i.value.toFixed(0)}</span>${i.count != null ? `<span class="fin-count">${i.count}台</span>` : ''}</div>`;
    });
    return `<div class="fin-panel"><div class="fin-panel-head"><i class="${icon}" style="color:${color}"></i> ${title}</div><div class="fin-panel-body">${rows}</div></div>`;
}

function fmtBytes(b) {
    if (!b || b <= 0) return "0";
    if (b < 1073741824) return (b / 1048576).toFixed(0) + " MB";
    if (b < 1099511627776) return (b / 1073741824).toFixed(1) + " GB";
    return (b / 1099511627776).toFixed(2) + " TB";
}

/* ========== Panel Management ========== */
function setActivePanel(side) {
    activePanel = side;
    document.getElementById("panel-left").classList.toggle("active", side === "left");
    document.getElementById("panel-right").classList.toggle("active", side === "right");
    updateToolbarState();
}

function updateToolbarState() {
    const btn = document.getElementById("toggle-hidden-btn");
    btn.innerHTML = showHidden ? '<i class="fas fa-eye-slash"></i> 隐藏.文件' : '<i class="fas fa-eye"></i> 显示.文件';
    btn.classList.toggle("btn-active", showHidden);
    const vbtn = document.getElementById("toggle-view-btn");
    vbtn.innerHTML = viewMode === "list" ? '<i class="fas fa-th"></i> 图标' : '<i class="fas fa-list"></i> 列表';
}

/* ========== Nodes ========== */
async function loadNodes() {
    try { const nodes = await apiJson("/api/nodes"); renderNodeList(nodes); }
    catch (e) { if (e.message !== "Unauthorized") toast("加载节点失败: " + e.message, "error"); }
}

function renderNodeList(nodes) {
    const ul = document.getElementById("node-list");
    ul.innerHTML = "";

    // Local server entry
    const localLi = document.createElement("li");
    const isLocalLeft = P.left.nodeId === 0, isLocalRight = P.right.nodeId === 0;
    if (isLocalLeft || isLocalRight) localLi.classList.add("active");
    let localBadges = "";
    if (isLocalLeft) localBadges += '<span class="panel-badge badge-left">L</span>';
    if (isLocalRight) localBadges += '<span class="panel-badge badge-right">R</span>';
    const lm = _localMeta || {};
    let localTags = '<span class="node-tag tag-local">LOCAL</span>';
    if (lm.country) localTags += `<span class="node-tag tag-country">${esc(lm.country)}</span>`;
    if (lm.provider) localTags += `<span class="node-tag tag-provider">${esc(lm.provider)}</span>`;
    if (lm.business) localTags += `<span class="node-tag tag-business">${esc(lm.business)}</span>`;
    if (lm.cost) localTags += `<span class="node-tag tag-cost">${esc(lm.cost)}</span>`;
    if (lm.expire_date) {
        const days = Math.ceil((new Date(lm.expire_date) - new Date()) / 86400000);
        const cls = days < 7 ? "expire-danger" : days < 30 ? "expire-warn" : "";
        const label = days < 0 ? `已过期${-days}天` : days === 0 ? "今天到期" : `剩${days}天`;
        localTags += `<span class="node-tag tag-expire ${cls}">${label}</span>`;
    }
    if (_localInfo) {
        const hw = [];
        if (_localInfo.cpu) hw.push(_localInfo.cpu + "核");
        if (_localInfo.mem_total) hw.push(fmtBytes(_localInfo.mem_total));
        if (_localInfo.disk_total) hw.push(fmtBytes(_localInfo.disk_total));
        if (hw.length) localTags += `<span class="node-tag tag-hw">${hw.join(" · ")}</span>`;
    }
    localLi.innerHTML = `
        <div class="node-info" onclick="connectLocalToPanel()">
            <div class="node-name-row"><span class="node-name"><i class="fas fa-home" style="color:var(--accent);margin-right:4px;font-size:11px"></i>${esc(lm.name || '本机')}</span>${localBadges}</div>
            <span class="node-host">${_localInfo ? esc(_localInfo.exit_ip || _localInfo.hostname) : '...'}</span>
            <div class="node-tags">${localTags}</div>
        </div>
        <div class="node-actions">
            <button class="btn-icon" onclick="event.stopPropagation();editLocalNode()" title="编辑"><i class="fas fa-pen"></i></button>
        </div>`;
    localLi.style.borderBottom = "1px solid var(--border)";
    localLi.style.marginBottom = "4px";
    ul.appendChild(localLi);

    nodes.forEach(n => {
        const li = document.createElement("li");
        const isLeft = P.left.nodeId === n.id, isRight = P.right.nodeId === n.id;
        if (isLeft || isRight) li.classList.add("active");
        let badges = "";
        if (isLeft) badges += '<span class="panel-badge badge-left">L</span>';
        if (isRight) badges += '<span class="panel-badge badge-right">R</span>';
        let tags = "";
        if (n.country) tags += `<span class="node-tag tag-country">${esc(n.country)}</span>`;
        if (n.provider) tags += `<span class="node-tag tag-provider">${esc(n.provider)}</span>`;
        if (n.business) tags += `<span class="node-tag tag-business">${esc(n.business)}</span>`;
        if (n.cost) tags += `<span class="node-tag tag-cost">${esc(n.cost)}</span>`;
        if (n.expire_date) {
            const days = Math.ceil((new Date(n.expire_date) - new Date()) / 86400000);
            const cls = days < 0 ? "expire-danger" : days < 7 ? "expire-danger" : days < 30 ? "expire-warn" : "";
            const label = days < 0 ? `已过期${-days}天` : days === 0 ? "今天到期" : `剩${days}天`;
            tags += `<span class="node-tag tag-expire ${cls}">${label}</span>`;
        }
        if (n.hw) {
            const hw = n.hw;
            const parts = [];
            if (hw.cpu) parts.push(hw.cpu + "核");
            if (hw.mem_total) parts.push(fmtBytes(hw.mem_total));
            if (hw.disk_total) parts.push(fmtBytes(hw.disk_total));
            if (parts.length) tags += `<span class="node-tag tag-hw">${parts.join(" · ")}</span>`;
        }
        const safeName = escAttr(escJs(n.name));
        li.innerHTML = `
            <div class="node-info" onclick="connectNodeToPanel(${n.id},'${safeName}')">
                <div class="node-name-row"><span class="node-name">${esc(n.name)}</span>${badges}</div>
                <span class="node-host">${esc(n.username)}@${esc(n.host)}:${n.port}</span>
                ${tags ? `<div class="node-tags">${tags}</div>` : ""}
            </div>
            <div class="node-actions">
                <button class="btn-icon" onclick="event.stopPropagation();editNode(${n.id})" title="编辑"><i class="fas fa-pen"></i></button>
                <button class="btn-icon" onclick="event.stopPropagation();removeNode(${n.id})" title="删除"><i class="fas fa-trash"></i></button>
            </div>`;
        li.title = [n.country, n.provider, n.business, n.cost, n.expire_date].filter(Boolean).join(" · ");
        ul.appendChild(li);
    });
}

async function connectNodeToPanel(nodeId, name) {
    const side = activePanel;
    const p = P[side];
    p.nodeId = nodeId;
    p.nodeName = name;
    p.path = "/";
    p.page = 1;
    document.getElementById(`${side}-node-name`).textContent = name;
    try {
        await apiJson(`/api/connect/${nodeId}`, { method: "POST" });
        toast(`${name} 已连接到 ${side === "left" ? "左" : "右"}面板`, "success");
    } catch (e) { toast("连接失败: " + e.message, "error"); return; }
    updateLocalCardActive();
    loadNodes();
    refreshPanel(side);
    setTimeout(loadNodes, 2000);
}

function showAddNodeModal() {
    document.getElementById("node-modal-title").textContent = "添加节点";
    document.getElementById("node-form").reset();
    document.getElementById("node-edit-id").value = "";
    document.getElementById("node-port").value = "22";
    ["node-country","node-provider","node-business","node-password","node-private-key","node-expire-date","node-cost"].forEach(id => document.getElementById(id).value = "");
    toggleAuthFields();
    openModal("node-modal");
}

async function editNode(id) {
    try {
        const n = await apiJson(`/api/nodes/${id}`);
        document.getElementById("node-modal-title").textContent = "编辑节点";
        document.getElementById("node-edit-id").value = n.id;
        ["name","host","port","username","auth-type","password","private-key","country","provider","business","expire-date","cost"]
            .forEach(f => { const el = document.getElementById("node-" + f); if (el) el.value = n[f.replace(/-/g,"_")] || ""; });
        toggleAuthFields();
        openModal("node-modal");
    } catch (e) { toast("加载失败: " + e.message, "error"); }
}

async function saveNode(e) {
    e.preventDefault();
    const editId = document.getElementById("node-edit-id").value;
    const data = {};
    ["name","host","port","username","auth_type","password","private_key","country","provider","business","expire_date","cost"]
        .forEach(f => { const el = document.getElementById("node-" + f.replace(/_/g,"-")); data[f] = el ? (f === "port" ? parseInt(el.value) : el.value) : ""; });
    try {
        if (editId === "local") {
            await apiJson("/api/local/meta", { method: "PUT", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: data.name, country: data.country, provider: data.provider, business: data.business, expire_date: data.expire_date, cost: data.cost }) });
            _localMeta = { ..._localMeta, name: data.name, country: data.country, provider: data.provider, business: data.business, expire_date: data.expire_date, cost: data.cost };
            toast("本机信息已更新", "success");
            // Re-enable disabled fields
            ["node-host","node-port","node-username","node-auth-type"].forEach(id => document.getElementById(id).disabled = false);
        } else if (editId) {
            await apiJson(`/api/nodes/${editId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
            toast("节点已更新", "success");
        } else {
            await apiJson("/api/nodes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
            toast("节点已添加", "success");
        }
        closeModal("node-modal"); loadNodes();
    } catch (e) { toast("保存失败: " + e.message, "error"); }
}

async function removeNode(id) {
    if (!confirm("确定要删除此节点吗？")) return;
    try {
        await apiJson(`/api/nodes/${id}`, { method: "DELETE" });
        ["left","right"].forEach(s => { if (P[s].nodeId === id) { P[s].nodeId = null; renderPanelPlaceholder(s); } });
        toast("节点已删除", "success"); loadNodes();
    } catch (e) { toast("删除失败: " + e.message, "error"); }
}

function toggleAuthFields() {
    const v = document.getElementById("node-auth-type").value;
    document.getElementById("password-field").classList.toggle("hidden", v !== "password");
    document.getElementById("key-field").classList.toggle("hidden", v !== "key");
}

/* ========== Panel File Browsing ========== */
async function refreshPanel(side) {
    const p = P[side];
    if (p.nodeId == null) return;
    document.getElementById(`${side}-path-input`).value = p.path;
    try {
        const data = await apiJson(`/api/files/${p.nodeId}?path=${encodeURIComponent(p.path)}`);
        p.entries = data.entries;
        renderPanelFiles(side);
    } catch (e) { toast("加载目录失败: " + e.message, "error"); }
}

function renderPanelPlaceholder(side) {
    document.getElementById(`${side}-body`).innerHTML = '<div class="panel-placeholder"><i class="fas fa-plug"></i><p>选择左侧节点连接服务器</p></div>';
    document.getElementById(`${side}-pagination`).innerHTML = "";
    document.getElementById(`${side}-node-name`).textContent = "未连接";
}

function getFiltered(side) {
    const entries = P[side].entries;
    return showHidden ? entries : entries.filter(f => !f.name.startsWith("."));
}

function renderPanelFiles(side) {
    const p = P[side];
    const filtered = getFiltered(side);
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (p.page > totalPages) p.page = totalPages;
    const start = (p.page - 1) * PAGE_SIZE;
    const pageEntries = filtered.slice(start, start + PAGE_SIZE);

    const body = document.getElementById(`${side}-body`);
    if (viewMode === "grid") {
        body.innerHTML = `<div class="file-grid"></div>`;
        const grid = body.querySelector(".file-grid");
        pageEntries.forEach(f => grid.appendChild(makeGridCard(side, f)));
    } else {
        let html = `<table class="file-table"><thead><tr><th style="width:30px"><input type="checkbox" onchange="toggleSelectAll('${side}',this.checked)"></th><th>名称</th><th style="width:80px">大小</th><th style="width:150px">修改时间</th><th style="width:160px">操作</th></tr></thead><tbody>`;
        pageEntries.forEach(f => { html += makeListRow(side, f); });
        html += "</tbody></table>";
        body.innerHTML = html;
    }
    renderPanelPagination(side, filtered.length, totalPages);
}

function makeListRow(side, f) {
    const p = P[side];
    const full = p.path === "/" ? `/${f.name}` : `${p.path}/${f.name}`;
    const icon = getIcon(f);
    return `<tr draggable="true" ondragstart="onFileDragStart(event,'${side}','${escJs(full)}','${escJs(f.name)}',${f.is_dir})">
        <td><input type="checkbox" class="file-check" data-side="${side}" data-path="${esc(full)}" data-name="${esc(f.name)}"></td>
        <td><span class="file-icon ${f.is_dir?'dir':''} ${isArchive(f.name)?'archive':''}"><i class="${icon}"></i></span><a class="file-name-link" onclick="${f.is_dir ? `panelNavigateTo('${side}','${escJs(full)}')` : ''}">${esc(f.name)}</a></td>
        <td>${f.is_dir ? "-" : formatSize(f.size)}</td>
        <td>${formatTime(f.mtime)}</td>
        <td><div class="file-actions">
            ${!f.is_dir && isEditable(f.name) ? `<button class="btn-icon" title="编辑" onclick="openEditor('${side}','${escJs(full)}')"><i class="fas fa-edit" style="color:var(--success)"></i></button>` : ""}
            ${!f.is_dir ? `<button class="btn-icon" title="下载" onclick="downloadFile('${side}','${escJs(full)}')"><i class="fas fa-download"></i></button>` : ""}
            ${panelMode==="dual"?`<button class="btn-icon" title="发送到对面" onclick="transferToOther('${side}','${escJs(full)}',${f.is_dir})"><i class="fas fa-exchange-alt" style="color:var(--accent)"></i></button>`:""}
            <button class="btn-icon" title="重命名" onclick="showRenameModal('${side}','${escJs(full)}','${escJs(f.name)}')"><i class="fas fa-pen"></i></button>
            <button class="btn-icon" title="删除" onclick="deleteSingle('${side}','${escJs(full)}')"><i class="fas fa-trash" style="color:var(--danger)"></i></button>
        </div></td></tr>`;
}

function makeGridCard(side, f) {
    const p = P[side];
    const full = p.path === "/" ? `/${f.name}` : `${p.path}/${f.name}`;
    const icon = getIcon(f);
    const card = document.createElement("div");
    card.className = "grid-card";
    card.draggable = true;
    card.ondragstart = (e) => onFileDragStart(e, side, full, f.name, f.is_dir);
    card.innerHTML = `
        <input type="checkbox" class="file-check grid-check" data-side="${side}" data-path="${esc(full)}" data-name="${esc(f.name)}">
        <div class="grid-icon ${f.is_dir?'dir':''}" onclick="${f.is_dir ? `panelNavigateTo('${side}','${escJs(full)}')` : ''}"><i class="${icon}"></i></div>
        <div class="grid-name" title="${esc(f.name)}">${esc(f.name)}</div>
        <div class="grid-meta">${f.is_dir ? "文件夹" : formatSize(f.size)}</div>
        <div class="grid-actions">
            ${panelMode==="dual"?`<button class="btn-icon" title="发送到对面" onclick="transferToOther('${side}','${escJs(full)}',${f.is_dir})"><i class="fas fa-exchange-alt"></i></button>`:""}
            <button class="btn-icon" title="删除" onclick="deleteSingle('${side}','${escJs(full)}')"><i class="fas fa-trash" style="color:var(--danger)"></i></button>
        </div>`;
    return card;
}

function renderPanelPagination(side, total, totalPages) {
    const p = P[side];
    const hc = P[side].entries.length - getFiltered(side).length;
    let html = `<span class="page-info">${total}项${hc > 0 ? `(${hc}隐藏)` : ""} ${p.page}/${totalPages}页</span><div class="page-btns">`;
    html += `<button class="btn-sm" ${p.page<=1?"disabled":""} onclick="panelGoToPage('${side}',${p.page-1})"><i class="fas fa-angle-left"></i></button>`;
    const s = Math.max(1, p.page - 2), e = Math.min(totalPages, p.page + 2);
    for (let i = s; i <= e; i++) html += `<button class="btn-sm ${i===p.page?'page-active':''}" onclick="panelGoToPage('${side}',${i})">${i}</button>`;
    html += `<button class="btn-sm" ${p.page>=totalPages?"disabled":""} onclick="panelGoToPage('${side}',${p.page+1})"><i class="fas fa-angle-right"></i></button></div>`;
    document.getElementById(`${side}-pagination`).innerHTML = html;
}

function panelNavigateTo(side, path) { P[side].path = path || "/"; P[side].page = 1; refreshPanel(side); setActivePanel(side); }
function panelGoUp(side) { const p = P[side]; if (p.path === "/") return; const parts = p.path.split("/").filter(Boolean); parts.pop(); p.path = "/" + parts.join("/"); p.page = 1; refreshPanel(side); }
function panelGoToPage(side, page) { P[side].page = page; renderPanelFiles(side); }
function toggleHidden() { showHidden = !showHidden; ["left","right"].forEach(s => { if (P[s].nodeId != null) renderPanelFiles(s); }); updateToolbarState(); }
function toggleView() { viewMode = viewMode === "list" ? "grid" : "list"; ["left","right"].forEach(s => { if (P[s].nodeId != null) renderPanelFiles(s); }); updateToolbarState(); }
function toggleSelectAll(side, checked) { document.querySelectorAll(`.file-check[data-side="${side}"]`).forEach(c => c.checked = checked); }
function getCheckedForPanel(side) { return [...document.querySelectorAll(`.file-check[data-side="${side}"]:checked`)].map(c => c.dataset.path); }

/* ========== Cross-Panel Transfer (Drag & Drop) ========== */
let dragData = null;

function onFileDragStart(e, side, path, name, isDir) {
    dragData = { side, path, name, isDir, nodeId: P[side].nodeId };
    e.dataTransfer.setData("text/plain", name);
    e.dataTransfer.effectAllowed = "copy";
    const other = otherSide(side);
    if (P[other].nodeId != null) document.getElementById(`${other}-drop-zone`).classList.remove("hidden");
}

function initPanelDropZones() {
    ["left", "right"].forEach(side => {
        const zone = document.getElementById(`${side}-drop-zone`);
        const panel = document.getElementById(`panel-${side}`);

        panel.addEventListener("dragover", e => {
            if (!dragData || dragData.side === side) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
        });

        panel.addEventListener("drop", async e => {
            e.preventDefault();
            zone.classList.add("hidden");
            if (!dragData || dragData.side === side) { dragData = null; return; }
            if (P[side].nodeId == null) { toast("目标面板未连接服务器", "error"); dragData = null; return; }
            await doTransfer(dragData.nodeId, dragData.path, dragData.isDir, P[side].nodeId, P[side].path);
            dragData = null;
            refreshPanel(side);
        });

        panel.addEventListener("dragleave", e => {
            if (!panel.contains(e.relatedTarget)) zone.classList.add("hidden");
        });
    });

    document.addEventListener("dragend", () => {
        dragData = null;
        document.querySelectorAll(".panel-drop-zone").forEach(z => z.classList.add("hidden"));
    });
}

async function transferToOther(side, path, isDir) {
    const other = otherSide(side);
    if (P[other].nodeId == null) { toast("请先在对面面板连接一个服务器", "info"); return; }
    if (P[side].nodeId === P[other].nodeId) {
        const dest = P[other].path;
        const conn = P[side].nodeId;
        try { await apiJson(`/api/files/${conn}/copy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, dest }) }); toast("复制成功", "success"); refreshPanel(other); }
        catch (e) { toast("复制失败: " + e.message, "error"); }
        return;
    }
    await doTransfer(P[side].nodeId, path, isDir, P[other].nodeId, P[other].path);
    refreshPanel(other);
}

async function doTransfer(srcNodeId, srcPath, isDir, dstNodeId, dstPath) {
    const tt = document.getElementById("transfer-toast");
    const msg = document.getElementById("transfer-msg");
    msg.textContent = `传输中: ${srcPath.split("/").pop()} ...`;
    tt.classList.remove("hidden");
    try {
        const result = await apiJson("/api/transfer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ src_node_id: srcNodeId, src_path: srcPath, dst_node_id: dstNodeId, dst_path: dstPath }),
        });
        toast(`传输完成: ${result.name}`, "success");
    } catch (e) {
        toast("传输失败: " + e.message, "error");
    } finally {
        tt.classList.add("hidden");
    }
}

/* ========== File Operations (panel-aware) ========== */
function downloadFile(side, path) { window.open(`/api/files/${P[side].nodeId}/download?path=${encodeURIComponent(path)}`, "_blank"); }

async function deleteSingle(side, path) {
    if (!confirm(`删除 ${path}？（移入回收站）`)) return;
    try { await apiJson(`/api/files/${P[side].nodeId}?path=${encodeURIComponent(path)}`, { method: "DELETE" }); toast("已移入回收站", "success"); refreshPanel(side); }
    catch (e) { toast("删除失败: " + e.message, "error"); }
}

async function deleteSelected() {
    const side = activePanel, p = ap();
    if (p.nodeId == null) return;
    const checked = getCheckedForPanel(side);
    if (!checked.length) return toast("请先选择文件", "info");
    if (!confirm(`删除 ${checked.length} 个文件？（移入回收站）`)) return;
    for (const path of checked) { try { await apiJson(`/api/files/${p.nodeId}?path=${encodeURIComponent(path)}`, { method: "DELETE" }); } catch (e) { toast(`删除失败: ${e.message}`, "error"); } }
    toast("已移入回收站", "success"); refreshPanel(side);
}

function showMkdirModal() { if (ap().nodeId == null) return toast("请先连接服务器","info"); document.getElementById("mkdir-name").value = ""; openModal("mkdir-modal"); }
async function doMkdir(e) { e.preventDefault(); const p = ap(), name = document.getElementById("mkdir-name").value, full = p.path === "/" ? `/${name}` : `${p.path}/${name}`; try { await apiJson(`/api/files/${p.nodeId}/mkdir`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({path:full}) }); toast("已创建","success"); closeModal("mkdir-modal"); refreshPanel(activePanel); } catch(e){ toast("失败: "+e.message,"error"); } }

function showCreateFileModal() { if (ap().nodeId == null) return toast("请先连接服务器","info"); document.getElementById("createfile-name").value = ""; openModal("createfile-modal"); }
async function doCreateFile(e) { e.preventDefault(); const p = ap(), name = document.getElementById("createfile-name").value, full = p.path === "/" ? `/${name}` : `${p.path}/${name}`; try { await apiJson(`/api/files/${p.nodeId}/create`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({path:full,content:""}) }); toast("已创建","success"); closeModal("createfile-modal"); refreshPanel(activePanel); } catch(e){ toast("失败: "+e.message,"error"); } }

function showRenameModal(side, path, name) { setActivePanel(side); document.getElementById("rename-old").value = path; document.getElementById("rename-new").value = name; openModal("rename-modal"); }
async function doRename(e) { e.preventDefault(); const p = ap(), old = document.getElementById("rename-old").value, parts = old.split("/"); parts[parts.length-1] = document.getElementById("rename-new").value; try { await apiJson(`/api/files/${p.nodeId}/rename`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({old_path:old,new_path:parts.join("/")}) }); toast("已重命名","success"); closeModal("rename-modal"); refreshPanel(activePanel); } catch(e){ toast("失败: "+e.message,"error"); } }

function showCompressModal() { if (ap().nodeId == null) return; const c = getCheckedForPanel(activePanel); if (!c.length) return toast("请先选择文件","info"); document.getElementById("compress-name").value = "archive.tar.gz"; openModal("compress-modal"); }
async function doCompress(e) { e.preventDefault(); const p = ap(), c = getCheckedForPanel(activePanel), name = document.getElementById("compress-name").value; try { await apiJson(`/api/files/${p.nodeId}/compress`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({paths:c,archive_name:name,cwd:p.path}) }); toast("压缩完成","success"); closeModal("compress-modal"); refreshPanel(activePanel); } catch(e){ toast("失败: "+e.message,"error"); } }

async function undoLast() {
    const p = ap();
    if (p.nodeId == null) return toast("请先连接服务器", "info");
    try {
        const stack = await apiJson(`/api/undo/${p.nodeId}`);
        if (!stack.last) return toast("没有可撤销的操作", "info");
        const desc = stack.last.type === "delete" ? `删除 ${stack.last.original_path}`
                   : stack.last.type === "move"   ? `移动 ${stack.last.src}`
                   : stack.last.type === "rename"  ? `重命名 ${stack.last.old_path}`
                   : stack.last.type;
        if (!confirm(`撤销: ${desc}？`)) return;
        const r = await apiJson(`/api/undo/${p.nodeId}`, { method: "POST" });
        toast(`已撤销: ${r.restored}`, "success");
        refreshPanel(activePanel);
        if (panelMode === "dual" && P[otherSide(activePanel)].nodeId != null) refreshPanel(otherSide(activePanel));
    } catch (e) {
        const msg = e.message.includes("No operation") ? "没有可撤销的操作" : "撤销失败: " + e.message;
        toast(msg, e.message.includes("No operation") ? "info" : "error");
    }
}

async function showTrashPanel() { const p = ap(); if (p.nodeId == null) return; openModal("trash-modal"); const c = document.getElementById("trash-list"); c.innerHTML = '<div style="padding:20px;text-align:center"><i class="fas fa-spinner fa-spin"></i></div>'; try { const items = await apiJson(`/api/trash/${p.nodeId}`); if (!items.length) { c.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim)">回收站为空</div>'; return; } let h = '<table class="trash-table"><thead><tr><th>文件名</th><th>大小</th><th>删除时间</th><th>操作</th></tr></thead><tbody>'; items.forEach(i => { h += `<tr><td>${esc(i.original_name)}</td><td>${i.is_dir?"-":formatSize(i.size)}</td><td>${formatTime(i.deleted_at)}</td><td class="trash-actions"><button class="btn-sm" onclick="restoreTrashItem('${escJs(i.trash_path)}','${escJs(i.original_name)}')"><i class="fas fa-undo"></i></button><button class="btn-sm btn-danger" onclick="deleteTrashItem('${escJs(i.trash_path)}')"><i class="fas fa-times"></i></button></td></tr>`; }); h += '</tbody></table>'; c.innerHTML = h; } catch(e){ c.innerHTML = `<div style="color:var(--danger);padding:20px">${esc(e.message)}</div>`; } }
async function restoreTrashItem(tp, name) { const dest = prompt("恢复到：", ap().path+"/"+name); if (!dest) return; try { await apiJson(`/api/trash/${ap().nodeId}/restore`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({trash_path:tp,original_path:dest})}); toast("已恢复","success"); showTrashPanel(); refreshPanel(activePanel); } catch(e){ toast("失败: "+e.message,"error"); } }
async function deleteTrashItem(tp) { if (!confirm("永久删除？")) return; try { await apiJson(`/api/trash/${ap().nodeId}/item?path=${encodeURIComponent(tp)}`,{method:"DELETE"}); toast("已删除","success"); showTrashPanel(); } catch(e){ toast("失败: "+e.message,"error"); } }
async function emptyTrash() { if (!confirm("清空回收站？")) return; try { await apiJson(`/api/trash/${ap().nodeId}`,{method:"DELETE"}); toast("已清空","success"); showTrashPanel(); } catch(e){ toast("失败: "+e.message,"error"); } }

/* ========== Editor ========== */
let editorOriginal = "";
async function openEditor(side, path) {
    const nodeId = P[side].nodeId;
    document.getElementById("editor-path").value = path;
    document.getElementById("editor-node").value = nodeId;
    document.getElementById("editor-filename").textContent = path.split("/").pop();
    document.getElementById("editor-modified").classList.add("hidden");
    document.getElementById("editor-save-btn").disabled = true;
    const ta = document.getElementById("editor-textarea"); ta.value = "";
    openModal("editor-modal");
    try { const d = await apiJson(`/api/files/${nodeId}/content?path=${encodeURIComponent(path)}`); ta.value = d.content; editorOriginal = d.content; document.getElementById("editor-size").textContent = formatSize(d.size); updateLineNumbers(); }
    catch (e) { toast("加载失败: "+e.message,"error"); closeModal("editor-modal"); }
}
async function saveEditorContent() {
    const nodeId = document.getElementById("editor-node").value, path = document.getElementById("editor-path").value, content = document.getElementById("editor-textarea").value;
    try { await apiJson(`/api/files/${nodeId}/content`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path,content})}); editorOriginal = content; document.getElementById("editor-modified").classList.add("hidden"); document.getElementById("editor-save-btn").disabled = true; toast("已保存","success"); refreshPanel(activePanel); }
    catch (e) { toast("保存失败: "+e.message,"error"); }
}
function closeEditor() { if (document.getElementById("editor-textarea").value !== editorOriginal && !confirm("未保存，确定关闭？")) return; closeModal("editor-modal"); }
function updateLineNumbers() { const ta = document.getElementById("editor-textarea"), n = ta.value.split("\n").length; let h = ""; for (let i=1;i<=n;i++) h+=i+"\n"; document.getElementById("editor-lines").textContent = h; }
function updateCursorPos() { const ta = document.getElementById("editor-textarea"), v = ta.value.substring(0,ta.selectionStart), l = v.split("\n").length, c = ta.selectionStart - v.lastIndexOf("\n"); document.getElementById("editor-cursor").textContent = `行 ${l}, 列 ${c}`; }
function initEditor() {
    const ta = document.getElementById("editor-textarea"); if (!ta) return;
    ta.addEventListener("input", () => { const m = ta.value !== editorOriginal; document.getElementById("editor-modified").classList.toggle("hidden",!m); document.getElementById("editor-save-btn").disabled = !m; updateLineNumbers(); });
    ta.addEventListener("scroll", () => { document.getElementById("editor-lines").scrollTop = ta.scrollTop; });
    ta.addEventListener("click", updateCursorPos); ta.addEventListener("keyup", updateCursorPos);
    ta.addEventListener("keydown", e => { if ((e.ctrlKey||e.metaKey)&&e.key==="s") { e.preventDefault(); e.stopPropagation(); if (!document.getElementById("editor-save-btn").disabled) saveEditorContent(); } if (e.key==="Tab") { e.preventDefault(); const s=ta.selectionStart,end=ta.selectionEnd; ta.value=ta.value.substring(0,s)+"    "+ta.value.substring(end); ta.selectionStart=ta.selectionEnd=s+4; ta.dispatchEvent(new Event("input")); } });
}

/* ========== Upload (local drag) ========== */
function initUploadDrop() {
    const main = document.getElementById("main"), overlay = document.getElementById("drop-overlay");
    let dc = 0;
    main.addEventListener("dragenter", e => { if (dragData) return; e.preventDefault(); dc++; if (ap().nodeId != null) overlay.classList.remove("hidden"); });
    main.addEventListener("dragleave", e => { if (dragData) return; e.preventDefault(); dc--; if (dc<=0){overlay.classList.add("hidden");dc=0;} });
    main.addEventListener("dragover", e => { if (dragData) return; e.preventDefault(); });
    main.addEventListener("drop", async e => { if (dragData) return; e.preventDefault(); dc=0; overlay.classList.add("hidden"); const p = ap(); if (p.nodeId == null) return; const files = e.dataTransfer.files; if (!files.length) return; for (const f of files) { const fd = new FormData(); fd.append("path",p.path); fd.append("file",f); try { await apiJson(`/api/files/${p.nodeId}/upload`,{method:"POST",body:fd}); toast(`已上传: ${f.name}`,"success"); } catch(err){ toast(`上传失败: ${err.message}`,"error"); } } refreshPanel(activePanel); });
}

/* ========== Helpers ========== */
function openModal(id) { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) {
    document.getElementById(id).classList.add("hidden");
    if (id === "node-modal") ["node-host","node-port","node-username","node-auth-type"].forEach(i => document.getElementById(i).disabled = false);
}
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function escAttr(s) { return s.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/'/g,"&#39;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function escJs(s) { return s.replace(/\\/g,"\\\\").replace(/'/g,"\\'").replace(/"/g,'\\"').replace(/\n/g,"\\n").replace(/\r/g,"\\r").replace(/</g,"\\x3c").replace(/>/g,"\\x3e"); }
function formatSize(b) { if(b<1024) return b+" B"; if(b<1048576) return (b/1024).toFixed(1)+" KB"; if(b<1073741824) return (b/1048576).toFixed(1)+" MB"; return (b/1073741824).toFixed(2)+" GB"; }
function formatTime(ts) { if(!ts) return "-"; return new Date(ts*1000).toLocaleString("zh-CN"); }
function isArchive(n) { return /\.(tar\.gz|tgz|tar|zip|gz|bz2|xz|rar|7z)$/i.test(n); }
function isEditable(n) { return /\.(txt|log|md|json|xml|yaml|yml|toml|ini|conf|cfg|env|sh|bash|py|js|ts|jsx|tsx|go|rs|java|c|cpp|h|hpp|cs|rb|php|lua|sql|html|htm|css|scss|less|vue|svelte|dockerfile|makefile|csv)$/i.test(n) || /^(Makefile|Dockerfile|\.env.*|\.gitignore|README|LICENSE|CHANGELOG)$/i.test(n); }
function getIcon(f) { if(f.is_dir) return "fas fa-folder"; if(isArchive(f.name)) return "fas fa-file-archive"; if(/\.(jpg|jpeg|png|gif|svg|webp)$/i.test(f.name)) return "fas fa-file-image"; if(/\.(mp4|avi|mkv|mov)$/i.test(f.name)) return "fas fa-file-video"; if(/\.(mp3|wav|flac|ogg)$/i.test(f.name)) return "fas fa-file-audio"; if(/\.(pdf)$/i.test(f.name)) return "fas fa-file-pdf"; if(/\.(py|js|ts|go|rs|java|c|cpp|h|sh|html|css|json|xml|yaml|yml|md|txt|log|conf)$/i.test(f.name)) return "fas fa-file-code"; return "fas fa-file"; }

/* ========== Init ========== */
document.addEventListener("DOMContentLoaded", () => {
    loadNodes(); loadLocalInfo(); initUploadDrop(); initEditor(); initPanelDropZones();
    applyMode();
    setActivePanel("left");
    document.addEventListener("keydown", e => {
        if (e.key === "Escape") document.querySelectorAll(".modal:not(.hidden)").forEach(m => m.classList.add("hidden"));
        const editorOpen = !document.getElementById("editor-modal").classList.contains("hidden");
        if ((e.ctrlKey || e.metaKey) && e.key === "z" && !editorOpen) { e.preventDefault(); undoLast(); }
    });
});

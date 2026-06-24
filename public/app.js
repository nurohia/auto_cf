const state = {
  tasks: [],
  logs: [],
  health: null,
  editingTask: null
};

const elements = {
  taskGrid: document.querySelector("#taskGrid"),
  emptyState: document.querySelector("#emptyState"),
  dialog: document.querySelector("#taskDialog"),
  form: document.querySelector("#taskForm"),
  dialogTitle: document.querySelector("#dialogTitle"),
  toast: document.querySelector("#toast"),
  logRows: document.querySelector("#logRows"),
  cfstStatus: document.querySelector("#cfstStatus"),
  cfstPath: document.querySelector("#cfstPath"),
  serviceUrl: document.querySelector("#serviceUrl"),
  loginScreen: document.querySelector("#loginScreen"),
  loginForm: document.querySelector("#loginForm"),
  quickForm: document.querySelector("#quickForm"),
  quickResultPanel: document.querySelector("#quickResultPanel"),
  quickResultGrid: document.querySelector("#quickResultGrid"),
  metricTasks: document.querySelector("#metricTasks"),
  metricEnabled: document.querySelector("#metricEnabled"),
  metricSuccess: document.querySelector("#metricSuccess"),
  metricFailed: document.querySelector("#metricFailed")
};

document.querySelector("#newTaskButton").addEventListener("click", () => openDialog());
document.querySelector("#emptyNewButton").addEventListener("click", () => openDialog());
document.querySelector("#refreshButton").addEventListener("click", () => refresh());
document.querySelector("#logoutButton").addEventListener("click", logout);
document.querySelector("#closeDialogButton").addEventListener("click", () => elements.dialog.close());
document.querySelector("#cancelDialogButton").addEventListener("click", () => elements.dialog.close());
document.querySelector("#authTypeSelect").addEventListener("change", updateAuthFields);
document.querySelector("#quickPreviewButton").addEventListener("click", quickPreview);
elements.form.addEventListener("submit", saveTask);
elements.quickForm.addEventListener("submit", quickRun);
elements.loginForm.addEventListener("submit", login);

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
    button.classList.add("active");
    document.querySelector(`#${button.dataset.view}View`).classList.add("active");
  });
});

elements.serviceUrl.textContent = location.origin;
await init();
setInterval(refresh, 6000);

async function init() {
  const session = await api("/api/session", { skipAuthRedirect: true });
  if (session.authenticated) {
    showLogin(false);
    await refresh();
  } else {
    showLogin(true);
  }
}

async function login(event) {
  event.preventDefault();
  const formData = new FormData(elements.loginForm);
  try {
    await api("/api/session", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(formData.entries())),
      skipAuthRedirect: true
    });
    elements.loginForm.reset();
    showLogin(false);
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
}

async function logout() {
  await api("/api/session", { method: "DELETE", skipAuthRedirect: true });
  showLogin(true);
}

function showLogin(visible) {
  elements.loginScreen.classList.toggle("hidden", !visible);
}

async function refresh() {
  if (!elements.loginScreen.classList.contains("hidden")) return;
  try {
    const [tasksData, healthData] = await Promise.all([
      api("/api/tasks"),
      api("/api/health")
    ]);
    state.tasks = tasksData.tasks;
    state.logs = tasksData.logs;
    state.health = healthData;
    render();
  } catch (error) {
    showToast(error.message);
  }
}

function render() {
  renderHealth();
  renderMetrics();
  renderTasks();
  renderLogs();
}

function renderHealth() {
  const found = state.health?.cfst?.found;
  elements.cfstStatus.textContent = found ? "已就绪" : "未找到";
  elements.cfstPath.textContent = state.health?.cfst?.path || "未找到";
}

function renderMetrics() {
  elements.metricTasks.textContent = state.tasks.length;
  elements.metricEnabled.textContent = state.tasks.filter((task) => task.enabled).length;
  elements.metricSuccess.textContent = state.logs.filter((log) => log.status === "success").length;
  elements.metricFailed.textContent = state.logs.filter((log) => log.status === "failed").length;
}

function renderTasks() {
  elements.taskGrid.innerHTML = "";
  elements.emptyState.classList.toggle("hidden", state.tasks.length > 0);

  for (const task of state.tasks) {
    const card = document.createElement("article");
    card.className = "task-card";
    card.innerHTML = `
      <div class="card-head">
        <div class="task-title">
          <h2>${escapeHtml(task.name)}</h2>
          <p>${escapeHtml(task.hostname)}</p>
        </div>
        <span class="status ${escapeHtml(task.status)}">${statusLabel(task.status)}</span>
      </div>
      <div class="ip-box">
        <span>当前解析</span>
        <strong>${escapeHtml(task.currentIp || "等待同步")}</strong>
      </div>
      <div class="details">
        <div class="detail">
          <span>记录类型</span>
          <strong>${escapeHtml(task.recordType)}</strong>
        </div>
        <div class="detail">
          <span>定时</span>
          <strong>${escapeHtml(task.intervalLabel)}</strong>
        </div>
        <div class="detail">
          <span>下次运行</span>
          <strong>${task.nextRunAt ? formatDate(task.nextRunAt) : "未启用"}</strong>
        </div>
        <div class="detail">
          <span>Zone</span>
          <strong>${escapeHtml(task.zoneName || "待查询")}</strong>
        </div>
        <div class="detail wide-detail">
          <span>优选目标</span>
          <strong>${escapeHtml(task.testTarget || task.hostname)}</strong>
        </div>
      </div>
      <p class="message">${escapeHtml(task.lastMessage || "准备就绪")}</p>
      <div class="card-actions">
        <button class="primary-button" data-action="run">立即优选</button>
        <button class="ghost-button" data-action="test">测试</button>
        <button class="ghost-button" data-action="edit">编辑</button>
        <button class="ghost-button" data-action="toggle">${task.enabled ? "暂停" : "启用"}</button>
        <button class="ghost-button danger" data-action="delete">删除</button>
      </div>
    `;

    card.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => handleTaskAction(task, button.dataset.action));
    });
    elements.taskGrid.appendChild(card);
  }
}

function renderLogs() {
  elements.logRows.innerHTML = "";

  for (const log of state.logs) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${formatDate(log.startedAt)}</td>
      <td>${escapeHtml(log.hostname || "")}</td>
      <td>${escapeHtml(log.oldIp || "-")}</td>
      <td>${escapeHtml(log.newIp || "-")}</td>
      <td>${log.latency ?? "-"}</td>
      <td>${log.speed ?? "-"}</td>
      <td><span class="status ${escapeHtml(log.status)}">${statusLabel(log.status)}</span></td>
      <td>${escapeHtml(log.message || "")}</td>
    `;
    elements.logRows.appendChild(row);
  }

  if (state.logs.length === 0) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="8">暂无运行日志</td>`;
    elements.logRows.appendChild(row);
  }
}

async function handleTaskAction(task, action) {
  try {
    if (action === "edit") {
      openDialog(task);
      return;
    }

    if (action === "delete") {
      if (!confirm(`删除任务 ${task.name}？`)) return;
      await api(`/api/tasks/${task.id}`, { method: "DELETE" });
      showToast("任务已删除");
      await refresh();
      return;
    }

    if (action === "run") {
      await api(`/api/tasks/${task.id}/run`, { method: "POST" });
      showToast("已加入优选队列");
    }

    if (action === "toggle") {
      await api(`/api/tasks/${task.id}/toggle`, { method: "POST" });
      showToast(task.enabled ? "任务已暂停" : "任务已启用");
    }

    if (action === "test") {
      const result = await api(`/api/tasks/${task.id}/test`, { method: "POST" });
      showToast(`连接成功：${result.zoneName}`);
    }

    await refresh();
  } catch (error) {
    showToast(error.message);
  }
}

function openDialog(task = null) {
  state.editingTask = task;
  elements.form.reset();
  elements.dialogTitle.textContent = task ? "编辑任务" : "新增任务";
  elements.form.id.value = task?.id || "";
  elements.form.name.value = task?.name || "";
  elements.form.authType.value = task?.authType || "token";
  elements.form.authEmail.value = task?.authEmail || "";
  elements.form.testTarget.value = task?.testTarget || task?.hostname || "";
  elements.form.hostname.value = task?.hostname || "";
  elements.form.apiToken.required = !task;
  elements.form.recordType.value = task?.recordType || "A";
  elements.form.ttl.value = task?.ttl || 1;
  elements.form.intervalValue.value = task?.intervalValue || 1;
  elements.form.intervalUnit.value = task?.intervalUnit || "hours";
  elements.form.maxLatency.value = task?.maxLatency ?? "";
  elements.form.minSpeed.value = task?.minSpeed ?? "";
  elements.form.cfstArgs.value = task?.cfstArgs || "";
  elements.form.proxied.checked = Boolean(task?.proxied);
  elements.form.enabled.checked = task?.enabled ?? true;
  updateAuthFields();
  elements.dialog.showModal();
}

function updateAuthFields() {
  const isGlobalKey = elements.form.authType.value === "globalKey";
  document.querySelector("#credentialLabel").textContent = isGlobalKey
    ? "Cloudflare Global API Key"
    : "Cloudflare API Token";
  elements.form.authEmail.required = isGlobalKey;
}

async function saveTask(event) {
  event.preventDefault();
  const payload = formPayload();
  const id = elements.form.id.value;

  try {
    await api(id ? `/api/tasks/${id}` : "/api/tasks", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload)
    });
    elements.dialog.close();
    showToast(id ? "任务已更新" : "任务已创建");
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
}

async function quickPreview() {
  const payload = quickPayload();
  if (!payload.testTarget && !payload.hostname) {
    showToast("先填写要优选的域名");
    return;
  }

  try {
    const preview = await api("/api/quick-preview", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    renderQuickResult(preview);
  } catch (error) {
    showToast(error.message);
  }
}

async function quickRun(event) {
  event.preventDefault();
  const payload = quickPayload();
  try {
    elements.quickResultPanel.classList.remove("hidden");
    elements.quickResultGrid.innerHTML = resultItem("状态", "正在优选，请稍等...");
    const result = await api("/api/quick-run", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    renderQuickResult(result);
  } catch (error) {
    showToast(error.message);
    elements.quickResultGrid.innerHTML = resultItem("错误", error.message);
  }
}

function formPayload() {
  const formData = new FormData(elements.form);
  const payload = Object.fromEntries(formData.entries());
  payload.proxied = elements.form.proxied.checked;
  payload.enabled = elements.form.enabled.checked;
  if (!payload.apiToken) delete payload.apiToken;
  return payload;
}

function quickPayload() {
  const formData = new FormData(elements.quickForm);
  return Object.fromEntries(formData.entries());
}

function renderQuickResult(result) {
  elements.quickResultPanel.classList.remove("hidden");
  const items = [
    ["测速 URL", result.testUrl || "-"],
    ["记录类型", result.recordType || "A"],
    ["CFST", result.cfst?.found ? "已就绪" : "未找到"],
    ["CFST 路径", result.cfst?.path || "-"]
  ];

  if (result.result) {
    items.push(["优选 IP", result.result.ip || "-"]);
    items.push(["平均延迟", result.result.latency === null ? "-" : `${result.result.latency} ms`]);
    items.push(["下载速度", result.result.speed === null ? "-" : `${result.result.speed} MB/s`]);
  }

  if (result.message) items.push(["结果", result.message]);
  elements.quickResultGrid.innerHTML = items.map(([label, value]) => resultItem(label, value)).join("");
}

function resultItem(label, value) {
  return `
    <div class="preview-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json"
    },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !options.skipAuthRedirect) {
    showLogin(true);
  }
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function statusLabel(status) {
  return {
    idle: "待命",
    queued: "排队",
    running: "运行中",
    failed: "失败",
    success: "成功"
  }[status] || "待命";
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.add("hidden"), 3200);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

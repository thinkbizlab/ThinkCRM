const state = {
  token: localStorage.getItem("thinkcrm_token") || "",
  user: null,
  cache: {
    paymentTerms: [],
    customers: [],
    items: [],
    customFieldDefinitions: {
      "payment-terms": [],
      customers: [],
      items: []
    },
    kanban: null,
    dealStages: [],
    visits: [],
    calendar: null,
    logs: [],
    kpiTargets: [],
    salesReps: [],
    taxConfig: null,
    branding: null,
    integrationCredentials: []
  },
  masterPage: "payment-terms",
  calendarFilters: {
    view: "month",
    eventType: "all",
    anchorDate: new Date().toISOString(),
    query: "",
    ownerId: "",
    customerId: "",
    visitStatus: "",
    dealStageId: ""
  },
  dashboardMonth: new Date().toISOString().slice(0, 7)
};

const THEME_OVERRIDE_KEY = "thinkcrm_theme_override";
state.themeOverride = localStorage.getItem(THEME_OVERRIDE_KEY) || "AUTO";
state.tenantThemeMode = "LIGHT";

const qs = (selector) => document.querySelector(selector);

const authScreen = qs("#auth-screen");
const appScreen = qs("#app-screen");
const loginForm = qs("#login-form");
const authMessage = qs("#auth-message");
const statusBar = qs("#status-bar");
const userMeta = qs("#user-meta");
const pageTitle = qs("#page-title");
const brandMark = qs("#brand-mark");
const brandTitle = qs("#brand-title");
const themeToggleBtn = qs("#theme-toggle-btn");

const views = {
  dashboard: qs("#view-dashboard"),
  master: qs("#view-master"),
  deals: qs("#view-deals"),
  visits: qs("#view-visits"),
  calendar: qs("#view-calendar"),
  integrations: qs("#view-integrations"),
  settings: qs("#view-settings")
};

const currency = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2
});

const dateTime = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

const masterPageRouteMap = {
  "payment-terms": "/master/payment-terms",
  customers: "/master/customers",
  items: "/master/items"
};

const pageTitleMap = {
  dashboard: "Dashboard",
  master: "Master Data",
  deals: "Deals Pipeline",
  visits: "Visit Execution",
  calendar: "Sales Calendar",
  integrations: "Integration Logs",
  settings: "Admin Settings"
};

const customFieldEntityApiMap = {
  "payment-terms": "payment-term",
  customers: "customer",
  items: "item"
};

function asMoney(value) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return currency.format(Number(value));
}

function asDate(value) {
  if (!value) return "-";
  return dateTime.format(new Date(value));
}

function asDateInput(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function asPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return "0.00";
  return Number(value).toFixed(2);
}

function shiftAnchorDate(anchorDate, view, direction) {
  const d = new Date(anchorDate || new Date().toISOString());
  const amount = direction === "next" ? 1 : -1;
  if (view === "year") d.setUTCFullYear(d.getUTCFullYear() + amount);
  if (view === "month") d.setUTCMonth(d.getUTCMonth() + amount);
  if (view === "day") d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString();
}

function prettyLabel(value) {
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getCustomFieldDefinitions(pageKey) {
  return state.cache.customFieldDefinitions[pageKey] || [];
}

function collectCustomFieldPayload(formData, definitions) {
  const customFields = {};
  definitions
    .filter((definition) => definition.isActive)
    .forEach((definition) => {
      const key = `cf__${definition.fieldKey}`;
      if (definition.dataType === "BOOLEAN") {
        customFields[definition.fieldKey] = formData.has(key);
        return;
      }
      const rawValue = formData.get(key);
      if (rawValue == null) return;
      const value = String(rawValue).trim();
      if (!value.length) return;
      if (definition.dataType === "NUMBER") {
        customFields[definition.fieldKey] = Number(value);
        return;
      }
      customFields[definition.fieldKey] = value;
    });
  return customFields;
}

function renderCustomFieldInputs(definitions) {
  const activeDefinitions = definitions.filter((definition) => definition.isActive);
  if (!activeDefinitions.length) return "";
  return `
    <div class="list">
      ${activeDefinitions
        .map((definition) => {
          const key = `cf__${definition.fieldKey}`;
          const required = definition.isRequired ? "required" : "";
          if (definition.dataType === "SELECT") {
            const options = Array.isArray(definition.optionsJson) ? definition.optionsJson : [];
            return `
              <label>${definition.label}
                <select name="${key}" ${required}>
                  <option value="">Select...</option>
                  ${options.map((option) => `<option value="${option}">${option}</option>`).join("")}
                </select>
              </label>
            `;
          }
          if (definition.dataType === "BOOLEAN") {
            return `
              <label>
                <input type="checkbox" name="${key}" />
                ${definition.label}
              </label>
            `;
          }
          const inputType = definition.dataType === "NUMBER" ? "number" : definition.dataType === "DATE" ? "date" : "text";
          return `
            <label>${definition.label}
              <input name="${key}" type="${inputType}" ${required} placeholder="${definition.placeholder || ""}" />
            </label>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderCustomFieldDefinitionRows(pageKey) {
  const definitions = getCustomFieldDefinitions(pageKey);
  if (!definitions.length) {
    return '<div class="empty-state compact"><div><strong>No custom fields</strong><p>Add fields to configure tenant-specific metadata.</p></div></div>';
  }
  return definitions
    .map(
      (definition) => `
      <div class="row">
        <h4>${definition.label}</h4>
        <div class="muted">${definition.fieldKey} · ${definition.dataType}</div>
        <div class="muted">Required: ${definition.isRequired ? "Yes" : "No"} · Order: ${definition.displayOrder}</div>
        <div class="inline-actions wrap">
          <button
            class="custom-field-toggle ghost"
            data-id="${definition.id}"
            data-entity="${customFieldEntityApiMap[pageKey]}"
            data-active="${definition.isActive}"
          >
            ${definition.isActive ? "Deactivate" : "Activate"}
          </button>
        </div>
      </div>
    `
    )
    .join("");
}

function renderCustomFieldsSummary(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return "";
  const entries = Object.entries(values);
  if (!entries.length) return "";
  return `
    <div class="inline-actions wrap">
      ${entries
        .map(
          ([key, value]) =>
            `<span class="chip">${prettyLabel(key)}: ${typeof value === "boolean" ? (value ? "Yes" : "No") : value}</span>`
        )
        .join("")}
    </div>
  `;
}

function normalizeHex(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }
  return fallback;
}

function darkenHex(hex, amount = 26) {
  const parsed = normalizeHex(hex, "#2563eb").slice(1);
  const r = Math.max(0, parseInt(parsed.slice(0, 2), 16) - amount);
  const g = Math.max(0, parseInt(parsed.slice(2, 4), 16) - amount);
  const b = Math.max(0, parseInt(parsed.slice(4, 6), 16) - amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function updateThemeToggleLabel() {
  if (!themeToggleBtn) return;
  const text =
    state.themeOverride === "AUTO"
      ? "Theme: Auto"
      : state.themeOverride === "DARK"
        ? "Theme: Dark"
        : "Theme: Light";
  themeToggleBtn.textContent = text;
}

function resolveThemeMode(tenantThemeMode = "LIGHT") {
  if (state.themeOverride === "LIGHT" || state.themeOverride === "DARK") {
    return state.themeOverride;
  }
  return tenantThemeMode === "DARK" ? "DARK" : "LIGHT";
}

function applyThemeMode(tenantThemeMode = "LIGHT") {
  state.tenantThemeMode = tenantThemeMode;
  const resolved = resolveThemeMode(tenantThemeMode);
  document.documentElement.dataset.theme = resolved.toLowerCase();
  updateThemeToggleLabel();
  updateUserMeta();
}

function applyBrandingTheme(branding) {
  if (!branding) return;
  const primary = normalizeHex(branding.primaryColor, "#2563eb");
  const secondary = normalizeHex(branding.secondaryColor, "#0f172a");
  const strong = darkenHex(primary, 28);

  document.documentElement.style.setProperty("--primary", primary);
  document.documentElement.style.setProperty("--primary-strong", strong);
  document.documentElement.style.setProperty("--secondary", secondary);

  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.setAttribute("content", primary);
  }

  if (brandTitle) {
    brandTitle.textContent = "ThinkCRM";
  }
  if (brandMark) {
    if (branding.logoUrl) {
      brandMark.innerHTML = `<img src="${branding.logoUrl}" alt="ThinkCRM logo" />`;
    } else {
      brandMark.textContent = "TC";
    }
  }

  applyThemeMode(branding.themeMode || "LIGHT");
}

function renderThemeDebugChip() {
  return `<span class="chip theme-debug-chip">Tenant: ${state.tenantThemeMode} | User: ${state.themeOverride}</span>`;
}

function updateUserMeta() {
  if (!userMeta || !state.user) return;
  userMeta.innerHTML = `${state.user.fullName} (${state.user.role}) ${renderThemeDebugChip()}`;
}

function setStatus(text, isError = false) {
  statusBar.textContent = text;
  statusBar.style.color = isError ? "#b91c1c" : "#0369a1";
}

async function api(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  const headers = {
    ...(isFormData ? {} : { "content-type": "application/json" }),
    ...(options.headers || {})
  };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const response = await fetch(`/api/v1${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? (isFormData ? options.body : JSON.stringify(options.body)) : undefined
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(data?.message || `API ${response.status}`);
  }
  return data;
}

const voiceNoteState = {
  entityType: null,
  entityId: null,
  jobId: null,
  mediaRecorder: null,
  chunks: [],
  stream: null,
  initBound: false
};

function getVoiceNoteEls() {
  const root = qs("#voice-note-modal");
  if (!root) return null;
  return {
    root,
    subtitle: qs("#voice-note-modal-subtitle"),
    recordBtn: qs("#voice-note-record"),
    stopBtn: qs("#voice-note-stop"),
    status: qs("#voice-note-status"),
    review: qs("#voice-note-review"),
    transcript: qs("#voice-note-transcript"),
    summary: qs("#voice-note-summary"),
    confirmBtn: qs("#voice-note-confirm"),
    rejectBtn: qs("#voice-note-reject"),
    fileInput: qs("#voice-note-file")
  };
}

function setVoiceNoteStatus(text, isError = false) {
  const els = getVoiceNoteEls();
  if (!els?.status) return;
  els.status.textContent = text || "";
  els.status.style.color = isError ? "#b91c1c" : "";
}

function stopVoiceNoteMedia() {
  if (voiceNoteState.mediaRecorder && voiceNoteState.mediaRecorder.state !== "inactive") {
    try {
      voiceNoteState.mediaRecorder.stop();
    } catch {
      /* ignore */
    }
  }
  voiceNoteState.mediaRecorder = null;
  voiceNoteState.chunks = [];
  if (voiceNoteState.stream) {
    voiceNoteState.stream.getTracks().forEach((t) => t.stop());
    voiceNoteState.stream = null;
  }
}

function resetVoiceNoteModal() {
  const els = getVoiceNoteEls();
  if (!els) return;
  stopVoiceNoteMedia();
  voiceNoteState.jobId = null;
  els.review.hidden = true;
  els.transcript.value = "";
  els.summary.value = "";
  els.fileInput.value = "";
  els.recordBtn.disabled = false;
  els.stopBtn.disabled = true;
  els.confirmBtn.disabled = false;
  els.rejectBtn.disabled = false;
  setVoiceNoteStatus("");
}

function openVoiceNoteModal(entityType, entityId, subtitle) {
  const els = getVoiceNoteEls();
  if (!els) return;
  resetVoiceNoteModal();
  voiceNoteState.entityType = entityType;
  voiceNoteState.entityId = entityId;
  els.subtitle.textContent = subtitle ? `${entityType} · ${subtitle}` : entityType;
  els.root.hidden = false;
}

function closeVoiceNoteModal() {
  const els = getVoiceNoteEls();
  if (!els) return;
  resetVoiceNoteModal();
  els.root.hidden = true;
}

async function uploadVoiceNoteAudio(blob, filename) {
  const els = getVoiceNoteEls();
  if (!els || !voiceNoteState.entityType || !voiceNoteState.entityId) return;
  setVoiceNoteStatus("Uploading and transcribing…");
  els.recordBtn.disabled = true;
  els.stopBtn.disabled = true;
  const form = new FormData();
  form.append("entityType", voiceNoteState.entityType);
  form.append("entityId", voiceNoteState.entityId);
  form.append("audio", blob, filename || "voice-note.webm");
  try {
    const job = await api("/voice-notes", { method: "POST", body: form });
    voiceNoteState.jobId = job.id;
    els.transcript.value = job.transcript?.transcriptText ?? "";
    els.summary.value = job.transcript?.summaryText ?? "";
    els.review.hidden = false;
    setVoiceNoteStatus("Review transcript and summary, then confirm or reject.");
  } catch (error) {
    setVoiceNoteStatus(error.message, true);
    els.recordBtn.disabled = false;
  }
}

async function startVoiceNoteRecording() {
  const els = getVoiceNoteEls();
  if (!els || !navigator.mediaDevices?.getUserMedia) {
    setVoiceNoteStatus("Recording is not available in this browser. Use “Upload file”.", true);
    return;
  }
  if (!window.MediaRecorder) {
    setVoiceNoteStatus("MediaRecorder is not supported. Use “Upload file”.", true);
    return;
  }
  try {
    voiceNoteState.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime =
      MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    voiceNoteState.chunks = [];
    try {
      voiceNoteState.mediaRecorder = new MediaRecorder(voiceNoteState.stream, { mimeType: mime });
    } catch {
      voiceNoteState.mediaRecorder = new MediaRecorder(voiceNoteState.stream);
    }
    voiceNoteState.mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) voiceNoteState.chunks.push(ev.data);
    };
    voiceNoteState.mediaRecorder.start();
    els.recordBtn.disabled = true;
    els.stopBtn.disabled = false;
    setVoiceNoteStatus("Recording… click Stop when finished.");
  } catch (error) {
    setVoiceNoteStatus(error.message || "Could not access microphone.", true);
    stopVoiceNoteMedia();
  }
}

function stopVoiceNoteRecording() {
  const els = getVoiceNoteEls();
  if (!els || !voiceNoteState.mediaRecorder) return;
  const mr = voiceNoteState.mediaRecorder;
  if (mr.state === "inactive") return;
  els.stopBtn.disabled = true;
  setVoiceNoteStatus("Processing recording…");
  mr.addEventListener(
    "stop",
    async () => {
      voiceNoteState.stream?.getTracks().forEach((t) => t.stop());
      voiceNoteState.stream = null;
      const blob = new Blob(voiceNoteState.chunks, { type: mr.mimeType || "audio/webm" });
      voiceNoteState.chunks = [];
      voiceNoteState.mediaRecorder = null;
      if (!blob.size) {
        setVoiceNoteStatus("No audio captured. Try again or upload a file.", true);
        els.recordBtn.disabled = false;
        return;
      }
      const ext = blob.type.includes("webm") ? "webm" : "ogg";
      await uploadVoiceNoteAudio(blob, `note.${ext}`);
    },
    { once: true }
  );
  mr.stop();
}

function bindVoiceNoteModal() {
  if (voiceNoteState.initBound) return;
  const els = getVoiceNoteEls();
  if (!els) return;
  voiceNoteState.initBound = true;
  els.root.addEventListener("click", (event) => {
    if (event.target?.closest?.("[data-voice-note-close]")) closeVoiceNoteModal();
  });
  els.recordBtn.addEventListener("click", () => {
    void startVoiceNoteRecording();
  });
  els.stopBtn.addEventListener("click", () => {
    stopVoiceNoteRecording();
  });
  els.fileInput.addEventListener("change", () => {
    const file = els.fileInput.files?.[0];
    if (!file) return;
    void uploadVoiceNoteAudio(file, file.name);
    els.fileInput.value = "";
  });
  els.confirmBtn.addEventListener("click", async () => {
    if (!voiceNoteState.jobId) return;
    setVoiceNoteStatus("Saving…");
    els.confirmBtn.disabled = true;
    els.rejectBtn.disabled = true;
    try {
      await api(`/voice-notes/${voiceNoteState.jobId}/confirm`, {
        method: "POST",
        body: {
          transcriptText: els.transcript.value,
          summaryText: els.summary.value
        }
      });
      const reloadAs = voiceNoteState.entityType;
      setStatus("Voice note confirmed and saved.");
      closeVoiceNoteModal();
      if (reloadAs === "DEAL") {
        await loadDeals();
        await loadDashboard();
      } else if (reloadAs === "VISIT") {
        await loadVisits();
      }
    } catch (error) {
      setVoiceNoteStatus(error.message, true);
      els.confirmBtn.disabled = false;
      els.rejectBtn.disabled = false;
    }
  });
  els.rejectBtn.addEventListener("click", async () => {
    if (!voiceNoteState.jobId) return;
    setVoiceNoteStatus("Rejecting…");
    els.confirmBtn.disabled = true;
    els.rejectBtn.disabled = true;
    try {
      await api(`/voice-notes/${voiceNoteState.jobId}/reject`, { method: "POST", body: {} });
      setStatus("Voice note rejected (nothing saved to CRM).");
      closeVoiceNoteModal();
    } catch (error) {
      setVoiceNoteStatus(error.message, true);
      els.confirmBtn.disabled = false;
      els.rejectBtn.disabled = false;
    }
  });
}

function switchView(target) {
  Object.entries(views).forEach(([key, el]) => {
    const isActive = key === target;
    el.classList.toggle("active", isActive);
    if (isActive) {
      el.classList.remove("view-enter");
      requestAnimationFrame(() => el.classList.add("view-enter"));
    }
  });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === target);
  });
  if (pageTitle) pageTitle.textContent = pageTitleMap[target] || "ThinkCRM";
}

function showApp() {
  authScreen.classList.remove("active");
  appScreen.classList.add("active");
}

function showAuth() {
  appScreen.classList.remove("active");
  authScreen.classList.add("active");
}

function syncMasterPageFromLocation() {
  const path = window.location.pathname;
  if (!path.startsWith("/master/")) return false;
  const page = path.replace("/master/", "");
  if (page in masterPageRouteMap) {
    state.masterPage = page;
    switchView("master");
    return true;
  }
  return false;
}

function navigateToMasterPage(page) {
  state.masterPage = page;
  const route = masterPageRouteMap[page] || "/master/payment-terms";
  if (window.location.pathname !== route) {
    window.history.pushState({ page }, "", route);
  }
}

function renderDashboard(data) {
  const completion = Number(data.kpis.visitCompletionRate || 0);
  const periodMonth = data?.period?.month || state.dashboardMonth;
  state.dashboardMonth = periodMonth;
  const topGamers = Array.isArray(data.gamification) ? data.gamification.slice(0, 5) : [];
  const teams = Array.isArray(data.teamPerformance) ? data.teamPerformance : [];
  views.dashboard.innerHTML = `
    <section class="card hero-metric">
      <div>
        <h3 class="section-title">Sales Command Center</h3>
        <div class="muted">Live KPI summary, target attainment, gamification, and team visibility for ${periodMonth}.</div>
      </div>
      <div class="chip chip-primary">Completion ${completion}%</div>
    </section>
    <section class="card">
      <form id="dashboard-month-form" class="inline-actions wrap dashboard-filter-form">
        <label class="dashboard-filter-label">Reporting Month
          <input type="month" name="month" value="${periodMonth}" required />
        </label>
        <button type="submit">Apply</button>
      </form>
      <div class="inline-actions wrap dashboard-chip-row">
        <span class="chip">Users in scope: ${data.kpis.usersInScope}</span>
        <span class="chip">Deals created: ${data.kpis.dealsCreatedInPeriod}</span>
        <span class="chip">Visits planned: ${data.kpis.visitsPlannedInPeriod}</span>
      </div>
    </section>
    <section class="kpi-grid">
      <article class="kpi"><h4>Active Deals</h4><strong>${data.kpis.activeDeals}</strong><div class="muted">Open pipeline opportunities</div></article>
      <article class="kpi"><h4>Pipeline Value</h4><strong>${asMoney(data.kpis.pipelineValue)}</strong><div class="muted">Potential revenue</div></article>
      <article class="kpi"><h4>Won Value</h4><strong>${asMoney(data.kpis.wonValue)}</strong><div class="muted">Closed won deals</div></article>
      <article class="kpi"><h4>Lost Value</h4><strong>${asMoney(data.kpis.lostValue)}</strong><div class="muted">Closed lost deals</div></article>
      <article class="kpi"><h4>Visit Completion</h4><strong>${completion}%</strong><div class="progress"><span style="width:${Math.min(completion, 100)}%"></span></div></article>
    </section>
    <section class="card">
      <h3 class="section-title">Target vs Actual</h3>
      <div class="list">
        ${
          data.targetVsActual.length
            ? data.targetVsActual
                .map(
                  (t) => `
          <div class="row">
            <div class="section-head">
              <h4>${t.userName}</h4>
              <span class="chip">${t.teamName}</span>
            </div>
            <div class="muted">Month ${t.month}</div>
            <div class="dashboard-target-row">
              <div class="muted">Visits: ${t.actual.visits}/${t.target.visits} (${asPercent(t.progress.visits)}%)</div>
              <div class="progress"><span style="width:${Math.min(Number(t.progress.visits || 0), 100)}%"></span></div>
            </div>
            <div class="dashboard-target-row">
              <div class="muted">New Deal: ${asMoney(t.actual.newDealValue)}/${asMoney(t.target.newDealValue)} (${asPercent(t.progress.newDealValue)}%)</div>
              <div class="progress"><span style="width:${Math.min(Number(t.progress.newDealValue || 0), 100)}%"></span></div>
            </div>
            <div class="dashboard-target-row">
              <div class="muted">Revenue: ${asMoney(t.actual.revenue)}/${asMoney(t.target.revenue)} (${asPercent(t.progress.revenue)}%)</div>
              <div class="progress"><span style="width:${Math.min(Number(t.progress.revenue || 0), 100)}%"></span></div>
            </div>
          </div>`
                )
                .join("")
            : '<div class="empty-state"><div class="empty-icon">🎯</div><div><strong>No KPI targets yet</strong><p>Set monthly targets in Settings to track team progress.</p></div></div>'
        }
      </div>
    </section>
    <section class="card">
      <h3 class="section-title">Gamification Leaderboard</h3>
      <div class="list">
        ${
          topGamers.length
            ? topGamers
                .map(
                  (g) => `
          <div class="row leaderboard-row">
            <div class="section-head">
              <h4>#${g.rank} ${g.userName}</h4>
              <span class="chip chip-primary">${g.badge}</span>
            </div>
            <div class="muted">${g.teamName}</div>
            <div class="inline-actions wrap dashboard-chip-row">
              <span class="chip">Score ${asPercent(g.score)}</span>
              <span class="chip">Streak ${g.streakDays}d</span>
              <span class="chip">Momentum ${String(g.momentum).toUpperCase()}</span>
            </div>
          </div>
        `
                )
                .join("")
            : '<div class="empty-state"><div class="empty-icon">🏆</div><div><strong>No leaderboard data</strong><p>Create KPI targets to generate rankings and badges.</p></div></div>'
        }
      </div>
    </section>
    <section class="card">
      <h3 class="section-title">Team Performance Visibility</h3>
      <div class="list">
        ${
          teams.length
            ? teams
                .map(
                  (team) => `
          <div class="row">
            <div class="section-head">
              <h4>${team.teamName}</h4>
              <span class="chip">${team.memberCount} member${team.memberCount === 1 ? "" : "s"}</span>
            </div>
            <div class="inline-actions wrap dashboard-chip-row">
              <span class="chip">Active Deals ${team.activeDeals}</span>
              <span class="chip">Pipeline ${asMoney(team.pipelineValue)}</span>
              <span class="chip">Won ${asMoney(team.wonValue)}</span>
              <span class="chip">Lost ${asMoney(team.lostValue)}</span>
            </div>
            <div class="dashboard-target-row">
              <div class="muted">Visit completion ${asPercent(team.visitCompletionRate)}% (${team.checkedOutVisits}/${team.plannedVisits})</div>
              <div class="progress"><span style="width:${Math.min(Number(team.visitCompletionRate || 0), 100)}%"></span></div>
            </div>
          </div>
        `
                )
                .join("")
            : '<div class="empty-state"><div class="empty-icon">👥</div><div><strong>No team performance records</strong><p>Assign users to teams to enable team analytics.</p></div></div>'
        }
      </div>
    </section>
  `;

  qs("#dashboard-month-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const month = String(new FormData(event.currentTarget).get("month") || "");
    if (!month) return;
    await loadDashboard(month);
  });
}

function renderMasterData(paymentTerms, customers) {
  const termOptions = paymentTerms
    .map((term) => `<option value="${term.id}">${term.code} - ${term.name}</option>`)
    .join("");
  const paymentTermFieldDefinitions = getCustomFieldDefinitions("payment-terms");
  const customerFieldDefinitions = getCustomFieldDefinitions("customers");
  const itemFieldDefinitions = getCustomFieldDefinitions("items");

  const masterPageTitle =
    state.masterPage === "payment-terms"
      ? "Payment Terms"
      : state.masterPage === "customers"
        ? "Customers"
        : "Items";

  views.master.innerHTML = `
    <section class="card">
      <h3 class="section-title">Master Data Pages</h3>
      <div class="inline-actions wrap">
        <button class="master-page-btn ${state.masterPage === "payment-terms" ? "active-master-btn" : ""}" data-page="payment-terms">Payment Terms</button>
        <button class="master-page-btn ${state.masterPage === "customers" ? "active-master-btn" : ""}" data-page="customers">Customers</button>
        <button class="master-page-btn ${state.masterPage === "items" ? "active-master-btn" : ""}" data-page="items">Items</button>
      </div>
      <div class="chip">${masterPageTitle}</div>
    </section>

    <section class="card" ${state.masterPage !== "payment-terms" ? 'style="display:none"' : ""}>
      <h3 class="section-title">Payment Terms</h3>
      <form id="payment-term-form" class="mini-form">
        <input name="code" placeholder="Code (e.g. NET45)" required />
        <input name="name" placeholder="Name" required />
        <input name="dueDays" type="number" min="0" placeholder="Due days" required />
        ${renderCustomFieldInputs(paymentTermFieldDefinitions)}
        <button type="submit">Create Payment Term</button>
      </form>
      <h4>Custom Fields</h4>
      <form class="mini-form custom-field-def-form" data-entity="payment-term">
        <input name="fieldKey" placeholder="fieldKey (e.g. collectionMethod)" required />
        <input name="label" placeholder="Label" required />
        <select name="dataType" required>
          <option value="TEXT">Text</option>
          <option value="NUMBER">Number</option>
          <option value="BOOLEAN">Boolean</option>
          <option value="DATE">Date</option>
          <option value="SELECT">Select</option>
        </select>
        <input name="options" placeholder="Select options (comma separated)" />
        <input name="displayOrder" type="number" min="0" placeholder="Display order" />
        <label><input name="isRequired" type="checkbox" /> Required</label>
        <button type="submit">Add Field</button>
      </form>
      <div class="list">${renderCustomFieldDefinitionRows("payment-terms")}</div>
      <div class="list">
        ${paymentTerms
          .map(
            (p) => `
          <div class="row">
            <h4>${p.name} (${p.code})</h4>
            <div class="muted">Due ${p.dueDays} days</div>
            <div class="chip ${p.isActive ? "chip-success" : "chip-danger"}">${p.isActive ? "Active" : "Inactive"}</div>
            ${renderCustomFieldsSummary(p.customFields)}
            <div class="inline-actions wrap">
              <button class="payment-term-toggle" data-id="${p.id}" data-active="${p.isActive}">
                ${p.isActive ? "Deactivate" : "Activate"}
              </button>
              <button class="payment-term-delete ghost" data-id="${p.id}">Delete</button>
            </div>
          </div>`
          )
          .join("")}
      </div>
    </section>
    <section class="card" ${state.masterPage !== "customers" ? 'style="display:none"' : ""}>
      <h3 class="section-title">Customers</h3>
      <form id="customer-form" class="mini-form">
        <input name="customerCode" placeholder="Customer code" required />
        <input name="name" placeholder="Customer name" required />
        <select name="defaultTermId" required>
          ${termOptions}
        </select>
        ${renderCustomFieldInputs(customerFieldDefinitions)}
        <button type="submit">Create Customer</button>
      </form>
      <h4>Custom Fields</h4>
      <form class="mini-form custom-field-def-form" data-entity="customer">
        <input name="fieldKey" placeholder="fieldKey (e.g. customerTier)" required />
        <input name="label" placeholder="Label" required />
        <select name="dataType" required>
          <option value="TEXT">Text</option>
          <option value="NUMBER">Number</option>
          <option value="BOOLEAN">Boolean</option>
          <option value="DATE">Date</option>
          <option value="SELECT">Select</option>
        </select>
        <input name="options" placeholder="Select options (comma separated)" />
        <input name="displayOrder" type="number" min="0" placeholder="Display order" />
        <label><input name="isRequired" type="checkbox" /> Required</label>
        <button type="submit">Add Field</button>
      </form>
      <div class="list">${renderCustomFieldDefinitionRows("customers")}</div>
      <div class="list">
        ${customers
          .map(
            (c) => `
          <div class="row">
            <h4>${c.name}</h4>
            <div class="muted">${c.customerCode} · Term ${c.paymentTerm?.code ?? "-"}</div>
            <div class="muted">${c.addresses?.[0]?.addressLine1 ?? "No address"}</div>
            ${renderCustomFieldsSummary(c.customFields)}
            <div class="inline-actions wrap">
              <button class="customer-rename" data-id="${c.id}" data-name="${c.name}">Rename</button>
              <button class="customer-delete ghost" data-id="${c.id}">Delete</button>
            </div>
          </div>`
          )
          .join("")}
      </div>
    </section>
    <section class="card" ${state.masterPage !== "items" ? 'style="display:none"' : ""}>
      <h3 class="section-title">Items</h3>
      <form id="item-form" class="mini-form">
        <input name="itemCode" placeholder="Item code" required />
        <input name="name" placeholder="Item name" required />
        <input name="unitPrice" type="number" min="0" step="0.01" placeholder="Unit price" required />
        ${renderCustomFieldInputs(itemFieldDefinitions)}
        <button type="submit">Create Item</button>
      </form>
      <h4>Custom Fields</h4>
      <form class="mini-form custom-field-def-form" data-entity="item">
        <input name="fieldKey" placeholder="fieldKey (e.g. warrantyMonths)" required />
        <input name="label" placeholder="Label" required />
        <select name="dataType" required>
          <option value="TEXT">Text</option>
          <option value="NUMBER">Number</option>
          <option value="BOOLEAN">Boolean</option>
          <option value="DATE">Date</option>
          <option value="SELECT">Select</option>
        </select>
        <input name="options" placeholder="Select options (comma separated)" />
        <input name="displayOrder" type="number" min="0" placeholder="Display order" />
        <label><input name="isRequired" type="checkbox" /> Required</label>
        <button type="submit">Add Field</button>
      </form>
      <div class="list">${renderCustomFieldDefinitionRows("items")}</div>
      <div class="list" id="item-list"></div>
    </section>
  `;

  const itemList = qs("#item-list");
  itemList.innerHTML = state.cache.items
    .map(
      (item) => `
    <div class="row">
      <h4>${item.name} (${item.itemCode})</h4>
      <div class="muted">Unit price ${asMoney(item.unitPrice)}</div>
      ${renderCustomFieldsSummary(item.customFields)}
      <div class="inline-actions wrap">
        <button class="item-price" data-id="${item.id}" data-price="${item.unitPrice}">Update Price</button>
        <button class="item-delete ghost" data-id="${item.id}">Delete</button>
      </div>
    </div>`
    )
    .join("");

  views.master.querySelectorAll(".master-page-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      navigateToMasterPage(btn.dataset.page);
      renderMasterData(state.cache.paymentTerms, state.cache.customers);
    });
  });

  qs("#payment-term-form").addEventListener("submit", async (event) => {
    if (state.masterPage !== "payment-terms") return;
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const payload = {
      code: String(formData.get("code") || ""),
      name: String(formData.get("name") || ""),
      dueDays: Number(formData.get("dueDays") || 0)
    };
    const customFields = collectCustomFieldPayload(formData, paymentTermFieldDefinitions);
    if (Object.keys(customFields).length) payload.customFields = customFields;
    try {
      await api("/payment-terms", {
        method: "POST",
        body: payload
      });
      setStatus("Payment term created.");
      await loadMaster();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  views.master.querySelectorAll(".payment-term-toggle").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api(`/payment-terms/${btn.dataset.id}`, {
          method: "PATCH",
          body: { isActive: btn.dataset.active !== "true" }
        });
        setStatus("Payment term updated.");
        await loadMaster();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.master.querySelectorAll(".payment-term-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this payment term?")) return;
      try {
        await api(`/payment-terms/${btn.dataset.id}`, { method: "DELETE" });
        setStatus("Payment term deleted.");
        await loadMaster();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  qs("#customer-form").addEventListener("submit", async (event) => {
    if (state.masterPage !== "customers") return;
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const payload = {
      customerCode: String(formData.get("customerCode") || ""),
      name: String(formData.get("name") || ""),
      defaultTermId: String(formData.get("defaultTermId") || "")
    };
    const customFields = collectCustomFieldPayload(formData, customerFieldDefinitions);
    if (Object.keys(customFields).length) payload.customFields = customFields;
    try {
      await api("/customers", { method: "POST", body: payload });
      setStatus("Customer created.");
      await loadMaster();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  views.master.querySelectorAll(".customer-rename").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = prompt("New customer name", btn.dataset.name || "");
      if (!name) return;
      try {
        await api(`/customers/${btn.dataset.id}`, { method: "PATCH", body: { name } });
        setStatus("Customer updated.");
        await loadMaster();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.master.querySelectorAll(".customer-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this customer?")) return;
      try {
        await api(`/customers/${btn.dataset.id}`, { method: "DELETE" });
        setStatus("Customer deleted.");
        await loadMaster();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  qs("#item-form").addEventListener("submit", async (event) => {
    if (state.masterPage !== "items") return;
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const payload = {
      itemCode: String(formData.get("itemCode") || ""),
      name: String(formData.get("name") || ""),
      unitPrice: Number(formData.get("unitPrice") || 0)
    };
    const customFields = collectCustomFieldPayload(formData, itemFieldDefinitions);
    if (Object.keys(customFields).length) payload.customFields = customFields;
    try {
      await api("/items", {
        method: "POST",
        body: payload
      });
      setStatus("Item created.");
      await loadMaster();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  views.master.querySelectorAll(".item-price").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const unitPrice = prompt("New unit price", btn.dataset.price || "0");
      if (!unitPrice) return;
      try {
        await api(`/items/${btn.dataset.id}`, {
          method: "PATCH",
          body: { unitPrice: Number(unitPrice) }
        });
        setStatus("Item updated.");
        await loadMaster();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.master.querySelectorAll(".item-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this item?")) return;
      try {
        await api(`/items/${btn.dataset.id}`, { method: "DELETE" });
        setStatus("Item deleted.");
        await loadMaster();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.master.querySelectorAll(".custom-field-def-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const entity = form.dataset.entity;
      if (!entity) return;
      const formData = new FormData(event.currentTarget);
      const options = String(formData.get("options") || "")
        .split(",")
        .map((option) => option.trim())
        .filter(Boolean);
      const payload = {
        fieldKey: String(formData.get("fieldKey") || ""),
        label: String(formData.get("label") || ""),
        dataType: String(formData.get("dataType") || "TEXT"),
        isRequired: formData.get("isRequired") === "on",
        displayOrder: Number(formData.get("displayOrder") || 0),
        options
      };
      if (!options.length) delete payload.options;
      try {
        await api(`/custom-fields/${entity}`, {
          method: "POST",
          body: payload
        });
        setStatus("Custom field created.");
        await loadMaster();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.master.querySelectorAll(".custom-field-toggle").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api(`/custom-fields/${btn.dataset.entity}/${btn.dataset.id}`, {
          method: "PATCH",
          body: { isActive: btn.dataset.active !== "true" }
        });
        setStatus("Custom field updated.");
        await loadMaster();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });
}

function renderDeals(kanban) {
  const stageOptions = kanban.stages
    .map((stage) => `<option value="${stage.id}">${stage.stageName}</option>`)
    .join("");

  views.deals.innerHTML = `
    <section class="card">
      <h3 class="section-title">Create Deal</h3>
      <form id="deal-form" class="mini-form">
        <input name="dealNo" placeholder="Deal number" required />
        <input name="dealName" placeholder="Deal name" required />
        <select name="customerId" required>
          ${state.cache.customers.map((c) => `<option value="${c.id}">${c.name}</option>`).join("")}
        </select>
        <select name="stageId" required>${stageOptions}</select>
        <input name="estimatedValue" type="number" min="0" step="0.01" placeholder="Estimated value" required />
        <input name="followUpAt" type="datetime-local" required />
        <button type="submit">Create Deal</button>
      </form>
    </section>
    ${kanban.stages
      .map(
        (stage) => `
      <section class="card">
        <div class="section-head">
          <h3 class="section-title">${stage.stageName}</h3>
          <span class="chip">${stage.deals.length} deal${stage.deals.length === 1 ? "" : "s"}</span>
        </div>
        <div class="list">
          ${
            stage.deals.length
              ? stage.deals
                  .map(
                    (deal) => `
              <div class="row">
                <h4>${deal.dealNo} · ${deal.dealName}</h4>
                <div class="muted">${deal.customer.name} · ${asMoney(deal.estimatedValue)}</div>
                <div class="muted">Follow-up ${asDate(deal.followUpAt)}</div>
                <div class="inline-actions">
                  <select class="deal-stage-select" data-id="${deal.id}">
                    ${kanban.stages
                      .map(
                        (s) =>
                          `<option value="${s.id}" ${s.id === deal.stageId ? "selected" : ""}>${s.stageName}</option>`
                      )
                      .join("")}
                  </select>
                  <button class="deal-stage-save" data-id="${deal.id}">Save Stage</button>
                </div>
                <div class="inline-actions wrap">
                  <button type="button" class="voice-note-btn ghost" data-entity-type="DEAL" data-entity-id="${deal.id}">Voice note</button>
                  <button class="deal-value" data-id="${deal.id}" data-value="${deal.estimatedValue}">Update Value</button>
                  <button class="deal-delete ghost" data-id="${deal.id}">Delete</button>
                </div>
              </div>`
                  )
                  .join("")
              : '<div class="empty-state compact"><div class="empty-icon">🗃️</div><div><strong>No deals in this stage</strong><p>Move an existing deal or create a new one.</p></div></div>'
          }
        </div>
      </section>`
      )
      .join("")}
  `;

  qs("#deal-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    const followUpAt = new Date(payload.followUpAt).toISOString();
    try {
      await api("/deals", {
        method: "POST",
        body: {
          ...payload,
          estimatedValue: Number(payload.estimatedValue),
          followUpAt
        }
      });
      setStatus("Deal created.");
      await loadDeals();
      await loadDashboard();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  views.deals.querySelectorAll(".deal-stage-save").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const nextStage = views.deals.querySelector(
        `.deal-stage-select[data-id="${btn.dataset.id}"]`
      )?.value;
      if (!nextStage) return;
      try {
        await api(`/deals/${btn.dataset.id}/stage`, {
          method: "PATCH",
          body: { stageId: nextStage }
        });
        setStatus("Deal stage moved.");
        await loadDeals();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.deals.querySelectorAll(".deal-value").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const estimatedValue = prompt("New estimated value", btn.dataset.value || "0");
      if (!estimatedValue) return;
      try {
        await api(`/deals/${btn.dataset.id}`, {
          method: "PATCH",
          body: { estimatedValue: Number(estimatedValue) }
        });
        setStatus("Deal updated.");
        await loadDeals();
        await loadDashboard();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.deals.querySelectorAll(".deal-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this deal?")) return;
      try {
        await api(`/deals/${btn.dataset.id}`, { method: "DELETE" });
        setStatus("Deal deleted.");
        await loadDeals();
        await loadDashboard();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.deals.querySelectorAll(".voice-note-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".row");
      const label = row?.querySelector("h4")?.textContent?.trim() || "";
      openVoiceNoteModal(btn.dataset.entityType, btn.dataset.entityId, label);
    });
  });
}

function visitActionLabel(v) {
  if (v.status === "CHECKED_IN") return "Check-out";
  if (v.status === "PLANNED") return "Check-in";
  return "Done";
}

function renderVisits(visits) {
  views.visits.innerHTML = `
    <section class="card">
      <h3 class="section-title">Visits</h3>
      <div class="list">
        ${visits
          .map(
            (v) => `
          <div class="row">
            <h4>${v.customer.name}</h4>
            <div class="chip">${v.visitType} · ${v.status}</div>
            <div class="muted">${asDate(v.plannedAt)}</div>
            <div class="inline-actions wrap">
              <button type="button" class="voice-note-btn ghost" data-entity-type="VISIT" data-entity-id="${v.id}">Voice note</button>
              ${
                v.status !== "CHECKED_OUT"
                  ? `<button type="button" data-visit-id="${v.id}" data-visit-status="${v.status}" class="visit-action">${visitActionLabel(v)}</button>`
                  : ""
              }
            </div>
          </div>`
          )
          .join("") || '<div class="empty-state"><div class="empty-icon">📍</div><div><strong>No visits found</strong><p>Create planned or unplanned visits to see activity here.</p></div></div>'}
      </div>
    </section>
  `;

  views.visits.querySelectorAll(".voice-note-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".row");
      const label = row?.querySelector("h4")?.textContent?.trim() || "";
      openVoiceNoteModal(btn.dataset.entityType, btn.dataset.entityId, label);
    });
  });

  views.visits.querySelectorAll(".visit-action").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.visitId;
      const status = btn.dataset.visitStatus;
      try {
        if (status === "PLANNED") {
          await api(`/visits/${id}/checkin`, {
            method: "POST",
            body: { lat: 13.7563, lng: 100.5018, selfieUrl: "r2://demo/selfie.jpg" }
          });
          setStatus(`Checked in visit ${id}`);
        } else if (status === "CHECKED_IN") {
          await api(`/visits/${id}/checkout`, {
            method: "POST",
            body: { lat: 13.7564, lng: 100.5019, result: "Completed via web UI test" }
          });
          setStatus(`Checked out visit ${id}`);
        }
        await loadVisits();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });
}

function renderCalendar(calendarData) {
  const filters = state.calendarFilters;
  const customerOptions = state.cache.customers
    .map((customer) => `<option value="${customer.id}">${customer.name}</option>`)
    .join("");
  const stageOptions = state.cache.dealStages
    .map((stage) => `<option value="${stage.id}">${stage.stageName}</option>`)
    .join("");
  const events = Array.isArray(calendarData?.events) ? calendarData.events : [];

  views.calendar.innerHTML = `
    <section class="card">
      <h3 class="section-title">Sales Calendar</h3>
      <div class="muted">Combined Visit and Deal timeline with Year/Month/Day views and status colors.</div>
      <form id="calendar-filter-form" class="calendar-filter-grid">
        <select name="view">
          <option value="year" ${filters.view === "year" ? "selected" : ""}>Year</option>
          <option value="month" ${filters.view === "month" ? "selected" : ""}>Month</option>
          <option value="day" ${filters.view === "day" ? "selected" : ""}>Day</option>
        </select>
        <input name="anchorDate" type="date" value="${asDateInput(filters.anchorDate)}" />
        <select name="eventType">
          <option value="all" ${filters.eventType === "all" ? "selected" : ""}>Visit + Deal</option>
          <option value="visit" ${filters.eventType === "visit" ? "selected" : ""}>Visit Only</option>
          <option value="deal" ${filters.eventType === "deal" ? "selected" : ""}>Deal Only</option>
        </select>
        <input name="query" placeholder="Search customer/owner/stage" value="${filters.query || ""}" />
        <select name="customerId">
          <option value="">All customers</option>
          ${customerOptions}
        </select>
        <select name="ownerId">
          <option value="">All owners</option>
          <option value="${state.user.id}">Me (${state.user.fullName})</option>
        </select>
        <select name="visitStatus">
          <option value="">All visit statuses</option>
          <option value="PLANNED">Planned</option>
          <option value="CHECKED_IN">Checked-in</option>
          <option value="CHECKED_OUT">Checked-out</option>
        </select>
        <select name="dealStageId">
          <option value="">All deal stages</option>
          ${stageOptions}
        </select>
        <div class="inline-actions">
          <button type="button" class="ghost" id="calendar-prev">Previous</button>
          <button type="submit">Apply Filters</button>
          <button type="button" class="ghost" id="calendar-next">Next</button>
        </div>
      </form>
      <div class="calendar-legend">
        <span class="chip">Visit type: Blue</span>
        <span class="chip">Deal type: Purple</span>
        <span class="chip">Green: Checked-in + Checked-out</span>
        <span class="chip">Yellow: Checked-in only</span>
        <span class="chip">Red: Overdue attention required</span>
      </div>
    </section>
    <section class="card">
      <div class="section-head">
        <h3 class="section-title">Events (${calendarData?.counts?.total ?? 0})</h3>
        <span class="chip">${asDate(calendarData?.dateFrom)} - ${asDate(calendarData?.dateTo)}</span>
      </div>
      <div class="list">
        ${
          events.length
            ? events
                .map(
                  (event) => `
              <div class="row calendar-event-row color-${event.color}">
                <h4>${event.title}</h4>
                <div class="inline-actions wrap">
                  <span class="chip">${event.type.toUpperCase()}</span>
                  <span class="chip">${event.color.toUpperCase()}</span>
                  <span class="chip">${event.status || "-"}</span>
                </div>
                <div class="muted">${asDate(event.at)}</div>
                <div class="muted">Customer: ${event.customer?.name || "-"}</div>
                <div class="muted">Owner: ${event.owner?.name || "-"}</div>
                ${event.stage?.name ? `<div class="muted">Stage: ${event.stage.name}</div>` : ""}
              </div>
            `
                )
                .join("")
            : '<div class="empty-state"><div class="empty-icon">🗓️</div><div><strong>No events matched</strong><p>Try a broader date or clear filters.</p></div></div>'
        }
      </div>
    </section>
  `;

  const form = qs("#calendar-filter-form");
  const customerSelect = form?.querySelector('select[name="customerId"]');
  if (customerSelect) customerSelect.value = filters.customerId || "";
  const ownerSelect = form?.querySelector('select[name="ownerId"]');
  if (ownerSelect) ownerSelect.value = filters.ownerId || "";
  const visitStatusSelect = form?.querySelector('select[name="visitStatus"]');
  if (visitStatusSelect) visitStatusSelect.value = filters.visitStatus || "";
  const dealStageSelect = form?.querySelector('select[name="dealStageId"]');
  if (dealStageSelect) dealStageSelect.value = filters.dealStageId || "";

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    await loadCalendar(payload);
  });

  qs("#calendar-prev")?.addEventListener("click", async () => {
    const nextAnchor = shiftAnchorDate(filters.anchorDate, filters.view, "prev");
    await loadCalendar({ ...filters, anchorDate: nextAnchor });
  });

  qs("#calendar-next")?.addEventListener("click", async () => {
    const nextAnchor = shiftAnchorDate(filters.anchorDate, filters.view, "next");
    await loadCalendar({ ...filters, anchorDate: nextAnchor });
  });
}

function renderIntegrationLogs(logs) {
  views.integrations.innerHTML = `
    <section class="card">
      <h3 class="section-title">Integration Logs</h3>
      <div class="list">
        ${
          logs.length
            ? logs
                .map(
                  (log) => `
          <div class="row">
            <h4>${log.operationType} · ${log.status}</h4>
            <div class="chip">${log.platform}</div>
            <div class="muted">${asDate(log.startedAt)}</div>
            <div class="muted">${log.responseSummary || log.errorMessage || "-"}</div>
          </div>`
                )
                .join("")
            : '<div class="empty-state"><div class="empty-icon">🔌</div><div><strong>No integration logs yet</strong><p>Run a connection test in Settings to generate first log.</p></div></div>'
        }
      </div>
    </section>
  `;
}

function renderSettings() {
  const tenantId = state.user?.tenantId;
  if (!tenantId) {
    views.settings.innerHTML = `<section class="card"><div class="muted">No tenant context.</div></section>`;
    return;
  }

  const branding = state.cache.branding || {};
  const tax = state.cache.taxConfig || { vatEnabled: true, vatRatePercent: 7 };
  const tenantThemeMode = branding.themeMode || "LIGHT";
  const isAdmin = state.user?.role === "ADMIN";
  const integrationCredentials = state.cache.integrationCredentials || [];
  const salesRepOptions = state.cache.salesReps
    .map((rep) => {
      const teamSuffix = rep.team?.teamName ? ` · ${rep.team.teamName}` : "";
      return `<option value="${rep.id}">${rep.fullName}${teamSuffix}</option>`;
    })
    .join("");
  const defaultRepId = state.cache.salesReps[0]?.id || "";
  views.settings.innerHTML = `
    <section class="card">
      <h3 class="section-title">Branding (Admin)</h3>
      <form id="branding-form" class="mini-form">
        <input name="logoUrl" placeholder="Logo URL (optional)" value="${branding.logoUrl || ""}" />
        <input name="logoFile" type="file" accept="image/*" />
        <input name="primaryColor" placeholder="#2563eb" value="${branding.primaryColor || "#2563eb"}" required />
        <input name="secondaryColor" placeholder="#0f172a" value="${branding.secondaryColor || "#0f172a"}" required />
        <select name="themeMode" required>
          <option value="LIGHT" ${tenantThemeMode === "LIGHT" ? "selected" : ""}>Tenant Theme: Light</option>
          <option value="DARK" ${tenantThemeMode === "DARK" ? "selected" : ""}>Tenant Theme: Dark</option>
        </select>
        <button type="submit">Save Branding</button>
      </form>
      <div class="inline-actions wrap" style="margin-top:10px">
        <button id="theme-override-auto" class="ghost">Use Tenant Default</button>
        <button id="theme-override-light" class="ghost">Force Light</button>
        <button id="theme-override-dark" class="ghost">Force Dark</button>
      </div>
      <div class="muted" style="margin-top:8px">Current user theme override: ${state.themeOverride}</div>
    </section>

    <section class="card">
      <h3 class="section-title">Tax Config (Admin)</h3>
      <form id="tax-form" class="mini-form">
        <label><input name="vatEnabled" type="checkbox" ${tax.vatEnabled ? "checked" : ""} /> VAT Enabled</label>
        <input name="vatRatePercent" type="number" min="0" step="0.01" value="${tax.vatRatePercent}" required />
        <button type="submit">Save Tax Config</button>
      </form>
    </section>

    <section class="card">
      <h3 class="section-title">KPI Target (Tenant Admin)</h3>
      ${
        isAdmin
          ? `
        ${
          state.cache.salesReps.length
            ? `
          <form id="kpi-form" class="mini-form">
            <select name="userId" required>
              ${salesRepOptions}
            </select>
            <input name="targetMonth" placeholder="YYYY-MM" value="${new Date().toISOString().slice(0, 7)}" required />
            <input name="visitTargetCount" type="number" min="0" placeholder="Visit target" required />
            <input name="newDealValueTarget" type="number" min="0" placeholder="New deal value target" required />
            <input name="revenueTarget" type="number" min="0" placeholder="Revenue target" required />
            <button type="submit">Create KPI Target</button>
          </form>
        `
            : `<div class="empty-state compact"><div><strong>No active sales reps</strong><p>Create and activate sales rep users before assigning KPI targets.</p></div></div>`
        }
        <div class="list">
          ${
            state.cache.kpiTargets.length
              ? state.cache.kpiTargets
                  .map((k) => {
                    const repLabel = k.rep?.fullName || k.userId;
                    const teamLabel = k.rep?.team?.teamName ? ` · Team ${k.rep.team.teamName}` : "";
                    return `<div class="row">
                      <h4>${k.targetMonth} · ${repLabel}${teamLabel}</h4>
                      <div class="muted">Visits ${k.visitTargetCount} · New Deal ${asMoney(k.newDealValueTarget)} · Revenue ${asMoney(k.revenueTarget)}</div>
                      <div class="inline-actions wrap">
                        <button class="kpi-edit ghost" data-id="${k.id}" data-user-id="${k.userId}" data-target-month="${k.targetMonth}" data-visit-target="${k.visitTargetCount}" data-new-deal-target="${k.newDealValueTarget}" data-revenue-target="${k.revenueTarget}">Edit</button>
                      </div>
                    </div>`;
                  })
                  .join("")
              : `<div class="empty-state compact"><div><strong>No KPI targets yet</strong><p>Create monthly targets by sales rep for visit volume, new deal value, and revenue.</p></div></div>`
          }
        </div>
      `
          : `<div class="muted">Only tenant admins can manage KPI targets.</div>`
      }
    </section>

    <section class="card">
      <h3 class="section-title">Tenant Integration Credentials</h3>
      <div class="muted">Configure platform API keys/secrets, run Test Connection, then activate.</div>
      <div class="list">
        ${
          integrationCredentials.length
            ? integrationCredentials
                .map((credential) => {
                  const maskedEntries = Object.entries(credential.credentialsMasked || {})
                    .filter(([, value]) => value)
                    .map(([key, value]) => `${prettyLabel(key)}: ${value}`)
                    .join(" · ");
                  const testSummary =
                    credential.lastTestStatus && credential.lastTestedAt
                      ? `${credential.lastTestStatus} at ${asDate(credential.lastTestedAt)}`
                      : "Not tested yet";
                  return `
                    <form class="mini-form integration-credential-form" data-platform="${credential.platform}">
                      <div class="section-head">
                        <h4>${credential.platform}</h4>
                        <span class="chip ${credential.isEnabled ? "chip-success" : "chip-danger"}">${credential.isEnabled ? "Enabled" : "Disabled"}</span>
                      </div>
                      <input name="clientId" placeholder="Client ID (optional)" />
                      <input name="clientSecret" placeholder="Client Secret (optional)" />
                      <input name="apiKey" placeholder="API Key (optional)" />
                      <input name="webhookToken" placeholder="Webhook Token (optional)" />
                      <div class="muted">Stored: ${maskedEntries || "No credential values stored yet."}</div>
                      <div class="muted">Last test: ${testSummary}</div>
                      <div class="muted">${credential.lastTestResult || "Run test connection before enabling."}</div>
                      <div class="inline-actions wrap">
                        <button type="submit">Save Credentials</button>
                        <button type="button" class="integration-test-btn" data-platform="${credential.platform}">Test Connection</button>
                        <button type="button" class="integration-toggle-btn ${credential.canEnable ? "" : "ghost"}" data-platform="${credential.platform}" data-enabled="${credential.isEnabled}">
                          ${credential.isEnabled ? "Disable" : "Enable"}
                        </button>
                      </div>
                    </form>
                  `;
                })
                .join("")
            : `<div class="empty-state compact"><div><strong>No platform list returned</strong><p>Unable to load tenant integration credential settings.</p></div></div>`
        }
      </div>
    </section>
  `;

  qs("#branding-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fd = new FormData(form);
    const file = fd.get("logoFile");

    if (file instanceof File && file.size > 0) {
      const uploadFd = new FormData();
      uploadFd.append("file", file, file.name);
      try {
        const uploadResult = await api(`/tenants/${tenantId}/branding/logo`, {
          method: "POST",
          body: uploadFd
        });
        if (uploadResult?.logoUrl) {
          fd.set("logoUrl", uploadResult.logoUrl);
        }
      } catch (error) {
        setStatus(`Logo upload failed: ${error.message}`, true);
        return;
      }
    }

    const payload = Object.fromEntries(fd.entries());
    if (!payload.logoUrl) {
      delete payload.logoUrl;
    }
    delete payload.logoFile;
    try {
      await api(`/tenants/${tenantId}/branding`, { method: "PUT", body: payload });
      setStatus("Branding saved.");
      await loadSettings();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  qs("#theme-override-auto").addEventListener("click", () => {
    state.themeOverride = "AUTO";
    localStorage.setItem(THEME_OVERRIDE_KEY, state.themeOverride);
    applyThemeMode(tenantThemeMode);
    setStatus("Theme override set to tenant default.");
    renderSettings();
  });
  qs("#theme-override-light").addEventListener("click", () => {
    state.themeOverride = "LIGHT";
    localStorage.setItem(THEME_OVERRIDE_KEY, state.themeOverride);
    applyThemeMode(tenantThemeMode);
    setStatus("Theme override set to light.");
    renderSettings();
  });
  qs("#theme-override-dark").addEventListener("click", () => {
    state.themeOverride = "DARK";
    localStorage.setItem(THEME_OVERRIDE_KEY, state.themeOverride);
    applyThemeMode(tenantThemeMode);
    setStatus("Theme override set to dark.");
    renderSettings();
  });

  qs("#tax-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    try {
      await api(`/tenants/${tenantId}/tax-config`, {
        method: "PUT",
        body: {
          vatEnabled: fd.get("vatEnabled") === "on",
          vatRatePercent: Number(fd.get("vatRatePercent"))
        }
      });
      setStatus("Tax config saved.");
      await loadSettings();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  const kpiForm = qs("#kpi-form");
  if (kpiForm) {
    const repSelect = kpiForm.querySelector('select[name="userId"]');
    if (repSelect && defaultRepId) {
      repSelect.value = defaultRepId;
    }
    kpiForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
      try {
        await api("/kpi-targets", {
          method: "POST",
          body: {
            ...payload,
            visitTargetCount: Number(payload.visitTargetCount),
            newDealValueTarget: Number(payload.newDealValueTarget),
            revenueTarget: Number(payload.revenueTarget)
          }
        });
        setStatus("KPI target created.");
        await loadSettings();
        await loadDashboard();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  }

  views.settings.querySelectorAll(".kpi-edit").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const targetMonth = prompt("Target month (YYYY-MM)", btn.dataset.targetMonth || "");
      if (!targetMonth) return;
      const visitTargetCount = prompt("Visit target", btn.dataset.visitTarget || "0");
      if (visitTargetCount == null) return;
      const newDealValueTarget = prompt("New deal value target", btn.dataset.newDealTarget || "0");
      if (newDealValueTarget == null) return;
      const revenueTarget = prompt("Revenue target", btn.dataset.revenueTarget || "0");
      if (revenueTarget == null) return;

      try {
        await api(`/kpi-targets/${btn.dataset.id}`, {
          method: "PATCH",
          body: {
            userId: btn.dataset.userId,
            targetMonth: targetMonth.trim(),
            visitTargetCount: Number(visitTargetCount),
            newDealValueTarget: Number(newDealValueTarget),
            revenueTarget: Number(revenueTarget)
          }
        });
        setStatus("KPI target updated.");
        await loadSettings();
        await loadDashboard();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.settings.querySelectorAll(".integration-credential-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const platform = form.dataset.platform;
      if (!platform) return;
      const formData = new FormData(event.currentTarget);
      const payload = {
        clientId: String(formData.get("clientId") || "").trim(),
        clientSecret: String(formData.get("clientSecret") || "").trim(),
        apiKey: String(formData.get("apiKey") || "").trim(),
        webhookToken: String(formData.get("webhookToken") || "").trim()
      };
      if (!payload.clientId) delete payload.clientId;
      if (!payload.clientSecret) delete payload.clientSecret;
      if (!payload.apiKey) delete payload.apiKey;
      if (!payload.webhookToken) delete payload.webhookToken;
      if (!Object.keys(payload).length) {
        setStatus("Provide at least one credential value before saving.", true);
        return;
      }
      try {
        await api(`/tenants/${tenantId}/integrations/credentials/${platform}`, {
          method: "PUT",
          body: payload
        });
        setStatus(`${platform} credentials saved. Run Test Connection next.`);
        await loadSettings();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.settings.querySelectorAll(".integration-test-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const platform = btn.dataset.platform;
      if (!platform) return;
      try {
        const result = await api(`/tenants/${tenantId}/integrations/credentials/${platform}/test`, {
          method: "POST"
        });
        setStatus(
          result.ok
            ? `${platform} test connection passed.`
            : `${platform} test connection failed.`,
          !result.ok
        );
        await Promise.all([loadSettings(), loadIntegrations()]);
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  views.settings.querySelectorAll(".integration-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const platform = btn.dataset.platform;
      if (!platform) return;
      const enabled = btn.dataset.enabled === "true";
      try {
        await api(`/tenants/${tenantId}/integrations/credentials/${platform}/enable`, {
          method: "PATCH",
          body: { enabled: !enabled }
        });
        setStatus(`${platform} integration ${enabled ? "disabled" : "enabled"}.`);
        await Promise.all([loadSettings(), loadIntegrations()]);
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });
}

async function loadDashboard(month = state.dashboardMonth) {
  const query = month ? `?month=${encodeURIComponent(month)}` : "";
  const data = await api(`/dashboard/overview${query}`);
  renderDashboard(data);
}

async function loadMaster() {
  const [paymentTerms, customers, items, paymentTermCustomFields, customerCustomFields, itemCustomFields] = await Promise.all([
    api("/payment-terms"),
    api("/customers"),
    api("/items"),
    api("/custom-fields/payment-term"),
    api("/custom-fields/customer"),
    api("/custom-fields/item")
  ]);
  state.cache.paymentTerms = paymentTerms;
  state.cache.customers = customers;
  state.cache.items = items;
  state.cache.customFieldDefinitions = {
    "payment-terms": paymentTermCustomFields,
    customers: customerCustomFields,
    items: itemCustomFields
  };
  renderMasterData(paymentTerms, customers);
}

async function loadDeals() {
  const data = await api("/deals/kanban");
  state.cache.kanban = data;
  state.cache.dealStages = Array.isArray(data?.stages) ? data.stages : [];
  renderDeals(data);
}

async function loadVisits() {
  const data = await api("/visits");
  state.cache.visits = data;
  renderVisits(data);
}

async function loadCalendar(nextFilters = {}) {
  state.calendarFilters = {
    ...state.calendarFilters,
    ...nextFilters
  };
  const query = new URLSearchParams();
  Object.entries(state.calendarFilters).forEach(([key, value]) => {
    if (value == null) return;
    const normalized = String(value).trim();
    if (!normalized.length) return;
    query.set(key, normalized);
  });
  const data = await api(`/calendar/events?${query.toString()}`);
  state.cache.calendar = data;
  renderCalendar(data);
}

async function loadIntegrations() {
  const data = await api("/integrations/logs");
  state.cache.logs = data;
  renderIntegrationLogs(data);
}

async function loadSettings() {
  const tenantId = state.user?.tenantId;
  if (!tenantId) return;
  const isAdmin = state.user?.role === "ADMIN";
  const [branding, taxConfig, kpiTargets, salesReps, integrationCredentials] = await Promise.all([
    api(`/tenants/${tenantId}/branding`),
    api(`/tenants/${tenantId}/tax-config`),
    isAdmin ? api("/kpi-targets") : Promise.resolve([]),
    isAdmin ? api("/kpi-targets/reps") : Promise.resolve([]),
    api(`/tenants/${tenantId}/integrations/credentials`)
  ]);
  state.cache.branding = branding;
  state.cache.taxConfig = taxConfig;
  state.cache.kpiTargets = kpiTargets;
  state.cache.salesReps = salesReps;
  state.cache.integrationCredentials = integrationCredentials;
  applyBrandingTheme(branding);
  renderSettings();
}

async function loadAllViews() {
  await Promise.all([
    loadDashboard(),
    loadMaster(),
    loadDeals(),
    loadVisits(),
    loadCalendar(),
    loadIntegrations(),
    loadSettings()
  ]);
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authMessage.textContent = "";

  const formData = new FormData(loginForm);
  const payload = Object.fromEntries(formData.entries());
  try {
    const result = await api("/auth/login", { method: "POST", body: payload, headers: {} });
    state.token = result.accessToken;
    state.user = result.user;
    localStorage.setItem("thinkcrm_token", state.token);
    showApp();
    updateUserMeta();
    const onMasterRoute = syncMasterPageFromLocation();
    setStatus("Signed in successfully.");
    await loadAllViews();
    applyBrandingTheme(state.cache.branding);
    if (onMasterRoute) {
      switchView("master");
    }
  } catch (error) {
    authMessage.textContent = error.message;
  }
});

qs("#logout-btn").addEventListener("click", () => {
  state.token = "";
  state.user = null;
  localStorage.removeItem("thinkcrm_token");
  showAuth();
  authMessage.textContent = "";
});

themeToggleBtn?.addEventListener("click", () => {
  state.themeOverride =
    state.themeOverride === "AUTO"
      ? "LIGHT"
      : state.themeOverride === "LIGHT"
        ? "DARK"
        : "AUTO";
  localStorage.setItem(THEME_OVERRIDE_KEY, state.themeOverride);
  applyThemeMode(state.cache.branding?.themeMode || "LIGHT");
  setStatus(`Theme switched: ${state.themeOverride}`);
  if (views.settings.classList.contains("active")) {
    renderSettings();
  }
});

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const target = btn.dataset.view;
    if (target !== "master" && window.location.pathname.startsWith("/master/")) {
      window.history.pushState({}, "", "/");
    }
    if (target === "master") {
      navigateToMasterPage(state.masterPage);
    }
    switchView(target);
    try {
      if (target === "dashboard") await loadDashboard();
      if (target === "master") await loadMaster();
      if (target === "deals") await loadDeals();
      if (target === "visits") await loadVisits();
      if (target === "calendar") await loadCalendar();
      if (target === "integrations") await loadIntegrations();
      if (target === "settings") await loadSettings();
    } catch (error) {
      setStatus(error.message, true);
    }
  });
});

window.addEventListener("popstate", async () => {
  const isMasterRoute = syncMasterPageFromLocation();
  if (isMasterRoute) {
    await loadMaster();
    return;
  }
  if (window.location.pathname === "/") {
    switchView("dashboard");
    await loadDashboard();
  }
});

async function bootstrap() {
  if (!state.token) return;
  try {
    const me = await api("/auth/me");
    state.user = me;
    updateUserMeta();
    showApp();
    const onMasterRoute = syncMasterPageFromLocation();
    setStatus("Session restored.");
    await loadAllViews();
    applyBrandingTheme(state.cache.branding);
    if (onMasterRoute) {
      switchView("master");
    }
  } catch {
    localStorage.removeItem("thinkcrm_token");
    state.token = "";
  }
}

bindVoiceNoteModal();
applyThemeMode("LIGHT");
bootstrap();

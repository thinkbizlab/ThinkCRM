const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function parseCron(expr) {
  if (!expr || typeof expr !== "string") return { mode: "custom" };
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return { mode: "custom" };
  const [min, hour, dom, month, dow] = parts;
  const m = Number(min);
  const h = Number(hour);
  if (!Number.isInteger(m) || m < 0 || m > 59) return { mode: "custom" };
  if (!Number.isInteger(h) || h < 0 || h > 23) return { mode: "custom" };
  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

  if (month !== "*") return { mode: "custom" };

  if (dom === "*" && dow === "*") return { mode: "daily", time };

  if (dom === "*" && dow !== "*") {
    const weekdays = parseDow(dow);
    if (!weekdays) return { mode: "custom" };
    return { mode: "weekly", time, weekdays };
  }

  if (dom !== "*" && dow === "*") {
    const d = Number(dom);
    if (!Number.isInteger(d) || d < 1 || d > 31) return { mode: "custom" };
    return { mode: "monthly", time, monthday: d };
  }

  return { mode: "custom" };
}

function parseDow(dow) {
  const out = new Set();
  for (const chunk of dow.split(",")) {
    if (/^\d+$/.test(chunk)) {
      const n = Number(chunk) % 7;
      out.add(n);
    } else if (/^\d+-\d+$/.test(chunk)) {
      const [a, b] = chunk.split("-").map(Number);
      if (a > b || a < 0 || b > 7) return null;
      for (let i = a; i <= b; i++) out.add(i % 7);
    } else {
      return null;
    }
  }
  return [...out].sort();
}

export function buildCron({ mode, time, weekdays, monthday }) {
  const [h, m] = (time || "00:00").split(":").map(Number);
  if (mode === "daily") return `${m} ${h} * * *`;
  if (mode === "weekly") {
    const days = (weekdays && weekdays.length ? weekdays : [1]).slice().sort();
    const compact = compactDow(days);
    return `${m} ${h} * * ${compact}`;
  }
  if (mode === "monthly") {
    const d = Math.min(31, Math.max(1, monthday || 1));
    return `${m} ${h} ${d} * *`;
  }
  return "";
}

function compactDow(days) {
  if (days.length === 5 && days.join(",") === "1,2,3,4,5") return "1-5";
  if (days.length === 2 && days.join(",") === "0,6") return "0,6";
  if (days.length === 7) return "*";
  return days.join(",");
}

export function renderCronPicker({ jobKey, cronExpr, defaultCronExpr }) {
  const parsed = parseCron(cronExpr);
  const isCustom = parsed.mode === "custom";
  const activeMode = isCustom ? "custom" : parsed.mode;
  const time = parsed.time || "06:00";
  const weekdays = new Set(parsed.weekdays || [1]);
  const monthday = parsed.monthday || 1;

  const modeBtn = (key, label) => `
    <button type="button" class="cp-mode-btn ${activeMode === key ? "active" : ""}"
            data-cp-mode="${key}" data-job-key="${jobKey}">${label}</button>`;

  const dayChip = (i) => `
    <label class="cp-day-chip ${weekdays.has(i) ? "active" : ""}">
      <input type="checkbox" data-cp-dow="${i}" data-job-key="${jobKey}" ${weekdays.has(i) ? "checked" : ""} hidden>
      <span>${DAY_LABELS[i]}</span>
    </label>`;

  const monthdayOptions = Array.from({ length: 31 }, (_, i) => {
    const d = i + 1;
    return `<option value="${d}" ${d === monthday ? "selected" : ""}>${d}</option>`;
  }).join("");

  return `
    <div class="cron-picker" data-job-key="${jobKey}">
      <div class="cp-modes" role="tablist">
        ${modeBtn("daily", "Daily")}
        ${modeBtn("weekly", "Weekly")}
        ${modeBtn("monthly", "Monthly")}
        ${modeBtn("custom", "Custom")}
      </div>

      <div class="cp-body" data-cp-body="daily" ${activeMode === "daily" ? "" : "hidden"}>
        <label class="cp-field-label">Time</label>
        <input type="time" class="cp-time" data-job-key="${jobKey}" value="${time}">
      </div>

      <div class="cp-body" data-cp-body="weekly" ${activeMode === "weekly" ? "" : "hidden"}>
        <label class="cp-field-label">Days</label>
        <div class="cp-days">
          ${[1,2,3,4,5,6,0].map(dayChip).join("")}
        </div>
        <label class="cp-field-label" style="margin-top:var(--sp-2)">Time</label>
        <input type="time" class="cp-time" data-job-key="${jobKey}" value="${time}">
      </div>

      <div class="cp-body" data-cp-body="monthly" ${activeMode === "monthly" ? "" : "hidden"}>
        <label class="cp-field-label">Day of month</label>
        <select class="cp-monthday" data-job-key="${jobKey}">${monthdayOptions}</select>
        <label class="cp-field-label" style="margin-top:var(--sp-2)">Time</label>
        <input type="time" class="cp-time" data-job-key="${jobKey}" value="${time}">
      </div>

      <div class="cp-body" data-cp-body="custom" ${activeMode === "custom" ? "" : "hidden"}>
        <label class="cp-field-label">Cron expression</label>
        <input type="text" class="cp-custom" data-job-key="${jobKey}" value="${cronExpr || ""}" placeholder="e.g. 0 6 * * 1-5" autocomplete="off">
        <p class="cp-custom-hint muted">Format: <code>min hour day-of-month month day-of-week</code> · Default: <code>${defaultCronExpr || ""}</code></p>
      </div>

      <input type="hidden" class="cron-expr-input" data-job-key="${jobKey}" value="${cronExpr || ""}">
    </div>`;
}

export function initCronPicker(root, { jobKey, onChange }) {
  const picker = root.querySelector(`.cron-picker[data-job-key="${jobKey}"]`);
  if (!picker) return;

  const hidden = picker.querySelector(`.cron-expr-input[data-job-key="${jobKey}"]`);
  const getMode = () => picker.querySelector(".cp-mode-btn.active")?.dataset.cpMode || "daily";
  const getTimeForMode = (mode) => {
    const body = picker.querySelector(`.cp-body[data-cp-body="${mode}"]`);
    return body?.querySelector(".cp-time")?.value || "06:00";
  };
  const getWeekdays = () => {
    const checks = picker.querySelectorAll('input[type="checkbox"][data-cp-dow]');
    const days = [...checks].filter(c => c.checked).map(c => Number(c.dataset.cpDow));
    return days.length ? days : [1];
  };
  const getMonthday = () => {
    const sel = picker.querySelector(".cp-monthday");
    return Number(sel?.value || 1);
  };

  const recompute = () => {
    const mode = getMode();
    let expr = "";
    if (mode === "custom") {
      expr = picker.querySelector(".cp-custom")?.value.trim() || "";
    } else {
      expr = buildCron({
        mode,
        time: getTimeForMode(mode),
        weekdays: getWeekdays(),
        monthday: getMonthday(),
      });
    }
    if (hidden) hidden.value = expr;
    onChange?.(expr);
  };

  picker.querySelectorAll(".cp-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      picker.querySelectorAll(".cp-mode-btn").forEach(b => b.classList.toggle("active", b === btn));
      picker.querySelectorAll(".cp-body").forEach(b => {
        b.hidden = b.dataset.cpBody !== btn.dataset.cpMode;
      });
      recompute();
    });
  });

  picker.querySelectorAll(".cp-time, .cp-custom, .cp-monthday").forEach(el => {
    el.addEventListener("input", recompute);
    el.addEventListener("change", recompute);
  });

  picker.querySelectorAll('input[type="checkbox"][data-cp-dow]').forEach(chk => {
    chk.addEventListener("change", () => {
      chk.closest(".cp-day-chip")?.classList.toggle("active", chk.checked);
      recompute();
    });
  });

  recompute();
}

// Calendar view (month / day / year) + filter bar + click-to-create visit.
// Host injects app-level helpers — `openVisitCreateModal`, `showEventDetail`,
// `msDropdown`, `initMsDropdown` — via `setCalendarDeps()` so this module
// doesn't depend on app.js.
import { qs, views } from "./dom.js";
import { state } from "./state.js";
import { api } from "./api.js";
import { escHtml, shiftAnchorDate } from "./utils.js";

let deps = {
  openVisitCreateModal: () => {},
  showEventDetail: () => {},
  msDropdown: () => "",
  initMsDropdown: () => {}
};

export function setCalendarDeps(d) {
  deps = { ...deps, ...d };
}

export async function loadCalendar(nextFilters = {}) {
  state.calendarFilters = { ...state.calendarFilters, ...nextFilters };
  const f = state.calendarFilters;
  const query = new URLSearchParams();

  if (f.view)       query.set("view", f.view);
  if (f.anchorDate) query.set("anchorDate", f.anchorDate);
  if (f.query?.trim()) query.set("query", f.query.trim());
  if (f.customerId) query.set("customerId", f.customerId);

  // For day view, pass explicit local-day boundaries so the backend returns
  // events that fall within the user's local calendar day (not UTC day).
  if (f.view === "day" && f.anchorDate) {
    const anchor = new Date(f.anchorDate);
    const dayStart = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 0, 0, 0, 0);
    const dayEnd   = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 1, 0, 0, 0, 0);
    query.set("dateFrom", dayStart.toISOString());
    query.set("dateTo",   dayEnd.toISOString());
  }

  if (f.eventTypes?.length)    query.set("eventTypes",    f.eventTypes.join(","));
  if (f.ownerIds?.length)      query.set("ownerIds",      f.ownerIds.join(","));
  if (f.visitStatuses?.length) query.set("visitStatuses", f.visitStatuses.join(","));
  if (f.dealStageIds?.length)  query.set("dealStageIds",  f.dealStageIds.join(","));
  if (f.dealStatuses?.length)  query.set("dealStatuses",  f.dealStatuses.join(","));

  const data = await api(`/calendar/events?${query.toString()}`);
  state.cache.calendar = data;
  renderCalendar(data);
}

export function renderCalendar(calendarData) {
  const filters = state.calendarFilters;
  const events = Array.isArray(calendarData?.events) ? calendarData.events : [];
  const view = filters.view || "month";

  const eventsByDate = {};
  events.forEach((ev) => {
    const d = new Date(ev.at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!eventsByDate[key]) eventsByDate[key] = [];
    eventsByDate[key].push(ev);
  });

  const anchor = new Date(filters.anchorDate || new Date().toISOString());
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const todayStr = (() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  })();

  const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  function eventChip(ev, compact = false) {
    const label = ev.title || ev.customer?.name || "Event";
    return `<div class="cal-event cal-event--${ev.color || "blue"}" data-event-id="${ev.id}" title="${escHtml(label)}${ev.customer?.name ? " · " + escHtml(ev.customer.name) : ""}">
      ${compact ? "" : `<span class="cal-event-dot"></span>`}
      <span class="cal-event-label">${escHtml(label)}</span>
    </div>`;
  }

  function renderMonthView() {
    const firstDay = new Date(year, month, 1);
    const lastDate = new Date(year, month + 1, 0).getDate();
    const startOffset = (firstDay.getDay() + 6) % 7; // Mon=0
    const cells = [];
    for (let i = 0; i < startOffset; i++) cells.push(null);
    for (let d = 1; d <= lastDate; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);

    return `
      <div class="cal-month">
        <div class="cal-weekdays">
          ${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d) => `<div class="cal-weekday">${d}</div>`).join("")}
        </div>
        <div class="cal-grid">
          ${cells.map((day) => {
            if (!day) return `<div class="cal-day cal-day--empty"></div>`;
            const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const dayEvs = eventsByDate[dateKey] || [];
            const isToday = dateKey === todayStr;
            const maxShow = 3;
            const overflow = Math.max(0, dayEvs.length - maxShow);
            return `
              <div class="cal-day${isToday ? " cal-day--today" : ""}${dayEvs.length ? " cal-day--has-events" : ""}" data-date="${dateKey}">
                <span class="cal-day-num">${day}</span>
                <div class="cal-event-list">
                  ${dayEvs.slice(0, maxShow).map((e) => eventChip(e)).join("")}
                  ${overflow ? `<div class="cal-overflow">+${overflow} more</div>` : ""}
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  function renderDayView() {
    const dayKey = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, "0")}-${String(anchor.getDate()).padStart(2, "0")}`;
    const dayEvs = eventsByDate[dayKey] || [];
    const dayLabel = anchor.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

    const byHour = {};
    dayEvs.forEach((ev) => {
      const h = new Date(ev.at).getHours();
      if (!byHour[h]) byHour[h] = [];
      byHour[h].push(ev);
    });

    const hours = Array.from({ length: 24 }, (_, i) => i);
    return `
      <div class="cal-day-view">
        <div class="cal-day-header">${dayLabel}
          ${dayEvs.length ? `<span class="cal-day-count">${dayEvs.length} event${dayEvs.length !== 1 ? "s" : ""}</span>` : ""}
        </div>
        <div class="cal-timeline">
          ${hours.map((h) => {
            const evs = byHour[h] || [];
            const timeLabel = `${String(h).padStart(2, "0")}:00`;
            return `
              <div class="cal-hour-slot${evs.length ? " cal-hour-slot--has-events" : ""}" data-date="${dayKey}" data-hour="${h}">
                <div class="cal-hour-label">${timeLabel}</div>
                <div class="cal-hour-events">
                  ${evs.map((ev) => `
                    <div class="cal-tl-event cal-event--${ev.color || "blue"}" data-event-id="${ev.id}">
                      <span class="cal-tl-title">${escHtml(ev.title)}</span>
                      ${ev.customer?.name ? `<span class="cal-tl-meta">${escHtml(ev.customer.name)}</span>` : ""}
                      ${ev.status ? `<span class="cal-tl-badge">${ev.status}</span>` : ""}
                    </div>
                  `).join("")}
                </div>
              </div>
            `;
          }).join("")}
        </div>
        ${!dayEvs.length ? `<div class="empty-state"><div class="empty-icon">🗓️</div><div><strong>No events on this day</strong><p class="muted">Use the arrows to navigate or switch to Month view.</p></div></div>` : ""}
      </div>
    `;
  }

  function renderYearView() {
    return `
      <div class="cal-year-view">
        ${MONTH_NAMES.map((mName, mIdx) => {
          const firstDay = new Date(year, mIdx, 1);
          const lastDate = new Date(year, mIdx + 1, 0).getDate();
          const startOffset = (firstDay.getDay() + 6) % 7;
          const cells = [];
          for (let i = 0; i < startOffset; i++) cells.push(null);
          for (let d = 1; d <= lastDate; d++) cells.push(d);
          while (cells.length % 7 !== 0) cells.push(null);

          return `
            <div class="cal-mini-month">
              <div class="cal-mini-title">${mName}</div>
              <div class="cal-mini-weekdays">
                ${["M","T","W","T","F","S","S"].map((d) => `<span>${d}</span>`).join("")}
              </div>
              <div class="cal-mini-grid">
                ${cells.map((day) => {
                  if (!day) return `<span class="cal-mini-day cal-mini-day--empty"></span>`;
                  const dateKey = `${year}-${String(mIdx + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                  const hasEvents = (eventsByDate[dateKey] || []).length > 0;
                  const isToday = dateKey === todayStr;
                  return `<span class="cal-mini-day${isToday ? " cal-mini-day--today" : ""}${hasEvents ? " cal-mini-day--dot" : ""}">${day}</span>`;
                }).join("")}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  const navTitle = view === "month"
    ? `${MONTH_NAMES[month]} ${year}`
    : view === "day"
      ? anchor.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
      : `${year}`;

  views.calendar.innerHTML = `
    <div class="calendar-outer">
      <div class="cal-toolbar">
        <div class="cal-toolbar-main">
          <div class="cal-nav-group">
            <button class="cal-nav-btn" id="calendar-prev">‹</button>
            <h2 class="cal-nav-title">${navTitle}</h2>
            <button class="cal-nav-btn" id="calendar-next">›</button>
          </div>
          <div class="cal-view-tabs">
            <button class="cal-view-tab${view === "month" ? " active" : ""}" data-view="month">Month</button>
            <button class="cal-view-tab${view === "day" ? " active" : ""}" data-view="day">Day</button>
            <button class="cal-view-tab${view === "year" ? " active" : ""}" data-view="year">Year</button>
          </div>
          <button class="cal-filter-toggle ghost" id="cal-filter-toggle">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 3h10M4 7h6M6 11h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            Filters${events.length ? ` · ${events.length}` : ""}
          </button>
        </div>
        <div class="cal-filter-bar" id="cal-filter-bar" hidden>
          <form id="calendar-filter-form" class="cal-filter-grid">
            ${(() => {
              const eventsHtml = deps.msDropdown({
                id: "cal-events", fieldName: "eventTypes",
                options: [{ value: "visit", label: "Visit" }, { value: "deal", label: "Deal" }],
                selected: filters.eventTypes || [], allLabel: "All Events", singularUnit: "event"
              });

              const calReps = state.cache.salesReps || [];
              const calCanFilterReps = state.user?.role !== "REP" && calReps.length > 0;
              const ownerOptions = calReps.map(u => ({ value: u.id, label: u.fullName || u.id }));
              const ownerHtml = calCanFilterReps ? deps.msDropdown({
                id: "cal-owner", fieldName: "ownerIds",
                options: ownerOptions, selected: filters.ownerIds || [],
                allLabel: "All Sales Reps", singularUnit: "rep"
              }) : "";

              const statusHtml = deps.msDropdown({
                id: "cal-status", fieldName: "visitStatuses",
                options: [
                  { value: "PLANNED",      label: "Planned" },
                  { value: "CHECKED_IN",   label: "Checked-in" },
                  { value: "CHECKED_OUT",  label: "Checked-out" }
                ],
                selected: filters.visitStatuses || [], allLabel: "All Statuses", singularUnit: "status"
              });

              const stageOptions = (state.cache.dealStages || []).map(s => ({ value: s.id, label: s.stageName }));
              const stageHtml = stageOptions.length ? deps.msDropdown({
                id: "cal-stage", fieldName: "dealStageIds",
                options: stageOptions, selected: filters.dealStageIds || [],
                allLabel: "All Stages", singularUnit: "stage"
              }) : "";

              return `
            <div class="cal-filter-field">
              <span class="cal-filter-label">Events</span>
              ${eventsHtml}
            </div>

            <div class="cal-filter-field">
              <span class="cal-filter-label">Customer</span>
              <div class="cal-autocomplete" id="cal-customer-wrap">
                <input class="cal-autocomplete-input" id="cal-customer-input" type="text"
                  placeholder="Name or code…" autocomplete="off"
                  value="${filters.customerName || ""}" />
                <button type="button" class="cal-autocomplete-clear" id="cal-customer-clear"
                  ${filters.customerId ? "" : "hidden"} aria-label="Clear customer">✕</button>
                <div class="cal-autocomplete-list" id="cal-customer-list" hidden></div>
                <input type="hidden" name="customerId" id="cal-customer-id" value="${filters.customerId || ""}" />
              </div>
            </div>

            ${calCanFilterReps ? `
            <div class="cal-filter-field">
              <span class="cal-filter-label">Sales Rep</span>
              ${ownerHtml}
            </div>` : ""}

            <div class="cal-filter-field">
              <span class="cal-filter-label">Status</span>
              ${statusHtml}
            </div>

            ${stageOptions.length ? `
            <div class="cal-filter-field">
              <span class="cal-filter-label">Stage</span>
              ${stageHtml}
            </div>` : ""}`;
            })()}

            <div class="cal-filter-actions">
              <button type="submit" class="cal-filter-apply">Apply</button>
              <button type="button" id="cal-filter-reset" class="cal-filter-reset">Reset</button>
            </div>
          </form>
        </div>
      </div>

      <div class="cal-legend">
        <span class="cal-legend-item cal-event--blue">Visit</span>
        <span class="cal-legend-item cal-event--green">Checked-out</span>
        <span class="cal-legend-item cal-event--yellow">Checked-in</span>
        <span class="cal-legend-item cal-event--purple">Deal</span>
        <span class="cal-legend-item cal-event--red">Overdue</span>
      </div>

      ${view === "month" ? renderMonthView() : view === "day" ? renderDayView() : renderYearView()}
    </div>
  `;

  qs("#cal-filter-toggle")?.addEventListener("click", () => {
    const bar = qs("#cal-filter-bar");
    if (bar) bar.hidden = !bar.hidden;
  });

  views.calendar.querySelectorAll(".cal-day[data-date]").forEach((cell) => {
    cell.addEventListener("click", (e) => {
      if (e.target.closest(".cal-event, .cal-overflow")) return;
      const dateTime = new Date(cell.dataset.date + "T09:00:00");
      deps.openVisitCreateModal(dateTime);
    });
  });

  views.calendar.querySelectorAll(".cal-hour-slot[data-date]").forEach((slot) => {
    slot.addEventListener("click", (e) => {
      if (e.target.closest(".cal-tl-event")) return;
      const dateTime = new Date(`${slot.dataset.date}T${String(slot.dataset.hour).padStart(2, "0")}:00:00`);
      deps.openVisitCreateModal(dateTime);
    });
  });

  const eventsMap = new Map(events.map((e) => [e.id, e]));
  views.calendar.querySelectorAll("[data-event-id]").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      const ev = eventsMap.get(chip.dataset.eventId);
      if (ev) deps.showEventDetail(ev, chip);
    });
  });

  const customerInput = qs("#cal-customer-input");
  const customerList  = qs("#cal-customer-list");
  const customerIdEl  = qs("#cal-customer-id");
  const customerClear = qs("#cal-customer-clear");

  customerInput?.addEventListener("input", () => {
    const q = customerInput.value.trim().toLowerCase();
    if (!q) { customerList.hidden = true; return; }
    const matches = state.cache.customers.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.customerCode || "").toLowerCase().includes(q)
    ).slice(0, 8);
    if (!matches.length) { customerList.hidden = true; return; }
    customerList.innerHTML = matches.map((c) =>
      `<button type="button" class="cal-autocomplete-item" data-id="${c.id}" data-name="${escHtml(c.name)}">
         <span class="cal-ac-name">${escHtml(c.name)}</span>
         ${c.customerCode ? `<span class="cal-ac-code">${escHtml(c.customerCode)}</span>` : ""}
       </button>`
    ).join("");
    customerList.hidden = false;
  });

  customerList?.addEventListener("click", (e) => {
    const item = e.target.closest(".cal-autocomplete-item");
    if (!item) return;
    customerInput.value = item.dataset.name;
    customerIdEl.value  = item.dataset.id;
    customerList.hidden = true;
    if (customerClear) customerClear.hidden = false;
  });

  customerInput?.addEventListener("blur", () => {
    setTimeout(() => { if (customerList) customerList.hidden = true; }, 150);
  });

  customerClear?.addEventListener("click", () => {
    customerInput.value = "";
    customerIdEl.value  = "";
    customerClear.hidden = true;
  });

  ["cal-events", "cal-owner", "cal-status", "cal-stage"].forEach((id) => {
    const allLabel = { "cal-events": "All Events", "cal-owner": "All Sales Reps", "cal-status": "All Statuses", "cal-stage": "All Stages" }[id];
    deps.initMsDropdown(id, allLabel);
  });

  const form = qs("#calendar-filter-form");

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await loadCalendar({
      eventTypes:    fd.getAll("eventTypes"),
      ownerIds:      fd.getAll("ownerIds"),
      visitStatuses: fd.getAll("visitStatuses"),
      dealStageIds:  fd.getAll("dealStageIds"),
      customerId:    fd.get("customerId") || "",
      customerName:  customerInput?.value.trim() || "",
    });
  });

  qs("#cal-filter-reset")?.addEventListener("click", async () => {
    await loadCalendar({
      eventTypes:    ["visit", "deal"],
      ownerIds:      state.user?.id ? [state.user.id] : [],
      visitStatuses: ["PLANNED", "CHECKED_IN", "CHECKED_OUT"],
      dealStageIds:  [],
      dealStatuses:  ["OPEN"],
      customerId:    "",
      customerName:  "",
    });
  });

  qs("#calendar-prev")?.addEventListener("click", async () => {
    await loadCalendar({ anchorDate: shiftAnchorDate(filters.anchorDate, filters.view, "prev") });
  });

  qs("#calendar-next")?.addEventListener("click", async () => {
    await loadCalendar({ anchorDate: shiftAnchorDate(filters.anchorDate, filters.view, "next") });
  });

  views.calendar.querySelectorAll(".cal-view-tab").forEach((tab) => {
    tab.addEventListener("click", async () => {
      await loadCalendar({ view: tab.dataset.view });
    });
  });
}

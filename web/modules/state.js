export const THEME_OVERRIDE_KEY = "thinkcrm_theme_override";

export const state = {
  token: localStorage.getItem("thinkcrm_token") || "",
  user: null,
  googleMapsApiKey: null,
  cache: {
    paymentTerms: [],
    customers: [],
    items: [],
    customerGroups: [],
    customFieldDefinitions: {
      "payment-terms": [],
      customers: [],
      items: [],
      "customer-groups": []
    },
    kanban: null,
    dealStages: [],
    visits: [],
    notifPrefs: undefined,
    cronJobs: undefined,
    myIntegrations: null,
    calendar: null,
    logs: [],
    kpiTargets: [],
    salesReps: [],
    taxConfig: null,
    visitConfig: null,
    branding: null,
    integrationCredentials: [],
    teams: [],
    allUsers: [],
    tenantInfo: null
  },
  masterPage: "payment-terms",
  customerListQuery: "",
  customerListPage: 1,
  customerScope: "mine",
  customerSelectedIds: new Set(),
  paymentTermSelectedIds: new Set(),
  customerCustomFieldFilters: {},
  customerGroupFilter: "",
  itemCustomFieldFilters: {},
  masterFiltersOpen: false,
  customerCreateOpen: false,
  c360: null,
  settingsPage: "my-profile",
  openIntgSections: new Set(),
  openCronHistories: new Set(),
  rolePageQuery: "",
  rolePageTeam: "",
  roleInfoExpanded: false,
  settingsNavCollapsed: false,
  calendarFilters: {
    view: "month",
    eventTypes: ["visit", "deal"],
    anchorDate: new Date().toISOString(),
    query: "",
    ownerIds: [],
    customerId: "",
    customerName: "",
    visitStatuses: ["PLANNED", "CHECKED_IN", "CHECKED_OUT"],
    dealStageIds: [],
    dealStatuses: ["OPEN"]
  },
  dashboardMonth: new Date().toISOString().slice(0, 7),
  dashboardTeamId: "",
  dashboardRepId: "",
  visitPage: (() => {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    const pad = n => String(n).padStart(2, "0");
    const lastDay = new Date(y, m + 1, 0).getDate();
    return {
      query: "",
      status: "",
      repIds: [],
      dateFrom: `${y}-${pad(m + 1)}-01`,
      dateTo:   `${y}-${pad(m + 1)}-${pad(lastDay)}`
    };
  })(),
  repHubTab: "visits",
  themeOverride: localStorage.getItem(THEME_OVERRIDE_KEY) || "AUTO",
  tenantThemeMode: "LIGHT"
};

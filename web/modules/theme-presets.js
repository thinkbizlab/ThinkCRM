// Theme presets — Apple-inspired palettes for the Branding editor.
// Each preset carries a complete token set (primary/secondary + the new
// themeTokens fields + radius + shadow). The form fills every input from
// `tokens` when a preset is chosen; any edit flips the picker to "Custom".

export const DEFAULT_TOKENS = {
  background:  "#ffffff",
  text:        "#0f172a",
  accent:      "#7c3aed",
  card:        "#ffffff",
  muted:       "#f1f5f9",
  border:      "#e2e8f0",
  destructive: "#ef4444",
  radius:      12,
  shadow:      "MD",
};

export const SHADOW_PRESETS = {
  NONE: "none",
  SM:   "0 1px 2px rgba(0, 0, 0, 0.04)",
  MD:   "0 4px 12px rgba(0, 0, 0, 0.08)",
  LG:   "0 10px 30px rgba(0, 0, 0, 0.10)",
  XL:   "0 20px 50px rgba(0, 0, 0, 0.14)",
};

export const SHADOW_OPTIONS = [
  { value: "NONE", label: "None" },
  { value: "SM",   label: "Small" },
  { value: "MD",   label: "Medium" },
  { value: "LG",   label: "Large" },
  { value: "XL",   label: "Extra Large" },
];

export const PRESETS = [
  {
    slug: "ios-default",
    name: "iOS Default",
    swatches: ["#ffffff", "#1c1c1e", "#0a84ff"],
    tokens: {
      primaryColor:   "#0a84ff",
      secondaryColor: "#1c1c1e",
      background:     "#ffffff",
      text:           "#1c1c1e",
      accent:         "#30d158",
      card:           "#ffffff",
      muted:          "#f2f2f7",
      border:         "#e5e5ea",
      destructive:    "#ff3b30",
      radius:         12,
      shadow:         "MD",
    },
  },
  {
    slug: "graphite",
    name: "Graphite",
    swatches: ["#f5f5f7", "#86868b", "#0071e3"],
    tokens: {
      primaryColor:   "#1d1d1f",
      secondaryColor: "#86868b",
      background:     "#f5f5f7",
      text:           "#1d1d1f",
      accent:         "#0071e3",
      card:           "#ffffff",
      muted:          "#eeeef0",
      border:         "#d2d2d7",
      destructive:    "#ff3b30",
      radius:         10,
      shadow:         "SM",
    },
  },
  {
    slug: "cupertino-rose",
    name: "Cupertino Rose",
    swatches: ["#faf4f0", "#3a2e2b", "#e8b4a7"],
    tokens: {
      primaryColor:   "#c77f6e",
      secondaryColor: "#3a2e2b",
      background:     "#faf4f0",
      text:           "#3a2e2b",
      accent:         "#e8b4a7",
      card:           "#ffffff",
      muted:          "#f3ebe5",
      border:         "#e7d9d2",
      destructive:    "#c0392b",
      radius:         14,
      shadow:         "LG",
    },
  },
  {
    slug: "midnight",
    name: "Midnight",
    swatches: ["#0f0f10", "#1c1c1e", "#0a84ff"],
    tokens: {
      primaryColor:   "#0a84ff",
      secondaryColor: "#0f0f10",
      background:     "#0f0f10",
      text:           "#f2f2f7",
      accent:         "#bf5af2",
      card:           "#1c1c1e",
      muted:          "#2c2c2e",
      border:         "#3a3a3c",
      destructive:    "#ff453a",
      radius:         12,
      shadow:         "LG",
    },
  },
  {
    slug: "mint",
    name: "Mint",
    swatches: ["#f3fbf8", "#143a35", "#64d8b8"],
    tokens: {
      primaryColor:   "#00a98f",
      secondaryColor: "#143a35",
      background:     "#f3fbf8",
      text:           "#143a35",
      accent:         "#64d8b8",
      card:           "#ffffff",
      muted:          "#e6f3ee",
      border:         "#cde6dc",
      destructive:    "#ff3b30",
      radius:         14,
      shadow:         "MD",
    },
  },
  {
    slug: "sierra",
    name: "Sierra",
    swatches: ["#fbf5ef", "#3c2e2a", "#f2c77e"],
    tokens: {
      primaryColor:   "#d97757",
      secondaryColor: "#3c2e2a",
      background:     "#fbf5ef",
      text:           "#3c2e2a",
      accent:         "#f2c77e",
      card:           "#ffffff",
      muted:          "#f3eadd",
      border:         "#e5d6c4",
      destructive:    "#c0392b",
      radius:         14,
      shadow:         "MD",
    },
  },
  {
    slug: "amethyst",
    name: "Amethyst",
    swatches: ["#f7f4fb", "#1f1933", "#af52de"],
    tokens: {
      primaryColor:   "#af52de",
      secondaryColor: "#1f1933",
      background:     "#f7f4fb",
      text:           "#1f1933",
      accent:         "#ff375f",
      card:           "#ffffff",
      muted:          "#ece6f4",
      border:         "#d9cfe8",
      destructive:    "#ff375f",
      radius:         12,
      shadow:         "LG",
    },
  },
  {
    slug: "coastal",
    name: "Coastal",
    swatches: ["#f1fafb", "#0f2a33", "#3eb1c8"],
    tokens: {
      primaryColor:   "#3eb1c8",
      secondaryColor: "#0f2a33",
      background:     "#f1fafb",
      text:           "#0f2a33",
      accent:         "#ffb84d",
      card:           "#ffffff",
      muted:          "#e0f1f4",
      border:         "#c7e3e8",
      destructive:    "#ff3b30",
      radius:         12,
      shadow:         "MD",
    },
  },
  {
    slug: "sakura",
    name: "Sakura",
    swatches: ["#fbf4f7", "#3b2a33", "#e06c9f"],
    tokens: {
      primaryColor:   "#e06c9f",
      secondaryColor: "#3b2a33",
      background:     "#fbf4f7",
      text:           "#3b2a33",
      accent:         "#ffd1e0",
      card:           "#ffffff",
      muted:          "#f5e6ec",
      border:         "#ebd0da",
      destructive:    "#d63384",
      radius:         14,
      shadow:         "LG",
    },
  },
  {
    slug: "noir",
    name: "Noir",
    swatches: ["#ffffff", "#1c1c1e", "#ff375f"],
    tokens: {
      primaryColor:   "#000000",
      secondaryColor: "#1c1c1e",
      background:     "#ffffff",
      text:           "#000000",
      accent:         "#ff375f",
      card:           "#ffffff",
      muted:          "#f2f2f2",
      border:         "#d1d1d6",
      destructive:    "#ff375f",
      radius:         10,
      shadow:         "MD",
    },
  },
];

export function findPresetBySlug(slug) {
  return PRESETS.find((p) => p.slug === slug) || null;
}

// Compare a token bag to every preset; return the slug of the first exact match,
// or "custom" if none match. Used to sync the picker to the saved values on load.
export function detectPresetSlug(fullTokens) {
  if (!fullTokens) return "custom";
  const keys = ["primaryColor","secondaryColor","background","text","accent","card","muted","border","destructive","radius","shadow"];
  for (const p of PRESETS) {
    let match = true;
    for (const k of keys) {
      const a = String(fullTokens[k] ?? "").toLowerCase();
      const b = String(p.tokens[k] ?? "").toLowerCase();
      if (a !== b) { match = false; break; }
    }
    if (match) return p.slug;
  }
  return "custom";
}

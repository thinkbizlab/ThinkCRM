import { config } from "../config.js";

export type ThaiAddressParts = {
  road?: string;
  subdistrict?: string;
  district?: string;
  province?: string;
};

type AddressComponent = {
  long_name: string;
  short_name: string;
  types: string[];
};

type GeocodeResult = {
  address_components: AddressComponent[];
};

type GeocodeResponse = {
  status: string;
  results?: GeocodeResult[];
};

function pickComponent(
  components: AddressComponent[],
  ...wantedTypes: string[]
): string | undefined {
  for (const t of wantedTypes) {
    const found = components.find((c) => c.types.includes(t));
    if (found?.long_name) return found.long_name;
  }
  return undefined;
}

/**
 * Reverse-geocode (lat, lng) into Thai address parts via Google Maps Geocoding API.
 * Returns null if the key isn't configured, the request fails, or no result is found.
 * Always resolves within ~4 s — never blocks a check-in.
 */
export async function reverseGeocodeTH(
  lat: number,
  lng: number,
): Promise<ThaiAddressParts | null> {
  if (!config.GOOGLE_MAPS_API_KEY) return null;

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("latlng", `${lat},${lng}`);
  url.searchParams.set("language", "th");
  url.searchParams.set("key", config.GOOGLE_MAPS_API_KEY);

  let body: GeocodeResponse;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    body = (await res.json()) as GeocodeResponse;
  } catch {
    return null;
  }

  if (body.status !== "OK" || !body.results?.length) return null;
  const components = body.results[0]!.address_components;

  return {
    road: pickComponent(components, "route"),
    subdistrict: pickComponent(
      components,
      "sublocality_level_2",
      "sublocality_level_1",
      "sublocality",
    ),
    district: pickComponent(
      components,
      "administrative_area_level_2",
      "locality",
    ),
    province: pickComponent(components, "administrative_area_level_1"),
  };
}

/**
 * Render the address parts as a single watermark line, joined by spaces.
 * In Bangkok the subdistrict/district prefixes are แขวง/เขต; elsewhere ตำบล/อำเภอ.
 * Returns null when every part is missing.
 */
export function formatThaiAddressLine(parts: ThaiAddressParts | null): string | null {
  if (!parts) return null;
  const isBangkok = parts.province === "กรุงเทพมหานคร";
  const subPrefix = isBangkok ? "แขวง" : "ตำบล";
  const distPrefix = isBangkok ? "เขต" : "อำเภอ";

  const withPrefix = (value: string | undefined, prefix: string) => {
    if (!value) return null;
    return value.startsWith(prefix) ? value : `${prefix}${value}`;
  };

  const tokens = [
    parts.road, // Google already returns "ถนน..." in Thai
    withPrefix(parts.subdistrict, subPrefix),
    withPrefix(parts.district, distPrefix),
  ].filter((s): s is string => Boolean(s && s.trim()));

  if (!tokens.length) return null;
  return tokens.join(" ");
}

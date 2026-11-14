import { config } from "./config.js";
import { getToken, signOut } from "./auth.js";

async function errorMessage(res, fallback) {
  const body = await res.json().catch(() => null);
  return body?.message ?? body?.error ?? fallback;
}

async function request(path, { method = "GET", body } = {}) {
  const token = getToken();
  if (!token) throw new Error("Not signed in");
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(`${config.apiBaseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach the server");
  }
  if (res.status === 401 || res.status === 403) {
    signOut();
    throw new Error("Not authorised – try signing in again");
  }
  return res;
}

async function json(res, fallback) {
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
  return res.json();
}

const docPath = () => `/docs/${encodeURIComponent(config.docId)}`;

function wrapSeason(season) {
  return {
    type: config.docType,
    name: season.teamName || "Football season",
    title: season.teamName || "Football season",
    season,
  };
}

/** Load season from docs API, or null if missing. */
export async function loadSeasonDoc() {
  const res = await request(docPath());
  if (res.status === 404) return null;
  const doc = await json(res, "Could not load season");
  if (doc?.season && typeof doc.season === "object") return doc.season;
  // Tolerate a doc that is the season object itself (legacy / hand-made)
  if (doc?.players && doc?.matches) {
    const { id, createdAt, updatedAt, type, name, title, ...rest } = doc;
    return rest.season || rest;
  }
  return null;
}

/** Create or replace the season document. */
export async function saveSeasonDoc(season) {
  const body = wrapSeason(season);
  let res = await request(docPath(), { method: "PUT", body });
  if (res.status === 404) {
    res = await request("/docs", {
      method: "POST",
      body: { id: config.docId, ...body },
    });
  }
  return json(res, "Could not save season");
}

/** Seed used when the user has no document yet. */
export async function fetchSeedSeason() {
  const res = await fetch("./seed-season.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Could not load seed season data");
  return res.json();
}

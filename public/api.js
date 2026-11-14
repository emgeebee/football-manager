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
  if (res.status === 401) {
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

/** Pull the season object out of a docs API document. */
export function seasonFromDoc(doc) {
  if (doc?.season && typeof doc.season === "object") return doc.season;
  if (doc?.players && doc?.matches) {
    const { id, createdAt, updatedAt, type, name, title, ...rest } = doc;
    return rest.season || rest;
  }
  return null;
}

/** Load season from docs API, or null if missing. */
export async function loadSeasonDoc() {
  const res = await request(docPath());
  if (res.status === 404) return null;
  const doc = await json(res, "Could not load season");
  return seasonFromDoc(doc);
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

export async function listShares() {
  const res = await request(`${docPath()}/shares`);
  if (res.status === 404) return [];
  return json(res, "Could not load share links");
}

export async function createShare() {
  const res = await request(`${docPath()}/shares`, { method: "POST" });
  return json(res, "Could not create a share link");
}

export async function revokeShare(code) {
  const path = `${docPath()}/shares/${encodeURIComponent(code)}`;
  await json(await request(path, { method: "DELETE" }), "Could not revoke the share link");
}

/** Sets one viewer's access on a share link to `read` or `write`. */
export async function setShareAccess(code, userId, permission) {
  const path = `${docPath()}/shares/${encodeURIComponent(code)}/access/${encodeURIComponent(userId)}`;
  const res = await request(path, { method: "PUT", body: { permission } });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not update access"));
}

/** Open a shared season. Returns `{ permission, season }`. */
export async function loadSharedSeason(code) {
  const res = await request(`/shared/${encodeURIComponent(code)}`);
  if (res.status === 404) throw new Error("This share link has expired or been revoked.");
  const data = await json(res, "Could not open the shared team");
  const season = seasonFromDoc(data.doc);
  if (!season) throw new Error("This share link is not a football season.");
  return {
    permission: data.permission === "write" ? "write" : "read",
    season,
  };
}

/** Save a season through a share link (requires write permission). */
export async function saveSharedSeason(code, season) {
  const res = await request(`/shared/${encodeURIComponent(code)}`, {
    method: "PUT",
    body: wrapSeason(season),
  });
  if (res.status === 403) throw new Error("You have view-only access to this team.");
  return json(res, "Could not save shared season");
}

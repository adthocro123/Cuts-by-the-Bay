/**
 * Cuts By The Bay — walk-in queue API.
 *
 * Public:  GET /api/status   -> the wait time shown on the main site
 * Staff:   everything else, behind the shop password (STAFF_PASSWORD secret)
 */

const MIN = 60000;
const TOKEN_TTL = 12 * 60 * MIN;   // a staff login lasts one working day
const STALE_AFTER = 8 * 60 * MIN;  // forget anyone left in the list overnight
const MAX_NAME = 40;
const MAX_QUEUE = 60;
const LOCKOUT_AFTER = 10;          // failed logins before a cool-off
const LOCKOUT_MS = 60000;

const enc = new TextEncoder();

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function pickOrigin(request, env) {
  const allowed = String(env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get("origin") || "";
  if (allowed.includes("*")) return origin || "*";
  if (allowed.includes(origin)) return origin;
  return allowed[0] || "";
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg))));
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function mintToken(env) {
  const exp = Date.now() + TOKEN_TTL;
  return exp + "." + (await hmac(env.STAFF_PASSWORD, String(exp)));
}

async function tokenIsValid(env, token) {
  if (!token) return false;
  const parts = String(token).split(".");
  if (parts.length !== 2) return false;
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  return parts[1] === (await hmac(env.STAFF_PASSWORD, parts[0]));
}

function bearer(request) {
  const h = request.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

function clean(s, max) {
  return String(s == null ? "" : s)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max || MAX_NAME);
}

function newId() {
  return crypto.randomUUID().slice(0, 8);
}

/* ------------------------------------------------------------------ */
/* the wait-time model                                                 */
/* ------------------------------------------------------------------ */

/**
 * Work out how long someone walking in *right now* would wait.
 *
 * Rather than the flat "people / barbers * 30", this looks at when each
 * occupied chair actually opens up — a barber twenty minutes into a cut
 * frees up in ten, not thirty — then seats everyone already waiting into
 * the earliest chair available, one at a time.
 */
function computeWait(state, now) {
  const cut = state.settings.avgCutMinutes * MIN;
  const onDuty = state.barbers.filter((b) => b.onDuty);
  const waiting = state.queue.filter((q) => q.status === "waiting");
  const inChair = state.queue.filter((q) => q.status === "in-chair");

  const base = {
    open: !!state.settings.open,
    peopleWaiting: waiting.length,
    peopleInChair: inChair.length,
    barbersOnDuty: onDuty.length,
    avgCutMinutes: state.settings.avgCutMinutes,
  };

  if (!state.settings.open || onDuty.length === 0) {
    return { ...base, waitMinutes: null };
  }

  // When does each on-duty chair next come free?
  const freeAt = onDuty.map((b) => {
    const active = inChair.find((q) => q.barberId === b.id);
    if (!active) return now;
    return Math.max(now, active.startedAt + cut);
  });

  // Seat the people already in line, each into whichever chair opens first.
  for (let i = 0; i < waiting.length; i++) {
    let k = 0;
    for (let j = 1; j < freeAt.length; j++) if (freeAt[j] < freeAt[k]) k = j;
    freeAt[k] += cut;
  }

  const wait = Math.max(0, Math.min(...freeAt) - now);
  return { ...base, waitMinutes: Math.round(wait / MIN / 5) * 5 };
}

function defaultState() {
  return {
    barbers: [{ id: newId(), name: "Barber 1", onDuty: true }],
    queue: [],
    settings: { avgCutMinutes: 30, open: true },
    updatedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* the shared queue                                                    */
/* ------------------------------------------------------------------ */

export class QueueRoom {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async load() {
    let s = await this.ctx.storage.get("state");
    if (!s) s = defaultState();

    // Anyone still listed from yesterday is not really waiting.
    const cutoff = Date.now() - STALE_AFTER;
    const before = s.queue.length;
    s.queue = s.queue.filter((q) => q.joinedAt > cutoff);
    if (s.queue.length !== before) await this.ctx.storage.put("state", s);

    return s;
  }

  async save(s) {
    s.updatedAt = Date.now();
    await this.ctx.storage.put("state", s);
    return s;
  }

  async fetch(request) {
    const { op, args } = await request.json();
    const now = Date.now();
    const s = await this.load();
    const a = args || {};

    const find = (id) => s.queue.find((q) => q.id === id);
    const barber = (id) => s.barbers.find((b) => b.id === id);
    const ok = (extra) =>
      new Response(
        JSON.stringify({ ok: true, ...computeWait(s, now), updatedAt: s.updatedAt, ...extra }),
        { headers: { "content-type": "application/json" } }
      );
    const fail = (message, status) =>
      new Response(JSON.stringify({ ok: false, error: message }), {
        status: status || 400,
        headers: { "content-type": "application/json" },
      });

    switch (op) {
      /* ---- read ---- */

      case "status":
        return ok({});

      case "state":
        return ok({ barbers: s.barbers, queue: s.queue, settings: s.settings });

      /* ---- login throttling ---- */

      case "loginAttempt": {
        const gate = (await this.ctx.storage.get("gate")) || { fails: 0, until: 0 };
        if (gate.until > now) {
          return new Response(
            JSON.stringify({ locked: true, retryInMs: gate.until - now }),
            { headers: { "content-type": "application/json" } }
          );
        }
        if (a.success) {
          await this.ctx.storage.put("gate", { fails: 0, until: 0 });
        } else {
          gate.fails += 1;
          if (gate.fails >= LOCKOUT_AFTER) {
            await this.ctx.storage.put("gate", { fails: 0, until: now + LOCKOUT_MS });
          } else {
            await this.ctx.storage.put("gate", gate);
          }
        }
        return new Response(JSON.stringify({ locked: false }), {
          headers: { "content-type": "application/json" },
        });
      }

      /* ---- the line ---- */

      case "add": {
        if (s.queue.length >= MAX_QUEUE) return fail("The list is full.");
        const name = clean(a.name);
        if (!name) return fail("Give the customer a name.");
        s.queue.push({
          id: newId(),
          name,
          note: clean(a.note, 60),
          joinedAt: now,
          status: "waiting",
          barberId: null,
          startedAt: null,
        });
        await this.save(s);
        return ok({ barbers: s.barbers, queue: s.queue, settings: s.settings });
      }

      case "seat": {
        const person = find(a.id);
        if (!person) return fail("That customer is no longer in the list.");
        const b = barber(a.barberId);
        if (!b) return fail("Pick a barber.");
        if (!b.onDuty) return fail(b.name + " is not on duty.");
        // A barber can only cut one head at a time — whoever was in that
        // chair is finished the moment the next person sits down.
        s.queue = s.queue.filter(
          (q) => !(q.status === "in-chair" && q.barberId === b.id)
        );
        const still = s.queue.find((q) => q.id === a.id);
        if (still) {
          still.status = "in-chair";
          still.barberId = b.id;
          still.startedAt = now;
        }
        await this.save(s);
        return ok({ barbers: s.barbers, queue: s.queue, settings: s.settings });
      }

      case "next": {
        const b = barber(a.barberId);
        if (!b) return fail("Pick a barber.");
        if (!b.onDuty) return fail(b.name + " is not on duty.");
        s.queue = s.queue.filter(
          (q) => !(q.status === "in-chair" && q.barberId === b.id)
        );
        const upNext = s.queue.find((q) => q.status === "waiting");
        if (upNext) {
          upNext.status = "in-chair";
          upNext.barberId = b.id;
          upNext.startedAt = now;
        }
        await this.save(s);
        return ok({ barbers: s.barbers, queue: s.queue, settings: s.settings });
      }

      case "done":
      case "remove": {
        s.queue = s.queue.filter((q) => q.id !== a.id);
        await this.save(s);
        return ok({ barbers: s.barbers, queue: s.queue, settings: s.settings });
      }

      /* ---- the chairs ---- */

      case "barberAdd": {
        const name = clean(a.name);
        if (!name) return fail("Give the barber a name.");
        if (s.barbers.length >= 12) return fail("That's plenty of barbers.");
        s.barbers.push({ id: newId(), name, onDuty: true });
        await this.save(s);
        return ok({ barbers: s.barbers, queue: s.queue, settings: s.settings });
      }

      case "barberUpdate": {
        const b = barber(a.id);
        if (!b) return fail("No such barber.");
        if (a.name != null) {
          const name = clean(a.name);
          if (!name) return fail("Give the barber a name.");
          b.name = name;
        }
        if (a.onDuty != null) {
          b.onDuty = !!a.onDuty;
          // Going off duty hands whoever is mid-cut back to the front of the line.
          if (!b.onDuty) {
            for (const q of s.queue) {
              if (q.status === "in-chair" && q.barberId === b.id) {
                q.status = "waiting";
                q.barberId = null;
                q.startedAt = null;
              }
            }
          }
        }
        await this.save(s);
        return ok({ barbers: s.barbers, queue: s.queue, settings: s.settings });
      }

      case "barberRemove": {
        if (s.barbers.length <= 1) return fail("Keep at least one barber.");
        s.barbers = s.barbers.filter((b) => b.id !== a.id);
        for (const q of s.queue) {
          if (q.barberId === a.id) {
            q.status = "waiting";
            q.barberId = null;
            q.startedAt = null;
          }
        }
        await this.save(s);
        return ok({ barbers: s.barbers, queue: s.queue, settings: s.settings });
      }

      /* ---- settings ---- */

      case "settings": {
        if (a.avgCutMinutes != null) {
          const m = Math.round(Number(a.avgCutMinutes));
          if (!Number.isFinite(m) || m < 5 || m > 180)
            return fail("Average cut time should be between 5 and 180 minutes.");
          s.settings.avgCutMinutes = m;
        }
        if (a.open != null) s.settings.open = !!a.open;
        await this.save(s);
        return ok({ barbers: s.barbers, queue: s.queue, settings: s.settings });
      }

      case "clear": {
        s.queue = [];
        await this.save(s);
        return ok({ barbers: s.barbers, queue: s.queue, settings: s.settings });
      }

      default:
        return fail("Unknown operation.", 404);
    }
  }
}

/* ------------------------------------------------------------------ */
/* routing                                                             */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const origin = pickOrigin(request, env);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!env.STAFF_PASSWORD) {
      return json(
        { ok: false, error: "Server is missing STAFF_PASSWORD. Run: wrangler secret put STAFF_PASSWORD" },
        500,
        origin
      );
    }

    const room = env.QUEUE.get(env.QUEUE.idFromName("shop"));
    const call = async (op, args) => {
      const r = await room.fetch("https://queue.internal/", {
        method: "POST",
        body: JSON.stringify({ op, args: args || {} }),
      });
      return { status: r.status, body: await r.json() };
    };

    /* --- public --- */

    if (path === "/api/status" && request.method === "GET") {
      const { body } = await call("status");
      return json(
        {
          open: body.open,
          waitMinutes: body.waitMinutes,
          peopleWaiting: body.peopleWaiting,
          barbersOnDuty: body.barbersOnDuty,
          updatedAt: body.updatedAt,
        },
        200,
        origin
      );
    }

    /* --- login --- */

    if (path === "/api/login" && request.method === "POST") {
      let supplied = "";
      try {
        supplied = String((await request.json()).password || "");
      } catch {
        return json({ ok: false, error: "Bad request." }, 400, origin);
      }

      const gate = await call("loginAttempt", { success: false, probe: true });
      if (gate.body.locked) {
        return json(
          { ok: false, error: "Too many tries. Wait a minute and try again." },
          429,
          origin
        );
      }

      // Compare digests so the check doesn't leak the password's length.
      const match =
        (await sha256hex(supplied)) === (await sha256hex(env.STAFF_PASSWORD));
      await call("loginAttempt", { success: match });

      if (!match) return json({ ok: false, error: "Wrong password." }, 401, origin);
      return json({ ok: true, token: await mintToken(env) }, 200, origin);
    }

    /* --- staff only, below here --- */

    if (!path.startsWith("/api/")) {
      return json({ ok: false, error: "Not found." }, 404, origin);
    }

    if (!(await tokenIsValid(env, bearer(request)))) {
      return json({ ok: false, error: "Please sign in again." }, 401, origin);
    }

    const ops = {
      "/api/state": "state",
      "/api/customers/add": "add",
      "/api/customers/seat": "seat",
      "/api/customers/next": "next",
      "/api/customers/done": "done",
      "/api/customers/remove": "remove",
      "/api/barbers/add": "barberAdd",
      "/api/barbers/update": "barberUpdate",
      "/api/barbers/remove": "barberRemove",
      "/api/settings": "settings",
      "/api/clear": "clear",
    };

    const op = ops[path];
    if (!op) return json({ ok: false, error: "Not found." }, 404, origin);

    let args = {};
    if (request.method === "POST") {
      try {
        args = await request.json();
      } catch {
        args = {};
      }
    }

    const { status, body } = await call(op, args);
    return json(body, status, origin);
  },
};

/**
 * Front desk — the staff side of the walk-in queue.
 *
 * Nothing here is trusted: the password is checked by the worker, and the
 * token below only ever unlocks this shop's queue.
 */
(function () {
  var API = window.CBB_API;
  var KEY = "cbb.token";

  var token = "";
  try {
    token = localStorage.getItem(KEY) || "";
  } catch (e) {
    token = "";
  }

  var state = null;
  var poll = null;

  function $(id) { return document.getElementById(id); }

  var gate = $("gate");
  var desk = $("desk");
  var loginForm = $("login-form");
  var loginError = $("login-error");
  var addError = $("add-error");

  /* ---------------- plumbing ---------------- */

  function remember(t) {
    token = t;
    try {
      if (t) localStorage.setItem(KEY, t);
      else localStorage.removeItem(KEY);
    } catch (e) { /* private browsing — the session still works */ }
  }

  function api(path, body) {
    var opts = {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + token },
      cache: "no-store",
    };
    if (body !== undefined) {
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(API + path, opts).then(function (res) {
      if (res.status === 401) {
        signOut();
        throw new Error("Signed out — enter the password again.");
      }
      return res.json().then(function (data) {
        if (!res.ok || data.ok === false) {
          throw new Error(data.error || "Something went wrong.");
        }
        return data;
      });
    });
  }

  function act(path, body) {
    desk.classList.add("is-busy");
    return api(path, body || {})
      .then(paint)
      .catch(function (err) { flash(addError, err.message); })
      .then(function () { desk.classList.remove("is-busy"); });
  }

  function flash(el, message) {
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    setTimeout(function () { el.hidden = true; }, 5000);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function spell(minutes) {
    if (minutes < 5) return "No wait";
    if (minutes < 60) return minutes + " min";
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    return m ? h + " hr " + m + " min" : h + " hr";
  }

  function since(ts) {
    return Math.max(0, Math.round((Date.now() - ts) / 60000));
  }

  function firstName(s) {
    return String(s).split(" ")[0];
  }

  /* ---------------- painting ---------------- */

  function paint(data) {
    if (data) state = data;
    if (!state) return;

    var onDuty = state.barbers.filter(function (b) { return b.onDuty; });
    var seated = state.queue.filter(function (q) { return q.status === "in-chair"; });
    var waiting = state.queue.filter(function (q) { return q.status === "waiting"; });

    /* summary */
    var summary = document.querySelector(".summary");
    var shut = !state.settings.open || onDuty.length === 0;
    summary.classList.toggle("is-shut", shut);
    summary.classList.toggle("is-clear", !shut && state.waitMinutes < 5);
    $("sum-wait").textContent = shut ? "Hidden" : spell(state.waitMinutes);
    $("sum-waiting").textContent = waiting.length;
    $("sum-barbers").textContent = onDuty.length;
    $("sum-note").textContent = !state.settings.open
      ? "The shop is marked closed, so the main site shows nothing."
      : onDuty.length === 0
      ? "Nobody is on duty, so the main site shows nothing."
      : "";

    /* barbers */
    $("barbers").innerHTML = state.barbers
      .map(function (b) {
        var client = seated.find(function (q) { return q.barberId === b.id; });
        var status = !b.onDuty
          ? "Off duty"
          : client
          ? "Cutting " + esc(client.name) + " — " + since(client.startedAt) + " min in"
          : "Chair open";
        return (
          '<div class="barber' + (b.onDuty ? "" : " off") + '">' +
            '<span class="barber-name">' + esc(b.name) + "</span>" +
            '<label class="switch">' +
              '<input type="checkbox" data-duty="' + b.id + '"' + (b.onDuty ? " checked" : "") + ">" +
              "<span>On duty</span>" +
            "</label>" +
            '<button type="button" class="btn btn-sm btn-go" data-next="' + b.id + '"' +
              (b.onDuty && waiting.length ? "" : " disabled") + ">Call next</button>" +
            (client
              ? '<button type="button" class="btn btn-sm btn-ghost" data-done="' + client.id + '">Finished</button>'
              : "") +
            '<button type="button" class="btn btn-sm btn-ghost" data-drop-barber="' + b.id + '">Remove</button>' +
            '<span class="barber-status">' + status + "</span>" +
          "</div>"
        );
      })
      .join("");

    /* the line */
    var ordered = seated.concat(waiting);
    var n = 0;
    $("queue").innerHTML = ordered
      .map(function (q) {
        var chair = q.status === "in-chair";
        var b = chair && state.barbers.find(function (x) { return x.id === q.barberId; });
        if (!chair) n += 1;

        var meta = chair
          ? "In the chair with " + esc(b ? b.name : "a barber") + " — " + since(q.startedAt) + " min"
          : "Waiting " + since(q.joinedAt) + " min";
        if (q.note) meta += " · " + esc(q.note);

        var actions = chair
          ? '<button type="button" class="btn btn-sm btn-go" data-done="' + q.id + '">Finished</button>'
          : onDuty
              .map(function (b2) {
                return (
                  '<button type="button" class="btn btn-sm btn-ghost" data-seat="' + q.id +
                  '" data-barber="' + b2.id + '">Seat' +
                  (onDuty.length > 1 ? " · " + esc(firstName(b2.name)) : "") +
                  "</button>"
                );
              })
              .join("");

        return (
          '<li class="' + (chair ? "seated" : "") + '">' +
            '<span class="pos">' + (chair ? "✂" : n) + "</span>" +
            '<div class="who"><strong>' + esc(q.name) + "</strong><span>" + meta + "</span></div>" +
            '<div class="row-actions">' + actions +
              '<button type="button" class="btn btn-sm btn-ghost" data-remove="' + q.id + '">Remove</button>' +
            "</div>" +
          "</li>"
        );
      })
      .join("");

    $("queue-empty").hidden = ordered.length > 0;

    /* settings — don't yank a field the user is typing in */
    var avg = $("avg-cut");
    if (document.activeElement !== avg) avg.value = state.settings.avgCutMinutes;
    $("shop-open").checked = !!state.settings.open;

    $("foot").textContent = "Updated " + new Date(state.updatedAt).toLocaleTimeString();
  }

  /* ---------------- session ---------------- */

  function showDesk() {
    gate.hidden = true;
    desk.hidden = false;
    $("sign-out").hidden = false;
    refresh();
    clearInterval(poll);
    poll = setInterval(refresh, 20000);
  }

  function showGate() {
    desk.hidden = true;
    gate.hidden = false;
    $("sign-out").hidden = true;
    clearInterval(poll);
    poll = null;
  }

  function signOut() {
    remember("");
    state = null;
    showGate();
  }

  function refresh() {
    return api("/api/state").then(paint).catch(function () { /* shown on the next action */ });
  }

  /* ---------------- wiring ---------------- */

  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var submit = $("login-submit");
    var input = $("password");
    submit.disabled = true;
    loginError.hidden = true;

    fetch(API + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: input.value }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.ok) throw new Error(res.d.error || "Could not sign in.");
        remember(res.d.token);
        input.value = "";
        showDesk();
      })
      .catch(function (err) {
        flash(loginError, err.message === "Failed to fetch"
          ? "Can't reach the queue. Check the API address in assets/config.js."
          : err.message);
      })
      .then(function () { submit.disabled = false; });
  });

  $("sign-out").addEventListener("click", signOut);

  $("add-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var name = $("customer-name");
    var note = $("customer-note");
    if (!name.value.trim()) return;
    act("/api/customers/add", { name: name.value, note: note.value }).then(function () {
      name.value = "";
      note.value = "";
      name.focus();
    });
  });

  $("barber-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var input = $("barber-name");
    if (!input.value.trim()) return;
    act("/api/barbers/add", { name: input.value }).then(function () { input.value = ""; });
  });

  document.addEventListener("click", function (e) {
    var el = e.target.closest("button");
    if (!el) return;

    if (el.dataset.seat) act("/api/customers/seat", { id: el.dataset.seat, barberId: el.dataset.barber });
    else if (el.dataset.next) act("/api/customers/next", { barberId: el.dataset.next });
    else if (el.dataset.done) act("/api/customers/done", { id: el.dataset.done });
    else if (el.dataset.remove) act("/api/customers/remove", { id: el.dataset.remove });
    else if (el.dataset.dropBarber) {
      if (confirm("Remove this barber? Anyone in their chair goes back to the line."))
        act("/api/barbers/remove", { id: el.dataset.dropBarber });
    } else if (el.id === "clear-line") {
      if (confirm("Clear everyone out of the line?")) act("/api/clear");
    }
  });

  document.addEventListener("change", function (e) {
    var el = e.target;
    if (el.dataset && el.dataset.duty) act("/api/barbers/update", { id: el.dataset.duty, onDuty: el.checked });
    else if (el.id === "avg-cut") act("/api/settings", { avgCutMinutes: el.value });
    else if (el.id === "shop-open") act("/api/settings", { open: el.checked });
  });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && token) refresh();
  });

  /* keep "waiting 12 min" honest between polls */
  setInterval(function () { if (state && !desk.hidden) paint(); }, 30000);

  if (token) showDesk();
  else showGate();
})();

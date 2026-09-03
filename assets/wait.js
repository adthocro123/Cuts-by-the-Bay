/**
 * Shows the current walk-in wait on the main site.
 *
 * If the shop is closed, nobody is on duty, or the queue can't be reached,
 * the badge simply stays hidden — the page looks exactly as it did before.
 */
(function () {
  var badge = document.getElementById("wait-badge");
  if (!badge) return;

  var value = badge.querySelector(".wait-value");
  var meta = badge.querySelector(".wait-meta");

  function spell(minutes) {
    if (minutes < 5) return "Walk right in";
    if (minutes < 60) return minutes + " min";
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    return m ? h + " hr " + m + " min" : h + " hr";
  }

  function people(n) {
    return n === 1 ? "1 person ahead" : n + " people ahead";
  }

  function barbers(n) {
    return n + (n === 1 ? " barber" : " barbers") + " on the floor";
  }

  function render(data) {
    if (!data || !data.open || !data.barbersOnDuty || data.waitMinutes == null) {
      badge.hidden = true;
      return;
    }

    value.textContent = spell(data.waitMinutes);
    badge.classList.toggle("is-clear", data.waitMinutes < 5);

    var bits = [barbers(data.barbersOnDuty)];
    if (data.peopleWaiting > 0) bits.unshift(people(data.peopleWaiting));
    meta.textContent = bits.join(" · ");

    badge.hidden = false;
  }

  function refresh() {
    fetch(window.CBB_API + "/api/status", { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(render)
      .catch(function () {
        badge.hidden = true;
      });
  }

  refresh();
  setInterval(refresh, 45000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refresh();
  });
})();

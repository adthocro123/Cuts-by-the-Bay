/**
 * Where the queue lives. Deployed from worker/ — see worker/README.md.
 * Local development points at the worker running on this machine instead.
 */
window.CBB_API =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:8787"
    : "https://cuts-by-the-bay-queue.cutsbythebay.workers.dev";

/**
 * Where the queue lives.
 *
 * After you deploy the worker, wrangler prints a URL like
 *   https://cuts-by-the-bay-queue.something.workers.dev
 * Paste it below, replacing the placeholder.
 */
window.CBB_API =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:8787"
    : "https://cuts-by-the-bay-queue.YOUR-SUBDOMAIN.workers.dev";

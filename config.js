/* ============================================================
   Plug In Dashboard — your settings
   ------------------------------------------------------------
   Put this file in the SAME folder as index.html in your repo.
   Fill in your URLs ONCE here and every laptop that opens the
   board picks them up automatically — no Settings typing.

   Board updates (new index.html) will NEVER overwrite this file,
   so your URLs stay put. To change a URL, edit it here and commit.
   ============================================================ */
window.PIB_CONFIG = {

  // Your Apps Script web-app URL (ends in /exec). This is the live API.
  apiUrl: "https://script.google.com/macros/s/AKfycbzeLun6kVzO4K8N3cQpVRN0GvujvhH0IWN_RkmoaPsXQjl7x-NumxSLzi4oAnwOSbgi/exec",

  // Optional — only used if apiUrl is blank (older CSV mode):
  url:     "",   // published jobs CSV link
  errUrl:  "",   // published errors CSV link
  delHook: "",   // legacy delete webhook (ignored when apiUrl is set)

  // Optional refresh interval in seconds (default 60):
  secs: 60,

  // Optional passcode gate. Leave "" for no gate.
  // NOTE: this is a light cover, NOT real security — anyone who opens the
  // page can view its source and see this passcode. For real protection,
  // put the whole site behind Cloudflare Access (ask Claude how).
  passcode: ""

};

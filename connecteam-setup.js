// One-off helper for pointing Connecteam at the app. Run on your laptop:
//
//   node --env-file=.env connecteam-setup.js forms
//        → lists your forms, so you can copy the End of Job Report's id into EOJ_FORM_ID
//
//   node --env-file=.env connecteam-setup.js webhook https://your-app-url
//        → registers the app as a Connecteam webhook for new form submissions,
//          using CONNECTEAM_WEBHOOK_SECRET as the shared secret
//
//   node --env-file=.env connecteam-setup.js list
//        → shows the webhooks Connecteam already has
//
// Needs CONNECTEAM_API_KEY (Connecteam → Settings → API keys).

const API = (process.env.CONNECTEAM_API || "https://api.connecteam.com").replace(/\/$/, "");
const KEY = process.env.CONNECTEAM_API_KEY;
if (!KEY) { console.error("Set CONNECTEAM_API_KEY in .env first."); process.exit(1); }

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "X-API-KEY": KEY, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Connecteam ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "forms") {
    const r = await call("GET", "/forms/v1/forms?limit=200");
    const forms = r.data?.forms || r.forms || [];
    for (const f of forms) console.log(String(f.formId).padEnd(12), f.formName || f.name);
    console.log("\nPut the End of Job Report v2.0 id in EOJ_FORM_ID.");
  } else if (cmd === "webhook") {
    if (!arg || !/^https:\/\//.test(arg)) throw new Error("Give the app's https URL, e.g. https://pluginboard.onrender.com");
    const secret = process.env.CONNECTEAM_WEBHOOK_SECRET;
    if (!secret) throw new Error("Set CONNECTEAM_WEBHOOK_SECRET in .env first (same value as on the app).");
    const r = await call("POST", "/settings/v1/webhooks", {
      name: "Plug In Dashboard — stock deductions",
      url: arg.replace(/\/$/, "") + "/hooks/connecteam",
      featureType: "forms",
      eventTypes: ["form_submission"],
      secretKey: secret,
    });
    console.log("Webhook created:", JSON.stringify(r.data || r, null, 2));
  } else if (cmd === "list") {
    const r = await call("GET", "/settings/v1/webhooks?featureType=forms");
    console.log(JSON.stringify(r.data || r, null, 2));
  } else {
    console.log("Commands: forms | webhook <https://app-url> | list");
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

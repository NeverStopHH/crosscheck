/**
 * THE ONE SCRIPT IN THE WEB UI (1.0 spec 04a §5) — served as /ui/passkey.js
 * and loaded only by /ui/passkeys and /ui/waivers, whose CSP alone allows a
 * same-origin script and same-origin fetch. Every other page stays JS-free.
 *
 * WebAuthn has no form-only path: `navigator.credentials` is the only door
 * to an authenticator. So this script does exactly the ceremony and nothing
 * else: it reads a form marked `data-ceremony`, asks the hub for options
 * bound to those exact fields, hands them to the browser, and posts the
 * signed answer back with the same fields. It shows the terms it is about to
 * sign in the form's `<output>` BEFORE the device prompt, so what the person
 * reads is what the hub recomputes — the hub refuses any difference.
 *
 * Written as plain ES2020 without a build step, base64url by hand, so it runs
 * in every browser that has WebAuthn and ships as one constant string. No
 * template literals inside: this module wraps it in one.
 */
export const PASSKEY_SCRIPT = String.raw`(() => {
  "use strict";
  const status = document.getElementById("ceremony-status");
  const say = (text) => { if (status) status.textContent = text; };
  const csrf = document.getElementById("crosscheck-csrf")?.dataset.token ?? "";

  if (!window.PublicKeyCredential) {
    say("This browser offers no passkeys at this address. Passkeys need https, or the hub's own localhost.");
    document.querySelectorAll("form[data-ceremony] button").forEach((b) => { b.disabled = true; });
    return;
  }

  const toBuffer = (value) => {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)).buffer;
  };
  const toBase64url = (buffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buffer)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const creationOptions = (o) => ({
    ...o,
    challenge: toBuffer(o.challenge),
    user: { ...o.user, id: toBuffer(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: toBuffer(c.id) })),
  });
  const requestOptions = (o) => ({
    ...o,
    challenge: toBuffer(o.challenge),
    allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: toBuffer(c.id) })),
  });
  const registrationJSON = (cred) => ({
    id: cred.id,
    rawId: toBase64url(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toBase64url(cred.response.clientDataJSON),
      attestationObject: toBase64url(cred.response.attestationObject),
      transports: cred.response.getTransports ? cred.response.getTransports() : [],
    },
  });
  const assertionJSON = (cred) => ({
    id: cred.id,
    rawId: toBase64url(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toBase64url(cred.response.clientDataJSON),
      authenticatorData: toBase64url(cred.response.authenticatorData),
      signature: toBase64url(cred.response.signature),
      userHandle: cred.response.userHandle ? toBase64url(cred.response.userHandle) : undefined,
    },
  });

  const post = async (path, body) => {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "x-crosscheck-csrf": csrf },
      body: JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(parsed?.error?.message ?? "the hub refused (" + response.status + ")");
    }
    return parsed.data;
  };

  /** The fields a form signs: shortening hours become an exact ISO expiry. */
  const fieldsOf = (form) => {
    const fields = Object.fromEntries(new FormData(form));
    const hours = Number(fields.hours);
    if (fields.hours !== undefined && fields.hours !== "") {
      const fromHours = new Date(Date.now() + hours * 3600000);
      const ceiling = fields.requestedExpiresAt ? new Date(fields.requestedExpiresAt) : null;
      fields.expiresAt = (ceiling && ceiling < fromHours ? ceiling : fromHours).toISOString();
    } else if (fields.requestedExpiresAt) {
      fields.expiresAt = fields.requestedExpiresAt;
    }
    delete fields.hours;
    delete fields.requestedExpiresAt;
    return fields;
  };

  const showTerms = (form) => {
    const output = form.querySelector("output");
    const fields = fieldsOf(form);
    if (output && fields.expiresAt) output.textContent = "Signs: open until " + fields.expiresAt;
  };

  const run = async (form) => {
    const fields = fieldsOf(form);
    say("Confirm with your passkey on this device…");
    const options = await post("/ui/webauthn/options", fields);
    const isCreate = fields.action === "enrol";
    const credential = isCreate
      ? await navigator.credentials.create({ publicKey: creationOptions(options.publicKey) })
      : await navigator.credentials.get({ publicKey: requestOptions(options.publicKey) });
    if (!credential) throw new Error("the device returned no passkey");
    const result = await post("/ui/webauthn/verify", {
      ...fields,
      ceremonyId: options.ceremonyId,
      response: isCreate ? registrationJSON(credential) : assertionJSON(credential),
    });
    if (result.code) {
      const enrol = document.querySelector('form[data-ceremony] input[name="code"]');
      if (enrol) enrol.value = result.code;
      say("Confirmed. Now name this new device and enrol its passkey below.");
      return;
    }
    say(result.message ?? "Done.");
    window.setTimeout(() => window.location.reload(), 1200);
  };

  document.querySelectorAll("form[data-ceremony]").forEach((form) => {
    form.addEventListener("input", () => showTerms(form));
    showTerms(form);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      run(form).catch((error) => say(error.name === "NotAllowedError"
        ? "The passkey prompt was cancelled or timed out. Nothing was changed."
        : String(error.message ?? error)));
    });
  });
})();
`;

const { ipcRenderer } = require("electron");

if (process.isMainFrame) {
  const documentId = crypto.randomUUID();
  let target = null, filledTarget = null, token = "", filling = false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const forbidden = input => /(?:^|\s)(new-password|one-time-code)(?:\s|$)/i.test(input.autocomplete);
  const editable = input => input instanceof HTMLInputElement && input.isConnected && !input.disabled && !input.readOnly && input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const usable = input => editable(input) && !forbidden(input);
  const username = input => ["text", "email", "tel"].includes(input.type) && (/username|email/.test(input.autocomplete) || /user|email|login|identifier/i.test(`${input.name} ${input.id}`) || input.type === "email");
  const eligible = input => usable(input) && (input.type === "password" || username(input)) && ![...(input.form || input.getRootNode()).querySelectorAll("input")].some(field => editable(field) && field.type === "password" && forbidden(field));
  const active = () => {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element;
  };
  function dismiss() {
    target = null;
    token = "";
    ipcRenderer.send("legalwork:autofill:dismiss");
  }
  function suggest(input, preserveToken = false) {
    if (filling || input === filledTarget) return;
    if (!eligible(input)) { dismiss(); return; }
    // Native focus can return from the picker while the selected credential
    // is still being read. Keep that same field's pending selection valid.
    if (!preserveToken || target !== input || !token) token = crypto.randomUUID();
    target = input;
    const { x, y, width, height } = input.getBoundingClientRect();
    ipcRenderer.send("legalwork:autofill:suggest", { document: documentId, token, rect: { x, y, width, height } });
  }
  window.addEventListener("focusin", event => suggest(event.composedPath()[0], true), true);
  window.addEventListener("input", event => { const input = event.composedPath()[0]; if (!filling && event.isTrusted) filledTarget = null; if (username(input)) suggest(input); }, true);
  window.addEventListener("pointerdown", event => {
    const input = event.composedPath()[0];
    if (eligible(input)) { filledTarget = null; if (input === active()) suggest(input); }
    else dismiss();
  }, true);
  window.addEventListener("scroll", dismiss, { capture: true, passive: true });
  window.addEventListener("resize", dismiss);
  window.addEventListener("keydown", event => { if (event.key === "Escape" || event.key === "Tab") dismiss(); }, true);
  ipcRenderer.on("legalwork:autofill:cancel", () => { filledTarget = active(); dismiss(); });
  ipcRenderer.on("legalwork:autofill:fill", (_event, value) => {
    if (value?.document !== documentId || value.token !== token || value.url !== location.href || target !== active() || !eligible(target)) return;
    const field = target;
    const scope = field.form || field.getRootNode();
    const fields = [...scope.querySelectorAll("input")].filter(usable);
    const passwords = fields.filter(input => input.type === "password");
    const login = username(field) ? field : fields.filter(input => username(input) && (input.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1);
    const password = field.type === "password" ? field : passwords.length === 1 ? passwords[0] : null;
    const set = (input, text) => {
      if (!input || !usable(input)) return;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    };
    filling = true;
    filledTarget = field;
    try {
      if (value.username) set(login, value.username);
      if (password?.type === "password") set(password, value.password);
    } finally { filling = false; dismiss(); }
  });
}

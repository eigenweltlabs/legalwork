function origin(url) {
  try { return new URL(url).origin; } catch { return null; }
}

/** Resolve only in the desktop host and fill the existing native page, outside engine tool arguments. */
export function createBrowserPasswordActions(page, loadStore) {
  const check = signal => { signal.throwIfAborted(); if (page.contents.isDestroyed()) throw new Error("Browser tab is closed."); };
  return {
    async list(signal) {
      check(signal);
      const store = await loadStore();
      check(signal);
      const website = origin(page.contents.getURL());
      return { website: website === "null" ? null : website, passwords: website && website !== "null" ? await store.list(website) : [] };
    },
    async fill(body, signal) {
      // Errors from page scripts must never echo the password through this tool.
      let failure = "Password fill could not be confirmed. Inspect the page before retrying; use a current native password-field ref in this chat's local browser.";
      try {
        if (typeof body?.password_id !== "string" || typeof body.ref !== "string" || !body.ref || body.ref.length > 200) throw new Error();
        check(signal);
        const store = await loadStore();
        let saved = await store.get(body.password_id);
        check(signal);
        const generation = page.state().generation;
        const matches = url => store.matchesEntryWebsite(saved, url);
        if (!matches(page.contents.getURL())) {
          failure = "The current website does not match the saved password's website. Check the current website and saved entry; retrying different refs will not fix a website mismatch.";
          throw new Error();
        }
        const action = { type: "fill", tabID: page.state().id, ref: body.ref, text: "" };
        const { value: target } = await page.execute({ action, files: [], inspect: true }, signal);
        if (!target?.resources?.length || target.resources.some(url => !matches(url))) {
          failure = "The password field belongs to a different website. Use a password field on an allowed sign-in website or one of its subdomains.";
          throw new Error();
        }
        const checked = await page.execute({ action: { type: "evaluate", tabID: action.tabID, ref: body.ref,
          script: "function(element) { return element instanceof HTMLInputElement && element.type === 'password' && !element.disabled && !element.readOnly; }" },
          files: [], generation, target }, signal);
        if (checked.value?.value !== true || !matches(page.contents.getURL())) throw new Error();
        // A website grant or saved login can change while native observations are awaiting.
        saved = await store.get(body.password_id);
        check(signal);
        if (!matches(page.contents.getURL()) || target.resources.some(url => !matches(url))) {
          failure = "This website is no longer allowed to use the saved password. Check the saved login before continuing.";
          throw new Error();
        }
        await page.execute({ action: { ...action, text: saved.password }, files: [], generation, target }, signal);
        return { filled: true, password_id: saved.id };
      } catch {
        throw new Error(failure);
      }
    },
  };
}

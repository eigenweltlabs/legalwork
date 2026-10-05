// Keep accessible descendants when Chromium marks layout containers as ignored.
// The upstream browser plugin stops traversing at ignored, unnamed nodes.
export function normalizeAccessibilityTree(result) {
  if (!Array.isArray(result.nodes)) return result;
  const indexed = new Map(result.nodes.map((node) => [node.nodeId, node]));
  const removed = new Set(result.nodes.filter((node) => node.ignored && !node.name?.value).map((node) => node.nodeId));
  function expand(id, ancestors = new Set()) {
    if (ancestors.has(id) || !indexed.has(id)) return [];
    if (!removed.has(id)) return [id];
    const next = new Set(ancestors).add(id);
    return (indexed.get(id).childIds ?? []).flatMap((child) => expand(child, next));
  }
  const nodes = result.nodes.filter((node) => !removed.has(node.nodeId)).map((node) => ({
    ...node, childIds: (node.childIds ?? []).flatMap((id) => expand(id)),
  }));
  const parents = new Map(nodes.flatMap((node) => node.childIds.map((id) => [id, node.nodeId])));
  return { ...result, nodes: nodes.map((node) => ({ ...node, parentId: parents.get(node.nodeId) })) };
}

// Returned selectors describe the observed DOM, including controls without IDs.
function readControls() {
  function selectorFor(element) {
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1) {
      if (current.id && document.querySelectorAll("#" + CSS.escape(current.id)).length === 1) {
        parts.unshift("#" + CSS.escape(current.id));
        break;
      }
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement ? Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName) : [current];
      parts.unshift(tag + (siblings.length > 1 ? ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")" : ""));
      current = current.parentElement;
    }
    return parts.join(" > ");
  }
  return Array.from(document.querySelectorAll('input,textarea,select,button,a,[role="button"],[role="checkbox"]'))
    .filter((element) => element.getClientRects().length).slice(0, 200).map((element) => {
      const label = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        || element instanceof HTMLSelectElement || element instanceof HTMLButtonElement
        ? element.labels?.[0]?.innerText : "";
      const text = element instanceof HTMLElement ? element.innerText.slice(0, 160) : "";
      return {
        selector: selectorFor(element), tag: element.tagName.toLowerCase(),
        name: element.getAttribute("aria-label") || label || text || "",
        type: element.getAttribute("type"),
      };
    });
}

async function evaluate(send, expression) {
  const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Browser action failed.");
  return response.result?.value;
}

async function waitFor(send, expression, deadline) {
  let lastError;
  while (Date.now() < deadline) {
    try { if (await evaluate(send, expression)) return; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(lastError ? `Page did not become ready: ${lastError.message}` : "Timed out waiting for the page condition.");
}

export async function browserSnapshot(send, webContents) {
  await send("Accessibility.enable", {});
  const tree = normalizeAccessibilityTree(await send("Accessibility.getFullAXTree", {}));
  const elements = (tree.nodes ?? []).filter((node) => node.name?.value || node.value?.value).slice(0, 500).map((node) => ({
    node_id: node.backendDOMNodeId, role: node.role?.value, name: node.name?.value, value: node.value?.value,
  }));
  // Include selectors so a subsequent batch can act without a separate DOM probe.
  const controls = await evaluate(send, `(${readControls.toString()})()`);
  const text = elements.length > 1 ? undefined : await evaluate(send, "document.body?.innerText?.slice(0,12000) || ''");
  return { url: webContents.getURL(), title: webContents.getTitle(), elements, controls, ...(text === undefined ? {} : { text }) };
}

export async function runBrowserBatch(send, webContents, steps, timeoutMs = 15000) {
  if (!Array.isArray(steps) || steps.length > 20 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error("Use up to 20 actions and a timeout between 100 and 30000 ms.");
  for (const step of steps) {
    if (!step || !["click", "fill", "wait_for"].includes(step.action)) throw new Error("Supported batch actions: click, fill, wait_for.");
    if (step.selector !== undefined && (typeof step.selector !== "string" || !step.selector || step.selector.length > 2000)) throw new Error("Invalid selector.");
    if (step.action !== "wait_for" && !step.selector) throw new Error("Click and fill require an observed selector.");
    if (step.action === "fill" && typeof step.value !== "string") throw new Error("Fill requires a string value.");
    if (step.text !== undefined && typeof step.text !== "string") throw new Error("Wait text must be a string.");
  }
  const deadline = Date.now() + timeoutMs;
  const completed = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const selector = JSON.stringify(step.selector ?? null);
    const target = `document.querySelector(${selector})`;
    try {
      if (step.action === "wait_for") {
        const text = JSON.stringify(step.text ?? "");
        await waitFor(send, `document.readyState !== 'loading' && (${selector} === null || !!${target}?.getClientRects().length) && document.body?.innerText.includes(${text})`, deadline);
      } else {
        await waitFor(send, `(() => {const e=${target};return !!e && e.getClientRects().length > 0 && !e.disabled && e.getAttribute('aria-disabled') !== 'true'})()`, deadline);
        if (step.action === "click") {
          await evaluate(send, `(() => {const nodes=document.querySelectorAll(${selector});if(nodes.length!==1)throw new Error('Selector must identify exactly one element');const e=nodes[0];e.scrollIntoView({block:'center'});e.click();return true})()`);
        } else {
          await evaluate(send, `(() => {const nodes=document.querySelectorAll(${selector});if(nodes.length!==1)throw new Error('Selector must identify exactly one element');const e=nodes[0];if(!['INPUT','TEXTAREA','SELECT'].includes(e.tagName))throw new Error('Fill requires an input, textarea or select');if(e.readOnly)throw new Error('Field is read-only');const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value')?.set;if(!setter)throw new Error('Field cannot be filled');e.focus();setter.call(e,${JSON.stringify(step.value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
        }
      }
      completed.push({ index, action: step.action });
    } catch (error) {
      return { ok: false, completed, failedStep: index, error: error.message };
    }
  }
  return { ok: true, completed, snapshot: await browserSnapshot(send, webContents) };
}

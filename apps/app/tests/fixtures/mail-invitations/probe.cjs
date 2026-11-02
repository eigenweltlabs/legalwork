const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { writeFileSync } = require('node:fs');
const [root, evidence] = process.argv.slice(2);
app.setPath('userData', join(root, 'profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, enableLargerThanScreen: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const network = [];
  win.webContents.session.webRequest.onBeforeRequest((details, done) => { const remote = /^https?:/.test(details.url); if (remote) network.push(details.url); done({ cancel: remote }); });
  await win.loadFile(join(root, 'index.html')); win.show(); win.focus(); win.setContentSize(1100, 800);
  const run = code => win.webContents.executeJavaScript(code);
  const until = async code => { for (let attempt = 0; attempt < 300; attempt++) { if (await run(code)) return; await new Promise(done => setTimeout(done, 20)); } throw Error(`Renderer deadline: ${code}: ${await run('document.body.textContent')}`); };
  const button = (text, dialog = false) => `[...${dialog ? "document.querySelector('[role=dialog]')" : 'document'}.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)})`;
  const key = async (keyCode, modifiers = []) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); if (keyCode === 'Return') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); };
  const activate = async (text, dialog = false) => { const target = button(text, dialog); await until(`!!${target}&&!${target}.disabled`); await run(`${target}.focus()`); await key('Return'); };
  const respondCount = () => run("window.invitationFixture.calls.filter(call=>call.path.endsWith('/respond')).length");
  const capture = async name => { if (!evidence) return; await run('document.fonts.ready.then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))'); writeFileSync(join(evidence, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
  await until('document.hasFocus()&&innerWidth===1100&&innerHeight===800');
  assert(await run("getComputedStyle(document.documentElement).getPropertyValue('--lw-control-md').trim().length>0"));
  for (const provider of ['google', 'outlook']) {
    if (provider !== 'google') await run(`window.invitationFixture.select(${JSON.stringify(provider)})`);
    await activate('Reply');
    await until(`!!${button('Accept')}`);
    assert(await run(`${button('Accept')}.disabled`), 'Read-only calendars must not offer a reply');
    await run("document.querySelector('[aria-label=\"Reply calendar\"]').focus()"); await key('Down');
    const popup = '[data-slot=select-content][data-open]', highlighted = `${popup} [role=option][data-highlighted]`;
    await until(`document.querySelector('${popup}')?.contains(document.activeElement)&&!!document.querySelector('${highlighted}')`);
    const label = provider === 'outlook' ? 'Delegated calendar' : 'Personal calendar';
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await run(`document.querySelector('${highlighted}').textContent`);
      if (current.includes(label)) break;
      await key('Down'); await until(`document.querySelector('${highlighted}')?.textContent!==${JSON.stringify(current)}`);
    }
    assert((await run(`document.querySelector('${highlighted}').textContent`)).includes(label));
    await key('Return'); await until(`!document.querySelector('${popup}')&&!${button('Accept')}.disabled`);
    await activate('Accept'); await until("document.querySelector('[role=dialog]')?.textContent.includes('Updated matter review')");
    await until("document.activeElement?.textContent==='Cancel'");
    const review = await run("document.querySelector('[role=dialog]').textContent");
    for (const text of [label, 'owner@example.test', 'organizer@example.test', 'Room 14', 'Calendar event updated']) assert(review.includes(text));
    if (provider === 'outlook') { assert(review.includes('delegate@example.test')); assert(review.includes('Occurrence')); }
    await capture(`invitation-${provider}-review`);
    const before = await respondCount();
    await run(`${button('Send reply', true)}.focus()`); await key('Return', ['control']); await key('Return', ['meta']);
    await run('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    assert.equal(await respondCount(), before, 'Ctrl/Cmd+Enter cannot bypass the review');
    await key('Escape'); await until("!document.querySelector('[role=dialog]')");
    await until("document.activeElement?.textContent==='Accept'"); assert.equal(await respondCount(), before);
    await activate('Accept'); await until("document.activeElement?.textContent==='Cancel'");
    await key('Tab'); await until("document.activeElement?.textContent==='Send reply'");
    await key('Return'); await until("document.querySelector('[role=dialog]')?.querySelectorAll('button:disabled').length>=2");
    await until(`window.invitationFixture.calls.filter(call=>call.path.endsWith('/respond')).length===${before + 1}`);
    await key('Return'); await run('window.invitationFixture.release()');
    await until("!document.querySelector('[role=dialog]')&&document.body.textContent.includes('Reply status unknown')");
    await until("document.activeElement?.textContent==='Check reply'");
    assert.equal(await respondCount(), before + 1, 'Only one synthetic confirmation is allowed');
    assert(await run(`${button('Accept')}.disabled`));
    await capture(`invitation-${provider}-uncertain`);
    await activate('Check reply'); await until("document.querySelector('[role=dialog]')?.textContent.includes('Reply status unknown')");
    assert.equal(await run(`!!${button('Send reply', true)}`), false); assert.equal(await respondCount(), before + 1);
    await key('Escape'); await until("!document.querySelector('[role=dialog]')");
    await run('window.invitationFixture.saved()'); await activate('Check reply');
    await until("document.querySelector('[role=dialog]')?.textContent.includes('Response saved')");
    assert.equal(await run(`!!${button('Send reply', true)}`), false); assert.equal(await respondCount(), before + 1);
    await key('Escape'); await until("!document.querySelector('[role=dialog]')");
    await until("document.activeElement?.textContent==='Accept'");
  }
  await run("window.invitationFixture.select('cancelled')");
  await until("document.body.textContent.includes('Cancelled')");
  assert.equal(await run(`!!${button('Reply')}`), false);
  await activate('Details'); await until("document.body.textContent.includes('Discuss the revised contract.')");
  await capture('invitation-cancelled');
  const calls = await run('window.invitationFixture.calls');
  for (const provider of ['google', 'outlook']) {
    const previews = calls.filter(call => call.scenario === provider && call.path.endsWith('/preview'));
    assert.equal(previews.length, 4);
    for (const call of previews) assert.deepEqual(call.body, { source: { locator: { provider: 'gmail', messageId: 'invitation' }, partId: 'ics', referenceId: `sha256:${'b'.repeat(64)}`, rawReferenceId: `sha256:${'a'.repeat(64)}` }, index: 0, calendar: { connectorId: `${provider}-calendar`, connectionId: `synthetic-${provider}`, calendarId: 'selected-calendar' }, response: 'accepted' });
    assert.deepEqual(calls.filter(call => call.scenario === provider && call.path.endsWith('/respond')).map(call => call.body), [{ token: 'c'.repeat(64) }]);
  }
  assert.deepEqual(network, []);
  console.log('MAIL_INVITATION_UI_PASS'); win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });

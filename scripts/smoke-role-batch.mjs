import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { runRoleIsolationChecks } from './role-isolation-checks.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.ST_TEST_URL || 'http://127.0.0.1:18019';
assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/?$/);
let launch = { headless: true };
if (process.env.ST_CHROMIUM_MODULE) {
    const { default: binary } = await import(process.env.ST_CHROMIUM_MODULE);
    launch = { ...launch, executablePath: await binary.executablePath(), args: binary.args };
}
const browser = await chromium.launch(launch);
try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    const restartBatch = async () => {
        await page.waitForFunction(() => {
            const button = document.getElementById('nag-btn-restart-role');
            return button && !button.disabled;
        });
        await page.evaluate(() => document.getElementById('nag-btn-restart-role').click());
        const dialog = page.locator('dialog[open]').filter({ hasText: '从头生成全部角色' }).last();
        await dialog.waitFor({ state: 'visible' });
        await dialog.locator('.popup-button-ok').dispatchEvent('click');
        await page.waitForFunction(() => {
            const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
            const recovery = JSON.parse(localStorage.getItem('novel-auto-generator:role-batch:v1') || 'null');
            return !settings.roleBatch && recovery?.cleared === true;
        });
    };
    const startAndWait = async () => {
        const previousRevision = await page.evaluate(
            () => window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleBatch?.revision ?? -1,
        );
        await page.evaluate(() => window.jQuery('#nag-btn-start').triggerHandler('click'));
        await page.waitForFunction(
            (revision) => {
                const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
                const start = document.getElementById('nag-btn-start');
                return (
                    settings.roleBatch &&
                    settings.roleBatch.revision > revision &&
                    !settings.isRunning &&
                    start &&
                    !start.disabled
                );
            },
            previousRevision,
            { timeout: 60000 },
        );
    };
    const resetKeep = async () => {
        await page.evaluate(async () => {
            await window.jQuery('#nag-btn-reset').triggerHandler('click');
        });
        await page.waitForFunction(() => !document.getElementById('nag-btn-reset')?.disabled);
    };
    const connect = async () => {
        await page.locator('#api_button_openai').dispatchEvent('click');
        await page.waitForFunction(() => window.SillyTavern.getContext().onlineStatus !== 'no_connection');
    };
    const requests = [];
    const requestPages = [];
    let emptyReplies = false;
    let streamError = false;
    let holdResponse = false;
    let holdRole = null;
    let frontendReply = false;
    let releaseResponse;
    let onHeld;
    const errors = [];
    const saves = [];
    page.on('request', (request) => {
        if (!request.url().endsWith('/api/chats/save')) return;
        try {
            const data = request.postDataBuffer();
            const payload = JSON.parse(
                (request.headers()['content-encoding'] === 'gzip' ? gunzipSync(data) : data).toString(),
            );
            const message = payload.chat.at(-1);
            saves.push({
                body: message.mes?.match(/ROLE_RESULT_\d+/)?.[0],
                extra: message.extra?.nag_role_batch,
                receipts: message.swipe_info?.map((info) => info?.extra?.nag_role_batch),
            });
        } catch (error) {
            console.error('Cannot inspect synthetic save', error.message);
        }
    });
    let initializing = true;
    page.on('console', async (message) => {
        if (initializing && message.type() === 'error') {
            const values = await Promise.all(
                message
                    .args()
                    .map((arg) =>
                        arg.evaluate((value) => (value instanceof Error ? value.stack : String(value))).catch(() => ''),
                    ),
            );
            console.error('Host initialization:', values.join(' '));
        }
    });
    page.on('pageerror', (error) => errors.push(error.message));
    for (const endpoint of ['text-models', 'text-workers'])
        await page.route(`**/api/horde/${endpoint}`, (route) => route.fulfill({ json: [] }));
    await page.route('**/api/horde/status', (route) => route.fulfill({ json: { ok: false } }));
    await page.route('**/api/backends/chat-completions/status', (route) =>
        route.fulfill({ json: { data: [{ id: 'fixture-model' }] } }),
    );
    await page.route('**/api/backends/chat-completions/generate', async (route) => {
        const body = route.request().postDataJSON();
        requests.push(body);
        requestPages.push(
            await page.evaluate(() => ({
                swipe: window.SillyTavern.getContext().chat.at(-1)?.swipe_id,
                counter: document
                    .querySelector('#chat .last_mes .swipes-counter')
                    ?.textContent?.replace(/[\s\u200B-\u200D\uFEFF]/g, ''),
            })),
        );
        if (holdResponse || (holdRole && JSON.stringify(body.messages).includes(holdRole))) {
            await new Promise((resolve) => {
                releaseResponse = resolve;
                onHeld?.();
            });
        }
        if (streamError) {
            assert.equal(body.stream, true);
            return route.fulfill({
                contentType: 'text/event-stream',
                body: `data: ${JSON.stringify({ error: { message: 'Synthetic stream failure before first token' } })}\n\n`,
            });
        }
        const text =
            frontendReply === 'incomplete'
                ? '<card>这是有正文但缺少结束标签的角色卡，用来检查失败记录是否会被错误恢复为成功。'
                : frontendReply
                  ? '```html\n<html><body>GENERATED_FRONTEND<script>window.parent.__nagResultRuns=(window.parent.__nagResultRuns||0)+1;</script>' +
                    '角色原文'.repeat(50) +
                    '</body></html>\n```'
                  : emptyReplies
                    ? ''
                    : `[start]\n<character_design_complex>\nname: 测试角色${requests.length}\nversion: 1\nnotes: ROLE_RESULT_${requests.length}\n</character_design_complex>\n[end]`;
        if (!body.stream)
            return route.fulfill({ json: { choices: [{ message: { content: text }, finish_reason: 'stop' }] } });
        return route.fulfill({
            contentType: 'text/event-stream',
            body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        });
    });
    const waitForHost = async () => {
        await page.waitForFunction(() => window.SillyTavern?.getContext?.());
        await page.evaluate(async () => {
            const c = window.SillyTavern.getContext();
            await new Promise((resolve, reject) => {
                const finish = () => {
                    clearTimeout(timer);
                    resolve();
                };
                const timer = setTimeout(() => {
                    c.eventSource.removeListener(c.eventTypes.APP_READY, finish);
                    reject(new Error('Native APP_READY did not arrive'));
                }, 15000);
                c.eventSource.once(c.eventTypes.APP_READY, finish);
            });
        });
    };
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext?.());
    await page.evaluate(() => {
        const c = window.SillyTavern.getContext();
        c.eventSource.once(c.eventTypes.APP_READY, () => {
            window.__nagHostReady = true;
        });
    });
    await page.waitForFunction(
        () =>
            window.__nagHostReady || [...document.querySelectorAll('.popup-input')].some((input) => input.offsetParent),
    );
    const welcomeInput = page.locator('.popup-input:visible');
    if (await welcomeInput.count()) {
        await welcomeInput.last().fill('RoleBatchQA');
        await page.locator('.popup-button-ok:visible').last().click();
    }
    await waitForHost();
    await page.evaluate(async () => {
        await (await import('/script.js')).saveSettings();
    });
    const name = `RoleBatchQA-${Date.now()}`;
    const card = process.env.SMOKE_CARD
        ? JSON.parse(fs.readFileSync(process.env.SMOKE_CARD, 'utf8'))
        : {
              spec: 'chara_card_v2',
              spec_version: '2.0',
              data: { name, description: '', first_mes: '', character_book: { entries: [] } },
          };
    card.name = card.data.name = name;
    card.first_mes = card.data.first_mes = '写卡助手验收';
    card.data.description += '\nCARD_FORMAT_SENTINEL：严格遵守角色卡输出格式。';
    card.data.character_book.entries.push({
        id: 99991,
        keys: [],
        content: 'WORLD_FORMAT_SENTINEL：角色资料必须使用规定的格式。',
        constant: true,
        enabled: true,
        insertion_order: 1000000,
        position: 'before_char',
        extensions: {},
    });
    const token = (await (await page.request.get(url + '/csrf-token')).json()).token;
    const worldName = name + '-Worldbook';
    card.data.extensions ??= {};
    card.data.extensions.world = worldName;
    const entries = Object.fromEntries(
        card.data.character_book.entries.map((entry, uid) => [
            uid,
            {
                uid,
                key: entry.keys || [],
                keysecondary: entry.secondary_keys || [],
                content: entry.content,
                comment: entry.comment || '',
                constant: !!entry.constant,
                disable: entry.enabled === false,
                order: entry.insertion_order || 0,
                position: entry.extensions?.position ?? 0,
            },
        ]),
    );
    const world = await page.request.post(url + '/api/worldinfo/edit', {
        headers: { 'X-CSRF-Token': token },
        data: { name: worldName, data: { entries } },
    });
    assert.ok(world.ok(), await world.text());
    const imported = await page.request.post(url + '/api/characters/import', {
        headers: { 'X-CSRF-Token': token },
        multipart: {
            file_type: 'json',
            avatar: { name: name + '.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(card)) },
        },
    });
    assert.ok(imported.ok(), await imported.text());
    const importedName = (await imported.json()).file_name;
    const avatar = importedName.endsWith('.png') ? importedName : importedName + '.png';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page
        .waitForFunction(
            (avatar) => window.SillyTavern?.getContext().characters.some((c) => c.avatar === avatar),
            avatar,
        )
        .catch(async (error) => {
            console.error({
                avatar,
                errors,
                state: await page.evaluate(() => ({
                    characters: window.SillyTavern?.getContext().characters.map((c) => c.avatar),
                    body: document.body.innerText.slice(-1400),
                })),
            });
            throw error;
        });
    const showFixture = async () => {
        await waitForHost();
        await page.waitForFunction(
            (avatar) => window.SillyTavern?.getContext?.().characters.some((character) => character.avatar === avatar),
            avatar,
        );
        const index = await page.evaluate(
            (avatar) => SillyTavern.getContext().characters.findIndex((c) => c.avatar === avatar),
            avatar,
        );
        assert.ok(index >= 0, 'Imported writing assistant is available');
        await page.evaluate((name) => window.jQuery('#character_search_bar').val(name).trigger('input'), name);
        await page.locator('#CharID' + index).waitFor({ state: 'attached' });
        return index;
    };
    const reopenChat = async () => {
        const index = await showFixture();
        await page.evaluate(async (index) => {
            const core = await import('/script.js');
            await core.selectCharacterById(index);
        }, index);
        await page
            .waitForFunction((avatar) => {
                const c = window.SillyTavern.getContext();
                return (
                    c.characters[c.characterId]?.avatar === avatar &&
                    c.chat.length === 3 &&
                    c.chat[1]?.mes.includes('小助手生成角色')
                );
            }, avatar)
            .catch(async (error) => {
                console.error(
                    'Reopen fixture state:',
                    await page.evaluate(() => {
                        const c = window.SillyTavern.getContext();
                        return {
                            avatar: c.characters[c.characterId]?.avatar,
                            floors: c.chat.length,
                            types: c.chat.map((message) => !!message.is_user),
                            hasExpectedPrompt: c.chat[1]?.mes.includes('小助手生成角色'),
                            swipes: c.chat[2]?.swipes?.length,
                            batch: c.extensionSettings['novel-auto-generator'].roleBatch?.items.map((item) => ({
                                name: item.name,
                                processed: item.processed,
                                failed: item.failed,
                            })),
                            notices: document.querySelector('#toast-container')?.textContent,
                        };
                    }),
                );
                throw error;
            });
    };
    await page.locator('#CharID' + (await showFixture())).dispatchEvent('click');
    await page.waitForFunction(() => SillyTavern.getContext().chat.length > 0);
    await page
        .waitForFunction(() => document.getElementById('nag-set-mode'))
        .catch((error) => {
            console.error(JSON.stringify({ initializationErrors: errors }));
            throw error;
        });
    initializing = false;
    await page.locator('#main_api').selectOption('openai', { force: true });
    await page.locator('#chat_completion_source').selectOption('custom', { force: true });
    await page.locator('#custom_api_url_text').fill('http://127.0.0.1:18080/v1', { force: true });
    await page.locator('#custom_api_url_text').dispatchEvent('input');
    await page.locator('#custom_model_id').fill('fixture-model', { force: true });
    await page.locator('#custom_model_id').dispatchEvent('input');
    await page.locator('#api_button_openai').dispatchEvent('click');
    await page.locator('#stream_toggle').check({ force: true });
    await page.evaluate(async () => {
        const c = SillyTavern.getContext();
        const message = {
            is_user: true,
            name: c.name1,
            mes: '小助手生成角色：[[角色名]]。名字为[[角色名]]。',
            extra: {},
        };
        c.chat.push(message);
        c.addOneMessage(message);
        await c.saveChat();
        const mode = document.getElementById('nag-set-mode');
        mode.value = 'role-batch';
        mode.dispatchEvent(new Event('change'));
        for (const [id, value] of Object.entries({
            'nag-set-total': '3',
            'nag-set-prompt': '角色甲\n角色乙\n角色丙',
            'nag-set-reply-wait': '1',
        })) {
            const node = document.getElementById(id);
            node.value = value;
            if (id === 'nag-set-prompt') node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });
    // Each run starts with ordinary rendering; the isolation matrix enables its own switch.
    await page.evaluate(async () => {
        const toggle = window.jQuery('#nag-set-isolate-result');
        if (toggle.prop('checked')) {
            toggle.prop('checked', false);
            await toggle.triggerHandler('change');
        }
    });
    await restartBatch();
    // A previous manual stop must not leave the next generation using an aborted core controller.
    await page.locator('#nag-btn-clear-errors').dispatchEvent('click');
    if (process.env.SMOKE_WORKBENCH === '1') {
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ passed: true, host: 'SillyTavern', requests: requests.length }));
        await browser.close();
        process.exit(0);
    }
    await page.evaluate(() => window.SillyTavern.getContext().stopGeneration());
    await startAndWait().catch(async (error) => {
        console.error(
            await page.evaluate(() => ({
                progress: document.getElementById('nag-progress-text').textContent,
                statuses: document.getElementById('nag-role-results').textContent,
                notices: document.querySelector('#toast-container')?.textContent,
            })),
        );
        throw error;
    });
    const result = await page.evaluate(() => {
        const c = SillyTavern.getContext();
        return {
            floors: c.chat.length,
            prompt: c.chat[1].mes,
            replies: c.chat[2].swipes,
            ui: document.getElementById('nag-role-results').textContent,
        };
    });
    assert.equal(requests.length, 3);
    assert.equal(requestPages[1].swipe, 1);
    assert.ok(requestPages[1].counter?.startsWith('2/'), JSON.stringify(requestPages));
    assert.equal(result.floors, 3);
    assert.equal(result.replies.length, 3);
    assert.equal(result.prompt, '小助手生成角色：[[角色名]]。名字为[[角色名]]。');
    assert.ok(result.ui.includes('✅'));
    ['角色甲', '角色乙', '角色丙'].forEach((name, i) => {
        const prompt = JSON.stringify(requests[i].messages);
        assert.ok(prompt.includes(name));
        assert.ok(prompt.includes('CARD_FORMAT_SENTINEL'));
        assert.ok(prompt.includes('WORLD_FORMAT_SENTINEL'));
        assert.ok(!prompt.includes('ROLE_RESULT_'));
        assert.ok(result.replies[i].includes(`ROLE_RESULT_${i + 1}`));
    });
    if (process.env.SMOKE_ISOLATION_ONLY === '1') {
        const isolation = await runRoleIsolationChecks({
            page,
            requests,
            reopenChat,
            connect,
            restartBatch,
            setFrontendReply: (value) => {
                frontendReply = value;
            },
        });
        console.log(JSON.stringify({ passed: true, host: 'SillyTavern', isolation, requests: requests.length }));
        await browser.close();
        process.exit(0);
    }
    if (process.env.SMOKE_ARCHIVE_ONLY === '1') {
        await page.locator('#nag-role-correction-toggle').dispatchEvent('click');
        await page
            .locator('#nag-role-results .nag-role-status-set[data-index="0"][data-status="failed"]')
            .dispatchEvent('click');
        await page.waitForFunction(() => {
            const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
            return (
                settings.roleBatch?.items[0]?.manualStatus === 'failed' &&
                settings.roleBatch.items[0].failed &&
                !settings.roleArchive.includes('角色甲') &&
                !settings.isRunning
            );
        });
        assert.ok((await page.locator('#nag-role-results').textContent()).includes('❌'));
        await startAndWait();
        assert.equal(requests.length, 4, 'Manual failure retries despite the old archive entry');
        assert.equal(
            await page.evaluate(() => {
                const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
                const item = settings.roleBatch.items[0];
                return (
                    item.processed &&
                    !item.failed &&
                    item.manualStatus === null &&
                    settings.roleArchive.includes('角色甲')
                );
            }),
            true,
        );

        const archiveIndex = await page.evaluate(() =>
            window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleArchive.indexOf('角色甲'),
        );
        await page
            .locator(`#nag-archive-list .nag-archive-remove[data-index="${archiveIndex}"]`)
            .dispatchEvent('click');
        await page.waitForFunction(() => {
            const item = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleBatch.items[0];
            return item.processed === false && item.failed === false && item.manualStatus === null && !item.archived;
        });
        assert.ok(
            (await page.locator('#nag-role-results').locator('.ttw-memory-item').nth(0).textContent()).includes('⏳'),
        );
        const repliesBeforeDeleteRetry = await page.evaluate(() => ({
            floors: window.SillyTavern.getContext().chat.length,
            swipes: [...window.SillyTavern.getContext().chat[2].swipes],
        }));
        await startAndWait();
        assert.equal(requests.length, 5, 'Deleting a generated name requeues it without removing its old reply');
        const repliesAfterDeleteRetry = await page.evaluate(() => ({
            floors: window.SillyTavern.getContext().chat.length,
            swipes: window.SillyTavern.getContext().chat[2].swipes,
        }));
        assert.equal(repliesAfterDeleteRetry.floors, repliesBeforeDeleteRetry.floors);
        assert.equal(repliesAfterDeleteRetry.swipes.length, repliesBeforeDeleteRetry.swipes.length + 1);
        assert.deepEqual(
            repliesAfterDeleteRetry.swipes.slice(0, repliesBeforeDeleteRetry.swipes.length),
            repliesBeforeDeleteRetry.swipes,
        );

        const chatBeforeClear = await page.evaluate(() => ({
            floors: window.SillyTavern.getContext().chat.length,
            swipes: [...window.SillyTavern.getContext().chat[2].swipes],
        }));
        await page.locator('#nag-btn-archive-clear').dispatchEvent('click');
        const cancelDialog = page.locator('dialog[open]').filter({ hasText: '清空已完成角色名录' }).last();
        await cancelDialog.waitFor();
        assert.ok((await cancelDialog.textContent()).includes('已生成的角色会改为待生成，不会删除角色卡或回复'));
        const beforeCancel = await page.evaluate(() => {
            const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
            return { archive: [...settings.roleArchive], items: structuredClone(settings.roleBatch.items) };
        });
        await cancelDialog.locator('.popup-button-cancel').dispatchEvent('click');
        await page.waitForFunction(() => !document.querySelector('dialog[open]'));
        assert.deepEqual(
            await page.evaluate(() => {
                const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
                return { archive: settings.roleArchive, items: settings.roleBatch.items };
            }),
            beforeCancel,
        );
        await page.locator('#nag-btn-archive-clear').dispatchEvent('click');
        const confirmDialog = page.locator('dialog[open]').filter({ hasText: '清空已完成角色名录' }).last();
        await confirmDialog.waitFor();
        await confirmDialog.locator('.popup-button-ok').dispatchEvent('click');
        await page.waitForFunction(() => {
            const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
            return (
                settings.roleArchive.length === 0 &&
                settings.roleBatch.items.every(
                    (item) => item.processed === false && item.failed === false && item.manualStatus === null,
                )
            );
        });
        assert.deepEqual(
            await page.evaluate(() => ({
                floors: window.SillyTavern.getContext().chat.length,
                swipes: window.SillyTavern.getContext().chat[2].swipes,
            })),
            chatBeforeClear,
            'Clearing the archive changes task state only',
        );
        await startAndWait();
        assert.equal(requests.length, 8, 'Clearing the archive reruns every linked completed role');

        const setRoster = (names) =>
            page.evaluate((names) => {
                const prompt = document.getElementById('nag-set-prompt');
                prompt.value = names.join('\n');
                prompt.dispatchEvent(new Event('input', { bubbles: true }));
                prompt.dispatchEvent(new Event('change', { bubbles: true }));
            }, names);
        await page
            .locator('#nag-role-results .nag-role-status-set[data-index="0"][data-status="failed"]')
            .dispatchEvent('click');
        await page.waitForFunction(() => {
            const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
            return settings.roleBatch.items[0].manualStatus === 'failed' && !settings.roleArchive.includes('角色甲');
        });
        await setRoster(['角色甲', '角色乙', '角色丙', '名录跳过']);
        await page.waitForFunction(() =>
            window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleBatch.names.includes(
                '名录跳过',
            ),
        );
        await page.evaluate(() => {
            const input = document.getElementById('nag-archive-input');
            input.value = '角色甲\n名录跳过';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.locator('#nag-btn-archive-add').dispatchEvent('click');
        await page.waitForFunction(() => {
            const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
            return settings.roleArchive.includes('角色甲') && settings.roleArchive.includes('名录跳过');
        });
        assert.equal(
            await page.evaluate(() => {
                const item =
                    window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleBatch.items[0];
                return item.manualStatus === 'failed' && item.failed;
            }),
            true,
            'Adding an archive match cannot override a manual failure',
        );
        await startAndWait();
        assert.equal(
            requests.length,
            9,
            'Start retries the manual failure and skips only the unprocessed archive item',
        );
        const finalItems = await page.evaluate(
            () => window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleBatch.items,
        );
        assert.equal(finalItems[0].manualStatus, null);
        assert.equal(finalItems[3].archived, true);
        assert.equal(finalItems[3].processed, true);
        assert.ok(!JSON.stringify(requests.at(-1).messages).includes('名录跳过'));
        assert.deepEqual(errors, []);
        console.log(
            JSON.stringify({ passed: true, host: 'SillyTavern', archiveWorkflow: true, requests: requests.length }),
        );
        await browser.close();
        process.exit(0);
    }
    emptyReplies = true;
    await restartBatch();
    await page.evaluate(() => {
        for (const [id, value] of Object.entries({
            'nag-set-prompt': '无响应角色\n不会执行的角色',
            'nag-set-total': '2',
        })) {
            const node = document.getElementById(id);
            node.value = value;
            if (id === 'nag-set-prompt') node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });
    await startAndWait();
    const failure = await page.evaluate(
        () => window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleBatch,
    );
    assert.equal(requests.length, 6, 'Exactly three empty attempts, no request for the next name');
    assert.equal(failure.index, 0);
    assert.notEqual(failure.items[1]?.processed, true);
    assert.equal(
        await page.evaluate(() => window.SillyTavern.getContext().chat[2].swipes.length),
        3,
        'Empty attempts must not accumulate candidate pages',
    );
    emptyReplies = false;
    streamError = true;
    await restartBatch();
    await startAndWait();
    const streamFailure = await page.evaluate(
        () => window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleBatch,
    );
    assert.equal(streamFailure.index, 0, 'A swallowed streaming error must not count as a generated character');
    assert.equal(streamFailure.items[0].failed, true);
    assert.notEqual(streamFailure.items[1]?.processed, true);
    assert.equal(requests.length, 9, 'Three streaming failures must stop without processing the next name');
    const afterFailure = await page.evaluate(() => ({
        prompt: window.SillyTavern.getContext().chat[1].mes,
        replies: window.SillyTavern.getContext().chat[2].swipes,
    }));
    assert.deepEqual(afterFailure.replies, result.replies, 'Failed retries must preserve all completed pages');
    assert.equal(afterFailure.prompt, result.prompt);
    const errorRecords = await page.evaluate(
        () => window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].errorLog,
    );
    assert.equal(errorRecords.length, 6, 'Only the six failed attempts are recorded');
    assert.ok(errorRecords.every((entry) => entry.phase && entry.attempt && entry.roleIndex === 1));
    assert.ok(!JSON.stringify(errorRecords).includes('ROLE_RESULT_'));
    const downloaded = page.waitForEvent('download');
    await page.locator('#nag-btn-error-log').dispatchEvent('click');
    const download = await downloaded;
    const downloadedLog = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(downloadedLog.errors.length, 6);
    assert.equal(
        downloadedLog.pluginVersion,
        JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')).version,
    );
    streamError = false;
    await restartBatch();
    holdResponse = true;
    const held = new Promise((resolve) => {
        onHeld = resolve;
    });
    await page.evaluate(() => document.getElementById('nag-btn-start').click());
    await Promise.race([
        held,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Stop-test request did not start')), 15000)),
    ]);
    await page.locator('#mes_stop').dispatchEvent('click');
    holdResponse = false;
    releaseResponse();
    await page.waitForFunction(
        () => !window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].isRunning,
    );
    await page.waitForFunction(
        () => {
            const stop = document.querySelector('#mes_stop');
            return !stop || getComputedStyle(stop).display === 'none';
        },
        null,
        { timeout: 30000 },
    );
    // Restart clears the uncertain stopped request without reconciling its aborted candidate.
    await restartBatch();
    await page.evaluate(() => {
        for (const [id, value] of Object.entries({ 'nag-set-total': '1', 'nag-set-prompt': '停止后重新开始' })) {
            const element = document.getElementById(id);
            element.value = value;
            if (id === 'nag-set-prompt') element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });
    await startAndWait();
    const restarted = await page.evaluate(
        () => window.SillyTavern.getContext().extensionSettings['novel-auto-generator'],
    );
    assert.equal(restarted.roleBatch.index, 1, 'Manual stop, reset and start must dispatch a fresh request');
    assert.equal(requests.length, 11);
    assert.ok(JSON.stringify(requests[10].messages).includes('停止后重新开始'));
    const restartedReplies = await page.evaluate(() => window.SillyTavern.getContext().chat[2].swipes);
    assert.deepEqual(restartedReplies.slice(0, 3), result.replies);
    assert.ok(restartedReplies.at(-1).includes('ROLE_RESULT_11'));
    assert.equal(restarted.errorLog.length, 6, 'Manual stopping and successful restarting are not errors');
    // Error logs use the host's ordinary settings save; task recovery below deliberately does not wait for it.
    await page.evaluate(async () => {
        const core = await import('/script.js');
        await core.saveSettings();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('nag-btn-error-log'));
    assert.equal(
        await page.evaluate(
            () => window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].errorLog.length,
        ),
        6,
    );
    // Resume from the same journal after a tab is reloaded in the middle of a request.
    await reopenChat();
    await connect();
    const initialRecovery = await page.evaluate(() => {
        const c = window.SillyTavern.getContext();
        return {
            batch: c.extensionSettings['novel-auto-generator'].roleBatch,
            pages: c.chat[2]?.swipe_info?.map((info) => info?.extra?.nag_role_batch),
        };
    });
    const setNames = (names) =>
        page.evaluate((names) => {
            for (const [id, value] of Object.entries({
                'nag-set-total': String(names.length),
                'nag-set-prompt': names.join('\n'),
            })) {
                const element = document.getElementById(id);
                element.value = value;
                if (id === 'nag-set-prompt') element.dispatchEvent(new Event('input', { bubbles: true }));
                element.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, names);
    await resetKeep();
    await startAndWait();
    assert.equal(requests.length, 11, JSON.stringify({ initialRecovery, saves: saves.slice(-8) }));
    await restartBatch();
    await setNames(['恢复甲', '恢复乙', '恢复丙']);
    holdRole = '恢复乙';
    const interrupted = new Promise((resolve) => {
        onHeld = resolve;
    });
    await page.evaluate(() => document.getElementById('nag-btn-start').click());
    let interruptedTimer;
    try {
        await Promise.race([
            interrupted,
            new Promise((_, reject) => {
                interruptedTimer = setTimeout(
                    () => reject(new Error('Recovery interruption request did not start')),
                    20000,
                );
            }),
        ]);
    } catch (error) {
        console.error(
            'Recovery interruption state:',
            await page.evaluate(() => {
                const c = window.SillyTavern.getContext();
                const s = c.extensionSettings['novel-auto-generator'];
                return {
                    connected: c.onlineStatus,
                    mode: s.generationMode,
                    names: s.roleNames,
                    batch: s.roleBatch,
                    running: s.isRunning,
                    prompt: c.chat.at(-2)?.mes,
                    errors: s.errorLog,
                    notices: document.querySelector('#toast-container')?.textContent,
                };
            }),
        );
        throw error;
    } finally {
        clearTimeout(interruptedTimer);
    }
    const taskId = await page.evaluate(
        () => window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleBatch.id,
    );
    const recoverySnapshot = () =>
        page.evaluate(() => {
            const c = window.SillyTavern.getContext();
            return {
                items: c.extensionSettings['novel-auto-generator'].roleBatch.items,
                pages: c.chat[2]?.swipe_info?.map((info) => info?.extra?.nag_role_batch),
            };
        });
    const beforeReload = await recoverySnapshot();
    const navigation = page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() });
    const reload = page.reload({ waitUntil: 'domcontentloaded' });
    await navigation;
    holdRole = null;
    releaseResponse();
    await reload;
    await page.waitForFunction(() => document.getElementById('nag-btn-start'));
    await reopenChat();
    await connect();
    assert.equal(requests.length, 13, 'Reopening restores state without automatically starting the model');
    assert.equal(
        await page.evaluate(
            () => window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleBatch.id,
        ),
        taskId,
    );
    const afterReload = await recoverySnapshot();
    assert.ok(
        afterReload.pages?.some(
            (receipt) =>
                receipt?.taskId === taskId &&
                receipt.itemId === afterReload.items[0].id &&
                receipt.status === 'complete',
        ),
        JSON.stringify({ beforeReload, afterReload }),
    );
    await startAndWait();
    assert.equal(
        requests.length,
        15,
        JSON.stringify({ beforeReload, afterReload, prompts: requests.slice(13).map((r) => r.messages.at(-1)) }),
    );
    assert.ok(JSON.stringify(requests[13].messages).includes('恢复乙'));
    assert.ok(JSON.stringify(requests[14].messages).includes('恢复丙'));
    // Emulate a crash after native chat save but before the task's completion checkpoint.
    await page.evaluate(() => {
        const key = 'novel-auto-generator:role-batch:v1';
        const batch = JSON.parse(localStorage.getItem(key));
        batch.items.forEach((item) => {
            item.processed = false;
        });
        batch.index = 0;
        batch.pending = true;
        batch.revision += 100;
        batch.updatedAt = Date.now();
        batch.dispatch = { itemId: batch.items[0].id, attemptId: 'lost-checkpoint' };
        localStorage.setItem(key, JSON.stringify(batch));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('nag-btn-start'));
    await reopenChat();
    await connect();
    await startAndWait();
    assert.equal(requests.length, 15, 'Saved completion receipts prevent duplicate requests when progress is stale');
    await setNames(['恢复丙', '恢复丁', '恢复甲']);
    const editedRows = await page.locator('#nag-role-results .ttw-memory-item').allTextContents();
    assert.equal(editedRows.length, 3);
    assert.ok(editedRows[0].includes('恢复丙') && editedRows[0].includes('✅'));
    assert.ok(editedRows[1].includes('恢复丁') && !editedRows[1].includes('✅'));
    assert.ok(editedRows[2].includes('恢复甲') && editedRows[2].includes('✅'));
    assert.ok(editedRows.every((row) => !row.includes('恢复乙')));
    assert.ok((await page.locator('#nag-progress-text').textContent()).startsWith('2 / 3'));
    await startAndWait();
    assert.equal(requests.length, 16);
    assert.ok(JSON.stringify(requests[15].messages).includes('恢复丁'));
    await setNames(['恢复乙', '恢复丙', '恢复丁', '恢复甲']);
    await startAndWait();
    assert.equal(requests.length, 16, 'Re-adding an already completed role reuses its task record');
    await restartBatch();
    await setNames(['恢复甲', '恢复乙', '恢复丙']);
    await startAndWait();
    assert.equal(requests.length, 19, 'Only an explicit confirmed restart regenerates all roles');
    await page.locator('#nag-role-correction-toggle').dispatchEvent('click');
    await page
        .locator('#nag-role-results .nag-role-status-set[data-index="0"][data-status="failed"]')
        .dispatchEvent('click');
    await page.waitForFunction(() => {
        const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
        const item = settings.roleBatch?.items.find((entry) => entry.name === '恢复甲');
        return (
            item?.manualStatus === 'failed' &&
            item.failed &&
            !settings.roleArchive.includes('恢复甲') &&
            !settings.isRunning
        );
    });
    assert.equal(
        await page.evaluate(() =>
            window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleArchive.includes('恢复甲'),
        ),
        false,
        'A manual failure removes the matching archive name',
    );
    assert.ok((await page.locator('#nag-role-results').textContent()).includes('❌'));
    await startAndWait();
    assert.equal(requests.length, 20, 'A manual failure overrides the matching archive entry and retries');
    assert.ok(
        await page.evaluate(() => {
            const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
            return settings.roleBatch.items.find((entry) => entry.name === '恢复甲')?.manualStatus === null;
        }),
    );
    const archivedIndex = await page.evaluate(() =>
        window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleArchive.indexOf('恢复甲'),
    );
    assert.ok(archivedIndex >= 0, 'The generated role is present in the completed-role archive');
    await page.locator(`#nag-archive-list .nag-archive-remove[data-index="${archivedIndex}"]`).dispatchEvent('click');
    await page.waitForFunction(() => {
        const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
        const item = settings.roleBatch?.items.find((entry) => entry.name === '恢复甲');
        return (
            item?.processed === false &&
            item.failed === false &&
            item.manualStatus === null &&
            !item.archived &&
            !settings.roleArchive.includes('恢复甲') &&
            !settings.isRunning
        );
    });
    assert.equal(
        await page.evaluate(() =>
            window.SillyTavern.getContext().extensionSettings['novel-auto-generator'].roleArchive.includes('恢复甲'),
        ),
        false,
    );
    assert.ok((await page.locator('#nag-role-results').textContent()).includes('⏳'));
    await startAndWait();
    assert.equal(requests.length, 21, 'Deleting an archive entry updates status and requeues its role');
    const chatBeforeArchiveClear = await page.evaluate(() => {
        const message = window.SillyTavern.getContext().chat[2];
        return { floors: window.SillyTavern.getContext().chat.length, swipes: message?.swipes?.length };
    });
    await page.locator('#nag-btn-archive-clear').dispatchEvent('click');
    const clearDialog = page.locator('dialog[open]').filter({ hasText: '清空已完成角色名录' }).last();
    await clearDialog.waitFor();
    const clearPrompt = await clearDialog.textContent();
    assert.ok(clearPrompt.includes('已生成的角色会改为待生成，不会删除角色卡或回复'), clearPrompt);
    const archiveBeforeCancel = await page.evaluate(() => {
        const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
        return { archive: [...settings.roleArchive], items: structuredClone(settings.roleBatch.items) };
    });
    await clearDialog.locator('.popup-button-cancel').dispatchEvent('click');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.deepEqual(
        await page.evaluate(() => {
            const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
            return { archive: settings.roleArchive, items: settings.roleBatch.items };
        }),
        archiveBeforeCancel,
        'Cancelling archive clear changes no archive or task status',
    );
    await page.locator('#nag-btn-archive-clear').dispatchEvent('click');
    const confirmedClearDialog = page.locator('dialog[open]').filter({ hasText: '清空已完成角色名录' }).last();
    await confirmedClearDialog.waitFor();
    await confirmedClearDialog.locator('.popup-button-ok').dispatchEvent('click');
    await page.waitForFunction(() => {
        const settings = window.SillyTavern.getContext().extensionSettings['novel-auto-generator'];
        return (
            settings.roleArchive.length === 0 &&
            settings.roleBatch?.items.every(
                (item) =>
                    item.processed === false && item.failed === false && item.manualStatus === null && !item.archived,
            )
        );
    });
    const chatAfterArchiveClear = await page.evaluate(() => {
        const message = window.SillyTavern.getContext().chat[2];
        return { floors: window.SillyTavern.getContext().chat.length, swipes: message?.swipes?.length };
    });
    assert.deepEqual(chatAfterArchiveClear, chatBeforeArchiveClear, 'Clearing the archive leaves chat replies intact');
    await startAndWait();
    assert.equal(requests.length, 24, 'Clearing the archive requeues all completed roles in the linked batch');
    assert.deepEqual(errors, []);
    const isolation =
        process.env.SMOKE_ISOLATION === '1'
            ? await runRoleIsolationChecks({
                  page,
                  requests,
                  reopenChat,
                  connect,
                  restartBatch,
                  setFrontendReply: (value) => {
                      frontendReply = value;
                  },
              })
            : null;
    console.log(
        JSON.stringify({
            passed: true,
            host: 'SillyTavern',
            requests: requests.length,
            floors: result.floors,
            swipes: result.replies.length,
            cardAndWorldbookPreserved: true,
            previousResultsExcluded: true,
            emptyReplyAttempts: 3,
            streamFailureAttempts: 3,
            manualStopRestart: true,
            nativeSwipeCounterVerified: true,
            errorLogDownload: true,
            reloadResume: true,
            staleProgressReconciled: true,
            editedNamesPreserveCompleted: true,
            manualFailureRequeued: true,
            archiveDeletionRequeued: true,
            archiveClearRequeuedWithoutDeletingReplies: true,
            isolation,
            model: 'intercepted synthetic responses; no paid model calls',
        }),
    );
} finally {
    await browser.close();
}

import { afterEach, expect, it, vi } from 'vitest';
import { createRoleBatchRunner, parseRoleNames } from '../../src/novel/roleBatch.js';
import {
    applyArchiveSkips,
    applyRoleArchiveChanges,
    countUnidentifiedRolePages,
    dedupeRoleArchive,
    duplicateRoleNames,
    mergeRoleArchive,
    normalizeRoleArchive,
    removeRoleArchiveName,
    removeRoleArchiveMatches,
    resolveRoleStatus,
    unidentifiedRolePageSignature,
} from '../../src/novel/roleBatchState.js';

afterEach(() => vi.useRealTimers());

it('detects duplicate full names without merging works, variants or case', () => {
    const names = ' 碧蓝航线·俾斯麦 \n碧蓝航线·俾斯麦Zwei\n其他作品·俾斯麦\n碧蓝航线·俾斯麦\n碧蓝航线·俾斯麦zwei';
    expect(duplicateRoleNames(names)).toEqual(['碧蓝航线·俾斯麦']);
    expect(parseRoleNames(names)).toEqual([
        '碧蓝航线·俾斯麦',
        '碧蓝航线·俾斯麦Zwei',
        '其他作品·俾斯麦',
        '碧蓝航线·俾斯麦zwei',
    ]);
});

it('reports old pages without a reliable role binding and ignores pending preview pages', () => {
    const batch = { id: 'b', items: [{ id: 'a', name: '碧蓝航线·俾斯麦', swipe: 0 }], history: [] };
    const message = {
        swipes: ['已生成', '身份未知', '候选中'],
        swipe_info: [
            { extra: { nag_role_batch: { taskId: 'b', itemId: 'a', status: 'complete' } } },
            {},
            { extra: { nag_role_batch: { taskId: 'b', itemId: 'a', previewId: 'p' } } },
        ],
    };
    expect(countUnidentifiedRolePages(batch, message)).toBe(1);
    expect(countUnidentifiedRolePages(null, message)).toBe(2);
    expect(countUnidentifiedRolePages(null, { mes: '未建立备选页的旧回复' })).toBe(1);
});

it('does not report abandoned retry pages that still name a current role', () => {
    const batch = {
        id: 'b',
        items: [{ id: 'a', name: '碧蓝航线·俾斯麦', swipe: 2, processed: true }],
        history: [],
    };
    const message = {
        swipes: ['第一次尝试（半截）', '...', '成品'],
        swipe_info: [
            { extra: { nag_role_batch: { taskId: 'b', itemId: 'a', status: 'invalid' } } },
            {},
            { extra: { nag_role_batch: { taskId: 'b', itemId: 'a', status: 'complete' } } },
        ],
    };
    expect(countUnidentifiedRolePages(batch, message)).toBe(0);
    // A receipt from another batch, or naming a removed role, still needs manual review.
    message.swipe_info[0].extra.nag_role_batch.taskId = 'old-batch';
    expect(countUnidentifiedRolePages(batch, message)).toBe(1);
    message.swipe_info[0].extra.nag_role_batch.taskId = 'b';
    message.swipe_info[0].extra.nag_role_batch.itemId = 'missing';
    expect(countUnidentifiedRolePages(batch, message)).toBe(1);
});

it('fingerprints unresolved pages by content so reviewed pages are not asked twice', () => {
    const batch = { id: 'b', items: [{ id: 'a', name: '甲', swipe: 0 }], history: [] };
    const message = {
        swipes: ['甲的正文', '未知一', '未知二'],
        swipe_info: [{ extra: { nag_role_batch: { taskId: 'b', itemId: 'a' } } }, {}, {}],
    };
    const before = unidentifiedRolePageSignature(batch, message);
    expect(before).toBeTruthy();
    // Deleting an unrelated known page keeps the fingerprint stable.
    message.swipes.splice(0, 1);
    message.swipe_info.splice(0, 1);
    expect(unidentifiedRolePageSignature(batch, message)).toBe(before);
    // A different unresolved page changes the fingerprint.
    message.swipes.push('未知三');
    message.swipe_info.push({});
    expect(unidentifiedRolePageSignature(batch, message)).not.toBe(before);
    expect(unidentifiedRolePageSignature(batch, {})).toBe('');
});

it('recognizes 1000 recorded role pages without treating distinct names as duplicates', () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: `id${i}`, name: `作品·角色${i}`, swipe: i }));
    const batch = { id: 'batch', items, history: [] };
    const message = {
        swipes: items.map((item) => `正文 ${item.name}`),
        swipe_info: items.map((item) => ({ extra: { nag_role_batch: { taskId: 'batch', itemId: item.id } } })),
    };
    expect(countUnidentifiedRolePages(batch, message)).toBe(0);
    expect(duplicateRoleNames(items.map((item) => item.name).join('\n'))).toEqual([]);
    message.swipe_info[500] = {};
    expect(countUnidentifiedRolePages(batch, message)).toBe(1);
});

it('does not generate if the user declines to continue past unidentified old pages', async () => {
    const { host, runner, settings } = setup();
    host.confirmUnidentifiedRolePages = vi.fn(async () => false);
    await runner.start();
    expect(host.confirmUnidentifiedRolePages).toHaveBeenCalledOnce();
    expect(host.generateRoleReply).not.toHaveBeenCalled();
    expect(settings.isRunning).toBe(false);
});
it('marks the first batch after a confirmed restart as reviewed, only once', async () => {
    const { host, runner, settings } = setup();
    const seen = [];
    host.confirmUnidentifiedRolePages = vi.fn(async (batch) => {
        seen.push(!!batch.restartReviewed);
        return false;
    });
    await runner.start();
    await runner.resetPending({ restart: true });
    await runner.start();
    expect(settings.roleBatch.restartReviewed).toBe(true);
    await runner.resetPending();
    settings.roleBatch = null;
    await runner.start();
    expect(seen).toEqual([false, true, false]);
});

function setup(replies = [{ text: '结果' }]) {
    const settings = { roleNames: '琴\n安柏\n丽莎', totalChapters: 3, replyWaitTime: 0, roleBatch: null };
    const snapshot = { identity: 'chat-a', generating: false };
    let index = 0;
    const host = {
        snapshot: () => snapshot,
        prepareRoleBatch: () => ({ promptFloor: 1, resultFloor: 2, template: '生成 [[角色名]]，名字为 [[角色名]]' }),
        generateRoleReply: vi.fn(async () => {
            const result = replies[Math.min(index++, replies.length - 1)];
            if (result instanceof Error) throw result;
            return result;
        }),
        restoreRoleTemplate: vi.fn(async () => {}),
    };
    const notify = vi.fn();
    const archived = vi.fn();
    const runner = createRoleBatchRunner({
        getSettings: () => settings,
        host,
        notify,
        onChange: vi.fn(),
        onStats: vi.fn(),
        onRoleComplete: archived,
    });
    return { settings, host, snapshot, runner, notify, archived };
}

it('normalizes the finished-role archive by trimmed unique names', () => {
    expect(normalizeRoleArchive([' 琴 ', '琴', '', '安柏', null, { name: ' 丽莎 ' }])).toEqual(['琴', '安柏', '丽莎']);
    expect(normalizeRoleArchive('nope')).toEqual([]);
    expect(mergeRoleArchive(['琴'], ['安柏', ' 琴 ', ''])).toEqual(['琴', '安柏']);
    expect(removeRoleArchiveName(['琴', '安柏'], ' 琴 ')).toEqual(['安柏']);
    expect(removeRoleArchiveName(undefined, '琴')).toEqual([]);
});

it('resolves manual, batch, archive and queued state in the same precedence order', () => {
    expect(resolveRoleStatus({ manualStatus: 'failed', processed: true, failed: false }, true)).toMatchObject({
        status: 'failed',
        complete: false,
        manual: true,
        archived: false,
    });
    expect(resolveRoleStatus({ processed: true, failed: true }, true)).toMatchObject({
        status: 'failed',
        complete: false,
        source: 'batch',
    });
    expect(resolveRoleStatus({ processed: true, failed: false }, true)).toMatchObject({
        status: 'complete',
        complete: true,
        source: 'batch',
    });
    expect(resolveRoleStatus({ processed: false, failed: false }, true)).toMatchObject({
        status: 'complete',
        complete: true,
        archived: true,
        source: 'archive',
    });
    expect(resolveRoleStatus({})).toMatchObject({ status: 'queued', complete: false, source: 'queue' });
});

it('removes a manually failed archive role without deleting the same name from another work', () => {
    expect(
        removeRoleArchiveMatches(['最终幻想7·蒂法', '最终幻想8·蒂法'], '最终幻想7·蒂法', ['最终幻想7', '最终幻想8']),
    ).toEqual(['最终幻想8·蒂法']);
});

it('stores a role once even when it is written with and without the work name', () => {
    // 收录时也按「同一个角色」判断，避免名录里出现两条
    expect(mergeRoleArchive(['南达科他'], ['碧蓝航线·南达科他'], ['碧蓝航线'])).toEqual(['南达科他']);
    expect(mergeRoleArchive(['碧蓝航线·南达科他'], ['南达科他'], ['碧蓝航线'])).toEqual(['碧蓝航线·南达科他']);
    // 不同作品里的同名角色仍然各记一条
    expect(mergeRoleArchive(['最终幻想7蒂法'], ['最终幻想8蒂法'], ['最终幻想7', '最终幻想8'])).toEqual([
        '最终幻想7蒂法',
        '最终幻想8蒂法',
    ]);
});

it('collapses an existing duplicate archive entry and keeps the name with the work prefix', () => {
    const archive = ['琴', '南达科他', '安柏', '碧蓝航线·南达科他'];
    expect(dedupeRoleArchive(archive, ['碧蓝航线'])).toEqual(['琴', '安柏', '碧蓝航线·南达科他']);
    // 没有作品名清单时判断不了前缀，保持原样
    expect(dedupeRoleArchive(archive, [])).toEqual(archive);
    // 同一角色名对应多个作品时不合并
    expect(dedupeRoleArchive(['最终幻想7蒂法', '最终幻想8蒂法'], ['最终幻想7', '最终幻想8'])).toEqual([
        '最终幻想7蒂法',
        '最终幻想8蒂法',
    ]);
});

it('marks archived names as finished and releases them once deleted from the archive', () => {
    const batch = {
        id: 'b',
        names: ['琴', '安柏'],
        items: [
            { id: 'a', name: '琴' },
            { id: 'b', name: '安柏' },
        ],
        history: [],
    };
    expect(applyArchiveSkips(batch, [' 琴 '])).toEqual(['琴']);
    expect(batch.items[0]).toMatchObject({ archived: true, processed: true, failed: false });
    expect(batch.index).toBe(1);
    expect(applyArchiveSkips(batch, [])).toEqual([]);
    expect(batch.items[0].archived).toBe(false);
    expect(batch.items[0]).toMatchObject({ processed: false, failed: false });
    expect(batch.items[0].manualStatus).toBeNull();
    expect(batch.index).toBe(0);
});

it('synchronizes archive edits with task status and requeues deleted roles', () => {
    const batch = {
        id: 'b',
        names: ['琴', '安柏'],
        index: 2,
        items: [
            { id: 'a', name: '琴', processed: true, failed: false },
            { id: 'b', name: '安柏', archived: true, processed: true, failed: false },
        ],
        history: [],
    };
    expect(applyRoleArchiveChanges(batch, ['琴', '安柏'], ['琴'])).toMatchObject({ added: [], removed: ['安柏'] });
    expect(batch.items[1]).toMatchObject({
        archived: false,
        processed: false,
        failed: false,
        manualStatus: null,
    });
    expect(batch.index).toBe(1);

    expect(applyRoleArchiveChanges(batch, ['琴'], ['琴', '安柏'])).toMatchObject({ added: ['安柏'], removed: [] });
    expect(batch.items[1]).toMatchObject({ archived: true, processed: true, failed: false, manualStatus: null });
    expect(batch.index).toBe(2);
});

it('does not let a manual failure be promoted by an unchanged archive during queue preparation', () => {
    const batch = {
        names: ['琴'],
        items: [{ id: 'a', name: '琴', processed: true, failed: true, manualStatus: 'failed' }],
        history: [],
    };
    expect(applyArchiveSkips(batch, ['琴'])).toEqual([]);
    expect(batch.items[0]).toMatchObject({ processed: true, failed: true, manualStatus: 'failed' });
    expect(batch.index).toBe(0);
});

it('clears stale archive metadata without replacing generated or manual failures', () => {
    const batch = {
        names: ['生成失败', '手动失败', '已生成'],
        items: [
            { id: 'a', name: '生成失败', archived: true, processed: true, failed: true },
            { id: 'b', name: '手动失败', archived: true, processed: true, failed: true, manualStatus: 'failed' },
            { id: 'c', name: '已生成', archived: true, processed: true, failed: false, swipe: 2 },
        ],
        history: [],
    };
    applyArchiveSkips(batch, []);
    expect(batch.items[0]).toMatchObject({ archived: false, processed: true, failed: true });
    expect(batch.items[1]).toMatchObject({ archived: false, processed: true, failed: true, manualStatus: 'failed' });
    expect(batch.items[2]).toMatchObject({ archived: false, processed: true, failed: false, swipe: 2 });
});

it('does not let adding an archive entry replace a manual or generated failure', () => {
    const batch = {
        names: ['手动失败', '生成失败', '排队'],
        items: [
            { id: 'a', name: '手动失败', processed: true, failed: true, manualStatus: 'failed' },
            { id: 'b', name: '生成失败', processed: true, failed: true },
            { id: 'c', name: '排队' },
        ],
        history: [],
    };
    applyRoleArchiveChanges(batch, [], ['手动失败', '生成失败', '排队']);
    expect(batch.items[0]).toMatchObject({ processed: true, failed: true, manualStatus: 'failed' });
    expect(batch.items[1]).toMatchObject({ processed: true, failed: true });
    expect(batch.items[2]).toMatchObject({ archived: true, processed: true, failed: false });
});

it('only archive-skips unprocessed roles, preserving generated failures and completions', () => {
    const batch = {
        names: ['甲', '乙', '丙'],
        items: [
            { id: 'a', name: '甲', processed: true, failed: true },
            { id: 'b', name: '乙', processed: true, failed: false },
            { id: 'c', name: '丙', processed: false, failed: false },
        ],
        history: [],
    };
    expect(applyArchiveSkips(batch, ['甲', '乙', '丙'])).toEqual(['丙']);
    expect(batch.items[0]).toMatchObject({ processed: true, failed: true });
    expect(batch.items[0].archived).not.toBe(true);
    expect(batch.items[1]).toMatchObject({ processed: true, failed: false });
    expect(batch.items[2]).toMatchObject({ processed: true, failed: false, archived: true });
});

it('treats a name written with and without the work name as the same archived role', () => {
    const batch = {
        id: 'b',
        names: ['约克城II'],
        items: [{ id: 'a', name: '约克城II' }],
        history: [],
    };
    // 名录里记的是「作品名·角色名」，名单只写了角色名
    expect(applyArchiveSkips(batch, ['碧蓝航线·约克城II'])).toEqual(['约克城II']);
    expect(batch.items[0]).toMatchObject({ archived: true, processed: true });
});

it('keeps the same character from different works apart in the archive', () => {
    const batch = {
        id: 'b',
        names: ['最终幻想8蒂法'],
        items: [{ id: 'a', name: '最终幻想8蒂法' }],
        history: [],
    };
    expect(applyArchiveSkips(batch, ['最终幻想7蒂法'])).toEqual([]);
});

it('uses the work name list when checking the archive', () => {
    const batch = {
        id: 'b',
        names: ['安比'],
        items: [{ id: 'a', name: '安比' }],
        history: [],
    };
    expect(applyArchiveSkips(batch, ['绝区零安比'], ['绝区零'])).toEqual(['安比']);
});

it('skips archived names without calling the model and records new completions', async () => {
    vi.useFakeTimers();
    const { settings, host, runner, archived } = setup();
    settings.roleNames = '琴\n安柏';
    settings.roleArchive = ['琴'];
    await vi.runAllTimersAsync();
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply.mock.calls.map((call) => call[1])).toEqual(['生成 安柏，名字为 安柏']);
    expect(settings.roleBatch.items[0]).toMatchObject({ name: '琴', archived: true, processed: true });
    expect(settings.roleBatch.index).toBe(2);
    expect(archived.mock.calls.map((call) => call[0])).toEqual(['安柏']);
});

it('substitutes all placeholders and runs each unique full name once with an automatic total', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup();
    settings.totalChapters = 1;
    settings.roleNames = ' 琴 \n\n琴\n安柏';
    await vi.runAllTimersAsync();
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply.mock.calls.map((call) => call[1])).toEqual([
        '生成 琴，名字为 琴',
        '生成 安柏，名字为 安柏',
    ]);
    expect(settings.roleBatch.index).toBe(2);
    expect(settings.totalChapters).toBe(2);
    expect(settings.roleBatch.items.every((item) => item.processed && !item.failed)).toBe(true);
    expect(host.restoreRoleTemplate).toHaveBeenCalledWith(settings.roleBatch);
    expect(parseRoleNames(' A\r\n\nB ')).toEqual(['A', 'B']);
});

it('stops at the shorter list and accepts short or unformatted text', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup([{ text: '短' }]);
    settings.roleNames = '琴';
    settings.totalChapters = 100;
    settings.minChapterLength = 10000;
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
    expect(settings.roleBatch.index).toBe(1);
});

it('skips an error immediately and advances to the next role', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup([new Error('network'), { text: '正文' }]);
    settings.roleNames = '琴\n安柏';
    settings.totalChapters = 2;
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply.mock.calls.map((call) => call[1])).toEqual([
        '生成 琴，名字为 琴',
        '生成 安柏，名字为 安柏',
    ]);
    expect(settings.roleBatch.index).toBe(2);
    expect(settings.roleBatch.items.map((item) => item.failed)).toEqual([true, false]);
});

it('reorders and parks waiting roles during a request without changing its identity', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup();
    let finish;
    host.generateRoleReply.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const task = runner.start();
    await vi.advanceTimersByTimeAsync(1);
    const [first, second, third] = settings.roleBatch.items;
    expect(settings.roleBatch.dispatch.itemId).toBe(first.id);
    runner.editQueue('top', third.id);
    runner.editQueue('park', second.id);
    expect(settings.roleBatch.dispatch.itemId).toBe(first.id);
    finish({ text: '正文', swipe: 0 });
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply.mock.calls.map((call) => call[1])).toEqual([
        '生成 琴，名字为 琴',
        '生成 丽莎，名字为 丽莎',
    ]);
    expect(settings.roleBatch.items.find((item) => item.id === second.id).parked).toBe(true);
    runner.editQueue('restore', second.id);
    const next = runner.start();
    await vi.runAllTimersAsync();
    await next;
    expect(host.generateRoleReply.mock.calls.at(-1)[1]).toBe('生成 安柏，名字为 安柏');
});

it('restores a parked earlier role to the end while another role is generating', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup();
    let finish;
    host.generateRoleReply.mockImplementationOnce(async () => {
        runner.editQueue('park', settings.roleBatch.items[1].id);
        return { text: '正文' };
    });
    host.generateRoleReply.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const task = runner.start();
    await vi.advanceTimersByTimeAsync(10);
    const parked = settings.roleBatch.items.find((item) => item.name === '安柏');
    const activeId = settings.roleBatch.dispatch.itemId;
    runner.editQueue('restore', parked.id);
    expect(settings.roleBatch.items[settings.roleBatch.index].id).toBe(activeId);
    runner.addQueueNames(['诺艾尔']);
    finish({ text: '正文' });
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply.mock.calls.map((call) => call[1])).toEqual([
        '生成 琴，名字为 琴',
        '生成 丽莎，名字为 丽莎',
        '生成 安柏，名字为 安柏',
        '生成 诺艾尔，名字为 诺艾尔',
    ]);
});

it('skips an empty reply, continues, and retries the failed role on the next run', async () => {
    vi.useFakeTimers();
    const { settings, host, runner, notify } = setup([{ text: '  ' }, { text: '完成' }]);
    settings.roleNames = '琴\n安柏';
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(2);
    expect(settings.roleBatch.items[0]).toMatchObject({
        name: '琴',
        failed: true,
        processing: false,
        error: '没有返回内容',
    });
    expect(settings.roleBatch.items[1]).toMatchObject({ name: '安柏', processed: true, failed: false });
    expect(notify).toHaveBeenCalledWith('warning', expect.stringContaining('仍有 1 项未完成'));
    expect(settings.isRunning).toBe(false);
    expect(host.restoreRoleTemplate).toHaveBeenCalledWith(settings.roleBatch);
    const retry = runner.start();
    await vi.runAllTimersAsync();
    await retry;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(3);
    expect(host.generateRoleReply.mock.calls[2][1]).toContain('琴');
    expect(settings.roleBatch.items[0]).toMatchObject({ failed: false, error: null });
});

it('marks explicit truncation and continues without retrying that character', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup([{ text: '半截', truncated: true }, { text: '完成' }]);
    settings.roleNames = '琴\n安柏';
    settings.totalChapters = 2;
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(2);
    expect(settings.roleBatch.items.map((item) => item.failed)).toEqual([true, false]);
});

it('skips an empty truncation signal and moves to the next role', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup([{ text: '', truncated: true }, { text: '完成' }]);
    settings.roleNames = '琴\n安柏';
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(2);
    expect(settings.roleBatch.items.map((item) => item.failed)).toEqual([true, false]);
});

it('keeps uncertain requests pending and does not blindly resend on restart', async () => {
    const { settings, host, runner } = setup([Object.assign(new Error('timeout'), { uncertain: true })]);
    await runner.start();
    await runner.start();
    expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
    expect(settings.roleBatch.pending).toBe(true);
    expect(host.restoreRoleTemplate).not.toHaveBeenCalled();
});

it('pauses between roles and resumes without repeating completed roles', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup();
    let finish;
    host.generateRoleReply.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const task = runner.start();
    await Promise.resolve();
    runner.pause();
    finish({ text: '完成' });
    await vi.advanceTimersByTimeAsync(20);
    expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
    runner.resume();
    await vi.runAllTimersAsync();
    await task;
    expect(settings.roleBatch.index).toBe(3);
});

it('blocks duplicate starts and stops after a chat switch', async () => {
    const { settings, host, snapshot, runner } = setup();
    let finish;
    host.generateRoleReply.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const task = runner.start();
    await runner.start();
    snapshot.identity = 'other';
    finish({ text: '迟到的内容' });
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
    expect(settings.roleBatch.index).toBe(0);
    expect(settings.roleBatch.pending).toBe(true);
});

it('requires a real placeholder and never sends when preflight fails', async () => {
    const { host, runner, notify } = setup();
    host.prepareRoleBatch = () => ({ template: '没有占位符' });
    await runner.start();
    expect(host.generateRoleReply).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('warning', expect.stringContaining('[[角色名]]'));
});

it('treats names containing replacement symbols as literal text', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup();
    settings.roleNames = '$&';
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply.mock.calls[0][1]).toBe('生成 $&，名字为 $&');
});

it('retains the task but does not dispatch when the restored host is disconnected', async () => {
    const { runner, host, snapshot, settings } = setup();
    snapshot.connected = false;
    await runner.start();
    expect(host.generateRoleReply).not.toHaveBeenCalled();
    expect(settings.roleBatch.names).toEqual(['琴', '安柏', '丽莎']);
    expect(settings.isRunning).toBe(false);
});

it('marks unclosed role card tags as truncated failure instead of completed', async () => {
    vi.useFakeTimers();
    const unclosedReply = { text: '<character>\n名字：琴\n性格：温柔' };
    const { settings, host, runner } = setup([unclosedReply]);
    settings.totalChapters = 1;
    settings.roleNames = '琴';
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
    expect(settings.roleBatch.items[0]).toMatchObject({ name: '琴', failed: true });
});

it('accepts complete quoted or HTML-formatted cards for names containing middots and Latin letters', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup([
        { text: 'name: "碧蓝航线·俾斯麦Zwei"\ndescription: "完整的人物设定。"' },
        { text: '<character>完整的人物设定<br><portrait type="avatar" /></character>' },
    ]);
    settings.roleNames = '碧蓝航线·俾斯麦Zwei\n碧蓝航线·乌尔里希·冯·胡滕';
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(2);
    expect(settings.roleBatch.items.map((item) => item.failed)).toEqual([false, false]);
});

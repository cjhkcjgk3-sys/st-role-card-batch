import { afterEach, expect, it, vi } from 'vitest';
import { createRoleBatchRecoveryStore } from '../../src/novel/recoveryStore.js';
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

function setup(replies = [{ text: '结果' }], options = {}) {
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
        randomWaitMs: () => 0,
        ...options,
    });
    return { settings, host, snapshot, runner, notify, archived };
}

it('waits the configured random interval before dispatching the next role', async () => {
    vi.useFakeTimers();
    const { runner, settings, host } = setup([{ text: '结果' }], { randomWaitMs: () => 15000 });
    settings.roleNames = '琴\n安柏';
    const task = runner.start();
    await vi.advanceTimersByTimeAsync(14999);
    expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(2);
});

it.each([
    [0, 5000],
    [0.999999, 20000],
])('keeps the random role delay within 5–20 seconds', async (random, delay) => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(random);
    try {
        const { runner, settings, host } = setup([{ text: '结果' }], { randomWaitMs: undefined });
        settings.roleNames = '琴\n安柏';
        const task = runner.start();
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await task;
        expect(host.generateRoleReply).toHaveBeenCalledTimes(2);
    } finally {
        randomSpy.mockRestore();
    }
});

it('waits before recovery, reconciles uncertain requests, and stops at three interruptions', async () => {
    vi.useFakeTimers();
    const timeout = () => Object.assign(new Error('超时'), { code: 'GENERATION_TIMEOUT', uncertain: true });
    const { runner, settings, host, notify } = setup([timeout(), timeout(), timeout()], {
        recoveryWaitMs: () => 20000,
    });
    host.reconcileRoleBatch = vi.fn(async (batch) => {
        batch.pending = false;
    });
    const task = runner.start();
    await vi.advanceTimersByTimeAsync(19999);
    expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(3);
    expect(settings.isRunning).toBe(false);
    expect(notify).toHaveBeenCalledWith('warning', expect.stringContaining('累计 3 次'));
    expect(settings.roleBatch.pending).toBe(true);
});

it.each([
    [0, 20000],
    [0.999999, 30000],
])('waits 20–30 seconds before automatic recovery', async (random, delay) => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(random);
    try {
        const timeout = Object.assign(new Error('超时'), { code: 'GENERATION_TIMEOUT', uncertain: true });
        const { runner, settings, host } = setup([timeout, { text: '结果' }]);
        settings.roleNames = '琴\n安柏';
        host.reconcileRoleBatch = vi.fn(async (batch) => {
            batch.pending = false;
        });
        const task = runner.start();
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await task;
        expect(host.generateRoleReply).toHaveBeenCalledTimes(2);
    } finally {
        randomSpy.mockRestore();
    }
});

it('manual stop cancels an automatic recovery wait', async () => {
    vi.useFakeTimers();
    const timeout = Object.assign(new Error('超时'), { code: 'GENERATION_TIMEOUT', uncertain: true });
    const { runner, host } = setup([timeout], { recoveryWaitMs: () => 25000 });
    host.reconcileRoleBatch = vi.fn(async (batch) => {
        batch.pending = false;
    });
    const task = runner.start();
    await vi.advanceTimersByTimeAsync(1000);
    runner.stop();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
    expect(host.reconcileRoleBatch).toHaveBeenCalledTimes(1);
});

it('uses a result confirmed during recovery without generating the same role again', async () => {
    vi.useFakeTimers();
    const timeout = Object.assign(new Error('超时'), { code: 'GENERATION_TIMEOUT', uncertain: true });
    const { runner, settings, host, archived } = setup([timeout, { text: '下一角色' }], {
        recoveryWaitMs: () => 25000,
    });
    settings.roleNames = '琴\n安柏';
    host.reconcileRoleBatch = vi.fn(async (batch) => {
        if (batch.pending) Object.assign(batch.items[batch.index], { processed: true, failed: false, swipe: 0 });
        batch.pending = false;
    });
    const task = runner.start();
    await vi.advanceTimersByTimeAsync(24999);
    expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await task;
    expect(host.generateRoleReply.mock.calls.map((call) => call[1])).toEqual([
        '生成 琴，名字为 琴',
        '生成 安柏，名字为 安柏',
    ]);
    expect(archived.mock.calls.map((call) => call[0])).toEqual(['琴', '安柏']);
});

it('stops with the request pending when recovery cannot confirm the previous generation', async () => {
    vi.useFakeTimers();
    const timeout = Object.assign(new Error('超时'), { code: 'GENERATION_TIMEOUT', uncertain: true });
    const { runner, settings, host } = setup([timeout], { recoveryWaitMs: () => 20000 });
    host.reconcileRoleBatch = vi.fn(async (batch) => {
        if (batch.pending) throw new Error('酒馆仍在生成');
    });
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
    expect(settings.roleBatch.pending).toBe(true);
    expect(settings.isRunning).toBe(false);
});

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
        parked: true,
        processing: false,
        error: '没有返回内容',
    });
    expect(settings.roleBatch.items[1]).toMatchObject({ name: '安柏', processed: true, failed: false });
    expect(notify).toHaveBeenCalledWith('warning', expect.stringContaining('有 1 个失败角色已移至「暂移角色」'));
    expect(settings.isRunning).toBe(false);
    expect(host.restoreRoleTemplate).toHaveBeenCalledWith(settings.roleBatch);
    expect(runner.restoreAllParked()).toBe(1);
    const retry = runner.start();
    await vi.runAllTimersAsync();
    await retry;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(3);
    expect(host.generateRoleReply.mock.calls[2][1]).toContain('琴');
    expect(settings.roleBatch.items.find((item) => item.name === '琴')).toMatchObject({
        failed: false,
        parked: false,
        error: null,
    });
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

it('records error and skips archive when a fenced card misses </character_design_complex> or [end]', async () => {
    vi.useFakeTimers();
    const onRoleComplete = vi.fn();
    const { settings, runner } = setup(
        [{ text: '```\n[start]\n<character_design_complex>\nname: 琴\n```', swipe: 0 }],
        { onRoleComplete },
    );
    settings.roleNames = '琴';
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(settings.roleBatch.items[0]).toMatchObject({
        name: '琴',
        failed: true,
        error: '角色卡未闭合或内容截断',
    });
    expect(onRoleComplete).not.toHaveBeenCalled();
});

it('warns on YAML name mismatch without failing the card, and accepts work-prefixed or nickname matches', async () => {
    vi.useFakeTimers();
    const { settings, runner, notify } = setup([
        {
            text: '```\n[start]\n<character_design_complex>\nname: 丽莎\n</character_design_complex>\n[end]\n```',
            swipe: 0,
        },
        {
            text: '```\n[start]\n<character_design_complex>\nname: 雷电芽衣\nnicknames:\n  - 芽衣\n</character_design_complex>\n[end]\n```',
            swipe: 1,
        },
    ]);
    settings.roleNames = '琴\n崩坏三·雷电芽衣';
    settings.roleImageLibrary = { workNames: ['崩坏三'] };
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(settings.roleBatch.items[0]).toMatchObject({
        name: '琴',
        failed: false,
        nameWarning: expect.stringContaining('丽莎'),
    });
    expect(settings.roleBatch.items[1]).toMatchObject({
        name: '崩坏三·雷电芽衣',
        failed: false,
        nameWarning: null,
    });
    expect(notify).toHaveBeenCalledWith('warning', expect.stringContaining('备选页角色名为「丽莎」'));
});

it('auditReplies marks falsely completed truncated replies as failed, removes them from archive, and flags name mismatch', async () => {
    const truncatedCard = '```\n[start]\n<character_design_complex>\nname: 琴\n[外貌]\n```';
    const mismatchedCard =
        '```\n[start]\n<character_design_complex>\nname: 丽莎\n</character_design_complex>\n[end]\n```';
    const goodCard = '```\n[start]\n<character_design_complex>\nname: 芭芭拉\n</character_design_complex>\n[end]\n```';
    const settings = {
        roleNames: '琴\n安柏\n芭芭拉',
        roleArchive: ['琴', '安柏'],
        roleBatch: {
            id: 'task-1',
            identity: 'chat-1',
            promptFloor: 1,
            resultFloor: 2,
            template: '生成 [[角色名]]',
            names: ['琴', '安柏', '芭芭拉'],
            index: 3,
            items: [
                { id: 'r1', name: '琴', processed: true, failed: false, swipe: 0 },
                { id: 'r2', name: '安柏', processed: true, failed: false, swipe: 1 },
                { id: 'r3', name: '芭芭拉', processed: true, failed: false, swipe: 2 },
            ],
            history: [],
        },
    };
    const onRoleComplete = (name) => {
        if (!settings.roleArchive.includes(name)) settings.roleArchive.push(name);
    };
    const notify = vi.fn();
    const host = {
        snapshot: () => ({ identity: 'chat-1', generating: false, connected: true }),
        auditRoleBatch: vi.fn(async (batch) => [
            { item: batch.items[0], swipe: 0, text: truncatedCard, truncated: true },
            { item: batch.items[1], swipe: 1, text: mismatchedCard, truncated: false },
            { item: batch.items[2], swipe: 2, text: goodCard, truncated: false },
        ]),
    };
    const runner = createRoleBatchRunner({
        getSettings: () => settings,
        host,
        onChange: vi.fn(),
        notify,
        onStats: vi.fn(),
        onRoleComplete,
        onRoleArchiveChange: vi.fn(),
    });
    const summary = await runner.auditReplies();
    expect(summary).toEqual({
        checked: 3,
        truncatedFixed: 1,
        archiveRemoved: 1,
        archiveAdded: 1,
        nameMismatches: 1,
        adoptedCount: 0,
    });
    expect(settings.roleBatch.items[0]).toMatchObject({
        failed: true,
        parked: true,
        error: '角色卡未闭合或内容截断',
        nameWarning: null,
    });
    expect(settings.roleBatch.items[1]).toMatchObject({
        failed: false,
        nameWarning: expect.stringContaining('丽莎'),
    });
    expect(settings.roleBatch.items[2]).toMatchObject({
        failed: false,
        nameWarning: null,
    });
    expect(settings.roleArchive).toEqual(['安柏', '芭芭拉']);
    expect(settings.roleBatch.index).toBe(3);
    expect(notify).toHaveBeenCalledWith('warning', expect.stringContaining('1 页截断已标失败并移至暂移区'));
    expect(runner.restoreAllParked()).toBe(1);
    expect(settings.roleBatch.items.at(-1)).toMatchObject({ name: '琴', failed: true, parked: false });
    expect(settings.roleBatch.index).toBe(2);
});

it('restoreAllParked moves multiple failed and manually parked roles to the tail safely', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup([
        { text: '' },
        { text: '完成B' },
        { text: '<character_design_complex>\nname: 丽莎' },
        { text: '补齐A' },
        { text: '补齐C' },
    ]);
    settings.roleNames = '琴\n安柏\n丽莎';
    const first = runner.start();
    await vi.runAllTimersAsync();
    await first;
    // 琴（空回复失败）和丽莎（未闭合截断失败）均自动进入暂移区
    expect(settings.roleBatch.items.filter((item) => item.parked).map((item) => item.name)).toEqual(['琴', '丽莎']);
    // 全部放回队列后，再次开始只集中补齐这两个失败角色
    expect(runner.restoreAllParked()).toBe(2);
    expect(settings.roleBatch.items.map((item) => item.name)).toEqual(['安柏', '琴', '丽莎']);
    const second = runner.start();
    await vi.runAllTimersAsync();
    await second;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(5);
    expect(settings.roleBatch.items.every((item) => item.processed && !item.failed && !item.parked)).toBe(true);
});

it('fails and parks a card whose tokenCount is below minRoleTokens even when tags are closed', async () => {
    vi.useFakeTimers();
    const onRoleComplete = vi.fn();
    const closedShort = '```\n[start]\n<character_design_complex>\nname: 琴\n</character_design_complex>\n[end]\n```';
    const closedLong = '```\n[start]\n<character_design_complex>\nname: 安柏\n</character_design_complex>\n[end]\n```';
    const { settings, runner } = setup(
        [
            { text: closedShort, swipe: 0, tokenCount: 880 },
            { text: closedLong, swipe: 1, tokenCount: 6500 },
        ],
        { onRoleComplete },
    );
    settings.roleNames = '琴\n安柏';
    settings.minRoleTokens = 5000;
    const task = runner.start();
    await vi.runAllTimersAsync();
    await task;
    expect(settings.roleBatch.items[0]).toMatchObject({
        name: '琴',
        failed: true,
        parked: true,
        error: '角色卡 Token 不足（880 < 5000）',
    });
    expect(settings.roleBatch.items[1]).toMatchObject({
        name: '安柏',
        failed: false,
        parked: false,
    });
    expect(onRoleComplete).toHaveBeenCalledTimes(1);
    expect(onRoleComplete).toHaveBeenCalledWith('安柏');
});

it('restore-origin keeps a parked or failed role in its original slot while restore moves it to the tail', async () => {
    vi.useFakeTimers();
    const { settings, runner } = setup([{ text: '' }, { text: '完成B' }, { text: '完成C' }]);
    settings.roleNames = '琴\n安柏\n丽莎';
    const first = runner.start();
    await vi.runAllTimersAsync();
    await first;
    // 琴失败自动暂移，此时仍在原索引 0
    const qin = settings.roleBatch.items.find((item) => item.name === '琴');
    expect(qin.parked).toBe(true);
    runner.editQueue('restore-origin', qin.id);
    expect(settings.roleBatch.items.map((item) => item.name)).toEqual(['琴', '安柏', '丽莎']);
    expect(settings.roleBatch.items[0]).toMatchObject({ name: '琴', parked: false, failed: true });
    expect(settings.roleBatch.index).toBe(0);

    // 再次暂移后点放回队尾，应移动到末尾
    settings.roleBatch.items[0].parked = true;
    runner.editQueue('restore', qin.id);
    expect(settings.roleBatch.items.map((item) => item.name)).toEqual(['安柏', '丽莎', '琴']);
    expect(settings.roleBatch.items[2]).toMatchObject({ name: '琴', parked: false });
});

it('allows restoring parked roles even when a stopped batch still has pending=true for another item', () => {
    const settings = {
        roleNames: '琴\n安柏',
        roleArchive: [],
        roleBatch: {
            id: 'task-1',
            identity: 'chat-1',
            promptFloor: 1,
            resultFloor: 2,
            template: '生成 [[角色名]]',
            names: ['琴', '安柏'],
            index: 1,
            pending: true,
            dispatch: { itemId: 'r2', attemptId: 'att-1' },
            items: [
                { id: 'r1', name: '琴', failed: true, parked: true },
                { id: 'r2', name: '安柏', processing: false },
            ],
            history: [],
        },
    };
    const runner = createRoleBatchRunner({
        getSettings: () => settings,
        host: { snapshot: () => ({ identity: 'chat-1', generating: false, connected: true }) },
        onChange: vi.fn(),
        notify: vi.fn(),
        onStats: vi.fn(),
    });
    runner.editQueue('restore-origin', 'r1');
    expect(settings.roleBatch.items[0]).toMatchObject({ id: 'r1', parked: false });
    settings.roleBatch.items[0].parked = true;
    expect(runner.restoreAllParked()).toBe(1);
    expect(settings.roleBatch.items.map((item) => item.name)).toEqual(['安柏', '琴']);
});

it('auditReplies adopts unbound complete replies whose YAML name includes an English gloss (e.g. 胜利（Victory）)', async () => {
    const settings = {
        roleNames: '胜利\n胡德',
        roleArchive: [],
        roleBatch: {
            id: 'task-1',
            identity: 'chat-1',
            promptFloor: 1,
            resultFloor: 2,
            template: '生成 [[角色名]]',
            names: ['胜利', '胡德'],
            index: 0,
            items: [
                { id: 'r1', name: '胜利' },
                { id: 'r2', name: '胡德' },
            ],
            history: [],
        },
    };
    const onRoleComplete = (name) => {
        if (!settings.roleArchive.includes(name)) settings.roleArchive.push(name);
    };
    const bindRoleReply = vi.fn(async () => true);
    const runner = createRoleBatchRunner({
        getSettings: () => settings,
        host: {
            snapshot: () => ({ identity: 'chat-1', generating: false, connected: true }),
            auditRoleBatch: vi.fn(async () => []),
            scanUnboundRoleReplies: vi.fn(async () => [
                {
                    swipe: 0,
                    text: '```\n[start]\n<character_design_complex>\nname: 胜利（Victory）\n</character_design_complex>\n[end]\n```',
                    truncated: false,
                    tokenCount: 6000,
                },
            ]),
            bindRoleReply,
        },
        onChange: vi.fn(),
        notify: vi.fn(),
        onStats: vi.fn(),
        onRoleComplete,
        onRoleArchiveChange: vi.fn(),
    });
    const summary = await runner.auditReplies();
    expect(summary.adoptedCount).toBe(1);
    expect(bindRoleReply).toHaveBeenCalledWith(settings.roleBatch, 'r1', 0);
    expect(settings.roleBatch.items[0]).toMatchObject({ processed: true, failed: false, parked: false, swipe: 0 });
    expect(settings.roleArchive).toEqual(['胜利']);
});

it('manual generateOne generates only one next role or one explicitly picked role without chaining', async () => {
    vi.useFakeTimers();
    const { settings, host, runner } = setup([
        { text: '完成琴', swipe: 0 },
        { text: '完成丽莎', swipe: 1 },
    ]);
    settings.roleNames = '琴\n安柏\n丽莎';
    // 手动生成下一个：只生成琴就停，不连跑安柏
    const one = runner.generateOne();
    await vi.runAllTimersAsync();
    await one;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(1);
    expect(settings.roleBatch.items[0]).toMatchObject({ name: '琴', processed: true, failed: false });
    expect(settings.roleBatch.items[1].processed).toBeFalsy();

    // 手动指定生成丽莎：跳过安柏直接单步生成丽莎
    const lisaId = settings.roleBatch.items[2].id;
    const picked = runner.generateOne({ id: lisaId, name: '丽莎' });
    await vi.runAllTimersAsync();
    await picked;
    expect(host.generateRoleReply).toHaveBeenCalledTimes(2);
    expect(host.generateRoleReply.mock.calls[1][1]).toContain('丽莎');
    expect(settings.roleBatch.items[2]).toMatchObject({ name: '丽莎', processed: true, failed: false });
    expect(settings.roleBatch.items[1].processed).toBeFalsy();
});

it('isolates batches per chat, seamlessly continues in a new chat without restart, and preserves manual parks while retrying old failures', async () => {
    vi.useFakeTimers();
    const values = new Map();
    const storage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
    const recovery = createRoleBatchRecoveryStore(() => storage);
    const settings = {
        roleNames: '琴\n安柏\n丽莎\n芭芭拉',
        roleArchive: [],
        replyWaitTime: 0,
        roleBatch: null,
        roleBatches: {},
    };
    const snapshot = { identity: 'chat-1', generating: false, connected: true };
    const calls = [];
    const host = {
        snapshot: () => snapshot,
        prepareRoleBatch: () => ({ promptFloor: 1, resultFloor: null, template: '生成 [[角色名]]' }),
        reconcileRoleBatch: vi.fn(async () => {}),
        restoreRoleTemplate: vi.fn(async () => {}),
        generateRoleReply: vi.fn(async (batch, prompt) => {
            calls.push({ chat: batch.identity, prompt });
            if (batch.identity === 'chat-1' && prompt.includes('安柏')) return { text: '' };
            return { text: `完成：${prompt}`, swipe: calls.length - 1 };
        }),
    };
    const onRoleComplete = (name) => {
        if (!settings.roleArchive.includes(name)) settings.roleArchive.push(name);
    };
    const runner = createRoleBatchRunner({
        getSettings: () => settings,
        host,
        recovery,
        onChange: vi.fn(),
        notify: vi.fn(),
        onStats: vi.fn(),
        onRoleComplete,
        onRoleArchiveChange: vi.fn(),
        randomWaitMs: () => 0,
    });

    // 在旧对话 chat-1 先单步跑琴（成功）、再跑安柏（失败自动暂移），并手动暂移丽莎
    const step1 = runner.generateOne();
    await vi.runAllTimersAsync();
    await step1;
    const step2 = runner.generateOne();
    await vi.runAllTimersAsync();
    await step2;
    const lisa = settings.roleBatches['chat-1'].items.find((item) => item.name === '丽莎');
    runner.editQueue('park', lisa.id);
    // 模拟极端情况：琴虽然在 chat-1 完成但尚未入名录，且 chat-1 还有一个未结束的 preview
    settings.roleArchive = [];
    settings.roleBatches['chat-1'].preview = { id: 'p-old', name: '琴' };

    // 直接切换到新对话 chat-2（不点从头生成），直接 start() 无缝接续
    snapshot.identity = 'chat-2';
    expect(runner.activeBatch()).toBeNull();
    const run2 = runner.start();
    await vi.runAllTimersAsync();
    await run2;

    // 琴被自动从 chat-1 补录进名录并跳过；丽莎保留手动暂移；chat-2 只生成了旧失败的安柏和未做的芭芭拉！
    expect(calls.filter((c) => c.chat === 'chat-2').map((c) => c.prompt)).toEqual(['生成 安柏', '生成 芭芭拉']);
    expect(settings.roleArchive).toEqual(expect.arrayContaining(['琴', '安柏', '芭芭拉']));
    expect(settings.roleBatches['chat-2'].items.find((item) => item.name === '丽莎').parked).toBe(true);
    // 旧对话 chat-1 的独立批次完好无损，没有被新对话覆盖
    expect(settings.roleBatches['chat-1'].items.find((item) => item.name === '安柏').failed).toBe(true);

    // 切回 chat-1 单独重置，不影响 chat-2
    snapshot.identity = 'chat-1';
    delete settings.roleBatches['chat-1'].preview;
    await runner.resetPending({ restart: true });
    expect(settings.roleBatches['chat-1']).toBeUndefined();
    expect(settings.roleBatches['chat-2']).toBeDefined();
    snapshot.identity = 'chat-2';
    expect(runner.activeBatch()?.identity).toBe('chat-2');
});

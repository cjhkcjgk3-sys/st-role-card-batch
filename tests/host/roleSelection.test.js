import { expect, it } from 'vitest';
import { resolveRerollTarget, selectedRole } from '../../src/host/roleSelection.js';

it('resolves only the selected recorded role, including non-ASCII names', () => {
    const batch = {
        id: 'batch',
        items: [
            { id: 'a', name: '八重神子', swipe: 0 },
            { id: 'b', name: '雷电将军', swipe: 1 },
        ],
        history: [],
    };
    const message = {
        swipes: ['A', 'B'],
        swipe_id: 1,
        swipe_info: [
            { extra: { nag_role_batch: { taskId: 'batch', itemId: 'a' } } },
            { extra: { nag_role_batch: { taskId: 'batch', itemId: 'b' } } },
        ],
    };
    expect(selectedRole(batch, message)).toMatchObject({ index: 1, item: { name: '雷电将军' } });
    message.swipe_id = 0;
    expect(selectedRole(batch, message)).toMatchObject({ index: 0, item: { name: '八重神子' } });
});

it('refuses unknown, temporary, mismatched or ambiguous bindings', () => {
    const batch = { id: 'batch', items: [{ id: 'a', name: '甲', swipe: 0 }], history: [] };
    const message = {
        swipes: ['A', 'TEMP'],
        swipe_id: 1,
        swipe_info: [{}, { extra: { nag_role_batch: { taskId: 'batch', itemId: 'a' } } }],
    };
    expect(selectedRole(batch, message)).toBeNull();
    message.swipe_info[1].extra.nag_role_batch.taskId = 'other';
    expect(selectedRole(batch, message)).toBeNull();
    message.swipe_id = 0;
    expect(selectedRole(batch, message)).toBeNull();
});

it('warns when the user starts a native swipe/regenerate on the batch floor while the plugin is idle', async () => {
    const { EventEmitter } = await import('node:events');
    const { createRoleSelectionUI } = await import('../../src/host/roleSelection.js');
    const { vi } = await import('vitest');
    globalThis.document ??= { querySelectorAll: () => [], querySelector: () => null };
    const source = new EventEmitter();
    const context = { eventSource: source, eventTypes: { GENERATION_STARTED: 'gs' }, updateMessageBlock: () => {} };
    const chat = [{}, { is_user: true, mes: 't' }, { mes: 'r', swipes: ['r'], swipe_id: 0 }];
    let busy = false;
    const notify = vi.fn();
    const ui = createRoleSelectionUI({
        host: { getContext: () => context, getChat: () => chat, snapshot: () => ({ identity: 'id' }) },
        getBatch: () => ({ identity: 'id', resultFloor: 2, promptFloor: 1, items: [], history: [] }),
        isBusy: () => busy,
        onReroll: () => {},
        notify,
    });
    source.emit('gs', 'swipe', {}, false);
    expect(notify).toHaveBeenCalledTimes(1);
    busy = true;
    source.emit('gs', 'swipe', {}, false);
    busy = false;
    source.emit('gs', 'swipe', {}, true);
    source.emit('gs', 'normal', {}, false);
    expect(notify).toHaveBeenCalledTimes(1);
    ui.dispose();
});

it('never binds a pending preview candidate as the role result', () => {
    const batch = { id: 'batch', items: [{ id: 'a', name: '甲', swipe: 0 }], history: [] };
    const message = {
        swipes: ['A', 'CANDIDATE'],
        swipe_id: 1,
        swipe_info: [
            { extra: { nag_role_batch: { taskId: 'batch', itemId: 'a' } } },
            { extra: { nag_role_batch: { taskId: 'batch', itemId: 'a', previewId: 'p1' } } },
        ],
    };
    expect(selectedRole(batch, message)).toBeNull();
    message.swipe_id = 0;
    expect(selectedRole(batch, message)).toMatchObject({ index: 0 });
});

it('resolveRerollTarget still resolves stopped, unbound, or truncated pages without requiring an active batch', () => {
    const chat = [
        { is_user: true, mes: '生成 [[角色名]]' },
        {
            is_user: false,
            mes: '<character_design_complex>\nname: 胜利（Victory）\n</character_design_complex>',
            swipes: [
                '<character_design_complex>\nname: 胜利（Victory）\n</character_design_complex>',
                '<character_design_complex>\n被截断没有写完名字',
            ],
            swipe_id: 0,
            swipe_info: [{}, {}],
        },
    ];
    // 无批次时按正文 YAML name 匹配名单中的规范名
    expect(resolveRerollTarget(null, chat, 'chat-1', { rosterNames: ['胜利', '胡德'] })).toMatchObject({
        floor: 1,
        index: 0,
        name: '胜利',
        bound: false,
    });
    // 正文截断得连名字都没有时，仍允许重生成（name 为空，供点击后弹窗确认）
    chat[1].swipe_id = 1;
    expect(resolveRerollTarget(null, chat, 'chat-1', { rosterNames: ['胜利'] })).toMatchObject({
        floor: 1,
        index: 1,
        name: '',
        bound: false,
    });
    // 有批次但该项因失败清空了 swipe 时，仍可通过回执直接识别
    const batch = {
        id: 'b1',
        identity: 'chat-1',
        promptFloor: 0,
        resultFloor: 1,
        template: '生成 [[角色名]]',
        items: [{ id: 'r1', name: '胜利', failed: true, parked: true, swipe: null }],
        history: [],
    };
    chat[1].swipe_info[1] = { extra: { nag_role_batch: { taskId: 'b1', itemId: 'r1', status: 'invalid' } } };
    expect(resolveRerollTarget(batch, chat, 'chat-1')).toMatchObject({
        floor: 1,
        index: 1,
        name: '胜利',
        item: { id: 'r1' },
        bound: false,
    });
});

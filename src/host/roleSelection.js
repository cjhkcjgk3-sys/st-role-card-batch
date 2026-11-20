import { extractRoleCardNames } from '../novel/tagFilters.js';
import { matchRoleCardToCandidates } from '../novel/roleBatchState.js';

/** Resolve the selected native swipe through the batch receipt, never by parsing character text. */
export function selectedRole(batch, message) {
    if (!batch || !message || message.is_user || message.is_system) return null;
    const index = message.swipe_id ?? 0;
    if (!Number.isInteger(index) || typeof message.swipes?.[index] !== 'string') return null;
    const receipt = message.swipe_info?.[index]?.extra?.nag_role_batch ?? message.extra?.nag_role_batch;
    const candidates = [...(batch.items || []), ...(batch.history || [])];
    let matches = [];
    // Trial candidates of a pending preview are never a role's bound result.
    if (receipt?.previewId) return null;
    if (receipt?.taskId === batch.id && receipt.itemId)
        matches = candidates.filter((item) => item.id === receipt.itemId);
    else if (!receipt) matches = candidates.filter((item) => item.legacy && item.swipe === index);
    if (matches.length !== 1 || !matches[0].name || matches[0].swipe !== index) return null;
    return { item: matches[0], index };
}

/**
 * 解析当前备选页的可重生成目标，不再死绑“进行中的批次”：
 * 1) 优先复用严格的 selectedRole 绑定；
 * 2) 若当前页回执仍指向本批次某项（即使该项因失败/停止/清名录而清空了 swipe），依然识别出该项；
 * 3) 若无批次或属于旧批次/无回执页，只要位于尾楼层且前一层是含 [[角色名]] 的提示词（或当前批次模板），
 *    尝试从正文 YAML name: 提取角色名；截断得连名字都没有时返回 name: '' 供点击后弹窗确认。
 */
export function resolveRerollTarget(batch, chat, identity, { rosterNames = [], workNames = [] } = {}) {
    if (!Array.isArray(chat) || chat.length < 2) return null;
    const sameBatch = !!batch && batch.identity === identity;
    const floor = sameBatch && Number.isInteger(batch.resultFloor) ? batch.resultFloor : chat.length - 1;
    if (floor !== chat.length - 1 || floor < 1) return null;
    const message = chat[floor];
    if (!message || message.is_user || message.is_system) return null;
    const index = message.swipe_id ?? 0;
    const swipes = Array.isArray(message.swipes) && message.swipes.length ? message.swipes : [message.mes];
    if (!Number.isInteger(index) || index < 0 || index >= swipes.length || typeof swipes[index] !== 'string')
        return null;
    const receipt = message.swipe_info?.[index]?.extra?.nag_role_batch ?? message.extra?.nag_role_batch;
    if (receipt?.previewId) return null;

    if (sameBatch) {
        const strict = selectedRole(batch, message);
        if (strict) return { floor, index, item: strict.item, name: strict.item.name, bound: true };
        const candidates = [...(batch.items || []), ...(batch.history || [])];
        if (receipt?.taskId === batch.id && receipt.itemId) {
            const matched = candidates.filter((item) => item.id === receipt.itemId && item.name);
            if (matched.length === 1) return { floor, index, item: matched[0], name: matched[0].name, bound: false };
        }
    }

    const promptFloor = sameBatch && Number.isInteger(batch.promptFloor) ? batch.promptFloor : floor - 1;
    const prompt = chat[promptFloor];
    if (!prompt?.is_user || typeof prompt.mes !== 'string') return null;
    const hasTemplate =
        prompt.mes.includes('[[角色名]]') ||
        (sameBatch && typeof batch.template === 'string' && batch.template.includes('[[角色名]]'));
    if (!hasTemplate) return null;

    const text = swipes[index];
    const pool = sameBatch
        ? [...(batch.items || []), ...(batch.history || [])]
        : rosterNames.map((name) => ({ id: null, name }));
    const byBody = matchRoleCardToCandidates(pool, text, workNames);
    if (byBody.length === 1) {
        return { floor, index, item: byBody[0].id ? byBody[0] : null, name: byBody[0].name, bound: false };
    }
    const extracted = extractRoleCardNames(text);
    const inferredName = extracted.primaryNames[0] || extracted.allNames[0] || '';
    return { floor, index, item: null, name: inferredName, bound: false };
}

/** Add one control to the native message and render the prompt as a view-only substitution. */
const PREVIEW_BUTTONS = [
    ['compare', '⇄ 对比原版'],
    ['accept', '✓ 用这版替换'],
    ['again', '↻ 再生成一版'],
    ['discard', '✗ 放弃'],
];

export function createRoleSelectionUI({
    host,
    getBatch,
    getRosterNames = () => [],
    getWorkNames = () => [],
    isBusy,
    onReroll,
    onPreview = {},
    notify = () => {},
}) {
    const context = host.getContext();
    const source = context?.eventSource;
    const subscriptions = [];
    let disposed = false;
    let lastPrompt = null;
    function clearPrompt() {
        if (!lastPrompt) return;
        const { identity, floor, original } = lastPrompt;
        lastPrompt = null;
        if (host.snapshot().identity === identity && host.getChat()?.[floor] === original)
            context.updateMessageBlock(floor, original);
    }
    function refresh() {
        if (disposed) return;
        const batch = getBatch(),
            chat = host.getChat(),
            identity = host.snapshot().identity;
        const sameBatch = !!batch && batch.identity === identity;
        const resolved = resolveRerollTarget(batch, chat, identity, {
            rosterNames: getRosterNames(),
            workNames: getWorkNames(),
        });
        const floor = sameBatch && Number.isInteger(batch.resultFloor) ? batch.resultFloor : resolved?.floor;
        const message = Number.isInteger(floor) ? chat?.[floor] : null;
        const previewState =
            batch?.preview && sameBatch && batch.preview.floor === floor && host.rolePreview
                ? host.rolePreview(batch)
                : null;
        const pendingPreview = !!previewState && chat?.length === floor + 1;
        const bound = sameBatch ? selectedRole(batch, message) : null;
        // A displayed trial candidate shows its role name on the prompt, but is not a bound result.
        const selected =
            bound ||
            (previewState?.onCandidate
                ? { item: { name: batch.preview.name }, index: previewState.displayed, preview: true }
                : resolved?.name
                  ? { item: { name: resolved.name }, index: resolved.index, loose: true }
                  : null);
        const canReroll =
            !!(bound || resolved) && !pendingPreview && Number.isInteger(floor) && chat?.length === floor + 1;
        const document = globalThis.document;
        for (const button of document.querySelectorAll('.nag-reroll-role')) {
            if (!canReroll || button.closest('.mes')?.getAttribute('mesid') !== String(floor)) button.remove();
        }
        for (const button of document.querySelectorAll('.nag-preview-action')) {
            if (!pendingPreview || button.closest('.mes')?.getAttribute('mesid') !== String(floor)) button.remove();
        }
        if (pendingPreview) renderPreviewButtons(floor, previewState);
        if (!selected && !canReroll) {
            clearPrompt();
            return;
        }
        const promptFloor = sameBatch && Number.isInteger(batch.promptFloor) ? batch.promptFloor : floor - 1;
        const prompt = chat?.[promptFloor];
        const promptNode = document.querySelector(`#chat .mes[mesid="${promptFloor}"]`);
        const template = sameBatch ? batch.template : prompt?.mes;
        if (
            selected?.item?.name &&
            !isBusy() &&
            prompt?.is_user &&
            prompt.mes === template &&
            !promptNode?.querySelector('textarea')
        ) {
            const sourceText = typeof prompt.extra?.display_text === 'string' ? prompt.extra.display_text : template;
            if (!sourceText?.includes('[[角色名]]')) clearPrompt();
            else {
                const display = sourceText.replaceAll('[[角色名]]', () => selected.item.name);
                if (
                    lastPrompt?.floor !== promptFloor ||
                    lastPrompt?.name !== selected.item.name ||
                    lastPrompt?.original !== prompt ||
                    lastPrompt?.node !== promptNode ||
                    lastPrompt?.sourceText !== sourceText
                ) {
                    context.updateMessageBlock(promptFloor, {
                        ...prompt,
                        extra: { ...prompt.extra, display_text: display },
                    });
                    lastPrompt = {
                        identity,
                        floor: promptFloor,
                        original: prompt,
                        name: selected.item.name,
                        node: promptNode,
                        sourceText,
                    };
                }
            }
        } else if (!isBusy()) clearPrompt();
        if (!canReroll) return;
        const container = document.querySelector(`#chat .mes[mesid="${floor}"] .mes_buttons`);
        if (!container) return;
        let button = container.querySelector('.nag-reroll-role');
        if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.className = 'nag-reroll-role menu_button';
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                void onReroll();
            });
            container.appendChild(button);
        }
        button.textContent = '↻ 重生成此角色';
        button.title = selected?.item?.name ? `重新生成 ${selected.item.name}` : '重新生成当前备选页（点击输入角色名）';
        button.disabled = isBusy();
    }
    function renderPreviewButtons(floor, { preview, candidates, onCandidate }) {
        const document = globalThis.document;
        const container = document.querySelector(`#chat .mes[mesid="${floor}"] .mes_buttons`);
        if (!container) return;
        for (const [action, label] of PREVIEW_BUTTONS) {
            let button = container.querySelector(`.nag-preview-${action}`);
            if (!button) {
                button = document.createElement('button');
                button.type = 'button';
                button.className = `nag-preview-action nag-preview-${action} menu_button`;
                button.addEventListener('click', (event) => {
                    event.stopPropagation();
                    void onPreview[action]?.();
                });
                container.appendChild(button);
            }
            button.textContent = label;
            button.disabled =
                isBusy() || (action === 'accept' && !onCandidate) || (action === 'compare' && !candidates.length);
            button.title =
                action === 'compare'
                    ? '比较原角色和当前候选；若正在看原版，则比较最新候选'
                    : action === 'accept'
                      ? onCandidate
                          ? `用当前显示的候选版本替换「${preview.name}」原来的第 ${preview.index + 1} 页，并删除其他候选`
                          : `请先切换到候选页（第 ${candidates.map((index) => index + 1).join('、') || '无'} 页）`
                      : action === 'again'
                        ? `为「${preview.name}」在末尾再生成一个候选版本`
                        : `删除全部候选版本，回到「${preview.name}」原来的第 ${preview.index + 1} 页`;
        }
    }
    for (const name of [
        'MESSAGE_SWIPED',
        'MESSAGE_RECEIVED',
        'CHAT_CHANGED',
        'CHAT_LOADED',
        'MESSAGE_DELETED',
        'MESSAGE_UPDATED',
        'MESSAGE_EDITED',
        'MESSAGE_SWIPE_DELETED',
        'CHARACTER_MESSAGE_RENDERED',
        'USER_MESSAGE_RENDERED',
    ]) {
        const event = context?.eventTypes?.[name];
        if (!event || subscriptions.some(([name]) => name === event)) continue;
        const listener =
            name === 'USER_MESSAGE_RENDERED'
                ? (id) => {
                      if (id === lastPrompt?.floor) lastPrompt = null;
                      refresh();
                  }
                : refresh;
        source?.on(event, listener);
        subscriptions.push([event, listener]);
    }
    // A native overswipe/regenerate on the batch floor only appends a page and sends the raw [[角色名]] template.
    const onNativeGeneration = (type, _options, dryRun) => {
        if (disposed || dryRun || isBusy() || !['swipe', 'regenerate'].includes(type)) return;
        const batch = getBatch(),
            chat = host.getChat();
        if (!batch || batch.identity !== host.snapshot().identity || !Number.isInteger(batch.resultFloor)) return;
        if (chat?.length !== batch.resultFloor + 1) return;
        notify(
            'warning',
            '这是酒馆原生的重新生成：新内容只会追加到最后一页，不会替换任何角色，提示词里的 [[角色名]] 也不会被替换。要替换某个角色，请切到该页后点击「↻ 重生成此角色」',
        );
    };
    const startEvent = context?.eventTypes?.GENERATION_STARTED;
    if (startEvent) {
        source?.on(startEvent, onNativeGeneration);
        subscriptions.push([startEvent, onNativeGeneration]);
    }
    return {
        refresh,
        dispose() {
            disposed = true;
            clearPrompt();
            for (const [event, listener] of subscriptions) source?.removeListener(event, listener);
            for (const button of globalThis.document.querySelectorAll('.nag-reroll-role, .nag-preview-action'))
                button.remove();
        },
    };
}

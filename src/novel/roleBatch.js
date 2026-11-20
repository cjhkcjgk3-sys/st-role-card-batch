import { abortableDelay, throwIfAborted } from '../core/requestPolicy.js';
import { newIdentity } from '../core/chunkIdentity.js';
import {
    applyArchiveSkips,
    applyParkedRoles,
    applyRoleArchiveChanges,
    detectRoleCardNameMismatch,
    hydrateRoleBatch,
    matchRoleCardToCandidates,
    nextRoleIndex,
    normalizeRoleArchive,
    normalizeRoleParked,
    removeRoleArchiveMatches,
    removeRoleParked,
    roleComplete,
    updateRoleNames,
    upsertRoleParked,
    parseRoleNames,
} from './roleBatchState.js';
import { createRoleNameMatcher } from './roleName.js';
import { isRoleCardTruncated } from './tagFilters.js';

export const ROLE_PLACEHOLDER = '[[角色名]]';
export { parseRoleNames } from './roleBatchState.js';

/** One sequential batch, using the existing settings and controls. */
export function createRoleBatchRunner({
    getSettings,
    host,
    onChange,
    notify,
    onStats,
    onError = () => {},
    recovery,
    onRoleComplete = () => {},
    onRoleArchiveChange = () => {},
    randomWaitMs = () => 5000 + Math.floor(Math.random() * 15001),
    recoveryWaitMs = () => 20000 + Math.floor(Math.random() * 10001),
}) {
    const MAX_STORED_BATCHES = 30;
    let active = null;
    let preparing = false;
    const restoredChats = new Set();
    // Chat where the user just confirmed “从头生成”; its existing pages count as reviewed once.
    let restartIdentity = null;
    let lastSyncedIdentity = null;
    const currentIdentity = () => host.snapshot()?.identity;
    function ensureBatchMap(settings) {
        if (!settings.roleBatches || typeof settings.roleBatches !== 'object' || Array.isArray(settings.roleBatches)) {
            settings.roleBatches = {};
        }
        const legacy = settings.roleBatch;
        if (
            legacy &&
            typeof legacy.identity === 'string' &&
            legacy.identity &&
            !settings.roleBatches[legacy.identity]
        ) {
            settings.roleBatches[legacy.identity] = legacy;
        }
        return settings.roleBatches;
    }
    function pruneBatchMap(map, keepIdentity) {
        const keys = Object.keys(map);
        if (keys.length <= MAX_STORED_BATCHES) return;
        keys.filter((key) => key !== keepIdentity)
            .sort((a, b) => (map[a]?.updatedAt || 0) - (map[b]?.updatedAt || 0))
            .slice(0, keys.length - MAX_STORED_BATCHES)
            .forEach((key) => {
                delete map[key];
            });
    }
    function state(identity = currentIdentity()) {
        const settings = getSettings();
        const map = ensureBatchMap(settings);
        if (typeof identity === 'string' && identity) {
            if (lastSyncedIdentity === identity && settings.roleBatch === null && map[identity]) {
                delete map[identity];
            }
            const batch = map[identity] ?? null;
            if (!active || active.identity === identity) {
                settings.roleBatch = batch;
                lastSyncedIdentity = identity;
            }
            return batch;
        }
        return settings.roleBatch ?? null;
    }
    function setState(batch, identity = batch?.identity ?? currentIdentity()) {
        const settings = getSettings();
        const map = ensureBatchMap(settings);
        if (typeof identity === 'string' && identity) {
            if (batch) {
                map[identity] = batch;
                pruneBatchMap(map, identity);
            } else {
                delete map[identity];
            }
        }
        if (!active || active.identity === identity) {
            settings.roleBatch = batch ?? null;
            lastSyncedIdentity = typeof identity === 'string' && identity ? identity : null;
        }
        return batch;
    }
    /** 跨对话新建批次前，自动把历史对话里所有真正已完成的角色补录进全局名录，防止重复生成。 */
    function syncCompletedAcrossChatsToArchive() {
        const settings = getSettings();
        const map = ensureBatchMap(settings);
        for (const oldBatch of Object.values(map)) {
            for (const item of [...(oldBatch?.items || []), ...(oldBatch?.history || [])]) {
                if (item?.processed && !item.failed && !item.archived && item.manualStatus !== 'failed' && item.name) {
                    onRoleComplete(item.name);
                }
            }
        }
    }
    /**
     * 从历史对话批次一次性迁移暂移角色（含手动暂移与失败/截断暂移）到全局 settings.roleParked。
     * 按 updatedAt 从新到旧扫描：任何批次或名录里已完成的不迁移；较新对话里显式放回（parked === false）的不迁移。
     */
    function migrateParkedFromBatches(settings = getSettings()) {
        const map = ensureBatchMap(settings);
        const batches = Object.values(map)
            .filter(Boolean)
            .sort((a, b) => (b?.updatedAt || 0) - (a?.updatedAt || 0));
        const archiveMatcher = createRoleNameMatcher(
            normalizeRoleArchive(settings.roleArchive),
            settings.roleImageLibrary?.workNames,
        );
        const resolved = new Set();
        for (const batch of batches) {
            for (const item of [...(batch.items || []), ...(batch.history || [])]) {
                const name = String(item?.name || '').trim();
                if (name && roleComplete(item)) resolved.add(name);
            }
        }
        let parked = normalizeRoleParked(settings.roleParked);
        for (const entry of parked) resolved.add(entry.name);
        for (const batch of batches) {
            for (const item of batch.items || []) {
                const name = String(item?.name || '').trim();
                if (!name || resolved.has(name)) continue;
                if (archiveMatcher.has(name) && !item.failed) {
                    resolved.add(name);
                    continue;
                }
                if (item.parked === true) {
                    parked = upsertRoleParked(parked, {
                        name,
                        failed: Boolean(item.failed),
                        error: item.error || null,
                    });
                    resolved.add(name);
                } else if (item.parked === false) {
                    resolved.add(name);
                }
            }
        }
        settings.roleParked = parked;
        if (parked.length) {
            const parkedMap = new Map(parked.map((entry) => [entry.name, entry]));
            for (const batch of batches) {
                let touched = false;
                for (const item of batch.items || []) {
                    if (item?.parked !== undefined || roleComplete(item)) continue;
                    const entry = parkedMap.get(String(item.name || '').trim());
                    if (!entry) continue;
                    item.parked = true;
                    if (entry.failed) {
                        item.failed = true;
                        if (entry.error && !item.error) item.error = entry.error;
                    }
                    touched = true;
                }
                if (touched && batch.names) batch.index = nextRoleIndex(batch);
            }
        }
        return parked;
    }
    function ensureRoleParked(settings = getSettings()) {
        if (!Array.isArray(settings.roleParked)) return migrateParkedFromBatches(settings);
        return settings.roleParked;
    }
    function recordRoleParked(settings, entry) {
        settings.roleParked = upsertRoleParked(ensureRoleParked(settings), entry);
    }
    function clearRoleParked(settings, names) {
        settings.roleParked = removeRoleParked(ensureRoleParked(settings), names);
    }
    function mirrorParkedAcrossOtherBatches(
        settings,
        names,
        parked,
        { excludeIdentity = null, failed = false, error = null } = {},
    ) {
        const targets = new Set(
            (Array.isArray(names) ? names : [names]).map((value) => String(value || '').trim()).filter(Boolean),
        );
        if (!targets.size) return;
        const map = ensureBatchMap(settings);
        for (const [identity, otherBatch] of Object.entries(map)) {
            if (!otherBatch || (excludeIdentity && identity === excludeIdentity)) continue;
            let touched = false;
            for (const item of otherBatch.items || []) {
                const itemName = String(item?.name || '').trim();
                if (!targets.has(itemName)) continue;
                if (parked) {
                    if (!roleComplete(item)) {
                        item.parked = true;
                        if (failed) {
                            item.failed = true;
                            if (error && !item.error) item.error = error;
                        }
                        touched = true;
                    }
                } else if (item.parked) {
                    item.parked = false;
                    touched = true;
                }
            }
            if (touched && otherBatch.names) otherBatch.index = nextRoleIndex(otherBatch);
        }
    }
    const validationOptions = () => ({
        minLength: getSettings().minChapterLength,
        minTokens: Math.max(0, Number(getSettings().minRoleTokens) || 0),
        expectedClosingTags: getSettings().expectedClosingTags,
    });
    const truncationReason = (replyLike, options) => {
        const minTokens = options?.minTokens || 0;
        if (minTokens > 0 && Number.isFinite(replyLike?.tokenCount) && replyLike.tokenCount < minTokens) {
            return `角色卡 Token 不足（${replyLike.tokenCount} < ${minTokens}）`;
        }
        return '角色卡未闭合或内容截断';
    };
    function checkpoint(targetIdentity = active?.identity ?? currentIdentity()) {
        const batch = state(targetIdentity);
        try {
            if (batch) {
                batch.updatedAt = Date.now();
                batch.revision = (batch.revision || 0) + 1;
                if (typeof recovery?.writeForChat === 'function') recovery.writeForChat(batch.identity, batch);
                else recovery?.write?.(batch);
            }
        } catch {
            throw Object.assign(new Error('无法保存批量任务进度，已停止派发；请查看错误日志'), {
                code: 'CHECKPOINT_FAILED',
                uncertain: true,
            });
        }
        try {
            onChange();
        } catch (uiError) {
            onError(uiError, { phase: 'checkpoint-ui' });
        }
    }
    function restore(identity = currentIdentity()) {
        const slotKey = typeof identity === 'string' && identity ? identity : '__default__';
        if (restoredChats.has(slotKey)) return state(identity);
        const settings = getSettings();
        const existing = state(identity);
        const saved = typeof recovery?.readForChat === 'function' ? recovery.readForChat(identity) : recovery?.read?.();
        const matchesSlot =
            saved &&
            (saved.cleared ||
                typeof identity !== 'string' ||
                !identity ||
                !saved.identity ||
                saved.identity === identity);
        if (matchesSlot && saved.updatedAt >= (existing?.updatedAt || 0)) {
            const nextBatch = saved.cleared ? null : saved;
            setState(nextBatch, identity);
            if (nextBatch) {
                settings.roleNames = nextBatch.inputNames ?? nextBatch.names.join('\n');
                if (settings.generationMode !== 'novel')
                    settings.totalChapters = nextBatch.inputLimit ?? nextBatch.names.length;
            }
        }
        const current = state(identity);
        hydrateRoleBatch(current);
        restoredChats.add(slotKey);
        return current;
    }
    function saveInput() {
        const batch = state();
        if (active || preparing) return;
        const settings = getSettings();
        settings.totalChapters = parseRoleNames(settings.roleNames).length;
        if (!batch) return;
        batch.inputNames = settings.roleNames;
        batch.inputLimit = settings.totalChapters;
        updateRoleNames(batch, parseRoleNames(batch.inputNames));
        applyParkedRoles(batch, ensureRoleParked(settings));
        applyArchiveSkips(batch, settings.roleArchive, settings.roleImageLibrary?.workNames);
        try {
            checkpoint();
        } catch (error) {
            onError(error, { phase: 'save-input' });
            notify('warning', error.message);
        }
    }
    function assertCurrent(run) {
        throwIfAborted(run.controller.signal);
        if (host.snapshot().identity !== run.identity) throw new Error('聊天已切换，批量生成已停止');
    }
    const previewPendingError = (batch) =>
        Object.assign(
            new Error(
                `「${batch.preview.name}」有待确认的重生成候选版本，请先在结果消息上点击“用这版替换”或“放弃”，再进行其他操作`,
            ),
            { code: 'PREVIEW_PENDING' },
        );
    /** End a preview whose trial pages were all deleted by the user; never while a dispatch is unconfirmed. */
    function settlePreview(batch) {
        if (!batch?.preview || batch.pending || !host.rolePreview) return;
        const { message, candidates } = host.rolePreview(batch);
        if (!message || candidates.length) return;
        batch.preview = null;
        checkpoint();
        notify('info', '候选页已全部删除，已结束待确认状态，原角色页未改动');
    }
    function assertNoPreview(batch) {
        settlePreview(batch);
        if (batch?.preview) throw previewPendingError(batch);
    }
    async function syncEditedTemplate(batch, run) {
        if (!host.readRoleTemplate) return;
        let current = host.readRoleTemplate(batch);
        if (!current.includes(ROLE_PLACEHOLDER)) {
            // A stopped generation can leave its role-substituted prompt in the chat.
            const matches = [...batch.items, ...(batch.history || [])].some(
                (item) => item.name && batch.template.replaceAll(ROLE_PLACEHOLDER, () => item.name) === current,
            );
            if (matches) {
                await host.restoreRoleTemplateIfEquals(batch, current);
                assertCurrent(run);
                current = host.readRoleTemplate(batch);
            }
        }
        if (!current.includes(ROLE_PLACEHOLDER))
            throw new Error(
                `聊天中的提示词缺少 ${ROLE_PLACEHOLDER}：请在该用户楼层补上占位符并保存，或点击“恢复原始提示词”`,
            );
        if (current === batch.template) return;
        const previous = batch.template;
        batch.template = current;
        try {
            checkpoint();
        } catch (error) {
            batch.template = previous;
            throw error;
        }
    }
    async function start({ singleStep = false, targetItemId = null, targetName = null } = {}) {
        if (active || preparing) return;
        preparing = true;
        const settings = getSettings();
        const initial = host.snapshot();
        const isManualOne = Boolean(singleStep || targetItemId || targetName);
        const run = {
            identity: initial.identity,
            controller: new AbortController(),
            paused: false,
            queueRun: !isManualOne,
        };
        active = run;
        settings.isRunning = true;
        settings.isPaused = false;
        const stats = { startTime: Date.now(), chaptersGenerated: 0, totalCharacters: 0, errors: [] };
        onStats(stats);
        onChange();
        let ready = false;
        let explicitTargetIndex = -1;
        try {
            restore(initial.identity);
            if (initial.identity == null || initial.generating === true)
                throw new Error('请打开写卡助手聊天，并等待当前生成结束');
            if (recovery && typeof initial.identity !== 'string')
                throw new Error('无法可靠识别当前聊天，暂不能保存恢复进度');
            const names = parseRoleNames(settings.roleNames);
            settings.totalChapters = names.length;
            if (!names.length) throw new Error('请在角色名单中每行填写一个名字');
            let batch = state(initial.identity);
            if (batch) assertNoPreview(batch);
            if (!batch) {
                // 新开对话自动无缝接续：先确保历史对话已完成项全部补录进全局名录，并沿用全局持久化的暂移角色（含失败暂移与手动暂移）。
                syncCompletedAcrossChatsToArchive();
                const persistedParked = normalizeRoleParked(ensureRoleParked(settings));
                const target = host.prepareRoleBatch();
                if (!target.template.includes(ROLE_PLACEHOLDER))
                    throw new Error(`最后一条用户消息需要包含 ${ROLE_PLACEHOLDER}`);
                batch = setState(
                    {
                        id: newIdentity('role-batch'),
                        identity: initial.identity,
                        ...target,
                        names,
                        index: 0,
                        attempt: 0,
                        pending: false,
                        items: [],
                    },
                    initial.identity,
                );
                hydrateRoleBatch(batch);
                applyParkedRoles(batch, persistedParked);
                if (restartIdentity === initial.identity) batch.restartReviewed = true;
            }
            restartIdentity = null;
            if (host.reconcileRoleBatch) {
                await host.reconcileRoleBatch(batch, validationOptions());
                for (const item of batch.items || []) {
                    if (item.processed && !item.failed && !item.archived && item.name) {
                        onRoleComplete(item.name);
                        clearRoleParked(settings, item.name);
                    }
                }
            } else if (batch.pending) throw new Error('上一轮尚未确认结束，请先查看聊天结果');
            assertCurrent(run);
            await syncEditedTemplate(batch, run);
            assertCurrent(run);
            updateRoleNames(batch, names);
            applyParkedRoles(batch, ensureRoleParked(settings));
            batch.inputNames = settings.roleNames;
            batch.inputLimit = settings.totalChapters;
            const archivedSkips = applyArchiveSkips(batch, settings.roleArchive, settings.roleImageLibrary?.workNames);
            if (archivedSkips.length && !targetItemId && !targetName)
                notify(
                    'info',
                    `名录中已有 ${archivedSkips.length} 个角色，本次跳过：${archivedSkips.slice(0, 5).join('、')}${archivedSkips.length > 5 ? '…' : ''}；要重新生成请先在名录中删除。`,
                );
            if (targetItemId || targetName) {
                explicitTargetIndex = batch.items.findIndex(
                    (item) => (targetItemId && item.id === targetItemId) || (targetName && item.name === targetName),
                );
                if (explicitTargetIndex < 0) throw new Error('找不到要生成的角色，请先核对名单');
                batch.index = explicitTargetIndex;
            }
            checkpoint();
            if (explicitTargetIndex < 0 && batch.index >= batch.names.length) {
                notify('info', '名单已全部完成，已有成品与名录条目已跳过；需要重做请先从“已完成角色名录”删除对应名字');
                return;
            }
            if (host.confirmUnidentifiedRolePages && !(await host.confirmUnidentifiedRolePages(batch))) return;
            delete batch.restartReviewed;
            // Persist the review fingerprint set by confirmUnidentifiedRolePages().
            checkpoint();
            assertCurrent(run);
            if (host.snapshot().connected === false) throw new Error('酒馆 API 尚未连接，请连接后继续任务');
            ready = true;
        } catch (error) {
            if (!run.controller.signal.aborted) {
                onError(error, { phase: 'prepare' });
                notify('warning', error.message);
            }
            return;
        } finally {
            preparing = false;
            if (!ready) {
                active = null;
                settings.isRunning = false;
                settings.isPaused = false;
                onChange();
            }
        }
        try {
            const batch = state(run.identity);
            let recoveryFailures = 0;
            let processedInRun = 0;
            while (batch.index < batch.names.length) {
                while (run.paused) {
                    await abortableDelay(100, run.controller.signal);
                    assertCurrent(run);
                }
                assertCurrent(run);
                const isExplicit = explicitTargetIndex === batch.index;
                if (!isExplicit && (batch.items[batch.index].parked || roleComplete(batch.items[batch.index]))) {
                    batch.index++;
                    continue;
                }
                const name = batch.names[batch.index];
                const attempt = 1;
                let recoveredAfterStop = false;
                assertCurrent(run);
                batch.attempt = attempt;
                batch.items[batch.index] = { ...batch.items[batch.index], name, processing: true };
                batch.pending = true;
                batch.dispatch = { itemId: batch.items[batch.index].id, attemptId: newIdentity('attempt') };
                checkpoint();
                try {
                    const reply = await host.generateRoleReply(
                        batch,
                        batch.template.replaceAll(ROLE_PLACEHOLDER, () => name),
                        {
                            signal: run.controller.signal,
                            assertCurrent: () => assertCurrent(run),
                            timeoutMs: settings.replyTimeoutMs || 600000,
                            validationOptions: validationOptions(),
                        },
                    );
                    assertCurrent(run);
                    batch.pending = false;
                    if (!reply.text?.trim()) throw reply.error || new Error('没有返回内容');
                    const options = validationOptions();
                    const checkOptions = Number.isFinite(reply.tokenCount)
                        ? { ...options, tokenCount: reply.tokenCount }
                        : options;
                    const truncated = Boolean(reply.truncated || isRoleCardTruncated(reply.text, checkOptions));
                    const failureReason = truncated ? truncationReason(reply, options) : null;
                    const nameWarning = truncated
                        ? null
                        : detectRoleCardNameMismatch(name, reply.text, settings.roleImageLibrary?.workNames);
                    batch.items[batch.index] = {
                        ...batch.items[batch.index],
                        name,
                        legacy: false,
                        processing: false,
                        processed: true,
                        manualStatus: truncated ? batch.items[batch.index].manualStatus : null,
                        failed: truncated,
                        parked: truncated ? true : false,
                        error: failureReason,
                        nameWarning,
                        swipe: reply.swipe,
                    };
                    if (!truncated) {
                        onRoleComplete(batch.items[batch.index].name);
                        clearRoleParked(settings, name);
                    } else {
                        recordRoleParked(settings, { name, failed: true, error: failureReason });
                    }
                    if (nameWarning) notify('warning', `${name}：${nameWarning}`);
                    if (truncated) stats.errors.push({ chapter: batch.index + 1, error: failureReason });
                    batch.index = isExplicit ? nextRoleIndex(batch) : batch.index + 1;
                    batch.dispatch = null;
                    stats.chaptersGenerated++;
                    stats.totalCharacters += reply.text?.length || 0;
                    processedInRun++;
                    checkpoint();
                    mirrorParkedAcrossOtherBatches(settings, name, truncated, {
                        excludeIdentity: batch.identity,
                        failed: truncated,
                        error: failureReason,
                    });
                    if (isManualOne) {
                        notify(
                            truncated ? 'warning' : 'success',
                            truncated
                                ? `「${name}」未通过完整校验（${failureReason}），已移至「暂移角色」`
                                : `「${name}」已生成完成`,
                        );
                        break;
                    }
                } catch (error) {
                    assertCurrent(run);
                    if (error.code === 'CHECKPOINT_FAILED') throw error;
                    onError(error, {
                        phase: error.phase || 'generate-reply',
                        roleIndex: batch.index + 1,
                        attempt,
                        promptFloor: batch.promptFloor,
                        resultFloor: batch.resultFloor,
                        generating: host.snapshot().generating,
                    });
                    batch.pending = !!error.uncertain;
                    batch.items[batch.index] = {
                        ...batch.items[batch.index],
                        name,
                        processing: false,
                        processed: true,
                        failed: true,
                        parked: true,
                        error: error.message,
                    };
                    recordRoleParked(settings, { name, failed: true, error: error.message });
                    const recoverableStop =
                        !isManualOne &&
                        (error.code === 'GENERATION_TIMEOUT' ||
                            error.code === 'NOT_CONNECTED' ||
                            error.phase === 'select-swipe');
                    if (recoverableStop) {
                        let recovered = false;
                        while (!recovered && recoveryFailures < 3) {
                            recoveryFailures++;
                            if (recoveryFailures >= 3) break;
                            notify('warning', `${name}：任务中断，等待后自动继续（中断 ${recoveryFailures}/3）`);
                            await abortableDelay(recoveryWaitMs(), run.controller.signal);
                            assertCurrent(run);
                            while (run.paused) {
                                await abortableDelay(100, run.controller.signal);
                                assertCurrent(run);
                            }
                            try {
                                const current = host.snapshot();
                                if (current.generating !== false || current.connected === false)
                                    throw new Error('无法确认酒馆已停止生成或尚未连接');
                                if (batch.pending) {
                                    if (!host.reconcileRoleBatch) throw new Error('无法确认上一轮的结果');
                                    await host.reconcileRoleBatch(batch, validationOptions());
                                    assertCurrent(run);
                                    if (batch.pending) throw new Error('上一轮仍未确认结束');
                                }
                                recovered = true;
                            } catch (recoveryError) {
                                assertCurrent(run);
                                onError(recoveryError, { phase: 'auto-recovery', roleIndex: batch.index + 1 });
                            }
                        }
                        if (!recovered) throw new Error('任务中断累计 3 次，已停止；请检查酒馆连接和聊天结果');
                        recoveredAfterStop = true;
                    } else if (error.uncertain) throw error;
                    const recoveredComplete = roleComplete(batch.items[batch.index]);
                    if (recoveredComplete) {
                        batch.items[batch.index].parked = false;
                        clearRoleParked(settings, name);
                        onRoleComplete(name);
                        notify('info', `${name}：已恢复并确认生成结果${isManualOne ? '' : '，继续下一个角色'}`);
                    } else {
                        stats.errors.push({ chapter: batch.index + 1, error: error.message });
                        notify(
                            'warning',
                            isManualOne
                                ? `${name}：生成失败（${error.message}），已移至「暂移角色」`
                                : `${name}：生成失败，已移至「暂移角色」并继续下一个`,
                        );
                    }
                    batch.index = isExplicit ? nextRoleIndex(batch) : batch.index + 1;
                    batch.dispatch = null;
                    processedInRun++;
                    checkpoint();
                    mirrorParkedAcrossOtherBatches(settings, name, !recoveredComplete, {
                        excludeIdentity: batch.identity,
                        failed: !recoveredComplete,
                        error: recoveredComplete ? null : error.message,
                    });
                    if (isManualOne) break;
                }
                let hasNextRole = false;
                for (let i = batch.index; i < batch.items.length; i++) {
                    if (!batch.items[i].parked && !roleComplete(batch.items[i])) {
                        hasNextRole = true;
                        break;
                    }
                }
                if (!recoveredAfterStop && hasNextRole)
                    await abortableDelay(
                        Math.max(0, settings.replyWaitTime || 0, randomWaitMs()),
                        run.controller.signal,
                    );
            }
            if (!isManualOne) {
                const remaining = batch.items.filter((item) => !item.parked && !roleComplete(item)).length;
                const parkedFailed = batch.items.filter(
                    (item) => item.parked && item.failed && !roleComplete(item),
                ).length;
                notify(
                    remaining || parkedFailed ? 'warning' : 'success',
                    remaining
                        ? `本轮结束，仍有 ${remaining} 项未完成；点击开始继续补齐`
                        : parkedFailed
                          ? `本轮结束，有 ${parkedFailed} 个失败角色已移至「暂移角色」；可点击「全部放回队列」后继续补齐`
                          : '角色批量生成结束，请到写卡助手预览中加载全部设置并导出',
                );
            } else if (!processedInRun) {
                notify('info', '没有待生成的角色');
            }
        } catch (error) {
            if (!run.controller.signal.aborted) {
                if (error.code === 'CHECKPOINT_FAILED') onError(error, { phase: 'save-recovery' });
                stats.errors.push({ chapter: (state(run.identity)?.index ?? 0) + 1, error: error.message });
                notify('warning', error.message);
            }
        } finally {
            const batch = state(run.identity);
            if (!batch?.pending && host.snapshot().identity === run.identity) {
                try {
                    await host.restoreRoleTemplate?.(batch);
                } catch (error) {
                    onError(error, { phase: 'restore-template' });
                    notify('warning', `恢复提示词模板失败：${error.message}`);
                }
            }
            const item = batch?.items?.[batch.index];
            if (item?.processing) item.processing = false;
            try {
                checkpoint(run.identity);
            } catch (error) {
                onError(error, { phase: 'save-recovery' });
                notify('warning', error.message);
            } finally {
                active = null;
                settings.isRunning = false;
                settings.isPaused = false;
                onChange();
            }
        }
    }
    async function rerollSelected() {
        if (active || preparing) return;
        preparing = true;
        const settings = getSettings(),
            initial = host.snapshot();
        const run = { identity: initial.identity, controller: new AbortController(), paused: false };
        active = run;
        settings.isRunning = true;
        settings.isPaused = false;
        onChange();
        let batch,
            captured,
            previewReply = null,
            committed = false,
            promptSent = false;
        try {
            restore(initial.identity);
            batch = state(initial.identity);
            if (initial.generating === true) throw new Error('请先等待酒馆当前生成结束');
            if (initial.connected === false) throw new Error('酒馆 API 尚未连接');
            const rosterNames = parseRoleNames(settings.roleNames);
            const workNames = settings.roleImageLibrary?.workNames;
            if (!batch || batch.identity !== initial.identity) {
                const looseTarget = host.resolveCurrentRerollTarget?.(null, { rosterNames, workNames });
                if (!looseTarget || !host.prepareRoleBatch) throw new Error('请回到原批次聊天后重试');
                const prepared = host.prepareRoleBatch();
                if (!prepared.template.includes(ROLE_PLACEHOLDER))
                    throw new Error(`最后一条用户消息需要包含 ${ROLE_PLACEHOLDER}`);
                batch = setState(
                    {
                        id: newIdentity('role-batch'),
                        identity: initial.identity,
                        ...prepared,
                        names: rosterNames,
                        index: 0,
                        attempt: 0,
                        pending: false,
                        items: [],
                    },
                    initial.identity,
                );
                hydrateRoleBatch(batch);
                applyParkedRoles(batch, ensureRoleParked(settings));
            }
            const previousDispatch = batch.pending && batch.dispatch ? { ...batch.dispatch } : null;
            if (host.reconcileRoleBatch) await host.reconcileRoleBatch(batch, validationOptions());
            assertCurrent(run);
            if (previousDispatch?.itemId) {
                const previousItem = [...batch.items, ...(batch.history || [])].find(
                    (entry) => entry.id === previousDispatch.itemId,
                );
                if (previousItem)
                    await host.restoreRoleTemplateIfEquals?.(
                        batch,
                        batch.template.replaceAll(ROLE_PLACEHOLDER, () => previousItem.name),
                    );
            }
            assertNoPreview(batch);
            await syncEditedTemplate(batch, run);
            assertCurrent(run);
            let override = null;
            if (host.resolveCurrentRerollTarget) {
                const resolved = host.resolveCurrentRerollTarget(batch, { rosterNames, workNames });
                if (resolved && !resolved.bound) {
                    let targetName = resolved.name;
                    if (!targetName) {
                        const entered = await host.promptRoleName?.('');
                        if (!entered) return;
                        targetName = entered;
                    }
                    let targetItem =
                        resolved.item ||
                        [...batch.items, ...(batch.history || [])].find((entry) => entry.name === targetName);
                    if (!targetItem) {
                        targetItem = { id: newIdentity('role'), name: targetName };
                        batch.history ??= [];
                        batch.history.push(targetItem);
                    }
                    override = { itemId: targetItem.id, name: targetItem.name, index: resolved.index };
                }
            }
            captured = override ? await host.captureRoleReroll(batch, override) : await host.captureRoleReroll(batch);
            assertCurrent(run);
            if (settings.rerollConfirm === true && host.beginRolePreview) {
                batch.preview = await host.beginRolePreview(batch, captured);
                assertCurrent(run);
                promptSent = true;
                previewReply = await generatePreviewCandidate(run, batch);
                return;
            }
            batch.pending = true;
            batch.dispatch = { itemId: captured.itemId, attemptId: newIdentity('attempt') };
            checkpoint();
            promptSent = true;
            const reply = await host.generateRoleReply(
                batch,
                batch.template.replaceAll(ROLE_PLACEHOLDER, () => captured.name),
                {
                    signal: run.controller.signal,
                    assertCurrent: () => assertCurrent(run),
                    timeoutMs: settings.replyTimeoutMs || 600000,
                    validationOptions: validationOptions(),
                    expectedPrompt: batch.template,
                },
            );
            assertCurrent(run);
            if (!reply.text?.trim()) throw reply.error || new Error('酒馆没有返回正文，原角色内容已保留');
            const rerollOptions = validationOptions();
            const rerollCheck = Number.isFinite(reply.tokenCount)
                ? { ...rerollOptions, tokenCount: reply.tokenCount }
                : rerollOptions;
            if (reply.truncated || isRoleCardTruncated(reply.text, rerollCheck))
                throw new Error(
                    reply.truncated
                        ? '新回复的流式输出未正常结束，原角色内容已保留；部分新回复保留在末尾'
                        : `${truncationReason(reply, rerollOptions)}，原角色内容已保留；新回复保留在末尾`,
                );
            const committedResult = await host.commitRoleReroll(batch, captured, reply.swipe);
            committed = true;
            assertCurrent(run);
            const item = [...batch.items, ...(batch.history || [])].find((entry) => entry.id === captured.itemId);
            if (!item) throw Object.assign(new Error('角色记录已变化，请核对聊天'), { uncertain: true });
            Object.assign(item, {
                processing: false,
                processed: true,
                failed: false,
                parked: false,
                manualStatus: null,
                legacy: false,
                error: null,
                nameWarning: detectRoleCardNameMismatch(
                    captured.name,
                    reply.text,
                    settings.roleImageLibrary?.workNames,
                ),
                swipe: captured.index,
            });
            // 单角色重生成也要收录：从失败状态重生成成功的角色否则不会进入名录
            onRoleComplete(captured.name);
            clearRoleParked(settings, captured.name);
            batch.pending = false;
            batch.dispatch = null;
            checkpoint();
            mirrorParkedAcrossOtherBatches(settings, captured.name, false, { excludeIdentity: batch.identity });
            if (committedResult?.refreshFailed)
                notify('warning', `${captured.name} 已保存，但页面刷新失败，请重新打开聊天查看`);
            else notify('success', `${captured.name} 已重新生成，其他备选回复已保留`);
        } catch (error) {
            if (batch && captured) batch.pending = !!error.uncertain || run.controller.signal.aborted;
            if (batch?.preview && captured) {
                if (!run.controller.signal.aborted) reportPreviewFailure(error);
            } else if (!run.controller.signal.aborted || committed) {
                onError(error, { phase: 'reroll-role' });
                // Generation can take minutes; a 4s toast at the very end is easy to miss. Keep it until dismissed.
                notify(
                    'warning',
                    committed
                        ? `新回复已保存，但后续状态未确认：${error.message}`
                        : `未确认替换，请核对原角色：${error.message}`,
                    { timeOut: 0, extendedTimeOut: 0, closeButton: true },
                );
            }
        } finally {
            if (captured && !committed) {
                try {
                    if (batch?.preview) await landPreview(batch, previewReply);
                    if (!batch?.preview) await host.restoreRoleRerollView(captured);
                } catch (error) {
                    onError(error, { phase: 'reroll-restore' });
                }
            }
            if (batch && captured && promptSent && host.snapshot().identity === run.identity) {
                try {
                    await host.restoreRoleTemplateIfEquals(
                        batch,
                        batch.template.replaceAll(ROLE_PLACEHOLDER, () => captured.name),
                    );
                } catch (error) {
                    onError(error, { phase: 'restore-template' });
                }
            }
            active = null;
            preparing = false;
            settings.isRunning = false;
            settings.isPaused = false;
            if (batch) {
                try {
                    checkpoint(batch.identity);
                } catch (error) {
                    onError(error, { phase: 'save-recovery' });
                }
            } else onChange();
        }
    }
    // ---- Preview before replace ----
    /** Generate one trial candidate at the tail; it is never bound to the role until accepted. */
    async function generatePreviewCandidate(run, batch) {
        const settings = getSettings(),
            preview = batch.preview;
        batch.pending = true;
        batch.dispatch = { itemId: preview.itemId, attemptId: newIdentity('attempt'), previewId: preview.id };
        checkpoint();
        const reply = await host.generateRoleReply(
            batch,
            batch.template.replaceAll(ROLE_PLACEHOLDER, () => preview.name),
            {
                signal: run.controller.signal,
                assertCurrent: () => assertCurrent(run),
                timeoutMs: settings.replyTimeoutMs || 600000,
                validationOptions: validationOptions(),
                expectedPrompt: batch.template,
            },
        );
        assertCurrent(run);
        batch.pending = false;
        batch.dispatch = null;
        if (!reply.text?.trim()) throw reply.error || new Error('酒馆没有返回正文');
        const previewOptions = validationOptions();
        const previewCheck = Number.isFinite(reply.tokenCount)
            ? { ...previewOptions, tokenCount: reply.tokenCount }
            : previewOptions;
        const incomplete = reply.truncated || isRoleCardTruncated(reply.text, previewCheck);
        notify(
            incomplete ? 'warning' : 'success',
            incomplete
                ? `「${preview.name}」的候选版本（第 ${reply.swipe + 1} 页）可能不完整，原角色页未改动；可左右切换比较，确认无误也可“用这版替换”`
                : `已生成「${preview.name}」的候选版本（第 ${reply.swipe + 1} 页），原角色页未改动；请选择“用这版替换”“再生成一版”或“放弃”`,
            { timeOut: 0, extendedTimeOut: 0, closeButton: true },
        );
        return reply;
    }
    function reportPreviewFailure(error) {
        onError(error, { phase: 'reroll-preview' });
        notify('warning', `候选版本生成失败，原角色页未改动：${error.message}`, {
            timeOut: 0,
            extendedTimeOut: 0,
            closeButton: true,
        });
    }
    /** After a trial generation, show the newest candidate; end the preview if no candidate exists. */
    async function landPreview(batch, reply) {
        const { message, candidates } = host.rolePreview(batch);
        if (!message) return;
        if (!candidates.length) {
            batch.preview = null;
            return;
        }
        const target = candidates.includes(reply?.swipe) ? reply.swipe : candidates.at(-1);
        await host.showRolePage(batch.preview.floor, target, batch.preview.identity);
    }
    async function rerollPreviewAgain() {
        if (active || preparing) return;
        preparing = true;
        const settings = getSettings(),
            initial = host.snapshot();
        const run = { identity: initial.identity, controller: new AbortController(), paused: false };
        active = run;
        settings.isRunning = true;
        settings.isPaused = false;
        onChange();
        let batch,
            reply = null,
            promptSent = false;
        try {
            restore();
            batch = state();
            if (!batch?.preview || batch.identity !== initial.identity) throw new Error('没有待确认的候选版本');
            if (initial.generating === true) throw new Error('请先等待酒馆当前生成结束');
            if (initial.connected === false) throw new Error('酒馆 API 尚未连接');
            await host.reconcileRoleBatch(batch, validationOptions());
            assertCurrent(run);
            await syncEditedTemplate(batch, run);
            assertCurrent(run);
            await host.prepareRolePreviewReroll(batch);
            assertCurrent(run);
            promptSent = true;
            reply = await generatePreviewCandidate(run, batch);
        } catch (error) {
            if (batch?.preview) batch.pending = !!error.uncertain || run.controller.signal.aborted;
            if (!run.controller.signal.aborted) reportPreviewFailure(error);
        } finally {
            if (batch?.preview) {
                try {
                    await landPreview(batch, reply);
                } catch (error) {
                    onError(error, { phase: 'reroll-restore' });
                }
            }
            if (batch?.preview && promptSent && host.snapshot().identity === run.identity) {
                try {
                    await host.restoreRoleTemplateIfEquals(
                        batch,
                        batch.template.replaceAll(ROLE_PLACEHOLDER, () => batch.preview.name),
                    );
                } catch (error) {
                    onError(error, { phase: 'restore-template' });
                }
            }
            active = null;
            preparing = false;
            settings.isRunning = false;
            settings.isPaused = false;
            if (batch) {
                try {
                    checkpoint(batch.identity);
                } catch (error) {
                    onError(error, { phase: 'save-recovery' });
                }
            } else onChange();
        }
    }
    async function resolvePreview(accept) {
        if (active || preparing) return;
        preparing = true;
        let batch,
            savedAction = false;
        try {
            restore();
            batch = state();
            if (!batch?.preview) throw new Error('没有待确认的候选版本');
            if (batch.identity !== host.snapshot().identity) throw new Error('请回到原批次聊天后再处理候选版本');
            if (batch.pending) await host.reconcileRoleBatch(batch, validationOptions());
            const preview = batch.preview;
            if (!accept) {
                const result = await host.discardRolePreview(batch);
                savedAction = true;
                batch.preview = null;
                checkpoint();
                notify(
                    result?.skipped ? 'warning' : 'info',
                    result?.skipped
                        ? '回复楼层已变化，已结束待确认状态，未删除任何页面；请手动核对末尾的候选页'
                        : `已放弃「${preview.name}」的候选版本，原角色页保持不变`,
                );
                return;
            }
            const result = await host.acceptRolePreview(batch);
            savedAction = true;
            const item = [...batch.items, ...(batch.history || [])].find((entry) => entry.id === preview.itemId);
            batch.preview = null;
            if (item) {
                const manualComplete =
                    result.status === 'invalid' || isRoleCardTruncated(result.text, validationOptions());
                Object.assign(item, {
                    processing: false,
                    processed: true,
                    failed: false,
                    parked: false,
                    manualStatus: manualComplete ? 'complete' : null,
                    legacy: false,
                    error: null,
                    nameWarning: detectRoleCardNameMismatch(
                        preview.name,
                        result.text,
                        getSettings().roleImageLibrary?.workNames,
                    ),
                    swipe: preview.index,
                });
                // 用候选版本替换成功，同样要收录进名录
                onRoleComplete(preview.name);
                clearRoleParked(getSettings(), preview.name);
            }
            checkpoint();
            if (item) {
                mirrorParkedAcrossOtherBatches(getSettings(), preview.name, false, { excludeIdentity: batch.identity });
            }
            if (!item) notify('warning', '已替换，但角色记录已变化，请核对名单状态');
            else if (result.refreshFailed)
                notify('warning', `${preview.name} 已保存，但页面刷新失败，请重新打开聊天查看`);
            else notify('success', `「${preview.name}」已替换为所选版本，其他候选版本已删除`);
        } catch (error) {
            onError(error, { phase: accept ? 'preview-accept' : 'preview-discard' });
            const prefix = savedAction
                ? accept
                    ? '新回复已保存，但任务状态未能确认'
                    : '候选页已处理，但任务状态未能确认'
                : error.uncertain
                  ? '保存结果未确认，请返回原聊天核对后再操作'
                  : accept
                    ? '未能替换'
                    : '未能放弃';
            notify('warning', `${prefix}：${error.message}`, {
                timeOut: 0,
                extendedTimeOut: 0,
                closeButton: true,
            });
        } finally {
            preparing = false;
            onChange();
        }
    }
    function editQueue(action, itemId, targetId) {
        const batch = state();
        if (
            !batch ||
            preparing ||
            (active && !active.queueRun) ||
            batch.preview ||
            batch.identity !== host.snapshot().identity
        )
            throw new Error('当前任务无法调整队列，请回到原聊天并等待准备完成');
        if (!active && host.snapshot().generating) throw new Error('请等待酒馆生成结束');
        const itemIndex = batch.items.findIndex((item) => item.id === itemId);
        const item = batch.items[itemIndex];
        if (!active && batch.pending && batch.dispatch?.itemId === itemId)
            throw new Error('该角色上一轮请求尚未确认，请先核对聊天');
        const boundary = active ? batch.index + (batch.items[batch.index]?.processing ? 1 : 0) : 0;
        const isRestoreAction = action === 'restore' || action === 'restore-origin';
        if (
            !item ||
            item.processing ||
            ((roleComplete(item) || (item.failed && action !== 'park')) && !(isRestoreAction && item.parked)) ||
            (active && itemIndex < boundary && !(isRestoreAction && item.parked))
        )
            throw new Error('只能调整待生成的角色');
        const previous = structuredClone(batch);
        const settings = getSettings();
        const previousParked = structuredClone(ensureRoleParked(settings));
        const oldNames = settings.roleNames;
        let mirrorState = null;
        try {
            if (action === 'park') {
                item.parked = true;
                recordRoleParked(settings, {
                    name: item.name,
                    failed: Boolean(item.failed),
                    error: item.error || null,
                });
                mirrorState = {
                    name: item.name,
                    parked: true,
                    failed: Boolean(item.failed),
                    error: item.error || null,
                };
            } else if (action === 'restore-origin') {
                if (!item.parked) return;
                item.parked = false;
                clearRoleParked(settings, item.name);
                mirrorState = { name: item.name, parked: false };
            } else if (action === 'restore') {
                if (!item.parked) return;
                item.parked = false;
                clearRoleParked(settings, item.name);
                batch.items.splice(itemIndex, 1);
                if (active && itemIndex < batch.index) batch.index--;
                batch.items.push(item);
                mirrorState = { name: item.name, parked: false };
            } else if (action === 'top' || action === 'move') {
                if (item.parked) throw new Error('请先将角色放回队列');
                const targetIndex =
                    action === 'top' ? boundary : batch.items.findIndex((entry) => entry.id === targetId);
                if (targetIndex < boundary || targetIndex < 0) throw new Error('只能移动到待生成队列');
                const target = batch.items[targetIndex];
                if (action === 'move' && (target.parked || target.processing || target.failed || roleComplete(target)))
                    throw new Error('只能移动到待生成的角色旁');
                batch.items.splice(itemIndex, 1);
                batch.items.splice(targetIndex, 0, item);
            } else throw new Error('无效的队列操作');
            batch.names = batch.items.map((entry) => entry.name);
            settings.roleNames = batch.names.join('\n');
            batch.inputNames = settings.roleNames;
            if (!active) batch.index = nextRoleIndex(batch);
            checkpoint();
            if (mirrorState) {
                mirrorParkedAcrossOtherBatches(settings, mirrorState.name, mirrorState.parked, {
                    excludeIdentity: batch.identity,
                    failed: mirrorState.failed,
                    error: mirrorState.error,
                });
            }
        } catch (error) {
            Object.assign(batch, previous);
            settings.roleNames = oldNames;
            settings.roleParked = previousParked;
            throw error;
        }
    }
    function parkRole(name) {
        const targetName = String(name || '').trim();
        if (!targetName) return false;
        if (preparing || (active && !active.queueRun)) throw new Error('当前任务无法调整队列，请先等待准备完成');
        if (!active && host.snapshot().generating) throw new Error('请等待酒馆生成结束');
        restore();
        const settings = getSettings();
        const batch = state();
        if (batch && batch.identity === host.snapshot().identity) {
            const item = batch.items.find((entry) => entry.name === targetName);
            if (item) {
                if (item.parked) {
                    recordRoleParked(settings, {
                        name: item.name,
                        failed: Boolean(item.failed),
                        error: item.error || null,
                    });
                    onChange();
                    return true;
                }
                editQueue('park', item.id);
                return true;
            }
        }
        const archiveMatcher = createRoleNameMatcher(
            normalizeRoleArchive(settings.roleArchive),
            settings.roleImageLibrary?.workNames,
        );
        if (archiveMatcher.has(targetName)) throw new Error('该角色已完成，无需暂移');
        recordRoleParked(settings, { name: targetName, failed: false, error: null });
        mirrorParkedAcrossOtherBatches(settings, targetName, true, { excludeIdentity: batch?.identity ?? null });
        onChange();
        return true;
    }
    function unparkRole(name, mode = 'restore-origin') {
        const targetName = String(name || '').trim();
        if (!targetName) return false;
        if (mode !== 'restore' && mode !== 'restore-origin') throw new Error('无效的队列操作');
        if (preparing || (active && !active.queueRun)) throw new Error('当前任务无法调整队列，请先等待准备完成');
        if (!active && host.snapshot().generating) throw new Error('请等待酒馆生成结束');
        restore();
        const settings = getSettings();
        const batch = state();
        if (batch && batch.identity === host.snapshot().identity) {
            const item = batch.items.find((entry) => entry.name === targetName);
            if (item) {
                if (item.parked) {
                    editQueue(mode, item.id);
                    return true;
                }
                clearRoleParked(settings, targetName);
                mirrorParkedAcrossOtherBatches(settings, targetName, false, { excludeIdentity: batch.identity });
                checkpoint();
                return true;
            }
        }
        const before = normalizeRoleParked(ensureRoleParked(settings));
        const existed = before.some((entry) => entry.name === targetName);
        clearRoleParked(settings, targetName);
        mirrorParkedAcrossOtherBatches(settings, targetName, false, { excludeIdentity: null });
        if (mode === 'restore') {
            const currentNames = parseRoleNames(settings.roleNames);
            const nextNames = [...currentNames.filter((entry) => entry !== targetName), targetName];
            settings.roleNames = nextNames.join('\n');
            settings.totalChapters = nextNames.length;
        }
        onChange();
        return existed;
    }
    return {
        start,
        generateOne(target = null) {
            if (!target) return start({ singleStep: true });
            if (typeof target === 'string') return start({ singleStep: true, targetItemId: target });
            return start({ singleStep: true, targetItemId: target.id || null, targetName: target.name || null });
        },
        rerollSelected,
        rerollPreviewAgain,
        acceptPreview: () => resolvePreview(true),
        discardPreview: () => resolvePreview(false),
        previewPending: () => !!state()?.preview,
        restore,
        activeBatch() {
            restore();
            return state();
        },
        migrateParkedFromBatches,
        saveInput,
        editQueue,
        parkRole,
        unparkRole,
        restoreAllParked() {
            if (preparing || (active && !active.queueRun))
                throw new Error('当前任务无法调整队列，请回到原聊天并等待准备完成');
            if (!active && host.snapshot().generating) throw new Error('请等待酒馆生成结束');
            restore();
            const settings = getSettings();
            const batch = state();
            if (!batch) {
                const globalParked = normalizeRoleParked(ensureRoleParked(settings));
                if (!globalParked.length) return 0;
                const parkedNames = globalParked.map((entry) => entry.name);
                const parkedSet = new Set(parkedNames);
                settings.roleParked = [];
                const currentNames = parseRoleNames(settings.roleNames);
                const kept = currentNames.filter((name) => !parkedSet.has(name));
                const moved = currentNames.filter((name) => parkedSet.has(name));
                if (moved.length) {
                    settings.roleNames = [...kept, ...moved].join('\n');
                    settings.totalChapters = currentNames.length;
                }
                mirrorParkedAcrossOtherBatches(settings, parkedNames, false);
                onChange();
                return parkedNames.length;
            }
            if (batch.preview || batch.identity !== host.snapshot().identity)
                throw new Error('当前任务无法调整队列，请回到原聊天并等待准备完成');
            const pendingId = !active && batch.pending ? batch.dispatch?.itemId : null;
            const pendingName = pendingId ? batch.items.find((entry) => entry.id === pendingId)?.name || null : null;
            const parkedItems = batch.items.filter((item) => item.parked && item.id !== pendingId);
            const parkedItemNames = new Set(parkedItems.map((item) => item.name));
            const extraGlobalNames = normalizeRoleParked(ensureRoleParked(settings))
                .map((entry) => entry.name)
                .filter((name) => name !== pendingName && !parkedItemNames.has(name));
            if (!parkedItems.length && !extraGlobalNames.length) return 0;
            const previous = structuredClone(batch);
            const previousParked = structuredClone(ensureRoleParked(settings));
            const oldNames = settings.roleNames;
            const unparkedNames = [...parkedItems.map((item) => item.name), ...extraGlobalNames];
            try {
                let shiftedBeforeIndex = 0;
                const remaining = [];
                batch.items.forEach((item, idx) => {
                    if (item.parked && item.id !== pendingId) {
                        if (active && idx < batch.index) shiftedBeforeIndex++;
                        item.parked = false;
                    } else {
                        remaining.push(item);
                    }
                });
                batch.items = [...remaining, ...parkedItems];
                if (active) batch.index = Math.max(0, batch.index - shiftedBeforeIndex);
                else batch.index = nextRoleIndex(batch);
                batch.names = batch.items.map((entry) => entry.name);
                settings.roleNames = batch.names.join('\n');
                batch.inputNames = settings.roleNames;
                clearRoleParked(settings, unparkedNames);
                checkpoint();
                mirrorParkedAcrossOtherBatches(settings, unparkedNames, false, { excludeIdentity: batch.identity });
                return unparkedNames.length;
            } catch (error) {
                Object.assign(batch, previous);
                settings.roleNames = oldNames;
                settings.roleParked = previousParked;
                throw error;
            }
        },
        addQueueNames(names) {
            const batch = state();
            if (
                !batch ||
                preparing ||
                (active && !active.queueRun) ||
                batch.preview ||
                batch.identity !== host.snapshot().identity
            )
                throw new Error('当前任务无法调整队列，请回到原聊天并等待准备完成');
            if (!active && host.snapshot().generating) throw new Error('请等待酒馆生成结束');
            const previous = structuredClone(batch);
            const settings = getSettings();
            const oldNames = settings.roleNames;
            try {
                const existing = new Set(batch.names);
                for (const name of parseRoleNames(names.join('\n'))) {
                    if (existing.has(name)) continue;
                    existing.add(name);
                    const oldIndex = (batch.history || []).findIndex((item) => item.name === name);
                    batch.items.push(
                        oldIndex >= 0 ? batch.history.splice(oldIndex, 1)[0] : { id: newIdentity('role'), name },
                    );
                }
                batch.names = batch.items.map((item) => item.name);
                settings.roleNames = batch.names.join('\n');
                batch.inputNames = settings.roleNames;
                const currentIndex = batch.index;
                applyParkedRoles(batch, ensureRoleParked(settings));
                applyArchiveSkips(batch, settings.roleArchive, settings.roleImageLibrary?.workNames);
                if (active) batch.index = currentIndex;
                checkpoint();
            } catch (error) {
                Object.assign(batch, previous);
                settings.roleNames = oldNames;
                throw error;
            }
        },
        async setRoleArchive(nextArchive) {
            if (active || preparing) throw new Error('请先停止任务，再修改已完成角色名录');
            restore();
            if (host.snapshot().generating === true) throw new Error('请等待酒馆当前生成结束');
            const settings = getSettings();
            const previousArchive = normalizeRoleArchive(settings.roleArchive);
            const previousParked = structuredClone(ensureRoleParked(settings));
            const next = normalizeRoleArchive(nextArchive);
            if (previousArchive.length === next.length && previousArchive.every((name, index) => name === next[index]))
                return { added: [], removed: [] };
            const batch = state();
            const allBatches = Object.values(ensureBatchMap(settings)).filter(Boolean);
            preparing = true;
            const archiveChangesList = [];
            try {
                settings.roleArchive = next;
                const previousSet = new Set(previousArchive);
                const newlyAdded = next.filter((name) => !previousSet.has(name));
                if (newlyAdded.length) {
                    const addedMatcher = createRoleNameMatcher(newlyAdded, settings.roleImageLibrary?.workNames);
                    settings.roleParked = normalizeRoleParked(ensureRoleParked(settings)).filter(
                        (entry) => entry.failed || !addedMatcher.has(entry.name),
                    );
                }
                let currentChanges = { added: [], removed: [] };
                for (const entryBatch of allBatches) {
                    const changes = applyRoleArchiveChanges(
                        entryBatch,
                        previousArchive,
                        next,
                        settings.roleImageLibrary?.workNames,
                    );
                    archiveChangesList.push(changes);
                    if (entryBatch === batch) currentChanges = changes;
                }
                onRoleArchiveChange();
                if (batch) checkpoint(batch.identity);
                else onChange();
                return { added: currentChanges.added, removed: currentChanges.removed };
            } catch (error) {
                settings.roleArchive = previousArchive;
                settings.roleParked = previousParked;
                for (const changes of archiveChangesList) changes?.rollback?.();
                onRoleArchiveChange();
                throw error;
            } finally {
                preparing = false;
            }
        },
        async setRoleStatus(index, status) {
            if (active || preparing) throw new Error('请先停止任务，再手动纠错');
            if (!['complete', 'failed', 'auto'].includes(status)) throw new Error('无效的角色状态');
            restore();
            const batch = state();
            if (!batch || batch.identity !== host.snapshot().identity) throw new Error('请回到原批次聊天后纠错');
            if (host.snapshot().generating === true) throw new Error('请等待酒馆当前生成结束');
            if (!Number.isInteger(index) || !batch.items[index]) throw new Error('角色名单已变化，请重新选择');
            assertNoPreview(batch);
            preparing = true;
            const previous = structuredClone(batch);
            const settings = getSettings();
            const previousArchive = normalizeRoleArchive(settings.roleArchive);
            const previousParked = structuredClone(ensureRoleParked(settings));
            let completedName = null;
            try {
                await host.reconcileRoleBatch(batch, validationOptions());
                if (host.snapshot().identity !== batch.identity) throw new Error('聊天已切换，请返回原聊天');
                const item = batch.items[index];
                if (!item || item.id !== previous.items[index].id) throw new Error('角色名单已变化，请重新选择');
                item.manualStatus = status === 'auto' ? null : status;
                if (status === 'complete') {
                    Object.assign(item, {
                        processed: true,
                        failed: false,
                        parked: false,
                        processing: false,
                        archived: false,
                        error: null,
                    });
                    onRoleComplete(item.name);
                    clearRoleParked(settings, item.name);
                    completedName = item.name;
                }
                if (status === 'failed') {
                    const nextArchive = removeRoleArchiveMatches(
                        settings.roleArchive,
                        item.name,
                        settings.roleImageLibrary?.workNames,
                    );
                    const archiveChanged =
                        previousArchive.length !== nextArchive.length ||
                        previousArchive.some((name, position) => name !== nextArchive[position]);
                    if (archiveChanged) {
                        settings.roleArchive = nextArchive;
                        applyRoleArchiveChanges(
                            batch,
                            previousArchive,
                            nextArchive,
                            settings.roleImageLibrary?.workNames,
                        );
                        onRoleArchiveChange();
                    }
                    Object.assign(item, {
                        processed: true,
                        failed: true,
                        processing: false,
                        archived: false,
                        manualStatus: 'failed',
                        error: null,
                    });
                }
                if (status === 'auto') {
                    await host.reconcileRoleBatch(batch, validationOptions());
                    applyArchiveSkips(batch, getSettings().roleArchive, getSettings().roleImageLibrary?.workNames);
                }
                if (host.snapshot().identity !== batch.identity) throw new Error('聊天已切换，请返回原聊天');
                batch.index = nextRoleIndex(batch);
                checkpoint();
                if (completedName) {
                    mirrorParkedAcrossOtherBatches(settings, completedName, false, { excludeIdentity: batch.identity });
                }
            } catch (error) {
                Object.assign(batch, previous);
                settings.roleArchive = previousArchive;
                settings.roleParked = previousParked;
                onRoleArchiveChange();
                throw error;
            } finally {
                preparing = false;
            }
        },
        async auditReplies() {
            if (active || preparing) throw new Error('请先停止任务，再核对备选页');
            restore();
            const batch = state();
            if (!batch || batch.identity !== host.snapshot().identity)
                throw new Error('请回到原批次聊天后再核对备选页');
            if (host.snapshot().generating === true) throw new Error('请等待酒馆当前生成结束');
            assertNoPreview(batch);
            if (!host.auditRoleBatch) throw new Error('当前宿主不支持备选页核对');
            preparing = true;
            const settings = getSettings();
            const workNames = settings.roleImageLibrary?.workNames;
            try {
                const options = validationOptions();
                const entries = await host.auditRoleBatch(batch, options);
                let truncatedFixed = 0;
                let archiveRemoved = 0;
                let archiveAdded = 0;
                let nameMismatches = 0;
                let adoptedCount = 0;
                let archiveChanged = false;
                const newlyParked = [];
                const newlyCleared = [];
                for (const entry of entries) {
                    const { item } = entry;
                    if (entry.truncated) {
                        const reason = truncationReason(entry, options);
                        Object.assign(item, {
                            processing: false,
                            processed: true,
                            failed: true,
                            parked: true,
                            archived: false,
                            manualStatus: null,
                            error: reason,
                            nameWarning: null,
                            swipe: entry.swipe,
                        });
                        recordRoleParked(settings, { name: item.name, failed: true, error: reason });
                        newlyParked.push({ name: item.name, error: reason });
                        truncatedFixed++;
                        const beforeLen = normalizeRoleArchive(settings.roleArchive).length;
                        const nextArchive = removeRoleArchiveMatches(settings.roleArchive, item.name, workNames);
                        if (nextArchive.length < beforeLen) {
                            settings.roleArchive = nextArchive;
                            archiveRemoved += beforeLen - nextArchive.length;
                            archiveChanged = true;
                        }
                    } else {
                        const nameWarning = detectRoleCardNameMismatch(item.name, entry.text, workNames);
                        item.nameWarning = nameWarning;
                        if (nameWarning) nameMismatches++;
                        if (item.manualStatus !== 'failed') {
                            Object.assign(item, {
                                processing: false,
                                processed: true,
                                failed: false,
                                parked: false,
                                error: null,
                                swipe: entry.swipe,
                            });
                            clearRoleParked(settings, item.name);
                            newlyCleared.push(item.name);
                            const beforeLen = Array.isArray(settings.roleArchive) ? settings.roleArchive.length : 0;
                            onRoleComplete(item.name);
                            const afterLen = Array.isArray(settings.roleArchive) ? settings.roleArchive.length : 0;
                            if (afterLen > beforeLen) archiveAdded += afterLen - beforeLen;
                        }
                    }
                }
                // 对尚无回执但正文完整的备选页，按正文 YAML 角色名唯一认领到未完成名单项，并同步收录名录。
                if (host.scanUnboundRoleReplies && host.bindRoleReply) {
                    const unbound = await host.scanUnboundRoleReplies(batch, options);
                    const completeUnbound = unbound.filter((entry) => !entry.truncated);
                    const unclaimedItems = (batch.items || []).filter(
                        (item) => !roleComplete(item) && item.manualStatus !== 'failed',
                    );
                    const itemHits = new Map();
                    for (const entry of completeUnbound) {
                        const matches = matchRoleCardToCandidates(unclaimedItems, entry.text, workNames);
                        if (matches.length !== 1) continue;
                        const item = matches[0];
                        const list = itemHits.get(item.id) || [];
                        list.push({ item, entry });
                        itemHits.set(item.id, list);
                    }
                    for (const hits of itemHits.values()) {
                        if (hits.length !== 1) continue;
                        const { item, entry } = hits[0];
                        if (await host.bindRoleReply(batch, item.id, entry.swipe)) {
                            Object.assign(item, {
                                processing: false,
                                processed: true,
                                failed: false,
                                parked: false,
                                archived: false,
                                manualStatus: null,
                                error: null,
                                nameWarning: null,
                                swipe: entry.swipe,
                            });
                            clearRoleParked(settings, item.name);
                            newlyCleared.push(item.name);
                            adoptedCount++;
                            const beforeLen = Array.isArray(settings.roleArchive) ? settings.roleArchive.length : 0;
                            onRoleComplete(item.name);
                            const afterLen = Array.isArray(settings.roleArchive) ? settings.roleArchive.length : 0;
                            if (afterLen > beforeLen) archiveAdded += afterLen - beforeLen;
                        }
                    }
                }
                if (archiveChanged) onRoleArchiveChange();
                batch.index = nextRoleIndex(batch);
                checkpoint();
                for (const entry of newlyParked) {
                    mirrorParkedAcrossOtherBatches(settings, entry.name, true, {
                        excludeIdentity: batch.identity,
                        failed: true,
                        error: entry.error,
                    });
                }
                if (newlyCleared.length) {
                    mirrorParkedAcrossOtherBatches(settings, newlyCleared, false, { excludeIdentity: batch.identity });
                }
                const summary = {
                    checked: entries.length,
                    truncatedFixed,
                    archiveRemoved,
                    archiveAdded,
                    nameMismatches,
                    adoptedCount,
                };
                if (!entries.length && !adoptedCount) {
                    notify('info', '当前批次还没有已绑定的备选回复可核对');
                } else if (!truncatedFixed && !nameMismatches && !archiveAdded && !adoptedCount) {
                    notify('success', `核对完成：已检查 ${entries.length} 页备选回复，全部完整且名称一致`);
                } else {
                    const parts = [];
                    if (entries.length) parts.push(`已检查 ${entries.length} 页`);
                    if (adoptedCount) parts.push(`认领 ${adoptedCount} 页未绑定完整回复`);
                    if (truncatedFixed) parts.push(`${truncatedFixed} 页截断已标失败并移至暂移区`);
                    if (archiveRemoved) parts.push(`已从名录移出 ${archiveRemoved} 项`);
                    if (archiveAdded) parts.push(`已补录名录 ${archiveAdded} 项`);
                    if (nameMismatches) parts.push(`${nameMismatches} 页角色名与名单不符（已标 ⚠）`);
                    notify(truncatedFixed || nameMismatches ? 'warning' : 'info', `核对完成：${parts.join('，')}`);
                }
                return summary;
            } finally {
                preparing = false;
            }
        },
        pause() {
            if (active) {
                active.paused = true;
                getSettings().isPaused = true;
                onChange();
            }
        },
        resume() {
            if (active) {
                active.paused = false;
                getSettings().isPaused = false;
                onChange();
            }
        },
        stop() {
            active?.controller.abort();
        },
        async resetPending({ restart = false } = {}) {
            if (active || preparing) return;
            preparing = true;
            try {
                const identity = currentIdentity();
                restore(identity);
                const batch = state(identity);
                if (batch?.preview) assertNoPreview(batch);
                if (batch && (!restart || batch.identity === identity)) {
                    if (!restart) await host.reconcileRoleBatch?.(batch, validationOptions());
                    await host.restoreRoleTemplate?.(batch);
                }
                if (restart) {
                    restartIdentity = identity;
                    if (typeof recovery?.clearForChat === 'function') recovery.clearForChat(identity);
                    else recovery?.clear?.();
                    setState(null, identity);
                    restoredChats.add(typeof identity === 'string' && identity ? identity : '__default__');
                    onChange();
                } else if (batch) {
                    hydrateRoleBatch(batch);
                    batch.index = nextRoleIndex(batch);
                    checkpoint(identity);
                }
            } finally {
                preparing = false;
            }
        },
    };
}

/**
 * 写卡流程压测（纯函数层，不需要酒馆）。
 *
 * 重点压「名录随着生成不断增长」这条路径：每完成一个角色都会调用
 * mergeRoleArchive 收录一次，如果每次都重建整个匹配器，总复杂度会到 O(n²)。
 *
 * 用法：node scripts/stress-role-flow.mjs
 */
import {
    mergeRoleArchive,
    applyArchiveSkips,
    updateRoleNames,
    dedupeRoleArchive,
} from '../src/novel/roleBatchState.js';
import { createRoleNameMatcher } from '../src/novel/roleName.js';

const time = (label, fn) => {
    const start = performance.now();
    const result = fn();
    const ms = performance.now() - start;
    console.log(`${label.padEnd(42)}${ms.toFixed(1).padStart(9)} ms`);
    return { result, ms };
};

const makeNames = (count) => Array.from({ length: count }, (_, i) => `碧蓝航线·角色${i}`);

for (const count of [1000, 3000, 5000]) {
    console.log(`\n===== 名单 ${count} 个 =====`);
    const list = makeNames(count);
    const works = ['碧蓝航线'];

    // 1) 真实生成路径：完成一个角色收录一次，名录逐个增长
    //    运行时用缓存的匹配器 has + add 增量更新，不再每次重建
    const { result: archive, ms: incremental } = time('逐个完成并收录（增量匹配器）', () => {
        const matcher = createRoleNameMatcher([], works);
        const grown = [];
        for (const name of list) {
            if (matcher.has(name)) continue;
            matcher.add(name);
            grown.push(name);
        }
        return grown;
    });
    if (archive.length !== count) throw new Error(`收录数量不对：${archive.length} != ${count}`);
    console.log(`${''.padEnd(42)}          平均 ${(incremental / count).toFixed(2)} ms/角色`);

    // 2) 一次性批量收录（对照，收录按钮/导入用）
    const { result: batchArchive } = time('批量收录（对照）', () => mergeRoleArchive([], list, works));

    // 3) 开始任务时按名录跳过
    const batch = {
        id: 'b',
        names: [...list],
        items: list.map((name, i) => ({ id: `i${i}`, name })),
        history: [],
    };
    time('applyArchiveSkips', () => applyArchiveSkips(batch, batchArchive, works));

    // 4) 名单变化后重建批次
    time('updateRoleNames（重建）', () => updateRoleNames(batch, list));

    // 5) 匹配器全量构建
    time('匹配器构建（名录全量）', () => createRoleNameMatcher(archive, works));

    // 6) 加载时合并重复写法
    const mixed = [...archive, ...archive.map((name) => name.replace('碧蓝航线·', ''))];
    const { result: deduped } = time('dedupeRoleArchive（含重复写法）', () => dedupeRoleArchive(mixed, works));
    console.log(`${''.padEnd(42)}          ${mixed.length} -> ${deduped.length} 条`);
}

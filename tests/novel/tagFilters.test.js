import { expect, it } from 'vitest';
import {
    parseTagInput,
    applyTagFilters,
    endsWithClosingMarker,
    estimateTokenCount,
    extractRoleCardNames,
    isRoleCardTruncated,
} from '../../src/novel/tagFilters.js';

it('preserves extraction and exclusion when moved out of the entry module', () => {
    expect(parseTagInput('正文，内容;备注')).toEqual(['正文', '内容', '备注']);
    expect(
        applyTagFilters('<正文>内容<备注>隐藏</备注></正文>', {
            extractMode: 'tags',
            extractTags: ['正文'],
            excludeTags: ['备注'],
        }),
    ).toBe('内容');
});

it('accepts complete quoted character data, HTML void elements and self-closing tags with attributes', () => {
    for (const text of [
        'name: 碧蓝航线·俾斯麦Zwei\ndescription: "完整的人物描述，性格坚毅。"',
        "name: 碧蓝航线·乌尔里希·冯·胡滕\ndescription: '完整的人物描述。'",
        '<character_design_complex>\n人物介绍<br>第二行<img src="头像.png">\n</character_design_complex>',
        '<character><portrait type="avatar" /><name>亚德</name></character>',
        '```yaml\nname: "碧蓝航线·兴登堡"\n```',
    ])
        expect(isRoleCardTruncated(text)).toBe(false);
    expect(isRoleCardTruncated('<character><portrait type="avatar" /><name>亚德</name>')).toBe(true);
});

it('treats regex characters in tag names literally', () => {
    expect(applyTagFilters('<a.b>正确</a.b><axb>错误</axb>', { extractMode: 'tags', extractTags: ['a.b'] })).toBe(
        '正确',
    );
});

it('detects unclosed tags, unclosed code blocks and truncated text as incomplete', () => {
    // 1. 未闭合的 XML/自定义标签
    expect(isRoleCardTruncated('<character>\n姓名：琴\n性格：温柔')).toBe(true);
    expect(isRoleCardTruncated('<character>\n姓名：琴\n性格：温柔\n</character>')).toBe(false);

    // 2. 未闭合的 Markdown 代码块（奇数个 ```）
    expect(isRoleCardTruncated('```json\n{\n  "name": "琴"')).toBe(true);
    expect(isRoleCardTruncated('```json\n{\n  "name": "琴"\n}\n```')).toBe(false);

    // 3. 常见逗号/未完结标点挂起
    expect(isRoleCardTruncated('这是一个很长的角色设定描述，角色平时喜欢看书，并且性格十分，')).toBe(true);
    expect(isRoleCardTruncated('这是一个很长的角色设定描述，角色平时喜欢看书，并且性格十分温和。')).toBe(false);

    // 4. 字数过短检查
    expect(isRoleCardTruncated('琴', { minLength: 50 })).toBe(true);
    expect(isRoleCardTruncated('这是一个字数足够多的角色设定描述文本内容。', { minLength: 10 })).toBe(false);
});

it('treats an explicit closing marker as the end of the card', () => {
    // 单独一行的 [end] / [结束] / [/card] 说明流是完整结束的
    const withEnd = (body) => `[start]\n<character_design_complex>\n${body}\n</character_design_complex>\n[end]`;
    // 装饰性标签不成对、代码块没闭合，都不再当作截断证据
    expect(isRoleCardTruncated(withEnd('【属性】\n<属性>\n火力：S\n防空：A'))).toBe(false);
    expect(isRoleCardTruncated(withEnd('【示例】\n```json\n{"a":1}'))).toBe(false);
    expect(isRoleCardTruncated('[start]\n<character_design_complex>\n正文\n[/card]')).toBe(false);
    // 没有结束标记时，原有的截断判断照常生效
    expect(isRoleCardTruncated('[start]\n<character_design_complex>\n【属性】\n<属性>\n火力：S')).toBe(true);
    expect(isRoleCardTruncated('[start]\n<character_design_complex>\n正文说完了一半，')).toBe(true);
});

it('ignores decorative tags deep inside a long card', () => {
    const longBody = `${'设定内容。'.repeat(120)}\n<装饰标签>\n${'更多设定。'.repeat(120)}`;
    // 标签只检查开头的外层结构，正文深处的不成对标签不算截断
    expect(isRoleCardTruncated(`<character_design_complex>\n${longBody}\n</character_design_complex>`)).toBe(false);
});

it('detects truncated fenced [start]/<character_design_complex> cards accurately', () => {
    const completeFenced = [
        '```',
        '[start]',
        '<character_design_complex>',
        'name: 雷电芽衣',
        'nicknames:',
        '  - 雷之律者',
        '</character_design_complex>',
        '[end]',
        '```',
    ].join('\n');
    expect(endsWithClosingMarker(completeFenced)).toBe(true);
    expect(isRoleCardTruncated(completeFenced)).toBe(false);

    // 代码块提前闭合，但缺少 </character_design_complex> 和 [end]
    const closedFenceMissingTag = ['```', '[start]', '<character_design_complex>', 'name: 雷电芽衣', '```'].join('\n');
    expect(isRoleCardTruncated(closedFenceMissingTag)).toBe(true);

    // 代码块和容器标签都闭合，但 [start] 没有配对 [end]
    const missingEnd = [
        '```',
        '[start]',
        '<character_design_complex>',
        'name: 雷电芽衣',
        '</character_design_complex>',
        '```',
    ].join('\n');
    expect(isRoleCardTruncated(missingEnd)).toBe(true);

    // 截断在普通方括号小节标题或 [start] 上，不能误判为显式结束标记
    for (const marker of ['[start]', '[外貌]', '[性格]', '[核心信息]']) {
        const truncatedAtHeader = `[start]\n<character_design_complex>\nname: 雷电芽衣\n${marker}`;
        expect(endsWithClosingMarker(truncatedAtHeader)).toBe(false);
        expect(isRoleCardTruncated(truncatedAtHeader)).toBe(true);
    }

    // 开头超过 500 字的思考过程后出现未闭合的 <character_design_complex>
    const longThink = `<think>${'思考过程。'.repeat(150)}</think>\n<character_design_complex>\nname: 雷电芽衣\nage: 18`;
    expect(isRoleCardTruncated(longThink)).toBe(true);

    // 多个 <character_design_complex> 只闭合了一个
    const secondUnclosed = [
        '<character_design_complex>\nname: 角色A\n</character_design_complex>',
        '<character_design_complex>\nname: 角色B\nage: 20',
    ].join('\n');
    expect(isRoleCardTruncated(secondUnclosed)).toBe(true);
});

it('extracts primary names and nicknames from YAML character cards', () => {
    const card = [
        '```yaml',
        '[start]',
        '<character_design_complex>',
        '# 核心信息',
        'name: "雷电芽衣（雷之律者）"',
        'nicknames:',
        '  - 芽衣',
        '  - "煮饭婆"',
        '  - 无',
        'version: 1',
        '</character_design_complex>',
        '[end]',
        '```',
    ].join('\n');
    expect(extractRoleCardNames(card)).toEqual({
        primaryNames: ['雷电芽衣（雷之律者）'],
        nicknames: ['芽衣', '煮饭婆'],
        allNames: ['雷电芽衣（雷之律者）', '芽衣', '煮饭婆'],
    });

    // 非角色卡纯文本不误提取
    expect(extractRoleCardNames('这是一段普通的纯文本回复，没有 YAML 名字字段。')).toEqual({
        primaryNames: [],
        nicknames: [],
        allNames: [],
    });
});

it('enforces minTokens even when a short card has valid closing markers', () => {
    const shortClosedCard =
        '```\n[start]\n<character_design_complex>\nname: 琴\n</character_design_complex>\n[end]\n```';
    // 未启用 minTokens 时，结构完整即通过
    expect(isRoleCardTruncated(shortClosedCard, { minTokens: 0 })).toBe(false);
    // 启用 minTokens（例如 5000）后，哪怕有 [end]，Token 不足仍然判为截断
    expect(isRoleCardTruncated(shortClosedCard, { minTokens: 5000, tokenCount: 850 })).toBe(true);
    expect(isRoleCardTruncated(shortClosedCard, { minTokens: 5000, tokenCount: 5200 })).toBe(false);
    // 未传入宿主 tokenCount 时使用本地估算值兜底
    expect(estimateTokenCount(shortClosedCard)).toBeGreaterThan(10);
    expect(isRoleCardTruncated(shortClosedCard, { minTokens: 5000 })).toBe(true);
});

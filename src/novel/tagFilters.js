export function parseTagInput(s) {
    if (!s || typeof s !== 'string') return [];
    return s
        .split(/[,;，；\s\n\r]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
}

export function escapeTagName(tag) {
    return tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractTagContents(text, tags, separator = '\n\n') {
    if (!text || !tags || tags.length === 0) return '';
    const parts = [];
    for (const tag of tags) {
        const t = tag.trim();
        if (!t) continue;
        const escaped = escapeTagName(t);
        const pattern = new RegExp(`<\\s*${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\s*/\\s*${escaped}\\s*>`, 'gi');
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const content = match[1].trim();
            if (content) parts.push(content);
        }
    }
    return parts.join(separator);
}

export function removeTagContents(text, tags) {
    if (!text || !tags || tags.length === 0) return text || '';
    let result = text;
    for (const tag of tags) {
        const t = tag.trim();
        if (!t) continue;
        const escaped = escapeTagName(t);
        const pairPattern = new RegExp(`<\\s*${escaped}(?:\\s[^>]*)?>[\\s\\S]*?<\\s*/\\s*${escaped}\\s*>`, 'gi');
        const selfClosingPattern = new RegExp(`<\\s*${escaped}(?:\\s[^>]*)?/\\s*>`, 'gi');
        result = result.replace(pairPattern, '').replace(selfClosingPattern, '');
    }
    return result.trim();
}

export function applyTagFilters(text, options = {}) {
    const { extractTags = [], excludeTags = [], extractMode = 'all', separator = '\n\n' } = options;
    if (!text) return '';

    let result = text;
    if (extractMode === 'tags' && extractTags.length > 0) {
        result = extractTagContents(result, extractTags, separator);
        if (!result) return '';
    }

    if (excludeTags.length > 0) {
        result = removeTagContents(result, excludeTags);
    }

    return result.trim();
}

/**
 * 校验角色卡文本是否完整闭合。
 * 若出现未闭合的代码块（```）、未配对的 [start]/[end]、未闭合的 <character_design_complex>
 * 或外层 XML/结构标签、末尾截断标点或字数不足，则判定为截断。
 */
/** 单独一行的显式开始标记。 */
const START_MARKER_PATTERN = /^\[\s*start\s*\]$/i;
/** 单独一行的显式结束标记，如 [end] / [结束] / [/card]；不把 [start] 或 [外貌] 当成结束。 */
const CLOSING_MARKER_PATTERN = /^\[\s*(?:end|结束|\/[a-zA-Z\u4e00-\u9fa5_][\w\u4e00-\u9fa5-]{0,14})\s*\]$/i;
/** 单独一行的闭合代码块围栏。 */
const FENCE_CLOSE_PATTERN = /^`{3,}\s*$/;
/** 写卡助手常用的顶层角色卡容器标签（不受前 500 字和外层代码块限制）。 */
const CARD_CONTAINER_OPEN_PATTERN = /<\s*character_design_complex(?:\s[^>]*)?>/gi;
const CARD_CONTAINER_CLOSE_PATTERN = /<\s*\/\s*character_design_complex\s*>/gi;

export function endsWithClosingMarker(text) {
    if (!text || typeof text !== 'string') return false;
    const lines = text.split(/\r?\n/);
    let skippedFence = false;
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index].trim();
        if (!line) continue;
        if (!skippedFence && FENCE_CLOSE_PATTERN.test(line)) {
            skippedFence = true;
            continue;
        }
        return CLOSING_MARKER_PATTERN.test(line);
    }
    return false;
}

function hasStandaloneLine(text, pattern) {
    return text.split(/\r?\n/).some((line) => pattern.test(line.trim()));
}

function unwrapOuterCodeFence(trimmed) {
    const openMatch = trimmed.match(/^`{3,}[^\n]*\r?\n([\s\S]*)$/);
    if (!openMatch) return trimmed;
    const body = openMatch[1];
    return body.replace(/\r?\n`{3,}\s*$/, '');
}

/** 当宿主未提供原生 tokenizer 时使用的中英文混合 Token 估算值。 */
export function estimateTokenCount(text) {
    if (!text || typeof text !== 'string') return 0;
    const trimmed = text.trim();
    if (!trimmed) return 0;
    let cjk = 0;
    let other = 0;
    for (let index = 0; index < trimmed.length; index++) {
        const code = trimmed.charCodeAt(index);
        if (
            (code >= 0x4e00 && code <= 0x9fff) ||
            (code >= 0x3400 && code <= 0x4dbf) ||
            (code >= 0x3040 && code <= 0x30ff) ||
            (code >= 0xac00 && code <= 0xd7af)
        ) {
            cjk++;
        } else if (code > 0x20) {
            other++;
        }
    }
    return Math.ceil(cjk * 0.8 + other * 0.3);
}

export function isRoleCardTruncated(text, options = {}) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed || trimmed === '...') return false;

    const { minLength = 0, minTokens = 0, tokenCount = null, expectedClosingTags = [] } = options;

    if (minLength > 0 && trimmed.length < minLength) {
        return true;
    }

    if (minTokens > 0) {
        const tokens = Number.isFinite(tokenCount) ? tokenCount : estimateTokenCount(trimmed);
        if (tokens < minTokens) return true;
    }

    // 以显式结束标记收尾（例如单独一行的 [end]、[结束]、[/card]，其后可紧跟闭合 ```）：
    // 说明流已完整结束，不再因正文深处的装饰性标签或内嵌示例误杀完整卡片。
    if (endsWithClosingMarker(trimmed)) {
        return false;
    }

    // 0. 显式 [start] 必须有对应的结束标记，否则必然未生成完毕
    if (hasStandaloneLine(trimmed, START_MARKER_PATTERN) && !hasStandaloneLine(trimmed, CLOSING_MARKER_PATTERN)) {
        return true;
    }

    // 1. Markdown 代码块三反引号成对闭合检查（奇数个 ``` 必然未闭合截断）
    const codeBlockTokens = trimmed.match(/```/g);
    if (codeBlockTokens && codeBlockTokens.length % 2 === 1) {
        return true;
    }

    // 2. 指定结束标签检查（若指定）
    if (Array.isArray(expectedClosingTags) && expectedClosingTags.length > 0) {
        const hasAnyClosed = expectedClosingTags.some((tag) => {
            const t = String(tag || '').trim();
            return t && trimmed.endsWith(t);
        });
        if (!hasAnyClosed) return true;
    }

    // 3. 角色卡顶层容器标签 <character_design_complex> 必须成对闭合（即使包在代码块里或 500 字之后）
    const containerOpens = trimmed.match(CARD_CONTAINER_OPEN_PATTERN)?.length || 0;
    if (containerOpens > 0) {
        const containerCloses = trimmed.match(CARD_CONTAINER_CLOSE_PATTERN)?.length || 0;
        if (containerCloses < containerOpens) {
            return true;
        }
    }

    // 4. XML / 自定义成对标签首尾闭合检查
    const openTags = [];
    const tagPattern = /<\s*([a-zA-Z\u4e00-\u9fa5_][a-zA-Z0-9\u4e00-\u9fa5_-]*)(?:\s[^>]*)?\s*\/?>/g;
    const voidTags = new Set([
        'area',
        'base',
        'br',
        'col',
        'embed',
        'hr',
        'img',
        'input',
        'link',
        'meta',
        'param',
        'source',
        'track',
        'wbr',
    ]);
    // 剥离最外层代码块围栏与开头的思考块后再取前 500 字，避免整个角色卡包在 ``` 里时外层标签被吞掉；
    // 正文深处的不成对装饰性标签仍不作为截断证据。
    const unwrapped = unwrapOuterCodeFence(trimmed);
    const withoutLeadingThink = unwrapped.replace(/^(?:\s*<think>[\s\S]*?<\/think>\s*)+/i, '');
    const header = withoutLeadingThink.replace(/```[\s\S]*?```/g, ' ').slice(0, 500);
    let match;
    while ((match = tagPattern.exec(header)) !== null) {
        const tagName = match[1].toLowerCase();
        if (voidTags.has(tagName) || /\/\s*>$/.test(match[0])) continue;
        openTags.push(tagName);
    }

    if (openTags.length > 0) {
        for (const tag of openTags) {
            const escaped = escapeTagName(tag);
            const closePattern = new RegExp(`<\\s*/\\s*${escaped}\\s*>`, 'i');
            if (!closePattern.test(trimmed)) {
                return true;
            }
        }
    }

    // 5. JSON 顶层大括号配对检查（以 { 开头时）
    if (trimmed.startsWith('{') && !trimmed.endsWith('}')) {
        return true;
    }

    // 6. 常见截断停顿标点（句子说到一半硬断掉）
    if (trimmed.length >= 20) {
        const trailingHangingPattern = /[，,、:：\\/（([【{\-~—]\s*$/;
        if (trailingHangingPattern.test(trimmed)) {
            return true;
        }
    }

    return false;
}

const PLACEHOLDER_CARD_VALUES = new Set(['无', '暂无', '没有', 'none', 'null', 'n/a', 'na', '-', '—', '未知']);

function cleanCardScalar(raw) {
    let value = String(raw || '').trim();
    if (!value) return '';
    // 去掉行尾注释（仅当 # 前有空白，避免截断颜色码或名称里的 #）
    value = value.replace(/\s+#.*$/, '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1).trim();
    }
    if (!value || value.includes('${') || PLACEHOLDER_CARD_VALUES.has(value.toLowerCase())) return '';
    return value;
}

/**
 * 从角色卡文本中提取 YAML 风格的 name 与 nicknames，用于核对备选回复是否对应名单角色。
 * 若文本不含可识别的 name 字段，返回空列表，调用方不做误报。
 */
export function extractRoleCardNames(text) {
    if (!text || typeof text !== 'string') return { primaryNames: [], nicknames: [], allNames: [] };
    const blocks = [];
    const blockPattern = /<\s*character_design_complex(?:\s[^>]*)?>([\s\S]*?)<\s*\/\s*character_design_complex\s*>/gi;
    let blockMatch;
    while ((blockMatch = blockPattern.exec(text)) !== null) {
        blocks.push(blockMatch[1]);
    }
    const sources = blocks.length ? blocks : [unwrapOuterCodeFence(text.trim())];
    const primaryNames = [];
    const nicknames = [];
    const addUnique = (list, value) => {
        const cleaned = cleanCardScalar(value);
        if (cleaned && !list.includes(cleaned)) list.push(cleaned);
    };
    for (const source of sources) {
        const lines = source.split(/\r?\n/);
        let inNicknames = false;
        let nicknamesIndent = 0;
        for (const rawLine of lines) {
            const trimmedLine = rawLine.trim();
            if (!trimmedLine || trimmedLine.startsWith('#')) continue;
            const indent = rawLine.length - rawLine.trimStart().length;
            if (inNicknames) {
                const itemMatch = trimmedLine.match(/^-\s+(.+)$/);
                if (itemMatch && indent >= nicknamesIndent) {
                    addUnique(nicknames, itemMatch[1]);
                    continue;
                }
                if (indent <= nicknamesIndent) inNicknames = false;
            }
            const nameMatch = rawLine.match(/^\s*name\s*[:：]\s*(.+)$/i);
            if (nameMatch) {
                addUnique(primaryNames, nameMatch[1]);
                inNicknames = false;
                continue;
            }
            const nickMatch = rawLine.match(/^(\s*)(?:nicknames|aliases)\s*[:：]\s*(.*)$/i);
            if (nickMatch) {
                const rest = nickMatch[2].trim();
                if (rest.startsWith('[') && rest.endsWith(']')) {
                    for (const part of rest.slice(1, -1).split(/[,，、]/)) addUnique(nicknames, part);
                    inNicknames = false;
                } else if (rest) {
                    for (const part of rest.split(/[,，、]/)) addUnique(nicknames, part);
                    inNicknames = false;
                } else {
                    inNicknames = true;
                    nicknamesIndent = nickMatch[1].length;
                }
            }
        }
    }
    const extraNames = [];
    for (const primary of primaryNames) {
        const glossMatch = primary.match(/[(（]([^()（）]+)[)）]/g);
        if (!glossMatch) continue;
        for (const segment of glossMatch) {
            const inner = cleanCardScalar(segment.slice(1, -1));
            if (
                inner &&
                !/[\u3400-\u4dbf\u4e00-\u9fff]/.test(inner) &&
                /[a-zA-Z\u3040-\u30ff\uac00-\ud7af]{2,}/.test(inner)
            ) {
                extraNames.push(inner);
            }
        }
    }
    const allNames = [...new Set([...primaryNames, ...nicknames, ...extraNames])];
    return { primaryNames, nicknames, allNames };
}

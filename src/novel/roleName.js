// 名单、名录和图片共用同一套角色名规则，不要各自再写一份。
// 这里不依赖任何其他模块，避免和 roleImageLibrary / roleBatchState 形成循环引用。

function uniqueStrings(values) {
    return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

// ============================================
// 名称匹配：[作品名前缀] + 角色名 + [备注（皮肤/装甲/形态）]
// ============================================

const OPEN_BRACKETS = '(（[［{｛【〔〖「『《〈<＜';
const CLOSE_BRACKETS = ')）]］}｝】〕〗」』》〉>＞';

/** Fold width, brackets and case; brackets all become ASCII parentheses. */
export function unifyName(value) {
    let text = String(value ?? '').normalize('NFKC');
    let result = '';
    for (const character of text) {
        if (OPEN_BRACKETS.includes(character)) result += '(';
        else if (CLOSE_BRACKETS.includes(character)) result += ')';
        else result += character;
    }
    text = result.toLowerCase();
    return text;
}

/** Remove punctuation, symbols, spaces and middle dots; keep letters, digits and CJK. */
export function compact(value) {
    return unifyName(value).replace(/[\p{P}\p{S}\p{Cf}\p{Z}\s]+/gu, '');
}

/** Full-string key: only width, punctuation, brackets, spaces and case are ignored. */
export function normalizeRoleImageName(value) {
    return compact(value);
}

export function workKeysOf(workNames) {
    return uniqueStrings((Array.isArray(workNames) ? workNames : []).map(compact)).sort((a, b) => b.length - a.length);
}

/**
 * Split a name into role and notes, dropping the work name wherever it appears as a prefix or
 * as bracket content. `安比（绝区零）改`, `绝区零安比改` and `安比（改）` all give key `安比改`.
 * `work` is the removed work name (compact form), or '' when the name carries none.
 */
export function parseRoleImageName(value, workNames = []) {
    return parseWithWorkKeys(value, workKeysOf(workNames));
}

const HAS_HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const HAS_FOREIGN_RE = /[a-z\u3040-\u30ff\uac00-\ud7af]/;
const PURE_NUMBER_OR_MODEL_RE = /^(?:\d+|(?:v|ver|mk|type|no)\d+[a-z]?)$/i;

/** 明确的英文形态、职阶、稀有度与编号后缀：不能当作外文原名注释丢掉。 */
const FOREIGN_FORM_TOKENS = new Set([
    'meta',
    'alter',
    'lily',
    'proto',
    'kai',
    'kai2',
    'kaini',
    'zwei',
    'drei',
    'eins',
    'muse',
    'u',
    'μ',
    'terror',
    'sp',
    'ex',
    'dx',
    'hd',
    'pro',
    'plus',
    'zero',
    'origin',
    'prime',
    'summer',
    'winter',
    'spring',
    'autumn',
    'xmas',
    'christmas',
    'halloween',
    'bride',
    'wedding',
    'maid',
    'bunny',
    'idol',
    'swimsuit',
    'dress',
    'casual',
    'uniform',
    'skin',
    'costume',
    'retrofit',
    'mod',
    'ver',
    'version',
    'type',
    'mark',
    'mk',
    'saber',
    'lancer',
    'archer',
    'rider',
    'caster',
    'assassin',
    'berserker',
    'ruler',
    'avenger',
    'mooncancer',
    'foreigner',
    'pretender',
    'shielder',
    'beast',
    'alterego',
    's',
    'a',
    'b',
    'c',
    'd',
    'e',
    'r',
    'sr',
    'ssr',
    'ur',
    'lr',
    'n',
    'i',
    'ii',
    'iii',
    'iv',
    'v',
    'vi',
    'vii',
    'viii',
    'ix',
    'x',
]);

/** 常见中文形态/服装后缀：外文名带这些括号（如 Saber（泳装））时不能把括号内容当成中文译名。 */
const CJK_FORM_NOTES = new Set([
    '改',
    '改造',
    '二改',
    '三改',
    '泳装',
    '水着',
    '皮肤',
    '换装',
    '私服',
    '常服',
    '校服',
    '礼服',
    '正月',
    '圣诞',
    '万圣节',
    '兔女郎',
    '女仆',
    '女仆装',
    '偶像',
    '花嫁',
    '婚纱',
    '觉醒',
    '黑化',
    '幼女',
    '兵装',
    '律者',
    '形态',
    '立绘',
    '初始',
    '本体',
    '原型',
    '应援团',
    '旗袍',
    '和服',
    '浴衣',
    '睡衣',
    '赛车',
    '运动服',
    '体操服',
]);

function isForeignFormGroup(rawGroup, compactGroup) {
    if (compactGroup.length <= 1) return true;
    const tokens = String(rawGroup || '')
        .split(/[\p{P}\p{S}\p{Z}\s]+/u)
        .filter(Boolean);
    if (!tokens.length) return true;
    return tokens.every((token) => FOREIGN_FORM_TOKENS.has(token) || PURE_NUMBER_OR_MODEL_RE.test(token));
}

function isForeignGlossForHanRole(rawGroup, compactGroup) {
    if (!compactGroup || HAS_HAN_RE.test(compactGroup) || !HAS_FOREIGN_RE.test(compactGroup)) return false;
    return !isForeignFormGroup(rawGroup, compactGroup);
}

function isHanGlossForForeignRole(compactGroup) {
    if (!compactGroup || !HAS_HAN_RE.test(compactGroup)) return false;
    return !CJK_FORM_NOTES.has(compactGroup);
}

export function parseWithWorkKeys(value, workKeys) {
    const text = unifyName(value);
    let outside = '';
    const groups = [];
    let depth = 0;
    let current = '';
    for (const character of text) {
        if (character === '(') {
            if (depth > 0) current += character;
            depth++;
        } else if (character === ')' && depth > 0) {
            depth--;
            if (depth === 0) {
                groups.push(current);
                current = '';
            } else current += character;
        } else if (depth > 0) current += character;
        else outside += character;
    }
    if (depth > 0) outside += current;
    const workSet = new Set(workKeys);
    const groupEntries = groups.map((raw) => ({ raw, key: compact(raw) })).filter((entry) => entry.key);
    let work = groupEntries.find((entry) => workSet.has(entry.key))?.key || '';
    const nonWorkGroups = groupEntries.filter((entry) => !workSet.has(entry.key));
    let role = compact(outside);
    for (const key of workKeys) {
        if (role.length > key.length && role.startsWith(key)) {
            role = role.slice(key.length);
            work ||= key;
            break;
        }
    }
    if (workSet.has(role)) {
        work ||= role;
        role = '';
    }
    const notes = [];
    const roleHasHan = HAS_HAN_RE.test(role);
    const roleIsForeign = !roleHasHan && HAS_FOREIGN_RE.test(role);
    let promotedHanRole = '';
    for (const entry of nonWorkGroups) {
        if (roleHasHan && isForeignGlossForHanRole(entry.raw, entry.key)) {
            continue;
        }
        if (roleIsForeign && !promotedHanRole && isHanGlossForForeignRole(entry.key)) {
            promotedHanRole = entry.key;
            continue;
        }
        notes.push(entry.key);
    }
    if (promotedHanRole) role = promotedHanRole;
    if (!role && notes.length) role = notes.shift();
    return { role, notes, key: role + notes.join(''), work };
}

// Reverse UTF-16 code units so prefix comparison exactly preserves String#slice suffix semantics.
const reverseName = (name) => name.split('').reverse().join('');

/**
 * 名录和名单之间比对“是不是同一个角色”。
 *
 * 名单可以不写作品名（`约克城II`），名录里记的可能是全名（`碧蓝航线·约克城II`）；
 * 图片匹配早就允许作品名可选、忽略全／半角与括号，名录沿用同一解析规则。
 * 作品名清单没登记时，保留原有的后缀回退；这条规则不用于配图。
 */
export function createRoleNameMatcher(names, workNames = []) {
    const workKeys = workKeysOf(workNames);
    const byKey = new Map();
    const reversedNames = new Set();
    const addReversed = (str) => {
        if (str.length > 1) reversedNames.add(reverseName(str));
    };
    for (const raw of Array.isArray(names) ? names : []) {
        const name = String(raw ?? '').trim();
        if (!name) continue;
        const parsed = parseWithWorkKeys(name, workKeys);
        addReversed(compact(name));
        if (parsed.key) {
            addReversed(parsed.key);
            if (!byKey.has(parsed.key)) byKey.set(parsed.key, new Set());
            byKey.get(parsed.key).add(parsed.work);
        }
    }
    // A suffix of a name becomes a prefix of its reversal. Store one string per name,
    // rather than allocating every suffix (quadratic character storage for long names).
    // 反转名保持有序：新增时按二分位置插入，避免每次收录都整表重排
    const sortedNames = [...reversedNames].sort();
    const insertSorted = (value) => {
        let low = 0;
        let high = sortedNames.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (sortedNames[middle] < value) low = middle + 1;
            else high = middle;
        }
        sortedNames.splice(low, 0, value);
    };
    return {
        /** 增量收录一个名字：名录逐个增长时避免每次重建整个匹配器（O(n²)）。 */
        add(value) {
            const name = String(value ?? '').trim();
            if (!name) return;
            const parsed = parseWithWorkKeys(name, workKeys);
            for (const candidate of [compact(name), parsed.key]) {
                if (candidate && candidate.length > 1) {
                    const reversed = reverseName(candidate);
                    if (!reversedNames.has(reversed)) {
                        reversedNames.add(reversed);
                        insertSorted(reversed);
                    }
                }
            }
            if (!parsed.key) return;
            if (!byKey.has(parsed.key)) byKey.set(parsed.key, new Set());
            byKey.get(parsed.key).add(parsed.work);
        },
        /** 名录里是否已经有这个角色（任一可接受写法都算）。 */
        has(value) {
            const name = String(value ?? '').trim();
            if (!name) return false;
            const parsed = parseWithWorkKeys(name, workKeys);
            const works = byKey.get(parsed.key);
            if (works) {
                if (!parsed.work || works.has('') || works.has(parsed.work)) return true;
                // 同角色名但明确属于不同作品，直接返回 false，不再落入后缀回退。
                return false;
            }
            const compactTarget = compact(name);
            const candidates =
                !parsed.work && parsed.key && parsed.key !== compactTarget
                    ? [parsed.key, compactTarget]
                    : [compactTarget];
            for (const target of candidates) {
                if (target.length < 2) continue;
                const reversed = reverseName(target);
                let low = 0;
                let high = sortedNames.length;
                while (low < high) {
                    const middle = low + Math.floor((high - low) / 2);
                    if (sortedNames[middle] < reversed) low = middle + 1;
                    else high = middle;
                }
                if (sortedNames[low]?.startsWith(reversed)) return true;
            }
            return false;
        },
    };
}

export { uniqueStrings };

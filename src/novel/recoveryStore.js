// @ts-check
/** Synchronous journal: storage must acknowledge uncertainty before the host dispatches. */
/** @param {() => Storage} getStorage @param {string} key */
export function createRoleBatchRecoveryStore(getStorage, key = 'novel-auto-generator:role-batch:v1') {
    /** @param {string} storageKey */
    function readKey(storageKey) {
        const raw = getStorage().getItem(storageKey);
        if (raw == null) return null;
        const record = JSON.parse(raw);
        if (record?.schemaVersion !== 1 || typeof record.updatedAt !== 'number')
            throw new Error('批量任务恢复记录无效，请查看错误日志');
        if (record.cleared === true) return record;
        if (
            typeof record.id !== 'string' ||
            typeof record.identity !== 'string' ||
            typeof record.template !== 'string' ||
            !Array.isArray(record.names) ||
            !record.names.every(/** @param {unknown} name */ (name) => typeof name === 'string') ||
            !Array.isArray(record.items) ||
            !Number.isInteger(record.promptFloor) ||
            record.promptFloor < 0
        )
            throw new Error('批量任务恢复记录不完整，请查看错误日志');
        return record;
    }
    /** @param {string} identity */
    const chatKey = (identity) => `${key}:chat:${identity}`;
    return {
        read() {
            return readKey(key);
        },
        /** @param {Record<string, any>} batch */
        write(batch) {
            getStorage().setItem(key, JSON.stringify(batch));
        },
        clear() {
            getStorage().setItem(key, JSON.stringify({ schemaVersion: 1, cleared: true, updatedAt: Date.now() }));
        },
        /** @param {string} identity */
        readForChat(identity) {
            if (typeof identity !== 'string' || !identity) return readKey(key);
            const scoped = readKey(chatKey(identity));
            if (scoped) return scoped;
            const legacy = readKey(key);
            if (legacy && !legacy.cleared && legacy.identity === identity) return legacy;
            return null;
        },
        /** @param {string} identity @param {Record<string, any>} batch */
        writeForChat(identity, batch) {
            const payload = JSON.stringify(batch);
            if (typeof identity === 'string' && identity) getStorage().setItem(chatKey(identity), payload);
            getStorage().setItem(key, payload);
        },
        /** @param {string} identity */
        clearForChat(identity) {
            const payload = JSON.stringify({ schemaVersion: 1, cleared: true, updatedAt: Date.now() });
            if (typeof identity === 'string' && identity) getStorage().setItem(chatKey(identity), payload);
            const legacy = (() => {
                try {
                    return readKey(key);
                } catch {
                    return null;
                }
            })();
            if (!identity || !legacy || legacy.cleared || legacy.identity === identity) {
                getStorage().setItem(key, payload);
            }
        },
    };
}

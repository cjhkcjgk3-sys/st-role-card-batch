import { host } from './host/runtime.js';
import { initNovelUI } from './novel/runtime.js';
let novelUI;
export function enableRoleExtension() {
    novelUI = initNovelUI(host);
}
export function disposeRoleExtension() {
    novelUI?.dispose();
    novelUI = null;
}
enableRoleExtension();

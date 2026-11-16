import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLUGIN_DISPLAY_NAME } from '../../src/novel/runtime.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const EXPECTED_NAME = '角色卡批量生成器';

describe('plugin branding', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    const runtime = readFileSync(join(root, 'src/novel/runtime.js'), 'utf8');
    const header = runtime.match(/<div class="inline-drawer-toggle inline-drawer-header">\s*<b>([\s\S]*?)<\/b>/);
    const renderedTitle = header?.[1].includes('PLUGIN_DISPLAY_NAME') ? PLUGIN_DISPLAY_NAME : header?.[1].trim();

    it('uses the same visible name in the extension list and the settings panel', () => {
        expect(manifest.display_name).toBe(EXPECTED_NAME);
        expect(PLUGIN_DISPLAY_NAME).toBe(manifest.display_name);
        expect(header).not.toBeNull();
        expect(header[1].trim()).toBe('${PLUGIN_DISPLAY_NAME}');
        expect(renderedTitle).toBe(EXPECTED_NAME);
        expect(renderedTitle).not.toMatch(/小说/);
    });

    it('does not render the old plugin name in the live settings markup', () => {
        const start = runtime.indexOf('function createUI()');
        const end = runtime.indexOf('function applyPanelStates()');
        const createUi = runtime.slice(start, end);
        expect(createUi.length).toBeGreaterThan(0);
        expect(createUi).toContain('<b>${PLUGIN_DISPLAY_NAME}</b>');
        expect(createUi).not.toMatch(/小说自动生成器|小说生成器/);
    });
});

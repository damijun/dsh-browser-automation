import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTabList,
  currentIndex,
  describeTabs,
} from '../src/tab-list.js';

/** Captured from `playwright-cli -s=dsh tab-list` (playwright-cli 0.1.22). */
const REAL_SAMPLE = [
  '- 0: [dsh 侧边栏浏览器是否支持 CDP 接口 — DeepSeek Harness](dsh-app://app/)',
  '- 1: [哔哩哔哩 (゜-゜)つロ 干杯~-bilibili](https://www.bilibili.com/)',
  '- 2: (current) [搜索 - Microsoft 必应](https://cn.bing.com/)',
].join('\n');

test('parses the real three-tab sample', () => {
  const { tabs, ignored } = parseTabList(REAL_SAMPLE);
  assert.equal(ignored.length, 0);
  assert.equal(tabs.length, 3);
  assert.deepEqual(
    tabs.map((tab) => tab.index),
    [0, 1, 2],
  );
  assert.deepEqual(
    tabs.map((tab) => tab.current),
    [false, false, true],
  );
  assert.equal(tabs[0].url, 'dsh-app://app/');
  assert.equal(tabs[1].title, '哔哩哔哩 (゜-゜)つロ 干杯~-bilibili');
  assert.equal(tabs[2].url, 'https://cn.bing.com/');
});

test('handles a title containing brackets and parentheses', () => {
  const line = '- 0: (current) [A [b] (c) - pageId-s1-ab12cd34](https://example.com/)';
  const { tabs } = parseTabList(line);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].title, 'A [b] (c) - pageId-s1-ab12cd34');
  assert.equal(tabs[0].url, 'https://example.com/');
  assert.equal(tabs[0].current, true);
});

test('handles a URL containing parentheses', () => {
  const line = '- 3: [Wiki (disambiguation)](https://en.wikipedia.org/wiki/Foo_(bar))';
  const { tabs } = parseTabList(line);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].title, 'Wiki (disambiguation)');
  assert.equal(tabs[0].url, 'https://en.wikipedia.org/wiki/Foo_(bar)');
});

test('tolerates CRLF and surrounding whitespace', () => {
  const { tabs } = parseTabList('  - 7: [T](https://a.test/)\r\n\r\n');
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].index, 7);
});

test('collects unrecognized lines instead of dropping the list', () => {
  const output = [
    '- 0: [T](https://a.test/)',
    '- [Snapshot](.playwright-cli/page-2026-10-28T10-24-07-036Z.yml)',
    '',
  ].join('\n');
  const { tabs, ignored } = parseTabList(output);
  assert.equal(tabs.length, 1);
  assert.equal(ignored.length, 1);
  assert.match(ignored[0], /Snapshot/);
});

test('empty output yields an empty list', () => {
  assert.deepEqual(parseTabList(''), { tabs: [], ignored: [] });
  assert.deepEqual(parseTabList(undefined), { tabs: [], ignored: [] });
});

test('reports the current index', () => {
  assert.equal(currentIndex(REAL_SAMPLE), 2);
  assert.equal(currentIndex('- 0: [T](https://a.test/)'), undefined);
});

test('describeTabs reports only the documented fields', () => {
  const described = describeTabs(parseTabList(REAL_SAMPLE).tabs);
  assert.deepEqual(Object.keys(described[0]), ['index', 'current', 'title', 'url']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTabList,
  matchPage,
  resolveIndex,
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

test('resolves an index by page id in a title', () => {
  const pageId = 'dshpg-3f9a1c-77aa11bb';
  const output = [
    '- 0: [T](https://a.test/)',
    `- 1: [Example Domain [${pageId}]](https://example.com/)`,
    '- 2: (current) [Other](https://b.test/)',
  ].join('\n');
  const hit = resolveIndex(output, pageId);
  assert.equal(hit.index, 1);
  assert.equal(hit.current, false);
  assert.equal(hit.url, 'https://example.com/');
});

test('resolves an index by page id in a URL fragment', () => {
  const pageId = 'dshpg-aaaaaa-12345678';
  const output = `- 4: [T](https://a.test/#${pageId})`;
  assert.equal(resolveIndex(output, pageId).index, 4);
});

test('index drift after other tabs close still resolves', () => {
  const pageId = 'dshpg-aaaaaa-12345678';
  const before = [
    `- 0: [Mine [${pageId}]](https://mine.test/)`,
    '- 1: [Neighbour](https://other.test/)',
  ].join('\n');
  const after = `- 0: [Mine [${pageId}]](https://mine.test/)`;
  assert.equal(resolveIndex(before, pageId).index, 0);
  assert.equal(resolveIndex(after, pageId).index, 0);

  const shifted = [
    '- 0: [Neighbour](https://other.test/)',
    `- 1: [Mine [${pageId}]](https://mine.test/)`,
  ].join('\n');
  assert.equal(resolveIndex(shifted, pageId).index, 1);
});

test('missing page id raises PAGE_NOT_FOUND with the current snapshot', () => {
  assert.throws(
    () => resolveIndex(REAL_SAMPLE, 'dshpg-deadbe-00000000'),
    (error) => {
      assert.equal(error.code, 'PAGE_NOT_FOUND');
      assert.equal(error.tabs.length, 3);
      return true;
    },
  );
});

test('duplicate page ids raise AMBIGUOUS_PAGE instead of picking the first', () => {
  const pageId = 'dshpg-same00-11112222';
  const output = [
    `- 0: [One [${pageId}]](https://one.test/)`,
    `- 1: [Two [${pageId}]](https://two.test/)`,
  ].join('\n');
  assert.throws(
    () => resolveIndex(output, pageId),
    (error) => {
      assert.equal(error.code, 'AMBIGUOUS_PAGE');
      assert.deepEqual(
        error.matches.map((match) => match.index),
        [0, 1],
      );
      return true;
    },
  );
});

test('different pages resolve independently', () => {
  const a = 'dshpg-aaa-00000001';
  const b = 'dshpg-bbb-00000002';
  const output = [
    `- 0: [A [${a}]](https://a.test/)`,
    `- 1: [B [${b}]](https://b.test/)`,
  ].join('\n');
  assert.equal(resolveIndex(output, a).index, 0);
  assert.equal(resolveIndex(output, b).index, 1);
  assert.deepEqual(
    matchPage(parseTabList(output).tabs, a).map((tab) => tab.index),
    [0],
  );
});

test('includes page ids sharing a session prefix only once each', () => {
  const session = 'dshpg-abc123';
  const one = `${session}-aaaaaaaa`;
  const two = `${session}-bbbbbbbb`;
  const output = [
    `- 0: [One [${one}]](https://a.test/)`,
    `- 1: [Two [${two}]](https://b.test/)`,
  ].join('\n');
  assert.deepEqual(
    matchPage(parseTabList(output).tabs, session).map((tab) => tab.index),
    [0, 1],
  );
});

test('reports the current index', () => {
  assert.equal(currentIndex(REAL_SAMPLE), 2);
  assert.equal(currentIndex('- 0: [T](https://a.test/)'), undefined);
});

test('describeTabs reports only the documented fields', () => {
  const described = describeTabs(parseTabList(REAL_SAMPLE).tabs);
  assert.deepEqual(Object.keys(described[0]), ['index', 'current', 'title', 'url']);
});

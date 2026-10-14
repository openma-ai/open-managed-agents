import assert from 'node:assert/strict';
import test from 'node:test';
import { prefixZhDocHref, remarkZhDocLinks } from './remark-zh-links.mjs';

test('prefixes docs paths and leaves everything else', () => {
  assert.equal(prefixZhDocHref('/self-host/overview/'), '/zh-cn/self-host/overview/');
  assert.equal(
    prefixZhDocHref('/self-host/sandbox-persistence/#acp-native-session-persistence'),
    '/zh-cn/self-host/sandbox-persistence/#acp-native-session-persistence',
  );
  assert.equal(prefixZhDocHref('/'), '/zh-cn/');
  assert.equal(prefixZhDocHref('/zh-cn/quickstart/'), '/zh-cn/quickstart/');
  assert.equal(prefixZhDocHref('https://app.openma.ai'), 'https://app.openma.ai');
  assert.equal(prefixZhDocHref('#steps'), '#steps');
  assert.equal(prefixZhDocHref('/favicon.svg'), '/favicon.svg');
});

test('rewrites markdown and JSX hrefs only for zh-cn sources', () => {
  const tree = {
    type: 'root',
    children: [
      { type: 'link', url: '/concepts/', children: [] },
      {
        type: 'mdxJsxFlowElement',
        name: 'LinkCard',
        attributes: [{ type: 'mdxJsxAttribute', name: 'href', value: '/build/api/' }],
        children: [],
      },
    ],
  };
  remarkZhDocLinks()(tree, {
    path: '/workspace/apps/docs/src/content/docs/zh-cn/quickstart.mdx',
    history: [],
  });
  assert.equal(tree.children[0].url, '/zh-cn/concepts/');
  assert.equal(tree.children[1].attributes[0].value, '/zh-cn/build/api/');

  const english = { type: 'root', children: [{ type: 'link', url: '/concepts/', children: [] }] };
  remarkZhDocLinks()(english, {
    path: '/workspace/apps/docs/src/content/docs/quickstart.mdx',
    history: [],
  });
  assert.equal(english.children[0].url, '/concepts/');
});

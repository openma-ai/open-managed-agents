import path from 'node:path';

const DOC_ROOTS = [
  '/build/',
  '/concepts/',
  '/console/',
  '/contribute/',
  '/quickstart/',
  '/reference/',
  '/self-host/',
];

/** Prefix a root-absolute docs href so a zh-cn page stays on the Chinese site. */
export function prefixZhDocHref(url) {
  if (typeof url !== 'string' || url.length === 0) return url;
  if (
    url.startsWith('#')
    || url.startsWith('mailto:')
    || url.startsWith('http://')
    || url.startsWith('https://')
  ) {
    return url;
  }
  const hashAt = url.indexOf('#');
  const pathname = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return url;
  if (pathname === '/zh-cn' || pathname.startsWith('/zh-cn/')) return url;
  const isHome = pathname === '/';
  const isDoc = isHome || DOC_ROOTS.some((root) => pathname.startsWith(root));
  if (!isDoc) return url;
  if (isHome) return `/zh-cn/${hash}`;
  return `/zh-cn${pathname}${hash}`;
}

function isZhCnDoc(file) {
  const candidates = [file.path, ...(file.history ?? [])].filter(Boolean);
  return candidates.some((name) => {
    const normalized = name.split(path.sep).join('/');
    return normalized.includes('/content/docs/zh-cn/');
  });
}

function rewriteJsxHref(node) {
  if (node.type !== 'mdxJsxFlowElement' && node.type !== 'mdxJsxTextElement') return;
  for (const attr of node.attributes ?? []) {
    if (attr.type === 'mdxJsxAttribute' && attr.name === 'href' && typeof attr.value === 'string') {
      attr.value = prefixZhDocHref(attr.value);
    }
  }
}

/** Remark plugin: Chinese docs keep the English absolute-link style, but render under /zh-cn/. */
export function remarkZhDocLinks() {
  return (tree, file) => {
    if (!isZhCnDoc(file)) return;
    visit(tree);
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'link' || node.type === 'definition') {
        if (typeof node.url === 'string') node.url = prefixZhDocHref(node.url);
      }
      rewriteJsxHref(node);
      for (const child of node.children ?? []) visit(child);
    }
  };
}

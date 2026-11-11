"use client";

/**
 * The SyntaxHighlighter slot of assistant-ui's markdown primitive: a fenced code block
 * rendered as highlight.js tokens (src/codeHighlight.ts) inside the thread's own
 * <Pre>/<Code> components, so the frame, copy header and padding are the plain block's.
 * The hast tree becomes React elements through the JSX runtime, never innerHTML. A
 * language with no grammar renders the raw text, as before.
 *
 * Token colours live in globals.css under `.aui-md .hljs-*`.
 */

import { Fragment, memo, useMemo, type FC } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";

import { highlightCode } from "@/src/codeHighlight";

const SyntaxHighlighterImpl: FC<Omit<SyntaxHighlighterProps, "node">> = ({
  components: { Pre, Code },
  language,
  code,
}) => {
  const tree = useMemo(() => highlightCode(language, code), [language, code]);
  const children = useMemo(
    () => (tree ? toJsxRuntime(tree, { Fragment, jsx, jsxs }) : code),
    [tree, code],
  );
  return (
    <Pre>
      <Code className={tree ? "hljs" : undefined} data-highlighted={tree ? language : undefined}>
        {children}
      </Code>
    </Pre>
  );
};

export const SyntaxHighlighter = memo(SyntaxHighlighterImpl);

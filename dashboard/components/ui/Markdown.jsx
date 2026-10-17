'use client';
// dashboard/components/ui/Markdown.jsx: Markdown as the agent writes it (GitHub flavor: tables,
// task lists, strikethrough). Raw HTML in the text is shown as text, never rendered; links open in a
// new tab.
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
};

export function Markdown({ children, className = '' }) {
  return (
    <div className={`markdown ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {String(children ?? '')}
      </ReactMarkdown>
    </div>
  );
}

import { Children, isValidElement, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Icon } from './Icon'

/**
 * Markdown 渲染：代码块带语言标签与复制按钮；链接交给系统浏览器。
 * 所有内容都来自本地模型输出，不使用 dangerouslySetInnerHTML。
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <CodeBlockWrapper>{children}</CodeBlockWrapper>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(event) => {
                event.preventDefault()
                if (href) void window.pi.app.openExternal(href)
              }}
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div style={{ overflowX: 'auto' }}>
              <table>{children}</table>
            </div>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function CodeBlockWrapper({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children)[0]
  const props = isValidElement<{ className?: string; children?: ReactNode }>(child) ? child.props : undefined
  const language = /language-([\w+-]+)/.exec(props?.className ?? '')?.[1] ?? 'text'
  const code = String(props?.children ?? '').replace(/\n$/, '')
  return <CodeBlock language={language} code={code} />
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    })
  }

  return (
    <div className="code-block">
      <pre style={{ margin: 0, border: 'none', background: 'none' }}>
        <div className="code-head">
          <span>{language}</span>
          <div className="spacer" />
          <button className="btn ghost sm" onClick={copy} style={{ color: 'inherit' }}>
            <Icon name={copied ? 'check' : 'copy'} size={13} />
            {copied ? '已复制' : '复制'}
          </button>
        </div>
        <code>{code}</code>
      </pre>
    </div>
  )
}

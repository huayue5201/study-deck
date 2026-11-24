import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: true })

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(html)
}

/** 去掉 markdown 记号，压成一行纯文本（列表/摘要用） */
export function stripMarkdown(text: string): string {
  return text
    .replace(/[#>*`_\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

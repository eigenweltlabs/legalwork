import DOMPurify from "dompurify";
import { openDesktopUrl } from "@/app/lib/desktop";
import { safeCalendarUrl } from "./connected-calendars";

export function CalendarEventLink({ url, children }: { url: string | null | undefined; children: React.ReactNode }) {
  const safe = safeCalendarUrl(url ?? null);
  return safe ? <a href={safe} className="break-words text-primary underline underline-offset-2" onClick={event => { event.preventDefault(); void openDesktopUrl(safe); }}>{children}</a> : <span className="break-words">{children}</span>;
}

export function CalendarEventDescription({ text, html }: { text: string; html: boolean }) {
  if (!html) return <p className="whitespace-pre-wrap break-words">{text.split(/(https?:\/\/[^\s<>]+)/g).map((part, index) => <CalendarEventLink key={index} url={part}>{part}</CalendarEventLink>)}</p>;
  // Provider descriptions are untrusted. Keep readable formatting and HTTPS
  // links, without images, styles, embedded content or executable attributes.
  const sanitized = DOMPurify.sanitize(text, {
    ALLOWED_TAGS: ["p", "br", "div", "span", "b", "strong", "i", "em", "u", "ul", "ol", "li", "a", "pre", "blockquote"],
    ALLOWED_ATTR: ["href"], ALLOWED_URI_REGEXP: /^https:\/\//i,
  });
  return <div className="whitespace-pre-wrap break-words [&_a]:text-primary [&_a]:underline [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc" dangerouslySetInnerHTML={{ __html: sanitized }} onClick={event => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest("a");
    if (!link) return;
    event.preventDefault();
    const url = safeCalendarUrl(link.getAttribute("href"));
    if (url) void openDesktopUrl(url);
  }} />;
}

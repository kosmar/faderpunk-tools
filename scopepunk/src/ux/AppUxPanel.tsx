import type { AppUx, AppUxChannel } from "./types";

/** Render cheatsheet lines that only use <strong>…</strong> (strip anything else). */
export function RichLine({ html }: { html: string }) {
  const parts: Array<string | { strong: string }> = [];
  const re = /<strong>(.*?)<\/strong>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m.index > last) parts.push(stripTags(html.slice(last, m.index)));
    parts.push({ strong: stripTags(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < html.length) parts.push(stripTags(html.slice(last)));

  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : (
          <strong key={i}>{p.strong}</strong>
        ),
      )}
    </>
  );
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function channelLines(ch: AppUxChannel, index: number, faderBase: number): string[] {
  const fader = faderBase + index + 1;
  const lines: string[] = [];
  const push = (label: string, title?: string, desc?: string) => {
    if (!title && !desc) return;
    const body = [title, desc].filter(Boolean).join(" — ");
    lines.push(`${label}: ${body}`);
  };
  push(`F${fader} jack`, ch.jackTitle, ch.jackDescription);
  push("Fader", ch.faderTitle, ch.faderDescription);
  push("Alt", ch.faderPlusShiftTitle, ch.faderPlusShiftDescription);
  push("Third", ch.faderPlusFnTitle, ch.faderPlusFnDescription);
  push("Btn", ch.fnTitle, ch.fnDescription);
  push("Shift+Btn", ch.fnPlusShiftTitle, ch.fnPlusShiftDescription);
  if (ch.ledTop) lines.push(`LED top: ${ch.ledTop}`);
  if (ch.ledTopPlusShift) lines.push(`LED top+Shift: ${ch.ledTopPlusShift}`);
  if (ch.ledBottom) lines.push(`LED bottom: ${ch.ledBottom}`);
  return lines;
}

type Props = {
  ux: AppUx;
  /** Absolute fader start (0-based) for F-number labels */
  startChannel: number;
  /** How many channels this layout instance owns */
  width: number;
};

export function AppUxPanel({ ux, startChannel, width }: Props) {
  const channels = ux.channels.slice(0, Math.max(1, width));

  return (
    <div className="app-ux" role="region" aria-label={`${ux.name} how to play`}>
      {ux.sections.map((sec) => (
        <section key={sec.heading} className="app-ux-sec">
          <h4>{sec.heading}</h4>
          <ul>
            {sec.items.map((item, i) => (
              <li key={i}>
                <RichLine html={item} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {channels.length > 0 && (
        <section className="app-ux-sec">
          <h4>{channels.length > 1 ? "Channels" : "This channel"}</h4>
          {channels.map((ch, i) => {
            const lines = channelLines(ch, i, startChannel);
            if (!lines.length) return null;
            return (
              <div key={i} className="app-ux-ch">
                {channels.length > 1 && (
                  <div className="app-ux-ch-label">F{startChannel + i + 1}</div>
                )}
                <ul>
                  {lines.map((line, j) => (
                    <li key={j}>{line}</li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

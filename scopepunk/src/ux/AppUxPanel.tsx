import type { AppUx, AppUxChannel, AppUxSection } from "./types";

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

/** Semantic badge tint by gesture / channel role. */
export function badgeRole(label: string): string {
  const g = label.trim().toLowerCase();
  if (/^f\d/.test(g) || /\bjack\b/.test(g)) return "jack";
  if (/shift|\balt\+/.test(g)) return "shift";
  if (/^(main|fader)\b/.test(g) || /\bch\d+\s*main\b/.test(g)) return "main";
  if (/^alt\b/.test(g)) return "alt";
  if (/^third\b/.test(g)) return "third";
  if (/^(btn|hold|short|long)\b/.test(g)) return "btn";
  if (/^led/.test(g)) return "led";
  return "default";
}

/** Optional tint for decay-mode style zone chips that name a color. */
function zoneTone(label: string): string | null {
  const g = label.toLowerCase();
  if (/\brose\b|\bpink\b/.test(g)) return "rose";
  if (/\borange\b/.test(g)) return "orange";
  if (/\byellow\b/.test(g)) return "yellow";
  if (/\blime\b|\bgreen\b/.test(g)) return "lime";
  if (/\bcyan\b/.test(g)) return "cyan";
  if (/\bblue\b/.test(g)) return "blue";
  if (/\bviolet\b|\bpurple\b/.test(g)) return "violet";
  if (/\bred\b/.test(g)) return "red";
  return null;
}

function parseGestureLine(html: string): {
  gesture: string;
  hint: string | null;
  body: string;
} {
  const m = html.match(/^<strong>(.*?)<\/strong>\s*(.*)$/i);
  if (!m) {
    return { gesture: "", hint: null, body: stripTags(html).trim() };
  }
  const gesture = stripTags(m[1]).trim();
  let rest = m[2].trim();
  let hint: string | null = null;
  const hintM = rest.match(/^\(([^)]+)\)\s*[—–\-]\s*(.*)$/);
  if (hintM) {
    hint = hintM[1].trim();
    rest = hintM[2].trim();
  } else {
    rest = rest.replace(/^[—–\-]\s*/, "").trim();
  }
  return { gesture, hint, body: stripTags(rest) };
}

function splitZones(body: string): { lead: string; zones: string[] } | null {
  const idx = body.indexOf(":");
  if (idx < 0) return null;
  const lead = body.slice(0, idx).trim();
  const tail = body.slice(idx + 1).trim();
  if (!tail.includes("·") && !tail.includes("•")) return null;
  const zones = tail
    .split(/\s*[·•]\s*/)
    .map((z) => z.trim())
    .filter(Boolean);
  if (zones.length < 2) return null;
  return { lead, zones };
}

function GestureBadge({ label }: { label: string }) {
  return <span className={`ux-badge role-${badgeRole(label)}`}>{label}</span>;
}

function GestureRow({ html }: { html: string }) {
  const { gesture, hint, body } = parseGestureLine(html);
  const zones = splitZones(body);

  return (
    <div className="ux-row">
      {gesture ? <GestureBadge label={gesture} /> : null}
      {hint ? <span className="ux-hint">({hint})</span> : null}
      <div className="ux-body">
        {zones ? (
          <>
            <span className="ux-lead">{zones.lead}:</span>{" "}
            {zones.zones.map((z) => {
              const tone = zoneTone(z);
              return (
                <span
                  key={z}
                  className={tone ? `ux-zone tone-${tone}` : "ux-zone"}
                >
                  {z}
                </span>
              );
            })}
          </>
        ) : (
          body
        )}
      </div>
    </div>
  );
}

function SectionBlock({ section }: { section: AppUxSection }) {
  return (
    <section className="app-ux-sec">
      <h4>{section.heading}</h4>
      <div className="ux-rows">
        {section.items.map((item, i) => (
          <GestureRow key={i} html={item} />
        ))}
      </div>
    </section>
  );
}

function channelRows(
  ch: AppUxChannel,
  index: number,
  faderBase: number,
): { label: string; text: string }[] {
  const fader = faderBase + index + 1;
  const rows: { label: string; text: string }[] = [];
  const push = (label: string, title?: string, desc?: string) => {
    if (!title && !desc) return;
    rows.push({ label, text: [title, desc].filter(Boolean).join(" — ") });
  };
  push(`F${fader} jack`, ch.jackTitle, ch.jackDescription);
  push("Fader", ch.faderTitle, ch.faderDescription);
  push("Alt", ch.faderPlusShiftTitle, ch.faderPlusShiftDescription);
  push("Third", ch.faderPlusFnTitle, ch.faderPlusFnDescription);
  push("Btn", ch.fnTitle, ch.fnDescription);
  push("Shift", ch.fnPlusShiftTitle, ch.fnPlusShiftDescription);
  if (ch.ledTop) rows.push({ label: "LED top", text: ch.ledTop });
  if (ch.ledTopPlusShift) rows.push({ label: "LED top+S", text: ch.ledTopPlusShift });
  if (ch.ledBottom) rows.push({ label: "LED bottom", text: ch.ledBottom });
  return rows;
}

type Props = {
  ux: AppUx;
  startChannel: number;
  width: number;
};

function isGestureSection(heading: string): boolean {
  return /^(faders?|buttons?)\b/i.test(heading.trim());
}

export function AppUxPanel({ ux, startChannel, width }: Props) {
  const channels = ux.channels.slice(0, Math.max(1, width));
  const gestureSecs = ux.sections.filter((s) => isGestureSection(s.heading));
  const otherSecs = ux.sections.filter((s) => !isGestureSection(s.heading));

  return (
    <div className="app-ux" role="region" aria-label={`${ux.name} how to play`}>
      {gestureSecs.map((sec) => (
        <SectionBlock key={sec.heading} section={sec} />
      ))}

      {otherSecs.map((sec) => (
        <SectionBlock key={sec.heading} section={sec} />
      ))}

      {channels.length > 0 && (
        <section className="app-ux-sec">
          <h4>{channels.length > 1 ? "Channels" : "This channel"}</h4>
          {channels.map((ch, i) => {
            const rows = channelRows(ch, i, startChannel);
            if (!rows.length) return null;
            return (
              <div key={i} className="app-ux-ch">
                {channels.length > 1 && (
                  <div className="app-ux-ch-label">F{startChannel + i + 1}</div>
                )}
                <div className="ux-rows">
                  {rows.map((row) => (
                    <div key={row.label} className="ux-row">
                      <GestureBadge label={row.label} />
                      <div className="ux-body">{row.text}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

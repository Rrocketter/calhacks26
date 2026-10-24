import type { Card, When } from './cards';
import { highlightSegments } from './cards';

// stamp: how the turn ended, laid over the card (Applied / Discarded / Couldn't finish).
type Stamp = { text: string; tone: 'good' | 'bad' } | null;

const range = (w: When) => (w.end ? `${w.time} – ${w.end}` : w.time);

function Message({ card }: { card: Extract<Card, { kind: 'message' }> }) {
  return (
    <div className="rc mail">
      <div className="rc-bar">
        <span className="rc-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        New message · draft
      </div>
      <div className="mail-row">
        <span className="mail-k">To</span>
        <span className="mail-to">{card.to ?? 'Unknown'}</span>
      </div>
      {card.subject && (
        <div className="mail-row">
          <span className="mail-k">Subject</span>
          <span className="mail-subject">{card.subject}</span>
        </div>
      )}
      <div className="mail-body">
        {highlightSegments(card.body, card.highlight).map((s, i) => (s.mark ? <mark key={i}>{s.text}</mark> : s.text))}
      </div>
    </div>
  );
}

function Event({ card }: { card: Extract<Card, { kind: 'event' }> }) {
  // "Wed, Oct 28" → tile month OCT, date 28, weekday WED
  const [dow, md] = card.after.day.split(', ');
  const [mon, date] = (md ?? '').split(' ');
  return (
    <div className="rc event">
      <div className="cal-tile" aria-hidden>
        <span className="cal-mon">{mon}</span>
        <span className="cal-date num">{date}</span>
        <span className="cal-dow">{dow}</span>
      </div>
      <div className="event-main">
        <div className="event-title">{card.title ?? 'Event'}</div>
        <div className="event-when old">
          <s>
            {card.before.day} · {range(card.before)}
          </s>
        </div>
        <div className="event-when new">
          <span className="event-arrow" aria-hidden />
          {card.after.day} · {range(card.after)}
        </div>
        {card.location && <div className="event-loc">{card.location}</div>}
      </div>
    </div>
  );
}

function Note({ card }: { card: Extract<Card, { kind: 'note' }> }) {
  return (
    <div className="rc note">
      <div className="rc-bar">New note</div>
      {card.title && <div className="note-title">{card.title}</div>}
      <ul className="note-lines">
        {card.lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

function FileCard({ card }: { card: Extract<Card, { kind: 'file' }> }) {
  return (
    <div className="rc file">
      <div className={`file-icon ${(card.type ?? '').toLowerCase()}`} aria-hidden>
        <span>{card.type ?? '?'}</span>
      </div>
      <div className="file-main">
        <div className="file-name">{card.name}</div>
        {card.path ? <div className="file-path num">{card.path}</div> : <div className="file-path">Searching your files</div>}
        {card.why && <div className="file-why">{card.why}</div>}
      </div>
    </div>
  );
}

function Answer({ card }: { card: Extract<Card, { kind: 'answer' }> }) {
  return (
    <div className="rc chat">
      <div className="bubble you">{card.question}</div>
      <div className="bubble ahead">
        <span className="bubble-who">AHEAD</span>
        {card.answer ?? (
          <span className="typing" aria-label="answering">
            <i />
            <i />
            <i />
          </span>
        )}
      </div>
    </div>
  );
}

export function ResultCard({ card, stamp }: { card: Card; stamp: Stamp }) {
  return (
    <div className={stamp ? `rc-wrap ended ${stamp.tone}` : 'rc-wrap'}>
      {stamp && (
        <span className={`rc-stamp ${stamp.tone}`} key={stamp.text}>
          {stamp.text}
        </span>
      )}
      {card.kind === 'message' ? (
        <Message card={card} />
      ) : card.kind === 'event' ? (
        <Event card={card} />
      ) : card.kind === 'note' ? (
        <Note card={card} />
      ) : card.kind === 'file' ? (
        <FileCard card={card} />
      ) : (
        <Answer card={card} />
      )}
    </div>
  );
}

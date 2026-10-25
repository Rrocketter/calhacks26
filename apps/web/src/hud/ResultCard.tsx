import type { ReactNode } from 'react';
import type { Card, When } from './cards';
import { highlightSegments } from './cards';
import { CalendarIcon, ChatIcon, FileIcon, MailIcon, NoteIcon } from './icons';

// stamp: how the turn ended (Applied / Discarded, or err when the run failed: red in both views).
type Stamp = { text: string; tone: 'good' | 'bad' | 'err' } | null;

const range = (w: When) => (w.end ? `${w.time} – ${w.end}` : w.time);

// Every card: a tiny header row (icon + what Ahem did), then the content in the body font.
function Head({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="rc-head">
      {icon}
      {children}
    </div>
  );
}

function Message({ card }: { card: Extract<Card, { kind: 'message' }> }) {
  return (
    <div className="rc mail">
      <Head icon={<MailIcon />}>Draft message</Head>
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
      <div className="rc-body mail-body">
        <p>{highlightSegments(card.body, card.highlight).map((s, i) => (s.mark ? <mark key={i}>{s.text}</mark> : s.text))}</p>
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
      <Head icon={<CalendarIcon />}>Reschedule event</Head>
      <div className="rc-body event-body">
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
    </div>
  );
}

function Note({ card }: { card: Extract<Card, { kind: 'note' }> }) {
  return (
    <div className="rc note">
      <Head icon={<NoteIcon />}>New note</Head>
      <div className="rc-body">
        {card.title && <div className="note-title">{card.title}</div>}
        <ul className="note-lines">
          {card.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function FileCard({ card }: { card: Extract<Card, { kind: 'file' }> }) {
  return (
    <div className="rc file">
      <Head icon={<FileIcon />}>{card.path ? 'Found file' : 'Finding file'}</Head>
      <div className="rc-body file-body">
        <div className={`file-icon ${(card.type ?? '').toLowerCase()}`} aria-hidden>
          <span>{card.type ?? '?'}</span>
        </div>
        <div className="file-main">
          <div className="file-name">{card.name}</div>
          {card.path ? <div className="file-path num">{card.path}</div> : <div className="file-path">Searching your files</div>}
          {card.why && <div className="file-why">{card.why}</div>}
        </div>
      </div>
    </div>
  );
}

function Answer({ card }: { card: Extract<Card, { kind: 'answer' }> }) {
  return (
    <div className="rc chat">
      <Head icon={<ChatIcon />}>Answer</Head>
      <div className="rc-body">
        <div className="bubble you">{card.question}</div>
        <div className="bubble ahem">
          <span className="bubble-who">Ahem</span>
          {card.answer ?? (
            <span className="typing" aria-label="answering">
              <i />
              <i />
              <i />
            </span>
          )}
        </div>
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

// SMS character + segment counter (Phase 4).
//
// Exact, not approximate. SMS is encoded one of two ways:
//
//   GSM-7  — the message uses only characters from the GSM 03.38 alphabet.
//            Seven bits each, so 160 fit in one segment. A concatenated
//            message spends 7 bits per segment on a header, leaving 153.
//            Nine characters (^ { } \ [ ~ ] | €) are not in the basic set;
//            they are sent as an escape pair and therefore count as TWO.
//
//   UCS-2  — any character outside GSM 03.38 (an emoji, ñ in some forms,
//            curly quotes, most non-Latin scripts) forces the whole message
//            to 16-bit encoding: 70 per segment, 67 when concatenated.
//            JavaScript strings are UTF-16, so an emoji is a surrogate pair
//            and correctly counts as two units — which is why this walks
//            code units rather than using [...str].

// GSM 03.38 basic character set.
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
// Characters sent via the escape table — they occupy two septets each.
const GSM_EXTENDED = '^{}\\[~]|€';

const BASIC = new Set(GSM_BASIC.split(''));
const EXTENDED = new Set(GSM_EXTENDED.split(''));

export function isGsm7(text) {
  for (const ch of String(text || '')) {
    if (!BASIC.has(ch) && !EXTENDED.has(ch)) return false;
  }
  return true;
}

// Returns { encoding, length, segments, perSegment, remaining }.
//   length    — billable units (septets for GSM-7, UTF-16 units for UCS-2)
//   remaining — units left in the current segment
export function countSms(text) {
  const str = String(text || '');
  const gsm = isGsm7(str);

  let length = 0;
  if (gsm) {
    for (const ch of str) length += EXTENDED.has(ch) ? 2 : 1;
  } else {
    // UTF-16 code units: a surrogate pair (emoji) counts as 2, as Twilio bills.
    length = str.length;
  }

  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;

  let segments;
  let perSegment;
  if (length === 0) {
    segments = 0;
    perSegment = single;
  } else if (length <= single) {
    segments = 1;
    perSegment = single;
  } else {
    segments = Math.ceil(length / multi);
    perSegment = multi;
  }

  const remaining = segments <= 1 ? single - length : segments * perSegment - length;

  return { encoding: gsm ? 'GSM-7' : 'UCS-2', length, segments, perSegment, remaining };
}

// Small inline readout for composers. Turns amber past one segment so an
// operator can see before sending that a message will cost more than one SMS.
export default function SmsCounter({ text, className = '' }) {
  const { encoding, length, segments, remaining } = countSms(text);
  const multi = segments > 1;

  return (
    <span className={`sms-counter small ${multi ? 'sms-counter-warn' : 'muted'} ${className}`}>
      {length} char{length === 1 ? '' : 's'} · {segments} segment{segments === 1 ? '' : 's'}
      {segments > 0 && <> · {remaining} left</>}
      {encoding === 'UCS-2' && <> · Unicode (emoji/special characters)</>}
    </span>
  );
}

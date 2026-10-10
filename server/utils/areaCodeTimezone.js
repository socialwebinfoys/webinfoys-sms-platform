// US/Canada area code -> IANA timezone (Phase 2).
//
// Used to auto-fill Contact.timezone at import so automation can send inside
// each recipient's local hours instead of one global window. Best-effort only:
// an unknown area code returns '' and the contact simply falls back to the
// global sending-window timezone. A number's area code is where it was issued,
// not necessarily where the person is, so an explicit contact timezone always
// wins over this guess.
const AREA_CODE_TIMEZONES = {
  // --- America/New_York (Eastern) ---
  201: 'America/New_York', 202: 'America/New_York', 203: 'America/New_York',
  207: 'America/New_York', 212: 'America/New_York', 215: 'America/New_York',
  216: 'America/New_York', 220: 'America/New_York', 223: 'America/New_York',
  227: 'America/New_York', 229: 'America/New_York', 231: 'America/New_York',
  234: 'America/New_York', 236: 'America/Vancouver', 239: 'America/New_York',
  240: 'America/New_York', 248: 'America/New_York', 252: 'America/New_York',
  267: 'America/New_York', 269: 'America/New_York', 272: 'America/New_York',
  276: 'America/New_York', 278: 'America/New_York', 289: 'America/Toronto',
  301: 'America/New_York', 302: 'America/New_York', 304: 'America/New_York',
  305: 'America/New_York', 313: 'America/New_York', 315: 'America/New_York',
  317: 'America/New_York', 321: 'America/New_York', 326: 'America/New_York',
  330: 'America/New_York', 336: 'America/New_York', 339: 'America/New_York',
  343: 'America/Toronto', 347: 'America/New_York', 351: 'America/New_York',
  352: 'America/New_York', 364: 'America/New_York', 365: 'America/Toronto',
  380: 'America/New_York', 386: 'America/New_York', 401: 'America/New_York',
  404: 'America/New_York', 407: 'America/New_York', 410: 'America/New_York',
  412: 'America/New_York', 413: 'America/New_York', 416: 'America/Toronto',
  419: 'America/New_York', 423: 'America/New_York', 434: 'America/New_York',
  437: 'America/Toronto', 440: 'America/New_York', 443: 'America/New_York',
  445: 'America/New_York', 447: 'America/New_York', 464: 'America/Chicago',
  470: 'America/New_York', 475: 'America/New_York', 478: 'America/New_York',
  484: 'America/New_York', 500: 'America/New_York', 504: 'America/Chicago',
  508: 'America/New_York', 513: 'America/New_York', 516: 'America/New_York',
  517: 'America/New_York', 518: 'America/New_York', 519: 'America/Toronto',
  540: 'America/New_York', 546: 'America/Toronto', 548: 'America/Toronto',
  551: 'America/New_York', 557: 'America/Chicago', 561: 'America/New_York',
  567: 'America/New_York', 570: 'America/New_York', 571: 'America/New_York',
  585: 'America/New_York', 586: 'America/New_York', 588: 'America/Toronto',
  592: 'America/New_York', 603: 'America/New_York', 606: 'America/New_York',
  607: 'America/New_York', 610: 'America/New_York', 612: 'America/Chicago',
  614: 'America/New_York', 616: 'America/New_York', 617: 'America/New_York',
  624: 'America/New_York', 631: 'America/New_York', 646: 'America/New_York',
  647: 'America/Toronto', 672: 'America/Vancouver', 678: 'America/New_York',
  680: 'America/New_York', 681: 'America/New_York', 683: 'America/Toronto',
  689: 'America/New_York', 703: 'America/New_York', 704: 'America/New_York',
  705: 'America/Toronto', 706: 'America/New_York', 716: 'America/New_York',
  717: 'America/New_York', 718: 'America/New_York', 724: 'America/New_York',
  726: 'America/Chicago', 727: 'America/New_York', 729: 'America/New_York',
  732: 'America/New_York', 734: 'America/New_York', 740: 'America/New_York',
  743: 'America/New_York', 747: 'America/Los_Angeles', 753: 'America/Toronto',
  754: 'America/New_York', 757: 'America/New_York', 762: 'America/New_York',
  770: 'America/New_York', 772: 'America/New_York', 774: 'America/New_York',
  781: 'America/New_York', 786: 'America/New_York', 787: 'America/Puerto_Rico',
  802: 'America/New_York', 803: 'America/New_York', 804: 'America/New_York',
  807: 'America/Toronto', 810: 'America/New_York', 813: 'America/New_York',
  814: 'America/New_York', 828: 'America/New_York', 835: 'America/New_York',
  839: 'America/New_York', 843: 'America/New_York', 845: 'America/New_York',
  848: 'America/New_York', 854: 'America/New_York', 856: 'America/New_York',
  857: 'America/New_York', 859: 'America/New_York', 862: 'America/New_York',
  863: 'America/New_York', 873: 'America/Toronto', 878: 'America/New_York',
  904: 'America/New_York', 905: 'America/Toronto', 906: 'America/New_York',
  908: 'America/New_York', 910: 'America/New_York', 912: 'America/New_York',
  914: 'America/New_York', 917: 'America/New_York', 919: 'America/New_York',
  929: 'America/New_York', 930: 'America/New_York', 937: 'America/New_York',
  939: 'America/Puerto_Rico', 941: 'America/New_York', 947: 'America/New_York',
  949: 'America/Los_Angeles', 954: 'America/New_York', 959: 'America/New_York',
  980: 'America/New_York', 984: 'America/New_York', 989: 'America/New_York',

  // --- America/Chicago (Central) ---
  205: 'America/Chicago', 206: 'America/Los_Angeles', 210: 'America/Chicago',
  214: 'America/Chicago', 217: 'America/Chicago', 218: 'America/Chicago',
  219: 'America/Chicago', 224: 'America/Chicago', 225: 'America/Chicago',
  228: 'America/Chicago', 251: 'America/Chicago', 254: 'America/Chicago',
  256: 'America/Chicago', 262: 'America/Chicago', 270: 'America/Chicago',
  281: 'America/Chicago', 309: 'America/Chicago', 312: 'America/Chicago',
  314: 'America/Chicago', 316: 'America/Chicago', 318: 'America/Chicago',
  319: 'America/Chicago', 320: 'America/Chicago', 331: 'America/Chicago',
  337: 'America/Chicago', 346: 'America/Chicago', 361: 'America/Chicago',
  363: 'America/Chicago', 402: 'America/Chicago', 405: 'America/Chicago',
  409: 'America/Chicago', 414: 'America/Chicago', 417: 'America/Chicago',
  430: 'America/Chicago', 432: 'America/Chicago', 435: 'America/Denver',
  458: 'America/Los_Angeles', 463: 'America/New_York', 469: 'America/Chicago',
  479: 'America/Chicago', 501: 'America/Chicago', 502: 'America/New_York',
  507: 'America/Chicago', 512: 'America/Chicago', 515: 'America/Chicago',
  534: 'America/Chicago', 563: 'America/Chicago', 573: 'America/Chicago',
  580: 'America/Chicago', 601: 'America/Chicago', 605: 'America/Chicago',
  608: 'America/Chicago', 615: 'America/Chicago', 618: 'America/Chicago',
  620: 'America/Chicago', 630: 'America/Chicago', 636: 'America/Chicago',
  641: 'America/Chicago', 651: 'America/Chicago', 660: 'America/Chicago',
  662: 'America/Chicago', 682: 'America/Chicago', 708: 'America/Chicago',
  712: 'America/Chicago', 713: 'America/Chicago', 715: 'America/Chicago',
  731: 'America/Chicago', 737: 'America/Chicago', 763: 'America/Chicago',
  769: 'America/Chicago', 773: 'America/Chicago', 779: 'America/Chicago',
  785: 'America/Chicago', 806: 'America/Chicago', 815: 'America/Chicago',
  816: 'America/Chicago', 817: 'America/Chicago', 830: 'America/Chicago',
  832: 'America/Chicago', 847: 'America/Chicago', 870: 'America/Chicago',
  872: 'America/Chicago', 901: 'America/Chicago', 903: 'America/Chicago',
  913: 'America/Chicago', 915: 'America/Denver', 918: 'America/Chicago',
  920: 'America/Chicago', 931: 'America/Chicago', 936: 'America/Chicago',
  940: 'America/Chicago', 952: 'America/Chicago', 956: 'America/Chicago',
  972: 'America/Chicago', 979: 'America/Chicago', 985: 'America/Chicago',

  // --- America/Denver (Mountain) ---
  208: 'America/Boise', 303: 'America/Denver', 307: 'America/Denver',
  385: 'America/Denver', 406: 'America/Denver', 505: 'America/Denver',
  575: 'America/Denver', 719: 'America/Denver', 720: 'America/Denver',
  801: 'America/Denver', 970: 'America/Denver', 986: 'America/Boise',

  // --- America/Phoenix (Arizona: no DST) ---
  480: 'America/Phoenix', 520: 'America/Phoenix', 602: 'America/Phoenix',
  623: 'America/Phoenix', 928: 'America/Phoenix',

  // --- America/Los_Angeles (Pacific) ---
  209: 'America/Los_Angeles', 213: 'America/Los_Angeles', 221: 'America/Los_Angeles',
  250: 'America/Vancouver', 253: 'America/Los_Angeles', 279: 'America/Los_Angeles',
  310: 'America/Los_Angeles', 323: 'America/Los_Angeles', 341: 'America/Los_Angeles',
  350: 'America/Los_Angeles', 360: 'America/Los_Angeles', 369: 'America/Los_Angeles',
  408: 'America/Los_Angeles', 415: 'America/Los_Angeles', 424: 'America/Los_Angeles',
  425: 'America/Los_Angeles', 442: 'America/Los_Angeles', 503: 'America/Los_Angeles',
  509: 'America/Los_Angeles', 510: 'America/Los_Angeles', 530: 'America/Los_Angeles',
  541: 'America/Los_Angeles', 559: 'America/Los_Angeles', 562: 'America/Los_Angeles',
  604: 'America/Vancouver', 619: 'America/Los_Angeles', 626: 'America/Los_Angeles',
  628: 'America/Los_Angeles', 650: 'America/Los_Angeles', 657: 'America/Los_Angeles',
  661: 'America/Los_Angeles', 669: 'America/Los_Angeles', 702: 'America/Los_Angeles',
  707: 'America/Los_Angeles', 714: 'America/Los_Angeles', 725: 'America/Los_Angeles',
  742: 'America/Toronto', 760: 'America/Los_Angeles', 775: 'America/Los_Angeles',
  778: 'America/Vancouver', 805: 'America/Los_Angeles', 818: 'America/Los_Angeles',
  820: 'America/Los_Angeles', 831: 'America/Los_Angeles', 840: 'America/Los_Angeles',
  858: 'America/Los_Angeles', 909: 'America/Los_Angeles', 916: 'America/Los_Angeles',
  925: 'America/Los_Angeles', 935: 'America/Los_Angeles', 951: 'America/Los_Angeles',
  971: 'America/Los_Angeles',

  // --- Alaska / Hawaii ---
  907: 'America/Anchorage',
  808: 'Pacific/Honolulu',
};

// Resolve an E.164 phone number to an IANA timezone, or '' when unknown.
// Only +1 (NANP) numbers are mapped; everything else returns ''.
function timezoneForPhone(e164) {
  const s = String(e164 || '').trim();
  // +1 followed by exactly 10 national digits.
  const m = /^\+1(\d{10})$/.exec(s);
  if (!m) return '';
  const areaCode = parseInt(m[1].slice(0, 3), 10);
  return AREA_CODE_TIMEZONES[areaCode] || '';
}

module.exports = { timezoneForPhone, AREA_CODE_TIMEZONES };
